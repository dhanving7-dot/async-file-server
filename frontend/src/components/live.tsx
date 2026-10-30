import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  ArrowRight,
  Check,
  CircleDashed,
  Clock,
  Cpu,
  FileWarning,
  Inbox,
  Layers,
  PenLine,
  Plus,
  Radio,
  Send,
  Shuffle,
  X,
  Zap,
} from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { cx, formatBytes, formatClock, formatMs } from '../lib/format';
import { type ActivityItem, isOnline, useStore, type WorkerView } from '../lib/store';
import { toast } from '../lib/toast';
import type { FileEntry, Op } from '../lib/types';
import { Button, EmptyState, Modal, OP_COLOR, OpBadge } from './ui';

/* ------------------------------------------------------------------ */
/* Hooks                                                               */
/* ------------------------------------------------------------------ */

export function useNow(active: boolean, interval = 50) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(t);
  }, [active, interval]);
  return now;
}

/** True for `ms` after `at` changes; used to highlight real completions. */
function useRecent(at: number | undefined, ms = 1600) {
  const [recent, setRecent] = useState(false);
  useEffect(() => {
    if (!at) return;
    const remaining = at + ms - Date.now();
    if (remaining <= 0) return;
    setRecent(true);
    const t = setTimeout(() => setRecent(false), remaining);
    return () => clearTimeout(t);
  }, [at, ms]);
  return recent;
}

/* ------------------------------------------------------------------ */
/* Worker card                                                         */
/* ------------------------------------------------------------------ */

