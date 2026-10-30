import { AnimatePresence, motion } from 'framer-motion';
import { Inbox, Workflow } from 'lucide-react';
import { Pipeline, useNow } from '../components/live';
import { Card, CardHeader, EmptyState, OpBadge, PageHeader } from '../components/ui';
import { formatBytes, formatClock, formatMs } from '../lib/format';
import { isOnline, useStore } from '../lib/store';

export default function Queue() {
  const queue = useStore((s) => s.queue);
  const workers = useStore((s) => s.workers);
  const online = useStore(isOnline);
  const inFlight = online ? workers.filter((w) => w.state === 'PROCESSING') : [];
  const now = useNow(queue.length > 0 || inFlight.length > 0, 100);

  const rows = [
    ...inFlight.map((w) => ({
      requestId: w.requestId,
      op: w.op!,
      file: w.file ?? '',
      position: 0,
      status: `PROCESSING · W${w.id}`,
      since: w.startedAt,
      bytes: 0,
    })),
    ...queue.map((q, i) => ({
      requestId: q.requestId,
      op: q.op,
      file: q.file,
      position: i + 1,
      status: 'QUEUED',
      since: q.queuedAt,
      bytes: q.bytes,
    })),
  ];

  return (
    <div>
      <PageHeader
        title="Request queue"
        description="Contents of the server's RequestQueue, in FIFO order. Requests enter when a connection thread calls enqueue() and leave when a worker's dequeue() takes them."
      />

      <Card>
        <CardHeader
          title="Processing pipeline"
          subtitle="Chips move between lanes as the server reports each transition"
          icon={<Workflow className="h-3.5 w-3.5" />}
        />
        <div className="px-5 pb-5">
          <Pipeline maxQueue={12} maxDone={10} />
        </div>
      </Card>

      <Card className="mt-3 overflow-hidden" interactive={false}>
        <CardHeader
          title="Queued and in-flight requests"
          subtitle={`${queue.length} waiting · ${inFlight.length} being processed`}
          icon={<Inbox className="h-3.5 w-3.5" />}
        />
        {rows.length === 0 ? (
          <EmptyState
            icon={<Inbox className="h-5 w-5" />}
            title={online ? 'The request queue is empty' : 'Backend offline'}
            hint={
              online
                ? 'Small file operations complete in microseconds, so the queue usually drains instantly. Submit a burst (top right) — or start the server with --io-delay-ms to watch requests wait.'
                : 'Queue contents are unknown until the C server is reachable again.'
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[12.5px]">
              <thead>
                <tr className="table-row text-[11px] uppercase tracking-wide text-zinc-500">
                  <th className="px-5 py-2.5 font-medium">Position</th>
                  <th className="px-3 py-2.5 font-medium">Request ID</th>
                  <th className="px-3 py-2.5 font-medium">Operation</th>
                  <th className="px-3 py-2.5 font-medium">Filename</th>
                  <th className="px-3 py-2.5 font-medium">Payload</th>
                  <th className="px-3 py-2.5 font-medium">Status</th>
                  <th className="px-5 py-2.5 text-right font-medium">Time in state</th>
                </tr>
              </thead>
              <tbody>
                <AnimatePresence initial={false}>
                  {rows.map((r) => (
                    <motion.tr
                      key={r.requestId}
                      initial={{ opacity: 0, backgroundColor: 'rgba(129,140,248,0.12)' }}
                      animate={{ opacity: 1, backgroundColor: 'rgba(0,0,0,0)' }}
                      exit={{ opacity: 0, transition: { duration: 0.1 } }}
                      transition={{ duration: 0.5 }}
                      className="table-row"
                    >
                      <td className="px-5 py-2.5 font-mono text-zinc-400">{r.position ? `#${r.position}` : '—'}</td>
                      <td className="px-3 py-2.5 font-mono text-zinc-200">{r.requestId}</td>
                      <td className="px-3 py-2.5"><OpBadge op={r.op} /></td>
                      <td className="px-3 py-2.5 font-mono text-zinc-300">{r.file}</td>
                      <td className="px-3 py-2.5 font-mono text-zinc-500">{r.bytes ? formatBytes(r.bytes) : '—'}</td>
                      <td className="px-3 py-2.5">
                        <span
                          className={
                            r.position
                              ? 'rounded-md bg-sky-400/10 px-1.5 py-0.5 font-mono text-[10.5px] text-sky-300'
                              : 'rounded-md bg-amber-400/10 px-1.5 py-0.5 font-mono text-[10.5px] text-amber-300'
                          }
                        >
                          {r.status}
                        </span>
                      </td>
                      <td className="px-5 py-2.5 text-right font-mono text-zinc-400" title={formatClock(r.since, true)}>
                        {formatMs(Math.max(0, now - r.since))}
                      </td>
                    </motion.tr>
                  ))}
                </AnimatePresence>
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
