import { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { CheckCircle2, Search, Send } from 'lucide-react';
import { AnimatedNumber, Card, CardHeader, EmptyState, OpBadge, PageHeader, StatusBadge } from '../components/ui';
import { cx, formatBytes, formatClock, formatMs } from '../lib/format';
import { useStore } from '../lib/store';

type Filter = 'all' | 'ok' | 'failed';

export default function Completions() {
  const completions = useStore((s) => s.completions);
  const queueSize = useStore((s) => s.completionQueueSize);
  const counters = useStore((s) => s.counters);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return completions
      .filter((c) => (filter === 'ok' ? c.success : filter === 'failed' ? !c.success : true))
      .filter((c) => !q || c.file.toLowerCase().includes(q) || String(c.request_id) === q.replace('#', '') || c.status.toLowerCase().includes(q))
      .slice(0, 200);
  }, [completions, filter, query]);

  return (
    <div>
      <PageHeader
        title="Completion queue"
        description="Every Completion the workers pushed onto the CompletionQueue, with the result, the performance module's measured processing time and whether the completion thread delivered it to the client."
      />

      <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Mini label="In completion queue now" value={queueSize} />
        <Mini label="Delivered to clients" value={counters.delivered} />
        <Mini label="Client gone before delivery" value={counters.undelivered} tone={counters.undelivered ? 'bad' : undefined} />
        <Mini label="Error responses" value={counters.failed + counters.rejected} tone={counters.failed + counters.rejected ? 'bad' : undefined} />
      </div>

      <Card className="overflow-hidden" interactive={false}>
        <CardHeader
          title="Completed operations"
          subtitle={`${completions.length} most recent · newest first`}
          icon={<CheckCircle2 className="h-3.5 w-3.5" />}
          right={
            <div className="flex items-center gap-2">
              <div className="relative">
                <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="file, #id or status"
                  className="input !w-44 !py-1.5 !pl-8 !text-[12px]"
                />
              </div>
              <div className="flex rounded-lg border border-white/[0.07] bg-white/[0.02] p-0.5">
                {(['all', 'ok', 'failed'] as Filter[]).map((f) => (
                  <button
                    key={f}
                    onClick={() => setFilter(f)}
                    className={cx(
                      'relative rounded-md px-2.5 py-1 text-[11.5px] capitalize',
                      filter === f ? 'text-zinc-100' : 'text-zinc-500 hover:text-zinc-300',
                    )}
                  >
                    {filter === f && <motion.span layoutId="cfilter" className="absolute inset-0 rounded-md bg-white/[0.08]" />}
                    <span className="relative">{f}</span>
                  </button>
                ))}
              </div>
            </div>
          }
        />

        {rows.length === 0 ? (
          <EmptyState icon={<Send className="h-5 w-5" />} title="No completions yet" hint="Read or write a file, or submit a burst of requests to see completions arrive." />
        ) : (
          <div className="max-h-[calc(100vh-330px)] overflow-auto">
            <table className="w-full min-w-[980px] text-left text-[12.5px]">
              <thead className="sticky top-0 z-10 bg-ink-850/95 backdrop-blur">
                <tr className="table-row text-[11px] uppercase tracking-wide text-zinc-500">
                  <th className="px-5 py-2.5 font-medium">Request</th>
                  <th className="px-3 py-2.5 font-medium">Op</th>
                  <th className="px-3 py-2.5 font-medium">File</th>
                  <th className="px-3 py-2.5 font-medium">Worker</th>
                  <th className="px-3 py-2.5 font-medium">Response status</th>
                  <th className="px-3 py-2.5 font-medium">Result</th>
                  <th className="px-3 py-2.5 text-right font-medium">Processing</th>
                  <th className="px-3 py-2.5 text-right font-medium">Queue wait</th>
                  <th className="px-3 py-2.5 text-right font-medium">End-to-end</th>
                  <th className="px-3 py-2.5 font-medium">Delivery</th>
                  <th className="px-5 py-2.5 text-right font-medium">Completed</th>
                </tr>
              </thead>
              <tbody>
                <AnimatePresence initial={false}>
                  {rows.map((c) => (
                    <motion.tr
                      key={c.request_id}
                      initial={{ opacity: 0, backgroundColor: c.success ? 'rgba(52,211,153,0.10)' : 'rgba(244,63,94,0.12)' }}
                      animate={{ opacity: 1, backgroundColor: 'rgba(0,0,0,0)' }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.9 }}
                      className="table-row hover:bg-white/[0.02]"
                    >
                      <td className="px-5 py-2.5 font-mono text-zinc-200">#{c.request_id}</td>
                      <td className="px-3 py-2.5"><OpBadge op={c.op} /></td>
                      <td className="max-w-[160px] truncate px-3 py-2.5 font-mono text-zinc-300">{c.file || '—'}</td>
                      <td className="px-3 py-2.5 font-mono text-zinc-400">{c.worker ? `W${c.worker}` : '—'}</td>
                      <td className="px-3 py-2.5"><StatusBadge status={c.status} rejected={c.rejected} /></td>
                      <td className="max-w-[260px] px-3 py-2.5">
                        <span className="block truncate font-mono text-[11.5px] text-zinc-500" title={c.result}>
                          {c.op === 'READ' && c.success ? `${formatBytes(c.bytes)} · “${c.result.replace(/\s+/g, ' ')}”` : c.result}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono text-zinc-300">{c.rejected ? '—' : formatMs(c.processing_ms)}</td>
                      <td className="px-3 py-2.5 text-right font-mono text-zinc-500">{c.rejected ? '—' : formatMs(c.wait_ms)}</td>
                      <td className="px-3 py-2.5 text-right font-mono text-zinc-400">{formatMs(c.latency_ms)}</td>
                      <td className="px-3 py-2.5">
                        {c.delivered === null ? (
                          <span className="font-mono text-[11px] text-amber-300">sending…</span>
                        ) : c.delivered ? (
                          <span className="font-mono text-[11px] text-emerald-300">delivered</span>
                        ) : (
                          <span className="font-mono text-[11px] text-rose-300">client gone</span>
                        )}
                      </td>
                      <td className="px-5 py-2.5 text-right font-mono text-[11px] text-zinc-500">{formatClock(c.completed_at, true)}</td>
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

function Mini({ label, value, tone }: { label: string; value: number; tone?: 'bad' }) {
  return (
    <Card className="p-4">
      <div className="text-[11.5px] text-zinc-500">{label}</div>
      <div className={cx('mt-1.5 text-[22px] font-semibold tracking-tight', tone === 'bad' ? 'text-rose-200' : 'text-zinc-50')}>
        <AnimatedNumber value={value} />
      </div>
    </Card>
  );
}
