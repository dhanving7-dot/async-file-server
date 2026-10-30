import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowDownToLine, Hash, Pause, Play, ScrollText, Search, X } from 'lucide-react';
import { api } from '../lib/api';
import { cx, formatClock } from '../lib/format';
import { isOnline, mergeLogs, useStore } from '../lib/store';
import type { LogLevel } from '../lib/types';
import { Button, Card, EmptyState, PageHeader, Skeleton } from '../components/ui';

const LEVELS: LogLevel[] = ['DEBUG', 'INFO', 'WARN', 'ERROR'];

const LEVEL_STYLE: Record<LogLevel, string> = {
  DEBUG: 'text-zinc-400 bg-zinc-400/10 border-zinc-400/15',
  INFO: 'text-sky-300 bg-sky-400/10 border-sky-400/20',
  WARN: 'text-amber-300 bg-amber-400/10 border-amber-400/20',
  ERROR: 'text-rose-300 bg-rose-400/10 border-rose-400/25',
};

const MAX_RENDERED = 800;

function highlight(text: string, query: string) {
  if (!query) return text;
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const parts: ReactNode[] = [];
  let i = 0;
  let k = 0;
  for (;;) {
    const j = lower.indexOf(q, i);
    if (j === -1) break;
    parts.push(text.slice(i, j));
    parts.push(
      <mark key={k++} className="rounded-[3px] bg-indigo-400/30 px-0.5 text-indigo-50">
        {text.slice(j, j + q.length)}
      </mark>,
    );
    i = j + q.length;
  }
  parts.push(text.slice(i));
  return parts;
}