export function WorkerCard({ worker, compact = false }: { worker: WorkerView; compact?: boolean }) {
  const online = useStore(isOnline);
  const processing = online && worker.state === 'PROCESSING';
  const now = useNow(processing);
  const recent = useRecent(worker.lastResult?.at);
  const last = worker.lastResult;

  const ring = !online
    ? 'border-white/[0.06]'
    : processing
      ? 'border-amber-400/35 shadow-[0_0_0_1px_rgba(251,191,36,0.15),0_0_40px_-12px_rgba(251,191,36,0.45)]'
      : recent && last
        ? last.success
          ? 'border-emerald-400/35 shadow-[0_0_40px_-14px_rgba(52,211,153,0.55)]'
          : 'border-rose-400/35 shadow-[0_0_40px_-14px_rgba(244,63,94,0.55)]'
        : 'border-white/[0.07]';

  const state = !online ? 'OFFLINE' : worker.state;

  return (
    <motion.div
      className={cx(
        'surface relative overflow-hidden !border transition-[border-color,box-shadow] duration-500',
        ring,
        compact ? 'p-4' : 'p-5',
      )}
    >
      {processing && (
        <div className="absolute inset-x-0 top-0 h-[2px] overflow-hidden bg-amber-400/10">
          <div className="h-full w-1/3 animate-scan bg-gradient-to-r from-transparent via-amber-300 to-transparent" />
        </div>
      )}

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div
            className={cx(
              'grid h-8 w-8 place-items-center rounded-[10px] border transition-colors duration-500',
              processing ? 'border-amber-400/30 bg-amber-400/10 text-amber-200' : 'border-white/[0.08] bg-white/[0.03] text-zinc-400',
            )}
          >
            <Cpu className="h-4 w-4" />
          </div>
          <div>
            <div className="text-[13px] font-medium text-zinc-100">Worker {worker.id}</div>
            <div className="font-mono text-[10.5px] text-zinc-500">pthread · worker_function</div>
          </div>
        </div>

        <motion.span
          key={state}
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          className={cx(
            'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[10.5px] font-medium',
            state === 'PROCESSING' && 'border-amber-400/30 bg-amber-400/10 text-amber-200',
            state === 'IDLE' && 'border-white/[0.08] bg-white/[0.03] text-zinc-400',
            state === 'OFFLINE' && 'border-rose-400/20 bg-rose-400/[0.06] text-rose-300/80',
          )}
        >
          <span
            className={cx(
              'h-1.5 w-1.5 rounded-full',
              state === 'PROCESSING' ? 'animate-pulse-soft bg-amber-300' : state === 'IDLE' ? 'bg-zinc-500' : 'bg-rose-400',
            )}
          />
          {state}
        </motion.span>
      </div>

      <div className={cx('relative', compact ? 'mt-3 h-[52px]' : 'mt-4 h-[64px]')}>
        <AnimatePresence initial={false}>
          {processing ? (
            <motion.div
              key={`p${worker.requestId}`}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, transition: { duration: 0.05 } }}
              transition={{ duration: 0.18 }}
              className="absolute inset-0"
            >
              <div className="flex items-center gap-2">
                <span className="font-mono text-[12px] text-zinc-300">#{worker.requestId}</span>
                <OpBadge op={worker.op} />
                <span className="ml-auto font-mono text-[11px] tabular-nums text-amber-200">
                  {formatMs(Math.max(0, now - worker.startedAt))}
                </span>
              </div>
              <div className="mt-1.5 truncate font-mono text-[12px] text-zinc-400">files/{worker.file}</div>
            </motion.div>
          ) : (
            <motion.div
              key={`i${last?.requestId ?? 0}`}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, transition: { duration: 0.05 } }}
              transition={{ duration: 0.18 }}
              className="absolute inset-0"
            >
              {last ? (
                <>
                  <div className="flex items-center gap-2 text-[12px]">
                    <span
                      className={cx(
                        'grid h-4 w-4 place-items-center rounded-full',
                        last.success ? 'bg-emerald-400/15 text-emerald-300' : 'bg-rose-400/15 text-rose-300',
                      )}
                    >
                      {last.success ? <Check className="h-2.5 w-2.5" strokeWidth={3} /> : <X className="h-2.5 w-2.5" strokeWidth={3} />}
                    </span>
                    <span className="text-zinc-400">Last</span>
                    <span className="font-mono text-zinc-300">#{last.requestId}</span>
                    <OpBadge op={last.op} />
                    <span className="ml-auto font-mono text-[11px] text-zinc-400">{formatMs(last.processingMs)}</span>
                  </div>
                  <div className="mt-1.5 truncate font-mono text-[11.5px] text-zinc-500">
                    {last.success ? `files/${last.file}` : `${last.status} · files/${last.file}`}
                  </div>
                </>
              ) : (
                <div className="flex h-full items-center gap-2 text-[12px] text-zinc-500">
                  <CircleDashed className="h-3.5 w-3.5" />
                  {online ? 'Blocked in dequeue() waiting for work' : 'State unknown while offline'}
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {!compact && (
        <>
          <div className="mt-4 flex h-5 items-end gap-[3px]" title="Most recent requests handled by this worker (height = processing time)">
            {Array.from({ length: 28 }).map((_, i) => {
              const h = worker.history[27 - i];
              const max = Math.max(...worker.history.map((x) => x.processingMs), 0.001);
              const height = h ? 20 + 80 * (h.processingMs / max) : 12;
              return (
                <motion.div
                  key={i}
                  className={cx(
                    'flex-1 rounded-[2px]',
                    !h ? 'bg-white/[0.04]' : h.success ? 'bg-emerald-400/50' : 'bg-rose-400/60',
                  )}
                  style={{ height: `${height}%` }}
                />
              );
            })}
          </div>

          <div className="mt-4 grid grid-cols-3 gap-3 border-t border-white/[0.05] pt-3.5 text-[11px]">
            <Stat label="Processed" value={worker.processed.toLocaleString()} />
            <Stat label="Failed" value={worker.failed.toLocaleString()} tone={worker.failed ? 'bad' : undefined} />
            <Stat label="Busy time" value={formatMs(worker.busyMs)} />
          </div>

          <div className="mt-3">
            <div className="mb-1 flex justify-between text-[10.5px] text-zinc-500">
              <span>Utilization since start</span>
              <span className="font-mono">{(worker.utilization * 100).toFixed(3)}%</span>
            </div>
            <div className="h-1 overflow-hidden rounded-full bg-white/[0.05]">
              <motion.div
                className="h-full rounded-full bg-gradient-to-r from-indigo-400 to-cyan-300"
                animate={{ width: `${Math.min(100, Math.max(worker.utilization * 100, worker.utilization > 0 ? 1 : 0))}%` }}
                transition={{ type: 'spring', stiffness: 80, damping: 20 }}
              />
            </div>
          </div>
        </>
      )}
    </motion.div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'bad' }) {
  return (
    <div>
      <div className="text-zinc-500">{label}</div>
      <div className={cx('mt-0.5 font-mono text-[12px] tabular-nums', tone === 'bad' ? 'text-rose-300' : 'text-zinc-200')}>{value}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Pipeline                                                            */
/* ------------------------------------------------------------------ */

function Chip({ id, op, file, tone, subtitle }: { id: number; op: Op; file: string; tone?: 'ok' | 'bad'; subtitle?: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, x: -14, scale: 0.96 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      transition={{ type: 'spring', stiffness: 420, damping: 34 }}
      className={cx(
        'flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[11.5px] backdrop-blur',
        tone === 'ok' && 'border-emerald-400/20 bg-emerald-400/[0.06]',
        tone === 'bad' && 'border-rose-400/25 bg-rose-400/[0.07]',
        !tone && 'border-white/[0.09] bg-white/[0.04]',
      )}
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: OP_COLOR[op] }} />
      <span className="font-mono text-zinc-300">#{id}</span>
      <span className="truncate font-mono text-zinc-500">{file}</span>
      {subtitle && <span className="ml-auto shrink-0 font-mono text-[10.5px] text-zinc-500">{subtitle}</span>}
    </motion.div>
  );
}

