import { type ReactNode, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  Cpu,
  FolderOpen,
  Info,
  Layers,
  LayoutDashboard,
  ScrollText,
  Server,
  Unplug,
  XCircle,
  Zap,
} from 'lucide-react';
import { cx, formatDuration } from '../lib/format';
import { isOnline, useStore } from '../lib/store';
import { dismiss, useToasts } from '../lib/toast';
import { Button, StatusDot } from './ui';

export type PageId = 'overview' | 'workers' | 'queue' | 'completions' | 'files' | 'analytics' | 'logs';

export const NAV: { id: PageId; label: string; icon: typeof Activity; group: string }[] = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard, group: 'Monitor' },
  { id: 'workers', label: 'Worker Threads', icon: Cpu, group: 'Monitor' },
  { id: 'queue', label: 'Request Queue', icon: Layers, group: 'Monitor' },
  { id: 'completions', label: 'Completion Queue', icon: CheckCircle2, group: 'Monitor' },
  { id: 'files', label: 'File Manager', icon: FolderOpen, group: 'Operate' },
  { id: 'analytics', label: 'Performance', icon: BarChart3, group: 'Insights' },
  { id: 'logs', label: 'Activity Logs', icon: ScrollText, group: 'Insights' },
];

/* ------------------------------------------------------------------ */
/* Ambient background                                                  */
/* ------------------------------------------------------------------ */

export function Background() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden bg-ink-950">
      <motion.div
        className="absolute -top-[30%] left-[10%] h-[70vh] w-[70vh] rounded-full bg-indigo-600/[0.13] blur-[120px]"
        animate={{ x: [0, 80, -40, 0], y: [0, 40, 20, 0] }}
        transition={{ duration: 38, repeat: Infinity, ease: 'easeInOut' }}
      />
      <motion.div
        className="absolute top-[30%] -right-[15%] h-[60vh] w-[60vh] rounded-full bg-cyan-500/[0.07] blur-[120px]"
        animate={{ x: [0, -60, 30, 0], y: [0, -50, 30, 0] }}
        transition={{ duration: 46, repeat: Infinity, ease: 'easeInOut' }}
      />
      <motion.div
        className="absolute -bottom-[25%] left-[35%] h-[55vh] w-[55vh] rounded-full bg-violet-600/[0.08] blur-[130px]"
        animate={{ x: [0, 50, -70, 0], y: [0, -30, 10, 0] }}
        transition={{ duration: 52, repeat: Infinity, ease: 'easeInOut' }}
      />
      <div
        className="absolute inset-0 opacity-[0.35]"
        style={{
          backgroundImage:
            'linear-gradient(rgba(255,255,255,0.035) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.035) 1px, transparent 1px)',
          backgroundSize: '56px 56px',
          maskImage: 'radial-gradient(ellipse 80% 60% at 50% 0%, black 30%, transparent 75%)',
          WebkitMaskImage: 'radial-gradient(ellipse 80% 60% at 50% 0%, black 30%, transparent 75%)',
        }}
      />
      <div
        className="absolute inset-0 opacity-[0.025] mix-blend-overlay"
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")",
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Sidebar                                                             */
/* ------------------------------------------------------------------ */

export function Logo() {
  return (
    <div className="flex items-center gap-2.5">
      <div className="relative grid h-8 w-8 place-items-center rounded-[10px] border border-white/10 bg-gradient-to-br from-indigo-500/30 via-violet-500/20 to-cyan-400/20 shadow-[0_0_24px_-6px_rgba(129,140,248,0.7)]">
        <Zap className="h-4 w-4 text-indigo-100" strokeWidth={2.2} />
      </div>
      <div className="leading-tight">
        <div className="text-[13.5px] font-semibold tracking-[-0.01em] text-zinc-50">Async FS</div>
        <div className="text-[10.5px] text-zinc-500">File server console</div>
      </div>
    </div>
  );
}

