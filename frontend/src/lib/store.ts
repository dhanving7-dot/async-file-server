import { useSyncExternalStore } from 'react';
import type {
  BackendStatus,
  BridgeMessage,
  CompletionRecord,
  LogEntry,
  Op,
  ServerEvent,
  ServerInfo,
  Snapshot,
  TimelinePoint,
  WorkerSnapshot,
} from './types';

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

export interface WorkerResult {
  requestId: number;
  success: boolean;
  status: string;
  processingMs: number;
  op: Op;
  file: string;
  at: number; // local receive time, for the "just finished" highlight
}

export interface WorkerView {
  id: number;
  state: 'IDLE' | 'PROCESSING';
  requestId: number;
  op: Op | null;
  file: string | null;
  startedAt: number; // server wall clock ms
  processed: number;
  failed: number;
  busyMs: number;
  bytes: number;
  utilization: number;
  lastResult: WorkerResult | null;
  history: { requestId: number; success: boolean; processingMs: number }[];
}

export interface QueueItem {
  requestId: number;
  op: Op;
  file: string;
  tag: string;
  bytes: number;
  queuedAt: number; // server wall clock ms
}

export type ActivityKind = 'queued' | 'started' | 'finished' | 'delivered' | 'rejected';

export interface ActivityItem {
  key: string;
  seq: number;
  ts: number;
  kind: ActivityKind;
  requestId: number;
  op?: Op;
  file?: string;
  worker?: number;
  success?: boolean;
  status?: string;
  ms?: number;
}

export interface Counters {
  received: number;
  queued: number;
  completed: number;
  succeeded: number;
  failed: number;
  rejected: number;
  delivered: number;
  undelivered: number;
  bytesRead: number;
  bytesWritten: number;
  totalProcessingMs: number;
  totalWaitMs: number;
  totalLatencyMs: number;
  minProcessingMs: number;
  maxProcessingMs: number;
}

export interface AppState {
  bridgeConnected: boolean;
  bridgeEverConnected: boolean;
  backend: BackendStatus | null;
  server: ServerInfo | null;
  serverReceivedAt: number;
  snapshot: Snapshot | null;
  appliedSeq: number;
  workers: WorkerView[];
  queue: QueueItem[];
  completionQueueSize: number;
  completions: CompletionRecord[]; // newest first
  logs: LogEntry[]; // oldest first
  activity: ActivityItem[]; // newest first
  counters: Counters;
  byOp: Record<'READ' | 'WRITE' | 'CREATE', { count: number; failed: number; totalMs: number; bytes: number }>;
  timeline: TimelinePoint[];
  activeConnections: number;
  /** Bumps whenever the files directory may have changed. */
  filesVersion: number;
  logsVersion: number;
}

const MAX_COMPLETIONS = 500;
const MAX_LOGS = 3000;
const MAX_ACTIVITY = 80;
const WORKER_HISTORY = 28;

const emptyCounters = (): Counters => ({
  received: 0,
  queued: 0,
  completed: 0,
  succeeded: 0,
  failed: 0,
  rejected: 0,
  delivered: 0,
  undelivered: 0,
  bytesRead: 0,
  bytesWritten: 0,
  totalProcessingMs: 0,
  totalWaitMs: 0,
  totalLatencyMs: 0,
  minProcessingMs: 0,
  maxProcessingMs: 0,
});

const emptyByOp = (): AppState['byOp'] => ({
  READ: { count: 0, failed: 0, totalMs: 0, bytes: 0 },
  WRITE: { count: 0, failed: 0, totalMs: 0, bytes: 0 },
  CREATE: { count: 0, failed: 0, totalMs: 0, bytes: 0 },
});

let state: AppState = {
  bridgeConnected: false,
  bridgeEverConnected: false,
  backend: null,
  server: null,
  serverReceivedAt: 0,
  snapshot: null,
  appliedSeq: 0,
  workers: [],
  queue: [],
  completionQueueSize: 0,
  completions: [],
  logs: [],
  activity: [],
  counters: emptyCounters(),
  byOp: emptyByOp(),
  timeline: [],
  activeConnections: 0,
  filesVersion: 0,
  logsVersion: 0,
};

const listeners = new Set<() => void>();

function commit(next: AppState) {
  state = next;
  for (const listener of listeners) listener();
}

export function getState() {
  return state;
}

export function useStore<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => selector(state),
    () => selector(state),
  );
}

/* ------------------------------------------------------------------ */
/* Snapshot application                                                */
/* ------------------------------------------------------------------ */

function workerFromSnapshot(w: WorkerSnapshot, previous?: WorkerView): WorkerView {
  return {
    id: w.id,
    state: w.state,
    requestId: w.request_id,
    op: w.op,
    file: w.file,
    startedAt: w.started_at,
    processed: w.processed,
    failed: w.failed,
    busyMs: w.busy_ms,
    bytes: w.bytes,
    utilization: w.utilization,
    lastResult: previous?.lastResult ?? null,
    history: previous?.history ?? [],
  };
}