function Lane({ title, icon, count, children, accent }: { title: string; icon: ReactNode; count: number; children: ReactNode; accent: string }) {
  return (
    <div className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-white/[0.06] bg-black/20 p-3">
      <div className="mb-2.5 flex items-center gap-2 px-0.5">
        <span className={cx('grid h-5 w-5 place-items-center rounded-md', accent)}>{icon}</span>
        <span className="text-[11.5px] font-medium text-zinc-300">{title}</span>
        <span className="ml-auto rounded-md bg-white/[0.05] px-1.5 font-mono text-[10.5px] text-zinc-400">{count}</span>
      </div>
      <div className="flex flex-1 flex-col gap-1.5">{children}</div>
    </div>
  );
}

export function Pipeline({ maxQueue = 8, maxDone = 7 }: { maxQueue?: number; maxDone?: number }) {
  const queue = useStore((s) => s.queue);
  const workers = useStore((s) => s.workers);
  const completions = useStore((s) => s.completions);
  const completionQueueSize = useStore((s) => s.completionQueueSize);
  const online = useStore(isOnline);

  const done = completions.slice(0, maxDone);
  const busy = workers.filter((w) => w.state === 'PROCESSING');

  return (
    <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto_minmax(0,1fr)]">
        <Lane title="Request queue" icon={<Inbox className="h-3 w-3" />} count={queue.length} accent="bg-sky-400/15 text-sky-300">
            {queue.slice(0, maxQueue).map((q) => (
              <Chip key={q.requestId} id={q.requestId} op={q.op} file={q.file} />
            ))}
          {queue.length > maxQueue && (
            <div className="px-1 font-mono text-[10.5px] text-zinc-500">+{queue.length - maxQueue} more waiting</div>
          )}
          {queue.length === 0 && <LaneEmpty text={online ? 'Empty — workers are keeping up' : 'Offline'} />}
        </Lane>

        <Arrow />

        <Lane title="Worker threads" icon={<Cpu className="h-3 w-3" />} count={busy.length} accent="bg-amber-400/15 text-amber-300">
          {workers.map((w) => (
            <div
              key={w.id}
              className={cx(
                'flex min-h-[34px] items-center gap-2 rounded-lg border border-dashed px-2 py-1',
                online && w.state === 'PROCESSING' ? 'border-amber-400/30' : 'border-white/[0.07]',
              )}
            >
              <span className="w-6 shrink-0 font-mono text-[10.5px] text-zinc-500">W{w.id}</span>
              <div className="min-w-0 flex-1">
                  {online && w.state === 'PROCESSING' && w.op && (
                    <Chip key={w.requestId} id={w.requestId} op={w.op} file={w.file ?? ''} />
                  )}
                {!(online && w.state === 'PROCESSING') && <span className="font-mono text-[10.5px] text-zinc-600">idle</span>}
              </div>
            </div>
          ))}
          {workers.length === 0 && <LaneEmpty text="Waiting for snapshot" />}
        </Lane>

        <Arrow />

        <Lane
          title="Completed"
          icon={<Send className="h-3 w-3" />}
          count={completionQueueSize}
          accent="bg-emerald-400/15 text-emerald-300"
        >
            {done.map((c) => (
              <Chip
                key={c.request_id}
                id={c.request_id}
                op={c.op}
                file={c.file}
                tone={c.success ? 'ok' : 'bad'}
                subtitle={c.rejected ? 'rejected' : formatMs(c.processing_ms)}
              />
            ))}
          {done.length === 0 && <LaneEmpty text="No completions yet" />}
        </Lane>
    </div>
  );
}

function Arrow() {
  return (
    <div className="hidden items-center justify-center md:flex">
      <div className="relative h-px w-6 overflow-hidden bg-white/10">
        <div className="absolute inset-y-0 w-3 animate-scan bg-gradient-to-r from-transparent via-indigo-300/80 to-transparent" />
      </div>
      <ArrowRight className="-ml-1 h-3 w-3 text-zinc-600" />
    </div>
  );
}

