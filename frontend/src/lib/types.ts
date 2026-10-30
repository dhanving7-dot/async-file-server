/* Shapes produced by the C server (STATS / LIST / LOGS / SUBSCRIBE). */

export type Op = 'READ' | 'WRITE' | 'CREATE' | 'UNKNOWN';

export interface ServerInfo {
  name: string;
  version: string;
  pid: number;
  port: number;
  num_workers: number;
  io_delay_ms: number;
  started_at: number;
  now: number;
  uptime_ms: number;
  active_connections: number;
  total_connections: number;
  files_dir: string;
}

export interface QueuedRequest {
  request_id: number;
  op: Op;
  position: number;
  bytes: number;
  wait_ms: number;
  status: 'QUEUED';
  file: string;
  tag: string;
}

export interface PendingCompletion {
  request_id: number;
  op: Op;
  position: number;
  success: boolean;
  status: string;
  file: string;
}

export interface WorkerSnapshot {
  id: number;
  state: 'IDLE' | 'PROCESSING';
  request_id: number;
  op: Op | null;
  started_at: number;
  elapsed_ms: number;
  processed: number;
  failed: number;
  busy_ms: number;
  bytes: number;
  utilization: number;
  last_request_id: number;
  file: string | null;
  tag: string;
}

export interface Totals {
  received: number;
  queued: number;
  completed: number;
  succeeded: number;
  failed: number;
  rejected: number;
  delivered: number;
  undelivered: number;
  bytes_processed: number;
  bytes_read: number;
  bytes_written: number;
  avg_processing_ms: number;
  min_processing_ms: number;
  max_processing_ms: number;
  avg_wait_ms: number;
  avg_latency_ms: number;
  total_processing_ms: number;
}

export interface OpStats {
  count: number;
  failed: number;
  avg_ms: number;
  bytes: number;
}

export interface TimelinePoint {
  t: number;
  completed: number;
  failed: number;
  read: number;
  write: number;
  create: number;
  bytes: number;
  processing_ms: number;
  busy_ms: number;
}

export interface CompletionRecord {
  request_id: number;
  op: Op;
  file: string;
  tag: string;
  worker: number;
  success: boolean;
  status: string;
  bytes: number;
  processing_ms: number;
  wait_ms: number;
  latency_ms: number | null;
  delivered: boolean | null;
  completed_at: number;
  result: string;
  rejected?: boolean;
}

export interface Snapshot {
  server: ServerInfo;
  event_seq: number;
  queues: {
    request_queue_size: number;
    request_queue: QueuedRequest[];
    completion_queue_size: number;
    completion_queue: PendingCompletion[];
  };
  workers: WorkerSnapshot[];
  totals: Totals;
  by_op: Record<'READ' | 'WRITE' | 'CREATE', OpStats>;
  timeline: TimelinePoint[];
  recent_completions: CompletionRecord[];
}

export interface FileEntry {
  name: string;
  size: number;
  modified: number;
  accessible: boolean;
}

export interface FileListing {
  files_dir: string;
  files: FileEntry[];
  count: number;
  total_bytes: number;
}

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export interface LogEntry {
  seq: number;
  ts: number;
  level: LogLevel;
  request_id: number;
  message: string;
}

/* Live events (EVENT frames forwarded by the bridge). */

interface EventBase {
  seq: number;
  ts: number;
}

export type ServerEvent =
  | (EventBase & {
      type: 'request_queued';
      request_id: number;
      op: Op;
      file: string;
      tag: string;
      conn: number;
      bytes: number;
      queue_size: number;
      position: number;
    })
  | (EventBase & {
      type: 'request_started';
      request_id: number;
      op: Op;
      file: string;
      tag: string;
      worker: number;
      queue_size: number;
      wait_ms: number;
    })
  | (EventBase & {
      type: 'request_finished';
      request_id: number;
      op: Op;
      file: string;
      tag: string;
      worker: number;
      success: boolean;
      status: string;
      bytes: number;
      processing_ms: number;
      wait_ms: number;
      completion_queue_size: number;
      result: string;
    })
  | (EventBase & { type: 'completion_dispatched'; request_id: number; completion_queue_size: number })
  | (EventBase & { type: 'completion_delivered'; request_id: number; delivered: boolean; latency_ms: number })
  | (EventBase & {
      type: 'request_rejected';
      request_id: number;
      op: Op;
      file: string;
      tag: string;
      status: string;
      message: string;
    })
  | (EventBase & { type: 'client_connected' | 'client_disconnected'; conn: number; peer: string; active_connections: number })
  | (EventBase & { type: 'log'; log: LogEntry })
  | (EventBase & { type: 'resync'; missed_from: number });

export interface BackendStatus {
  online: boolean;
  host: string;
  port: number;
  onlineSince: number | null;
  lastError: string | null;
  pendingRequests: number;
  lastEventSeq: number;
}

export type BridgeMessage =
  | { type: 'status'; bridge: { ok: boolean; startedAt: number; uptimeMs: number }; backend: BackendStatus }
  | { type: 'snapshot'; data: Snapshot }
  | { type: 'event'; event: ServerEvent };

/* Bridge HTTP API results. */

export interface OperationResult {
  ok: boolean;
  op: Op;
  file: string;
  requestId: number;
  status: string;
  bytes: number;
  roundTripMs: number;
  message?: string;
  content?: string;
  encoding?: 'utf8' | 'base64';
  code?: string;
  error?: string;
}

export interface BatchResult {
  ok: boolean;
  submitted: number;
  succeeded: number;
  results: OperationResult[];
}