function countersFromSnapshot(s: Snapshot): Counters {
  const t = s.totals;
  const deliveredTotal = t.delivered + t.undelivered;
  return {
    received: t.received,
    queued: t.queued,
    completed: t.completed,
    succeeded: t.succeeded,
    failed: t.failed,
    rejected: t.rejected,
    delivered: t.delivered,
    undelivered: t.undelivered,
    bytesRead: t.bytes_read,
    bytesWritten: t.bytes_written,
    totalProcessingMs: t.total_processing_ms,
    totalWaitMs: t.avg_wait_ms * t.completed,
    totalLatencyMs: t.avg_latency_ms * deliveredTotal,
    minProcessingMs: t.min_processing_ms,
    maxProcessingMs: t.max_processing_ms,
  };
}

function byOpFromSnapshot(s: Snapshot): AppState['byOp'] {
  const out = emptyByOp();
  for (const op of ['READ', 'WRITE', 'CREATE'] as const) {
    const o = s.by_op[op];
    out[op] = { count: o.count, failed: o.failed, totalMs: o.avg_ms * o.count, bytes: o.bytes };
  }
  return out;
}

function mergeCompletions(existing: CompletionRecord[], incoming: CompletionRecord[]): CompletionRecord[] {
  const byId = new Map<number, CompletionRecord>();
  for (const c of existing) byId.set(c.request_id, c);
  for (const c of incoming) byId.set(c.request_id, { ...byId.get(c.request_id), ...c });
  return [...byId.values()]
    .sort((a, b) => b.completed_at - a.completed_at || b.request_id - a.request_id)
    .slice(0, MAX_COMPLETIONS);
}

function applySnapshot(s: AppState, snap: Snapshot): AppState {
  const restarted =
    !!s.server && (s.server.started_at !== snap.server.started_at || s.server.pid !== snap.server.pid);

  const base: AppState = restarted
    ? {
        ...s,
        appliedSeq: 0,
        workers: [],
        queue: [],
        completions: [],
        logs: [],
        activity: [],
        counters: emptyCounters(),
        byOp: emptyByOp(),
        logsVersion: s.logsVersion + 1,
        filesVersion: s.filesVersion + 1,
      }
    : s;

  const next: AppState = {
    ...base,
    server: snap.server,
    serverReceivedAt: Date.now(),
    snapshot: snap,
    timeline: snap.timeline,
    completions: mergeCompletions(base.completions, snap.recent_completions),
  };

  if (snap.event_seq >= base.appliedSeq) {
    // Snapshot reflects every event we have seen: it is authoritative.
    const prev = new Map(base.workers.map((w) => [w.id, w]));
    next.appliedSeq = snap.event_seq;
    next.workers = snap.workers.map((w) => workerFromSnapshot(w, prev.get(w.id)));
    next.queue = snap.queues.request_queue.map((q) => ({
      requestId: q.request_id,
      op: q.op,
      file: q.file,
      tag: q.tag,
      bytes: q.bytes,
      queuedAt: snap.server.now - q.wait_ms,
    }));
    next.completionQueueSize = snap.queues.completion_queue_size;
    next.counters = countersFromSnapshot(snap);
    next.byOp = byOpFromSnapshot(snap);
    next.activeConnections = snap.server.active_connections;
  } else {
    // Live events are already ahead of this snapshot; keep the event-driven
    // view and only refresh slow-moving per-worker aggregates.
    const snapWorkers = new Map(snap.workers.map((w) => [w.id, w]));
    next.workers = base.workers.map((w) => {
      const sw = snapWorkers.get(w.id);
      return sw ? { ...w, utilization: sw.utilization } : w;
    });
  }

  return next;
}

/* ------------------------------------------------------------------ */
/* Event application                                                   */
/* ------------------------------------------------------------------ */

function pushActivity(list: ActivityItem[], item: ActivityItem) {
  const next = [item, ...list];
  if (next.length > MAX_ACTIVITY) next.length = MAX_ACTIVITY;
  return next;
}

function opKey(op: Op): 'READ' | 'WRITE' | 'CREATE' | null {
  return op === 'READ' || op === 'WRITE' || op === 'CREATE' ? op : null;
}