function LaneEmpty({ text }: { text: string }) {
  return <div className="flex flex-1 items-center justify-center py-4 text-[11px] text-zinc-600">{text}</div>;
}

/* ------------------------------------------------------------------ */
/* Activity feed                                                       */
/* ------------------------------------------------------------------ */

const ACTIVITY_META: Record<ActivityItem['kind'], { label: string; icon: typeof Inbox; color: string }> = {
  queued: { label: 'Queued', icon: Inbox, color: 'text-sky-300 bg-sky-400/10' },
  started: { label: 'Started', icon: Cpu, color: 'text-amber-300 bg-amber-400/10' },
  finished: { label: 'Finished', icon: Check, color: 'text-emerald-300 bg-emerald-400/10' },
  delivered: { label: 'Delivered', icon: Send, color: 'text-indigo-300 bg-indigo-400/10' },
  rejected: { label: 'Rejected', icon: X, color: 'text-rose-300 bg-rose-400/10' },
};

export function ActivityFeed({ limit = 14 }: { limit?: number }) {
  const activity = useStore((s) => s.activity);
  const items = activity.slice(0, limit);

  if (items.length === 0) {
    return <EmptyState icon={<Radio className="h-5 w-5" />} title="Listening for server events" hint="Events from the C server's SUBSCRIBE stream appear here as they happen." />;
  }

  return (
    <div className="space-y-0.5 px-2 pb-3">
      <AnimatePresence initial={false}>
        {items.map((a) => {
          const meta = ACTIVITY_META[a.kind];
          const failed = a.kind === 'finished' && a.success === false;
          const Icon = failed ? X : meta.icon;
          return (
            <motion.div
              key={a.key}
              layout
              initial={{ opacity: 0, x: -10, height: 0 }}
              animate={{ opacity: 1, x: 0, height: 'auto' }}
              exit={{ opacity: 0 }}
              transition={{ type: 'spring', stiffness: 400, damping: 34 }}
              className="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[12px] hover:bg-white/[0.025]"
            >
              <span className={cx('grid h-5 w-5 shrink-0 place-items-center rounded-md', failed ? 'bg-rose-400/10 text-rose-300' : meta.color)}>
                <Icon className="h-3 w-3" />
              </span>
              <span className="w-[64px] shrink-0 text-zinc-400">{failed ? 'Failed' : meta.label}</span>
              <span className="shrink-0 font-mono text-zinc-300">#{a.requestId}</span>
              {a.op && <OpBadge op={a.op} className="shrink-0" />}
              <span className="min-w-0 truncate font-mono text-[11px] text-zinc-500">
                {a.kind === 'started' && `worker ${a.worker} · waited ${formatMs(a.ms)}`}
                {a.kind === 'finished' && `worker ${a.worker} · ${a.success ? formatMs(a.ms) : a.status}`}
                {a.kind === 'delivered' && (a.success ? `round trip ${formatMs(a.ms)}` : 'client gone')}
                {(a.kind === 'queued' || a.kind === 'rejected') && (a.file || a.status)}
              </span>
              <span className="ml-auto shrink-0 font-mono text-[10.5px] text-zinc-600">{formatClock(a.ts, true)}</span>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Workload modal                                                      */
/* ------------------------------------------------------------------ */

type Preset = 'read' | 'write' | 'mixed' | 'create' | 'fault';

const PRESETS: { id: Preset; label: string; hint: string; icon: typeof Zap }[] = [
  { id: 'read', label: 'Read burst', hint: 'N × READ of one file', icon: Layers },
  { id: 'write', label: 'Write burst', hint: 'N × WRITE to load_N.txt', icon: PenLine },
  { id: 'mixed', label: 'Mixed', hint: 'Alternating READ / WRITE', icon: Shuffle },
  { id: 'create', label: 'Create files', hint: 'N × CREATE new files', icon: Plus },
  { id: 'fault', label: 'Fault injection', hint: 'READ files that do not exist', icon: FileWarning },
];

export function WorkloadModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const online = useStore(isOnline);
  const [preset, setPreset] = useState<Preset>('read');
  const [count, setCount] = useState(16);
  const [file, setFile] = useState('large.txt');
  const [content, setContent] = useState('Written by the Async FS console.');
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    api
      .files()
      .then((l) => {
        const list = l.files.filter((f) => f.accessible).sort((a, b) => a.name.localeCompare(b.name));
        setFiles(list);
        if (list.length && !list.some((f) => f.name === file)) setFile(list[0].name);
      })
      .catch(() => setFiles([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const requests = useMemo(() => {
    const stamp = Date.now().toString(36);
    return Array.from({ length: count }, (_, i) => {
      switch (preset) {
        case 'read':
          return { op: 'READ' as Op, file };
        case 'write':
          return { op: 'WRITE' as Op, file: `load_${i + 1}.txt`, content: `${content}\nrequest ${i + 1} of ${count}\n` };
        case 'mixed':
          return i % 2 === 0
            ? { op: 'READ' as Op, file }
            : { op: 'WRITE' as Op, file: `load_${i + 1}.txt`, content: `${content}\nrequest ${i + 1} of ${count}\n` };
        case 'create':
          return { op: 'CREATE' as Op, file: `new_${stamp}_${i + 1}.txt` };
        case 'fault':
          return { op: 'READ' as Op, file: `missing_${stamp}_${i + 1}.txt` };
      }
    });
  }, [preset, count, file, content]);

  async function submit() {
    setBusy(true);
    try {
      const result = await api.batch(requests);
      const ids = result.results.map((r) => r.requestId).filter(Boolean);
      const range = ids.length ? `request IDs #${Math.min(...ids)}–#${Math.max(...ids)}` : '';
      const failed = result.submitted - result.succeeded;
      toast(
        failed === 0 ? 'success' : preset === 'fault' ? 'info' : 'error',
        `${result.succeeded}/${result.submitted} requests succeeded`,
        `${range}${failed ? ` · ${failed} returned an error status from the server` : ''}`,
      );
      onClose();
    } catch (err) {
      toast('error', 'Batch failed', err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const needsFile = preset === 'read' || preset === 'mixed';
  const needsContent = preset === 'write' || preset === 'mixed';

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Submit requests to the C server"
      subtitle="Requests are pipelined on one TCP connection without waiting — the four workers pick them up concurrently."
      width="max-w-xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={busy} disabled={!online} icon={<Send className="h-3.5 w-3.5" />}>
            Send {count} request{count === 1 ? '' : 's'}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {PRESETS.map((p) => {
          const Icon = p.icon;
          const active = p.id === preset;
          return (
            <button
              key={p.id}
              onClick={() => setPreset(p.id)}
              className={cx(
                'relative rounded-xl border p-3 text-left transition-colors',
                active ? 'border-indigo-400/40 bg-indigo-400/[0.08]' : 'border-white/[0.07] bg-white/[0.02] hover:border-white/[0.14]',
              )}
            >
              <Icon className={cx('h-4 w-4', active ? 'text-indigo-300' : 'text-zinc-500')} />
              <div className="mt-2 text-[12.5px] font-medium text-zinc-100">{p.label}</div>
              <div className="text-[11px] text-zinc-500">{p.hint}</div>
            </button>
          );
        })}
      </div>

      <div className="mt-5 space-y-4">
        <div>
          <div className="mb-1.5 flex justify-between text-[12px]">
            <span className="text-zinc-400">Number of requests</span>
            <span className="font-mono text-zinc-200">{count}</span>
          </div>
          <input
            type="range"
            min={1}
            max={64}
            value={count}
            onChange={(e) => setCount(Number(e.target.value))}
            className="w-full accent-indigo-400"
          />
        </div>

        {needsFile && (
          <label className="block">
            <span className="mb-1.5 block text-[12px] text-zinc-400">File to READ</span>
            <select value={file} onChange={(e) => setFile(e.target.value)} className="input font-mono">
              {files.map((f) => (
                <option key={f.name} value={f.name} className="bg-ink-850">
                  {f.name} ({formatBytes(f.size)})
                </option>
              ))}
            </select>
          </label>
        )}

        {needsContent && (
          <label className="block">
            <span className="mb-1.5 block text-[12px] text-zinc-400">WRITE content</span>
            <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={2} className="input resize-none font-mono" />
          </label>
        )}

        <div className="flex items-center gap-2 rounded-lg border border-white/[0.06] bg-black/20 px-3 py-2 font-mono text-[11px] text-zinc-500">
          <Clock className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">
            {requests[0] ? `@tag ${requests[0].op === 'WRITE' ? 'WRITEB' : requests[0].op} ${requests[0].file}${requests[0].op === 'WRITE' ? ' <len>' : ''}` : ''}
            {count > 1 ? `  … ×${count}` : ''}
          </span>
        </div>
      </div>
    </Modal>
  );
}
