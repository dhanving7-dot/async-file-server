import type { ReactNode } from 'react';
import { motion } from 'framer-motion';
import { Activity, CheckCircle2, Clock4, Cpu, Gauge, Inbox, Plug, Timer, XCircle } from 'lucide-react';
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ActivityFeed, Pipeline, WorkerCard } from '../components/live';
import { useUptime } from '../components/layout';
import { AnimatedNumber, Card, CardHeader, PageHeader, Skeleton, StatusDot } from '../components/ui';
import { cx, formatDuration, formatMs } from '../lib/format';
import { averages, isOnline, useStore } from '../lib/store';
import { ChartTooltip } from './Analytics';

const container = {
  hidden: {},
  show: { transition: { staggerChildren: 0.045 } },
};

const item = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { type: 'spring' as const, stiffness: 260, damping: 26 } },
};

function Metric({
  label,
  icon,
  children,
  footer,
  accent,
  loading,
}: {
  label: string;
  icon: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  accent: string;
  loading?: boolean;
}) {
  return (
    <motion.div variants={item}>
      <Card className="h-full overflow-hidden p-4">
        <div className={cx('pointer-events-none absolute -top-12 -right-10 h-28 w-28 rounded-full opacity-50 blur-3xl', accent)} />
        <div className="relative flex items-center justify-between">
          <span className="text-[12px] text-zinc-400">{label}</span>
          <span className="text-zinc-500">{icon}</span>
        </div>
        <div className="relative mt-3 text-[26px] font-semibold leading-none tracking-[-0.03em] text-zinc-50">
          {loading ? <Skeleton className="h-[26px] w-24" /> : children}
        </div>
        {footer && <div className="relative mt-2.5 text-[11.5px] text-zinc-500">{footer}</div>}
      </Card>
    </motion.div>
  );
}

