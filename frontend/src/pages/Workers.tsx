import { motion } from 'framer-motion';
import { Cpu, GitBranch } from 'lucide-react';
import { WorkerCard } from '../components/live';
import { Card, CardHeader, PageHeader, Skeleton } from '../components/ui';
import { formatBytes, formatMs } from '../lib/format';
import { isOnline, useStore } from '../lib/store';

export default function Workers() {
  const workers = useStore((s) => s.workers);
  const online = useStore(isOnline);
  const queueLength = useStore((s) => s.queue.length);
  const busy = online ? workers.filter((w) => w.state === 'PROCESSING').length : 0;

  return (
    <div>
      <PageHeader
        title="Worker threads"
        description="Each card is one pthread running worker_function(): it blocks in dequeue() on the request queue's condition variable, performs the file operation and pushes a Completion. States change only when the server emits request_started / request_finished."
      />

      <div className="mb-4 flex flex-wrap gap-2 text-[12px]">
        <Summary label="Processing" value={`${busy} / ${workers.length || 4}`} />
        <Summary label="Waiting in queue" value={online ? String(queueLength) : '—'} />
        <Summary label="Total processed" value={workers.reduce((n, w) => n + w.processed, 0).toLocaleString()} />
        <Summary label="Total busy time" value={formatMs(workers.reduce((n, w) => n + w.busyMs, 0))} />
        <Summary label="Bytes handled" value={formatBytes(workers.reduce((n, w) => n + w.bytes, 0))} />
      </div>

      <motion.div
        className="grid gap-3 md:grid-cols-2"
        initial="hidden"
        animate="show"
        variants={{ hidden: {}, show: { transition: { staggerChildren: 0.06 } } }}
      >
        {workers.length === 0
          ? Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[300px] rounded-2xl" />)
          : workers.map((w) => (
              <motion.div key={w.id} variants={{ hidden: { opacity: 0, y: 14 }, show: { opacity: 1, y: 0 } }}>
                <WorkerCard worker={w} />
              </motion.div>
            ))}
      </motion.div>

      <Card className="mt-3" interactive={false}>
        <CardHeader title="Thread model" subtitle="How a request flows through the server" icon={<GitBranch className="h-3.5 w-3.5" />} />
        <div className="grid gap-3 px-5 pb-5 text-[12px] text-zinc-400 md:grid-cols-4">
          {[
            ['Connection thread', 'One per TCP client. Parses READ / WRITE / WRITEB / CREATE lines, validates the filename and calls enqueue().'],
            ['RequestQueue', 'Linked list guarded by a mutex + condition variable. Workers sleep in pthread_cond_wait() while it is empty.'],
            ['Worker × 4', 'dequeue() → openat()/read()/write()/renameat() inside files/ → performance_end() → completion_enqueue().'],
            ['Completion thread', 'completion_dequeue() → sends RESP <id> <len> <status> on the client socket, under the connection send lock.'],
          ].map(([title, text], i) => (
            <div key={title} className="rounded-xl border border-white/[0.06] bg-black/20 p-3.5">
              <div className="flex items-center gap-2">
                <span className="grid h-5 w-5 place-items-center rounded-md bg-indigo-400/15 font-mono text-[10px] text-indigo-200">{i + 1}</span>
                <span className="font-medium text-zinc-200">{title}</span>
              </div>
              <p className="mt-2 leading-relaxed">{text}</p>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-2 rounded-full border border-white/[0.07] bg-white/[0.025] px-3 py-1">
      <Cpu className="h-3 w-3 text-zinc-500" />
      <span className="text-zinc-500">{label}</span>
      <span className="font-mono text-zinc-200">{value}</span>
    </div>
  );
}