function applyEvent(s: AppState, e: ServerEvent): AppState {
  // Log lines are ordered by their own sequence number.
  if (e.type === 'log') {
    const last = s.logs.length ? s.logs[s.logs.length - 1].seq : 0;
    if (e.log.seq <= last) return s;
    const logs = [...s.logs, e.log];
    if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS);
    return { ...s, logs };
  }

  if (e.type === 'resync') return s; // next snapshot (≤1 s) restores state

  if (e.seq <= s.appliedSeq) return s;

  const next: AppState = { ...s, appliedSeq: e.seq };

  switch (e.type) {
    case 'request_queued': {
      next.queue = [
        ...s.queue,
        { requestId: e.request_id, op: e.op, file: e.file, tag: e.tag, bytes: e.bytes, queuedAt: e.ts },
      ];
      next.counters = { ...s.counters, received: s.counters.received + 1, queued: s.counters.queued + 1 };
      next.activity = pushActivity(s.activity, {
        key: `q${e.seq}`, seq: e.seq, ts: e.ts, kind: 'queued', requestId: e.request_id, op: e.op, file: e.file,
      });
      break;
    }

    case 'request_started': {
      next.queue = s.queue.filter((q) => q.requestId !== e.request_id);
      next.workers = s.workers.map((w) =>
        w.id === e.worker
          ? { ...w, state: 'PROCESSING', requestId: e.request_id, op: e.op, file: e.file, startedAt: e.ts }
          : w,
      );
      next.activity = pushActivity(s.activity, {
        key: `s${e.seq}`, seq: e.seq, ts: e.ts, kind: 'started', requestId: e.request_id, op: e.op, file: e.file,
        worker: e.worker, ms: e.wait_ms,
      });
      break;
    }

    case 'request_finished': {
      const result: WorkerResult = {
        requestId: e.request_id,
        success: e.success,
        status: e.status,
        processingMs: e.processing_ms,
        op: e.op,
        file: e.file,
        at: Date.now(),
      };

      next.workers = s.workers.map((w) => {
        if (w.id !== e.worker) return w;
        const history = [{ requestId: e.request_id, success: e.success, processingMs: e.processing_ms }, ...w.history];
        if (history.length > WORKER_HISTORY) history.length = WORKER_HISTORY;
        return {
          ...w,
          state: 'IDLE',
          requestId: 0,
          op: null,
          file: null,
          processed: w.processed + 1,
          failed: w.failed + (e.success ? 0 : 1),
          busyMs: w.busyMs + e.processing_ms,
          bytes: w.bytes + e.bytes,
          lastResult: result,
          history,
        };
      });

      const c = s.counters;
      const first = c.completed === 0;
      next.counters = {
        ...c,
        completed: c.completed + 1,
        succeeded: c.succeeded + (e.success ? 1 : 0),
        failed: c.failed + (e.success ? 0 : 1),
        bytesRead: c.bytesRead + (e.success && e.op === 'READ' ? e.bytes : 0),
        bytesWritten: c.bytesWritten + (e.success && e.op === 'WRITE' ? e.bytes : 0),
        totalProcessingMs: c.totalProcessingMs + e.processing_ms,
        totalWaitMs: c.totalWaitMs + e.wait_ms,
        minProcessingMs: first ? e.processing_ms : Math.min(c.minProcessingMs, e.processing_ms),
        maxProcessingMs: Math.max(c.maxProcessingMs, e.processing_ms),
      };

      const key = opKey(e.op);
      if (key) {
        const o = s.byOp[key];
        next.byOp = {
          ...s.byOp,
          [key]: {
            count: o.count + 1,
            failed: o.failed + (e.success ? 0 : 1),
            totalMs: o.totalMs + e.processing_ms,
            bytes: o.bytes + e.bytes,
          },
        };
      }

      next.completionQueueSize = e.completion_queue_size;
      next.completions = mergeCompletions(s.completions, [
        {
          request_id: e.request_id,
          op: e.op,
          file: e.file,
          tag: e.tag,
          worker: e.worker,
          success: e.success,
          status: e.status,
          bytes: e.bytes,
          processing_ms: e.processing_ms,
          wait_ms: e.wait_ms,
          latency_ms: null,
          delivered: null,
          completed_at: e.ts,
          result: e.result,
        },
      ]);

      if (e.success && (e.op === 'WRITE' || e.op === 'CREATE')) next.filesVersion = s.filesVersion + 1;

      next.activity = pushActivity(s.activity, {
        key: `f${e.seq}`, seq: e.seq, ts: e.ts, kind: 'finished', requestId: e.request_id, op: e.op, file: e.file,
        worker: e.worker, success: e.success, status: e.status, ms: e.processing_ms,
      });
      break;
    }

    case 'completion_dispatched': {
      next.completionQueueSize = e.completion_queue_size;
      break;
    }

    case 'completion_delivered': {
      next.counters = {
        ...s.counters,
        delivered: s.counters.delivered + (e.delivered ? 1 : 0),
        undelivered: s.counters.undelivered + (e.delivered ? 0 : 1),
        totalLatencyMs: s.counters.totalLatencyMs + e.latency_ms,
      };
      next.completions = s.completions.map((c) =>
        c.request_id === e.request_id ? { ...c, delivered: e.delivered, latency_ms: e.latency_ms } : c,
      );
      next.activity = pushActivity(s.activity, {
        key: `d${e.seq}`, seq: e.seq, ts: e.ts, kind: 'delivered', requestId: e.request_id,
        success: e.delivered, ms: e.latency_ms,
      });
      break;
    }

    case 'request_rejected': {
      next.counters = { ...s.counters, received: s.counters.received + 1, rejected: s.counters.rejected + 1 };
      next.completions = mergeCompletions(s.completions, [
        {
          request_id: e.request_id,
          op: e.op,
          file: e.file,
          tag: e.tag,
          worker: 0,
          success: false,
          status: e.status,
          bytes: 0,
          processing_ms: 0,
          wait_ms: 0,
          latency_ms: null,
          delivered: true,
          completed_at: e.ts,
          result: e.message,
          rejected: true,
        },
      ]);
      next.activity = pushActivity(s.activity, {
        key: `r${e.seq}`, seq: e.seq, ts: e.ts, kind: 'rejected', requestId: e.request_id, op: e.op, file: e.file,
        success: false, status: e.status,
      });
      break;
    }

    case 'client_connected':
    case 'client_disconnected': {
      next.activeConnections = e.active_connections;
      break;
    }
  }

  return next;
}