export default function Overview() {
  const online = useStore(isOnline);
  const bridge = useStore((s) => s.bridgeConnected);
  const backend = useStore((s) => s.backend);
  const counters = useStore((s) => s.counters);
  const workers = useStore((s) => s.workers);
  const queue = useStore((s) => s.queue);
  const timeline = useStore((s) => s.timeline);
  const snapshot = useStore((s) => s.snapshot);
  const connections = useStore((s) => s.activeConnections);
  const uptime = useUptime();

  const loading = !snapshot;
  const avg = averages(counters);
  const active = online ? workers.filter((w) => w.state === 'PROCESSING').length : 0;
  const series = timeline.slice(-90).map((p) => ({ t: p.t, completed: p.completed, failed: p.failed }));
  const lastMinute = timeline.slice(-60).reduce((n, p) => n + p.completed, 0);

  return (
    <div>
      <PageHeader
        title="Overview"
        description="Live state of the C async file server — every number on this page comes from the server's STATS snapshot and SUBSCRIBE event stream."
      />

      <motion.div variants={container} initial="hidden" animate="show" className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Metric label="Total requests" icon={<Activity className="h-4 w-4" />} accent="bg-indigo-500/40" loading={loading}
          footer={<>{counters.queued.toLocaleString()} queued · {counters.rejected.toLocaleString()} rejected</>}>
          <AnimatedNumber value={counters.received} />
        </Metric>
        <Metric label="Completed" icon={<CheckCircle2 className="h-4 w-4" />} accent="bg-emerald-500/40" loading={loading}
          footer={<>{counters.succeeded.toLocaleString()} succeeded · {counters.delivered.toLocaleString()} delivered</>}>
          <AnimatedNumber value={counters.completed} />
        </Metric>
        <Metric label="Failed" icon={<XCircle className="h-4 w-4" />} accent="bg-rose-500/40" loading={loading}
          footer={<>worker errors · plus {counters.rejected} rejected at parse</>}>
          <AnimatedNumber value={counters.failed} className={counters.failed ? 'text-rose-200' : undefined} />
        </Metric>
        <Metric label="Avg response time" icon={<Timer className="h-4 w-4" />} accent="bg-cyan-500/40" loading={loading}
          footer={<>processing {formatMs(avg.avgProcessingMs)} · queue wait {formatMs(avg.avgWaitMs)}</>}>
          <AnimatedNumber value={avg.avgLatencyMs} format={(n) => formatMs(n)} />
        </Metric>
        <Metric label="Active workers" icon={<Cpu className="h-4 w-4" />} accent="bg-amber-500/40" loading={loading}
          footer={<>of {workers.length || 4} worker threads processing</>}>
          <span className="tabular-nums">{active}</span>
          <span className="text-zinc-600"> / {workers.length || 4}</span>
        </Metric>
        <Metric label="Request queue" icon={<Inbox className="h-4 w-4" />} accent="bg-sky-500/40" loading={loading}
          footer={<>waiting in RequestQueue</>}>
          <AnimatedNumber value={online ? queue.length : 0} />
        </Metric>
        <Metric label="Server uptime" icon={<Clock4 className="h-4 w-4" />} accent="bg-violet-500/40" loading={loading && online}
          footer={snapshot ? <>PID {snapshot.server.pid} · port {snapshot.server.port}</> : 'not running'}>
          <span className="text-[22px]">{uptime != null ? formatDuration(uptime) : '—'}</span>
        </Metric>
        <Metric label="Backend connection" icon={<Plug className="h-4 w-4" />} accent={online ? 'bg-emerald-500/40' : 'bg-rose-500/40'}
          footer={online ? <>{connections} open TCP connection{connections === 1 ? '' : 's'}</> : (backend?.lastError ?? (bridge ? 'connecting…' : 'bridge offline'))}>
          <span className="flex items-center gap-2.5 text-[22px]">
            <StatusDot tone={online ? 'good' : 'bad'} pulse={online} />
            {online ? 'Online' : 'Offline'}
          </span>
        </Metric>
      </motion.div>

      <div className="mt-3 grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader
            title="Processing pipeline"
            subtitle="Request queue → 4 worker threads → completion thread"
            icon={<Gauge className="h-3.5 w-3.5" />}
          />
          <div className="px-5 pb-5">
            <Pipeline maxQueue={6} maxDone={6} />
          </div>
        </Card>

        <Card>
          <CardHeader
            title="Throughput"
            subtitle={`${lastMinute.toLocaleString()} requests completed in the last 60 s`}
            icon={<Activity className="h-3.5 w-3.5" />}
          />
          <div className="h-[230px] px-2 pb-3">
            {loading ? (
              <Skeleton className="mx-3 h-full" />
            ) : (
              <ResponsiveContainer>
                <AreaChart data={series} margin={{ top: 8, right: 12, left: -18, bottom: 0 }}>
                  <defs>
                    <linearGradient id="ov-c" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0" stopColor="#818cf8" stopOpacity={0.45} />
                      <stop offset="1" stopColor="#818cf8" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="t" hide />
                  <YAxis allowDecimals={false} tick={{ fill: '#52525b', fontSize: 10 }} axisLine={false} tickLine={false} width={40} />
                  <Tooltip content={<ChartTooltip unit="req/s" />} cursor={{ stroke: 'rgba(255,255,255,0.1)' }} />
                  <Area type="monotone" dataKey="completed" name="Completed" stroke="#a5b4fc" strokeWidth={1.6} fill="url(#ov-c)" isAnimationActive={false} />
                  <Area type="monotone" dataKey="failed" name="Failed" stroke="#fb7185" strokeWidth={1.2} fill="transparent" isAnimationActive={false} />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
        </Card>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="grid gap-3 sm:grid-cols-2">
          {workers.length === 0
            ? Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[132px] rounded-2xl" />)
            : workers.map((w) => <WorkerCard key={w.id} worker={w} compact />)}
        </div>
        <Card className="max-h-[300px] overflow-hidden">
          <CardHeader title="Live activity" subtitle="SUBSCRIBE event stream" icon={<Activity className="h-3.5 w-3.5" />} />
          <div className="max-h-[236px] overflow-y-auto">
            <ActivityFeed limit={20} />
          </div>
        </Card>
      </div>
    </div>
  );
}