export function Sidebar({ page, onNavigate }: { page: PageId; onNavigate: (p: PageId) => void }) {
  const queueSize = useStore((s) => s.queue.length);
  const workers = useStore((s) => s.workers);
  const online = useStore(isOnline);
  const busy = workers.filter((w) => w.state === 'PROCESSING').length;

  const groups = [...new Set(NAV.map((n) => n.group))];

  return (
    <aside className="sticky top-0 hidden h-screen w-[244px] shrink-0 flex-col border-r border-white/[0.055] bg-ink-900/60 px-3 py-5 backdrop-blur-xl lg:flex">
      <div className="px-2">
        <Logo />
      </div>

      <nav className="mt-8 flex-1 space-y-6">
        {groups.map((group) => (
          <div key={group}>
            <div className="mb-1.5 px-2.5 text-[10.5px] font-medium uppercase tracking-[0.08em] text-zinc-600">{group}</div>
            <div className="space-y-0.5">
              {NAV.filter((n) => n.group === group).map((item) => {
                const active = item.id === page;
                const Icon = item.icon;
                const badge =
                  item.id === 'queue' && online && queueSize > 0
                    ? queueSize
                    : item.id === 'workers' && online && busy > 0
                      ? `${busy}/${workers.length}`
                      : null;

                return (
                  <button
                    key={item.id}
                    onClick={() => onNavigate(item.id)}
                    className={cx(
                      'group relative flex w-full items-center gap-2.5 rounded-[9px] px-2.5 py-[7px] text-[13px] transition-colors',
                      active ? 'text-zinc-50' : 'text-zinc-400 hover:text-zinc-100',
                    )}
                  >
                    {active && (
                      <motion.span
                        layoutId="nav-active"
                        className="absolute inset-0 rounded-[9px] border border-white/[0.07] bg-white/[0.055] shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]"
                        transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                      />
                    )}
                    {!active && (
                      <span className="absolute inset-0 rounded-[9px] opacity-0 transition-opacity group-hover:bg-white/[0.03] group-hover:opacity-100" />
                    )}
                    <Icon className={cx('relative h-4 w-4', active ? 'text-indigo-300' : 'text-zinc-500 group-hover:text-zinc-300')} />
                    <span className="relative">{item.label}</span>
                    <AnimatePresence>
                      {badge != null && (
                        <motion.span
                          initial={{ opacity: 0, scale: 0.6 }}
                          animate={{ opacity: 1, scale: 1 }}
                          exit={{ opacity: 0, scale: 0.6 }}
                          className="relative ml-auto rounded-md bg-indigo-400/15 px-1.5 font-mono text-[10.5px] text-indigo-200"
                        >
                          {badge}
                        </motion.span>
                      )}
                    </AnimatePresence>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      <ConnectionPanel />
    </aside>
  );
}

function ConnectionPanel() {
  const bridge = useStore((s) => s.bridgeConnected);
  const backend = useStore((s) => s.backend);
  const server = useStore((s) => s.server);

  const online = bridge && backend?.online;

  return (
    <div className="surface mx-1 p-3">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium text-zinc-400">Integration</span>
        <StatusDot tone={online ? 'good' : bridge ? 'bad' : 'warn'} pulse={!!online} />
      </div>
      <div className="mt-2.5 space-y-1.5 text-[11.5px]">
        <Row label="Bridge" value={bridge ? 'connected' : 'offline'} ok={bridge} />
        <Row label="C backend" value={backend?.online ? 'online' : 'offline'} ok={!!backend?.online} />
        <Row label="Endpoint" value={backend ? `${backend.host}:${backend.port}` : '—'} />
        {server && online && <Row label="PID" value={String(server.pid)} />}
      </div>
    </div>
  );
}

function Row({ label, value, ok }: { label: string; value: string; ok?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-zinc-500">{label}</span>
      <span className={cx('truncate font-mono text-[11px]', ok === undefined ? 'text-zinc-300' : ok ? 'text-emerald-300' : 'text-rose-300')}>
        {value}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Top bar                                                             */
/* ------------------------------------------------------------------ */

export function useUptime() {
  const server = useStore((s) => s.server);
  const receivedAt = useStore((s) => s.serverReceivedAt);
  const online = useStore(isOnline);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  if (!server || !online) return null;
  return server.uptime_ms + (now - receivedAt);
}

export function Topbar({
  page,
  onNavigate,
  onWorkload,
}: {
  page: PageId;
  onNavigate: (p: PageId) => void;
  onWorkload: () => void;
}) {
  const online = useStore(isOnline);
  const bridge = useStore((s) => s.bridgeConnected);
  const ioDelay = useStore((s) => s.server?.io_delay_ms ?? 0);
  const uptime = useUptime();
  const current = NAV.find((n) => n.id === page)!;

  return (
    <header className="sticky top-0 z-30 border-b border-white/[0.055] bg-ink-950/70 backdrop-blur-xl">
      <div className="flex h-14 items-center gap-3 px-4 sm:px-6 lg:px-8">
        <div className="lg:hidden">
          <Logo />
        </div>
        <div className="hidden items-center gap-2 text-[13px] lg:flex">
          <span className="text-zinc-500">Async File Server</span>
          <span className="text-zinc-700">/</span>
          <span className="font-medium text-zinc-200">{current.label}</span>
        </div>

        <div className="ml-auto flex items-center gap-2.5">
          {online && ioDelay > 0 && (
            <span
              title="The server was started with --io-delay-ms: each worker deliberately holds every request this long."
              className="hidden items-center gap-1.5 rounded-full border border-amber-400/25 bg-amber-400/[0.08] px-2.5 py-1 text-[11px] text-amber-200 md:inline-flex"
            >
              <AlertTriangle className="h-3 w-3" /> Demo I/O delay {ioDelay} ms
            </span>
          )}

          <div className="hidden items-center gap-2 rounded-full border border-white/[0.07] bg-white/[0.025] px-3 py-1 text-[11.5px] sm:flex">
            <StatusDot tone={online ? 'good' : 'bad'} pulse={online} />
            <span className={online ? 'text-zinc-200' : 'text-rose-200'}>
              {online ? 'Backend online' : bridge ? 'Backend offline' : 'Bridge offline'}
            </span>
            {uptime != null && (
              <>
                <span className="text-zinc-700">·</span>
                <span className="font-mono text-[11px] text-zinc-400">up {formatDuration(uptime)}</span>
              </>
            )}
          </div>

          <Button variant="primary" size="sm" icon={<Zap className="h-3.5 w-3.5" />} onClick={onWorkload} disabled={!online}>
            Submit requests
          </Button>
        </div>
      </div>

      {/* Mobile navigation */}
      <nav className="flex gap-1 overflow-x-auto px-3 pb-2 lg:hidden">
        {NAV.map((item) => (
          <button
            key={item.id}
            onClick={() => onNavigate(item.id)}
            className={cx(
              'shrink-0 rounded-lg px-2.5 py-1 text-[12px]',
              item.id === page ? 'bg-white/[0.07] text-zinc-100' : 'text-zinc-500',
            )}
          >
            {item.label}
          </button>
        ))}
      </nav>
    </header>
  );
}

/* ------------------------------------------------------------------ */
/* Offline banner                                                      */
/* ------------------------------------------------------------------ */

export function OfflineBanner() {
  const bridge = useStore((s) => s.bridgeConnected);
  const everConnected = useStore((s) => s.bridgeEverConnected);
  const backend = useStore((s) => s.backend);

  const show = (everConnected && !bridge) || (bridge && backend && !backend.online);

  return (
    <AnimatePresence initial={false}>
      {show && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ type: 'spring', stiffness: 300, damping: 32 }}
          className="overflow-hidden"
        >
          <div className="mx-4 mt-4 flex items-start gap-3 rounded-xl border border-rose-400/20 bg-[linear-gradient(90deg,rgba(244,63,94,0.12),rgba(244,63,94,0.04))] px-4 py-3 sm:mx-6 lg:mx-8">
            {bridge ? <Server className="mt-0.5 h-4 w-4 text-rose-300" /> : <Unplug className="mt-0.5 h-4 w-4 text-rose-300" />}
            <div className="min-w-0 text-[12.5px]">
              <div className="font-medium text-rose-100">
                {bridge ? 'C backend unreachable' : 'Bridge connection lost'}
              </div>
              <div className="mt-0.5 text-rose-200/70">
                {bridge
                  ? `${backend?.lastError ?? 'No response from the server.'} Reconnecting automatically. Values shown are the last known state.`
                  : 'The dashboard cannot reach the bridge on port 7070. Reconnecting…'}
              </div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/* ------------------------------------------------------------------ */
/* Toasts                                                              */
/* ------------------------------------------------------------------ */

export function Toaster() {
  const toasts = useToasts();

  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2">
      <AnimatePresence initial={false}>
        {toasts.map((t) => {
          const Icon = t.tone === 'success' ? CheckCircle2 : t.tone === 'error' ? XCircle : Info;
          const color = t.tone === 'success' ? 'text-emerald-300' : t.tone === 'error' ? 'text-rose-300' : 'text-indigo-300';
          return (
            <motion.div
              key={t.id}
              layout
              initial={{ opacity: 0, y: 16, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, x: 40, transition: { duration: 0.18 } }}
              transition={{ type: 'spring', stiffness: 420, damping: 32 }}
              onClick={() => dismiss(t.id)}
              className="pointer-events-auto flex cursor-pointer items-start gap-3 rounded-xl border border-white/[0.09] bg-ink-800/90 px-4 py-3 shadow-[0_20px_50px_-15px_rgba(0,0,0,0.8)] backdrop-blur-xl"
            >
              <Icon className={cx('mt-0.5 h-4 w-4 shrink-0', color)} />
              <div className="min-w-0">
                <div className="text-[12.5px] font-medium text-zinc-100">{t.title}</div>
                {t.detail && <div className="mt-0.5 break-words font-mono text-[11px] text-zinc-400">{t.detail}</div>}
              </div>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}

export function PageTransition({ id, children }: { id: string; children: ReactNode }) {
  return (
    <motion.div
      key={id}
      initial={{ opacity: 0, y: 10, filter: 'blur(4px)' }}
      animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
      exit={{ opacity: 0, y: -6, filter: 'blur(3px)' }}
      transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.div>
  );
}
