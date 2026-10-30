import { type ReactNode, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { Activity, BarChart3, Cpu, Gauge, PieChart as PieIcon, Timer } from 'lucide-react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from 'recharts';
import { AnimatedNumber, Card, CardHeader, EmptyState, PageHeader, Skeleton } from '../components/ui';
import { cx, formatBytes, formatClock, formatMs } from '../lib/format';
import { averages, useStore } from '../lib/store';

const AXIS = { fill: '#52525b', fontSize: 10.5 };
const GRID = 'rgba(255,255,255,0.045)';

/* eslint-disable @typescript-eslint/no-explicit-any */
export function ChartTooltip({
  active,
  payload,
  label,
  unit,
  formatter,
}: {
  active?: boolean;
  payload?: any[];
  label?: any;
  unit?: string;
  formatter?: (v: number) => string;
}) {
  if (!active || !payload?.length) return null;
  const title = typeof label === 'number' && label > 1e12 ? formatClock(label) : label;
  return (
    <div className="rounded-lg border border-white/[0.1] bg-ink-800/95 px-3 py-2 text-[11.5px] shadow-xl backdrop-blur">
      {title !== undefined && title !== '' && <div className="mb-1 font-mono text-[10.5px] text-zinc-500">{title}</div>}
      {payload.map((p: any) => (
        <div key={p.dataKey ?? p.name} className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full" style={{ background: p.color ?? p.payload?.fill }} />
          <span className="text-zinc-400">{p.name}</span>
          <span className="ml-auto pl-3 font-mono text-zinc-100">
            {p.value == null ? '—' : formatter ? formatter(Number(p.value)) : `${Number(p.value).toLocaleString(undefined, { maximumFractionDigits: 3 })}${unit ? ` ${unit}` : ''}`}
          </span>
        </div>
      ))}
    </div>
  );
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function ChartCard({ title, subtitle, icon, children, className, right }: { title: string; subtitle: string; icon: ReactNode; children: ReactNode; className?: string; right?: ReactNode }) {
  return (
    <motion.div variants={{ hidden: { opacity: 0, y: 14 }, show: { opacity: 1, y: 0 } }} className={cx("min-w-0", className)}>
      <Card className="h-full" interactive={false}>
        <CardHeader title={title} subtitle={subtitle} icon={icon} right={right} />
        <div className="h-[250px] px-3 pb-4">{children}</div>
      </Card>
    </motion.div>
  );
}

export default function Analytics() {
  const timeline = useStore((s) => s.timeline);
  const byOp = useStore((s) => s.byOp);
  const counters = useStore((s) => s.counters);
  const workers = useStore((s) => s.workers);
  const completions = useStore((s) => s.completions);
  const snapshot = useStore((s) => s.snapshot);
  const [windowSec, setWindowSec] = useState<60 | 180>(60);

  const series = useMemo(
    () =>
      timeline.slice(-windowSec).map((p) => ({
        t: p.t,
        read: p.read,
        write: p.write,
        create: p.create,
        failed: p.failed,
        completed: p.completed,
        avg: p.completed ? p.processing_ms / p.completed : null,
        bytes: p.bytes,
        util: (p.busy_ms / (1000 * Math.max(workers.length, 1))) * 100,
      })),
    [timeline, windowSec, workers.length],
  );

  const avg = averages(counters);
  const windowTotal = series.reduce((n, p) => n + p.completed, 0);
  const windowBytes = series.reduce((n, p) => n + p.bytes, 0);

  const distribution = [
    { name: 'READ', value: byOp.READ.count, fill: '#22d3ee' },
    { name: 'WRITE', value: byOp.WRITE.count, fill: '#a78bfa' },
    { name: 'CREATE', value: byOp.CREATE.count, fill: '#34d399' },
  ].filter((d) => d.value > 0);

  const workerBars = workers.map((w) => ({
    name: `W${w.id}`,
    processed: w.processed,
    busy: Number(w.busyMs.toFixed(3)),
  }));

  const comparison = useMemo(() => {
    const ops = ['READ', 'WRITE', 'CREATE'] as const;
    return ops
      .map((op) => {
        const recent = completions.filter((c) => c.op === op && !c.rejected);
        const mean = (f: (c: (typeof recent)[number]) => number | null) => {
          const values = recent.map(f).filter((v): v is number => v != null);
          return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
        };
        return {
          op,
          samples: recent.length,
          processing: mean((c) => c.processing_ms),
          wait: mean((c) => c.wait_ms),
          latency: mean((c) => c.latency_ms),
        };
      })
      .filter((r) => r.samples > 0);
  }, [completions]);

  const scatter = useMemo(
    () =>
      ['READ', 'WRITE', 'CREATE'].map((op) => ({
        op,
        data: completions
          .filter((c) => c.op === op && !c.rejected)
          .slice(0, 300)
          .map((c) => ({ id: c.request_id, ms: c.processing_ms, bytes: c.bytes })),
      })),
    [completions],
  );

  if (!snapshot) {
    return (
      <div>
        <PageHeader title="Performance analytics" description="Waiting for the first STATS snapshot from the server…" />
        <div className="grid gap-3 lg:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-[300px] rounded-2xl" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Performance analytics"
        description="Built from the performance module's CLOCK_MONOTONIC measurements (performance_start / performance_end) aggregated by the server into per-second buckets."
        actions={
          <div className="flex rounded-lg border border-white/[0.07] bg-white/[0.02] p-0.5 text-[12px]">
            {([60, 180] as const).map((w) => (
              <button key={w} onClick={() => setWindowSec(w)} className={cx('relative rounded-md px-3 py-1', windowSec === w ? 'text-zinc-100' : 'text-zinc-500')}>
                {windowSec === w && <motion.span layoutId="win" className="absolute inset-0 rounded-md bg-white/[0.08]" />}
                <span className="relative">Last {w === 60 ? '1 min' : '3 min'}</span>
              </button>
            ))}
          </div>
        }
      />

      <div className="mb-3 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Kpi label="Avg processing" value={avg.avgProcessingMs} format={formatMs} />
        <Kpi label="Min / max" text={`${formatMs(counters.minProcessingMs)} / ${formatMs(counters.maxProcessingMs)}`} />
        <Kpi label="Avg queue wait" value={avg.avgWaitMs} format={formatMs} />
        <Kpi label={`Throughput (${windowSec}s)`} value={windowTotal / windowSec} format={(n) => `${n.toFixed(2)} req/s`} />
        <Kpi label={`Data moved (${windowSec}s)`} value={windowBytes} format={(n) => formatBytes(n)} />
      </div>

      <motion.div className="grid grid-cols-1 gap-3 lg:grid-cols-2" initial="hidden" animate="show" variants={{ hidden: {}, show: { transition: { staggerChildren: 0.05 } } }}>
        <ChartCard title="Requests over time" subtitle="Completed requests per second, by operation" icon={<Activity className="h-3.5 w-3.5" />}>
          <ResponsiveContainer>
            <AreaChart data={series} margin={{ top: 8, right: 10, left: -14, bottom: 0 }}>
              <defs>
                {[['r', '#22d3ee'], ['w', '#a78bfa'], ['c', '#34d399']].map(([id, color]) => (
                  <linearGradient key={id} id={`g-${id}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" stopColor={color} stopOpacity={0.4} />
                    <stop offset="1" stopColor={color} stopOpacity={0.02} />
                  </linearGradient>
                ))}
              </defs>
              <CartesianGrid stroke={GRID} vertical={false} />
              <XAxis dataKey="t" tickFormatter={(t) => formatClock(t)} tick={AXIS} axisLine={false} tickLine={false} minTickGap={50} />
              <YAxis allowDecimals={false} tick={AXIS} axisLine={false} tickLine={false} width={40} />
              <Tooltip content={<ChartTooltip />} cursor={{ stroke: 'rgba(255,255,255,0.1)' }} />
              <Area stackId="1" type="monotone" dataKey="read" name="READ" stroke="#22d3ee" fill="url(#g-r)" strokeWidth={1.5} isAnimationActive={false} />
              <Area stackId="1" type="monotone" dataKey="write" name="WRITE" stroke="#a78bfa" fill="url(#g-w)" strokeWidth={1.5} isAnimationActive={false} />
              <Area stackId="1" type="monotone" dataKey="create" name="CREATE" stroke="#34d399" fill="url(#g-c)" strokeWidth={1.5} isAnimationActive={false} />
              <Line type="monotone" dataKey="failed" name="Failed" stroke="#fb7185" dot={false} isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Average processing time" subtitle="Mean worker processing time per second (gaps = idle)" icon={<Timer className="h-3.5 w-3.5" />}>
          <ResponsiveContainer>
            <LineChart data={series} margin={{ top: 8, right: 10, left: 4, bottom: 0 }}>
              <CartesianGrid stroke={GRID} vertical={false} />
              <XAxis dataKey="t" tickFormatter={(t) => formatClock(t)} tick={AXIS} axisLine={false} tickLine={false} minTickGap={50} />
              <YAxis tick={AXIS} axisLine={false} tickLine={false} width={62} tickFormatter={(v) => formatMs(v)} />
              <Tooltip content={<ChartTooltip formatter={formatMs} />} cursor={{ stroke: 'rgba(255,255,255,0.1)' }} />
              <Line type="monotone" dataKey="avg" name="Avg processing" stroke="#fbbf24" strokeWidth={1.8} dot={{ r: 2, fill: '#fbbf24' }} connectNulls={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="READ vs WRITE distribution" subtitle="All operations processed since server start" icon={<PieIcon className="h-3.5 w-3.5" />}>
          {distribution.length === 0 ? (
            <EmptyState icon={<PieIcon className="h-5 w-5" />} title="No operations yet" />
          ) : (
            <div className="flex h-full items-center gap-4">
              <ResponsiveContainer width="55%">
                <PieChart>
                  <Pie data={distribution} dataKey="value" nameKey="name" innerRadius="62%" outerRadius="88%" paddingAngle={3} stroke="none" animationDuration={700}>
                    {distribution.map((d) => (
                      <Cell key={d.name} fill={d.fill} />
                    ))}
                  </Pie>
                  <Tooltip content={<ChartTooltip />} />
                </PieChart>
              </ResponsiveContainer>
              <div className="flex-1 space-y-3 pr-4">
                {(['READ', 'WRITE', 'CREATE'] as const).map((op) => {
                  const o = byOp[op];
                  const total = byOp.READ.count + byOp.WRITE.count + byOp.CREATE.count;
                  return (
                    <div key={op}>
                      <div className="flex items-center justify-between text-[12px]">
                        <span className="flex items-center gap-2 text-zinc-300">
                          <span className="h-2 w-2 rounded-full" style={{ background: { READ: '#22d3ee', WRITE: '#a78bfa', CREATE: '#34d399' }[op] }} />
                          {op}
                        </span>
                        <span className="font-mono text-zinc-200">{o.count.toLocaleString()}</span>
                      </div>
                      <div className="mt-1 flex justify-between font-mono text-[10.5px] text-zinc-500">
                        <span>{total ? ((o.count / total) * 100).toFixed(1) : 0}%</span>
                        <span>avg {formatMs(o.count ? o.totalMs / o.count : 0)} · {o.failed} failed</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </ChartCard>

        <ChartCard title="Worker utilization" subtitle="Pool busy time as % of 4 threads, per second" icon={<Gauge className="h-3.5 w-3.5" />}>
          <ResponsiveContainer>
            <AreaChart data={series} margin={{ top: 8, right: 10, left: -6, bottom: 0 }}>
              <defs>
                <linearGradient id="g-u" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stopColor="#f59e0b" stopOpacity={0.45} />
                  <stop offset="1" stopColor="#f59e0b" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke={GRID} vertical={false} />
              <XAxis dataKey="t" tickFormatter={(t) => formatClock(t)} tick={AXIS} axisLine={false} tickLine={false} minTickGap={50} />
              <YAxis tick={AXIS} axisLine={false} tickLine={false} width={48} tickFormatter={(v) => `${Number(v).toFixed(v < 1 ? 2 : 0)}%`} />
              <Tooltip content={<ChartTooltip formatter={(v) => `${v.toFixed(3)} %`} />} cursor={{ stroke: 'rgba(255,255,255,0.1)' }} />
              <Area type="monotone" dataKey="util" name="Utilization" stroke="#fbbf24" fill="url(#g-u)" strokeWidth={1.6} isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Per-worker load" subtitle="Requests processed and total busy time per thread" icon={<Cpu className="h-3.5 w-3.5" />}>
          <ResponsiveContainer>
            <BarChart data={workerBars} margin={{ top: 8, right: 10, left: -10, bottom: 0 }} barGap={4}>
              <CartesianGrid stroke={GRID} vertical={false} />
              <XAxis dataKey="name" tick={AXIS} axisLine={false} tickLine={false} />
              <YAxis yAxisId="l" allowDecimals={false} tick={AXIS} axisLine={false} tickLine={false} width={44} />
              <YAxis yAxisId="r" orientation="right" tick={AXIS} axisLine={false} tickLine={false} width={52} tickFormatter={(v) => formatMs(v)} />
              <Tooltip content={<ChartTooltip />} cursor={{ fill: 'rgba(255,255,255,0.03)' }} />
              <Legend wrapperStyle={{ fontSize: 11, color: '#a1a1aa' }} iconType="circle" iconSize={7} />
              <Bar yAxisId="l" dataKey="processed" name="Processed" fill="#818cf8" radius={[5, 5, 0, 0]} animationDuration={600} />
              <Bar yAxisId="r" dataKey="busy" name="Busy (ms)" fill="#22d3ee" radius={[5, 5, 0, 0]} animationDuration={600} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Throughput" subtitle="Bytes read + written per second" icon={<BarChart3 className="h-3.5 w-3.5" />}>
          <ResponsiveContainer>
            <AreaChart data={series} margin={{ top: 8, right: 10, left: -2, bottom: 0 }}>
              <defs>
                <linearGradient id="g-b" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stopColor="#818cf8" stopOpacity={0.45} />
                  <stop offset="1" stopColor="#818cf8" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke={GRID} vertical={false} />
              <XAxis dataKey="t" tickFormatter={(t) => formatClock(t)} tick={AXIS} axisLine={false} tickLine={false} minTickGap={50} />
              <YAxis tick={AXIS} axisLine={false} tickLine={false} width={56} tickFormatter={(v) => formatBytes(v, 0)} />
              <Tooltip content={<ChartTooltip formatter={(v) => `${formatBytes(v)}/s`} />} cursor={{ stroke: 'rgba(255,255,255,0.1)' }} />
              <Area type="monotone" dataKey="bytes" name="Throughput" stroke="#a5b4fc" fill="url(#g-b)" strokeWidth={1.6} isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Completion time comparison" subtitle={`Mean per operation over the ${completions.length} most recent completions`} icon={<Timer className="h-3.5 w-3.5" />}>
          {comparison.length === 0 ? (
            <EmptyState icon={<Timer className="h-5 w-5" />} title="No completions yet" />
          ) : (
            <ResponsiveContainer>
              <BarChart data={comparison} margin={{ top: 8, right: 10, left: -2, bottom: 0 }} barGap={3}>
                <CartesianGrid stroke={GRID} vertical={false} />
                <XAxis dataKey="op" tick={AXIS} axisLine={false} tickLine={false} />
                <YAxis tick={AXIS} axisLine={false} tickLine={false} width={56} tickFormatter={(v) => formatMs(v)} />
                <Tooltip content={<ChartTooltip formatter={formatMs} />} cursor={{ fill: 'rgba(255,255,255,0.03)' }} />
                <Legend wrapperStyle={{ fontSize: 11, color: '#a1a1aa' }} iconType="circle" iconSize={7} />
                <Bar dataKey="wait" name="Queue wait" fill="#38bdf8" radius={[4, 4, 0, 0]} />
                <Bar dataKey="processing" name="Processing" fill="#fbbf24" radius={[4, 4, 0, 0]} />
                <Bar dataKey="latency" name="End-to-end" fill="#a78bfa" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </ChartCard>

        <ChartCard title="Processing time per request" subtitle="Each dot is one completed request (x = request ID)" icon={<Activity className="h-3.5 w-3.5" />}>
          {completions.length === 0 ? (
            <EmptyState icon={<Activity className="h-5 w-5" />} title="No completions yet" />
          ) : (
            <ResponsiveContainer>
              <ScatterChart margin={{ top: 8, right: 10, left: -2, bottom: 0 }}>
                <CartesianGrid stroke={GRID} />
                <XAxis type="number" dataKey="id" name="Request" tick={AXIS} axisLine={false} tickLine={false} domain={['dataMin', 'dataMax']} />
                <YAxis type="number" dataKey="ms" name="Processing" tick={AXIS} axisLine={false} tickLine={false} width={56} tickFormatter={(v) => formatMs(v)} />
                <ZAxis range={[22, 22]} />
                <Tooltip content={<ChartTooltip formatter={formatMs} />} cursor={{ strokeDasharray: '3 3' }} />
                <Legend wrapperStyle={{ fontSize: 11, color: '#a1a1aa' }} iconType="circle" iconSize={7} />
                {scatter.map((s) => (
                  <Scatter key={s.op} name={s.op} data={s.data} fill={{ READ: '#22d3ee', WRITE: '#a78bfa', CREATE: '#34d399' }[s.op]} fillOpacity={0.75} isAnimationActive={false} />
                ))}
              </ScatterChart>
            </ResponsiveContainer>
          )}
        </ChartCard>
      </motion.div>
    </div>
  );
}

function Kpi({ label, value, format, text }: { label: string; value?: number; format?: (n: number) => string; text?: string }) {
  return (
    <Card className="p-4">
      <div className="text-[11.5px] text-zinc-500">{label}</div>
      <div className="mt-1.5 text-[19px] font-semibold tracking-tight text-zinc-50">
        {text ?? <AnimatedNumber value={value ?? 0} format={format} />}
      </div>
    </Card>
  );
}