/* ------------------------------------------------------------------ */
/* Bridge connection                                                   */
/* ------------------------------------------------------------------ */

let socket: WebSocket | null = null;
let reconnectDelay = 500;
let inbox: BridgeMessage[] = [];
let frameScheduled = false;

/**
 * Messages are applied once per animation frame so a burst of events
 * produces one render instead of hundreds.
 */
function drain() {
  frameScheduled = false;
  if (inbox.length === 0) return;

  const batch = inbox;
  inbox = [];

  let s = state;
  let backendCameOnline = false;

  for (const message of batch) {
    if (message.type === 'status') {
      const wasOnline = s.backend?.online ?? false;
      s = { ...s, backend: message.backend };
      if (message.backend.online && !wasOnline) backendCameOnline = true;
      if (!message.backend.online) {
        // Unknown worker state while offline: show nothing as processing.
        s = { ...s, queue: [], completionQueueSize: 0 };
      }
    } else if (message.type === 'snapshot') {
      s = applySnapshot(s, message.data);
    } else if (message.type === 'event') {
      s = applyEvent(s, message.event);
    }
  }

  if (backendCameOnline) s = { ...s, logsVersion: s.logsVersion + 1, filesVersion: s.filesVersion + 1 };

  commit(s);
}

function enqueueMessage(message: BridgeMessage) {
  inbox.push(message);
  if (!frameScheduled) {
    frameScheduled = true;
    // rAF pauses in background tabs; fall back to a timer there.
    if (document.visibilityState === 'visible') requestAnimationFrame(drain);
    else setTimeout(drain, 100);
  }
}

export function connectBridge() {
  if (socket && socket.readyState <= WebSocket.OPEN) return;

  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${protocol}://${location.host}/ws`);
  socket = ws;

  ws.onopen = () => {
    reconnectDelay = 500;
    commit({ ...state, bridgeConnected: true, bridgeEverConnected: true });
  };

  ws.onmessage = (msg) => {
    try {
      enqueueMessage(JSON.parse(msg.data) as BridgeMessage);
    } catch {
      /* ignore malformed frames */
    }
  };

  ws.onclose = () => {
    if (socket !== ws) return;
    socket = null;
    commit({ ...state, bridgeConnected: false, backend: state.backend ? { ...state.backend, online: false } : null });
    setTimeout(connectBridge, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 5000);
  };
}

/** Merges logs fetched over HTTP with any already received live. */
export function mergeLogs(entries: LogEntry[]) {
  const bySeq = new Map<number, LogEntry>();
  for (const l of state.logs) bySeq.set(l.seq, l);
  for (const l of entries) bySeq.set(l.seq, l);
  const logs = [...bySeq.values()].sort((a, b) => a.seq - b.seq).slice(-MAX_LOGS);
  commit({ ...state, logs });
}

/* ------------------------------------------------------------------ */
/* Derived values                                                      */
/* ------------------------------------------------------------------ */

export const isOnline = (s: AppState) => s.bridgeConnected && !!s.backend?.online;

export function averages(c: Counters) {
  const deliveredTotal = c.delivered + c.undelivered;
  return {
    avgProcessingMs: c.completed ? c.totalProcessingMs / c.completed : 0,
    avgWaitMs: c.completed ? c.totalWaitMs / c.completed : 0,
    avgLatencyMs: deliveredTotal ? c.totalLatencyMs / deliveredTotal : 0,
  };
}