export default function Logs() {
  const logs = useStore((s) => s.logs);
  const logsVersion = useStore((s) => s.logsVersion);
  const online = useStore(isOnline);

  const [loaded, setLoaded] = useState(false);
  const [query, setQuery] = useState('');
  const [levels, setLevels] = useState<Set<LogLevel>>(new Set(LEVELS));
  const [requestId, setRequestId] = useState<number | null>(null);
  const [follow, setFollow] = useState(true);
  const [paused, setPaused] = useState<typeof logs | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  // Initial history (LOGS command); live lines arrive over the event stream.
  useEffect(() => {
    if (!online) return;
    api
      .logs(2000)
      .then((r) => mergeLogs(r.logs))
      .catch(() => undefined)
      .finally(() => setLoaded(true));
  }, [online, logsVersion]);

  const source = paused ?? logs;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return source.filter(
      (l) =>
        levels.has(l.level) &&
        (requestId == null || l.request_id === requestId || l.message.includes(`REQUEST ${requestId} `) || l.message.endsWith(`REQUEST ${requestId}`)) &&
        (!q || l.message.toLowerCase().includes(q) || String(l.request_id) === q.replace('#', '')),
    );
  }, [source, levels, requestId, query]);

  const rendered = filtered.slice(-MAX_RENDERED);

  useEffect(() => {
    if (follow && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [rendered.length, follow]);

  const counts = useMemo(() => {
    const c: Record<LogLevel, number> = { DEBUG: 0, INFO: 0, WARN: 0, ERROR: 0 };
    for (const l of source) c[l.level]++;
    return c;
  }, [source]);

  function toggleLevel(level: LogLevel) {
    const next = new Set(levels);
    if (next.has(level)) next.delete(level);
    else next.add(level);
    setLevels(next);
  }

  return (
    <div>
      <PageHeader
        title="Activity logs"
        description="Entries written by the server's logger (also appended to backend/logs/server.log). History is loaded with LOGS; new lines stream in live."
        actions={
          <>
            <Button size="sm" icon={paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />} onClick={() => setPaused(paused ? null : logs)}>
              {paused ? 'Resume' : 'Pause'}
            </Button>
            <Button size="sm" variant={follow ? 'primary' : 'secondary'} icon={<ArrowDownToLine className="h-3.5 w-3.5" />} onClick={() => setFollow(!follow)}>
              Follow
            </Button>
          </>
        }
      />

      <Card className="flex h-[calc(100vh-200px)] min-h-[440px] flex-col overflow-hidden" interactive={false}>
        <div className="flex flex-wrap items-center gap-2 border-b border-white/[0.05] p-3">
          <div className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search messages…" className="input !py-1.5 !pl-8 !text-[12.5px]" />
          </div>

          <div className="flex items-center gap-1">
            {LEVELS.map((level) => (
              <button
                key={level}
                onClick={() => toggleLevel(level)}
                className={cx(
                  'rounded-md border px-2 py-1 font-mono text-[10.5px] transition-opacity',
                  LEVEL_STYLE[level],
                  !levels.has(level) && 'opacity-35',
                )}
              >
                {level} <span className="opacity-60">{counts[level]}</span>
              </button>
            ))}
          </div>

          <div className="relative w-36">
            <Hash className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
            <input
              value={requestId ?? ''}
              onChange={(e) => setRequestId(e.target.value ? Number(e.target.value.replace(/\D/g, '')) || null : null)}
              placeholder="Request ID"
              className="input !py-1.5 !pl-8 !text-[12.5px]"
            />
            {requestId != null && (
              <button onClick={() => setRequestId(null)} className="absolute top-1/2 right-2 -translate-y-1/2 text-zinc-500 hover:text-zinc-200">
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between px-4 py-1.5 text-[11px] text-zinc-500">
          <span>
            {filtered.length.toLocaleString()} of {source.length.toLocaleString()} entries
            {filtered.length > MAX_RENDERED && ` · showing latest ${MAX_RENDERED}`}
          </span>
          {paused && <span className="text-amber-300">Paused — new entries are buffered</span>}
        </div>

        <div
          ref={scroller}
          onWheel={(e) => e.deltaY < 0 && follow && setFollow(false)}
          className="flex-1 overflow-y-auto px-2 pb-2 font-mono text-[12px]"
        >
          {!loaded && logs.length === 0 ? (
            <div className="space-y-1.5 p-2">
              {Array.from({ length: 14 }).map((_, i) => (
                <Skeleton key={i} className="h-5" />
              ))}
            </div>
          ) : rendered.length === 0 ? (
            <EmptyState icon={<ScrollText className="h-5 w-5" />} title={source.length ? 'No entries match the filters' : 'No log entries yet'} />
          ) : (
            <AnimatePresence initial={false}>
              {rendered.map((l) => (
                <motion.div
                  key={l.seq}
                  initial={{ opacity: 0, backgroundColor: 'rgba(129,140,248,0.10)' }}
                  animate={{ opacity: 1, backgroundColor: 'rgba(0,0,0,0)' }}
                  transition={{ duration: 0.8 }}
                  className="group flex items-start gap-3 rounded-md px-2 py-[3px] hover:!bg-white/[0.025]"
                >
                  <span className="shrink-0 text-zinc-600">{formatClock(l.ts, true)}</span>
                  <span className={cx('w-[52px] shrink-0 rounded border px-1 text-center text-[10px] leading-[17px]', LEVEL_STYLE[l.level])}>{l.level}</span>
                  {l.request_id ? (
                    <button
                      onClick={() => setRequestId(l.request_id)}
                      className="w-[52px] shrink-0 text-left text-indigo-300/80 hover:text-indigo-200"
                      title="Filter by this request"
                    >
                      #{l.request_id}
                    </button>
                  ) : (
                    <span className="w-[52px] shrink-0 text-zinc-700">—</span>
                  )}
                  <span className={cx('min-w-0 break-all', l.level === 'ERROR' ? 'text-rose-200' : l.level === 'WARN' ? 'text-amber-100' : 'text-zinc-300')}>
                    {highlight(l.message, query.trim())}
                  </span>
                </motion.div>
              ))}
            </AnimatePresence>
          )}
        </div>
      </Card>
    </div>
  );
}
