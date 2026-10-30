import {
  type ButtonHTMLAttributes,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
} from 'react';
import { AnimatePresence, motion, useMotionValue, useSpring, useTransform } from 'framer-motion';
import { Loader2, X } from 'lucide-react';
import { cx, formatNumber } from '../lib/format';
import type { Op } from '../lib/types';

/* ------------------------------------------------------------------ */
/* Card                                                                */
/* ------------------------------------------------------------------ */

export function Card({
  children,
  className,
  interactive = true,
  style,
}: {
  children: ReactNode;
  className?: string;
  interactive?: boolean;
  style?: CSSProperties;
}) {
  const ref = useRef<HTMLDivElement>(null);

  const onMove = useCallback((e: MouseEvent<HTMLDivElement>) => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    el.style.setProperty('--spot-x', `${e.clientX - rect.left}px`);
    el.style.setProperty('--spot-y', `${e.clientY - rect.top}px`);
  }, []);

  return (
    <div
      ref={ref}
      onMouseMove={interactive ? onMove : undefined}
      style={style}
      className={cx('surface', interactive && 'surface-interactive spotlight', className)}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  subtitle,
  icon,
  right,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 px-5 pt-4 pb-3">
      <div className="flex min-w-0 items-center gap-2.5">
        {icon && (
          <div className="grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-white/[0.07] bg-white/[0.03] text-zinc-300">
            {icon}
          </div>
        )}
        <div className="min-w-0">
          <h3 className="truncate text-[13px] font-medium text-zinc-100">{title}</h3>
          {subtitle && <p className="truncate text-[11.5px] text-zinc-500">{subtitle}</p>}
        </div>
      </div>
      {right && <div className="shrink-0">{right}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Numbers                                                             */
/* ------------------------------------------------------------------ */

export function AnimatedNumber({
  value,
  format = formatNumber,
  className,
}: {
  value: number;
  format?: (n: number) => string;
  className?: string;
}) {
  const motionValue = useMotionValue(0);
  const spring = useSpring(motionValue, { stiffness: 110, damping: 22, mass: 0.7 });
  const text = useTransform(spring, (v) => format(v));

  useEffect(() => {
    motionValue.set(Number.isFinite(value) ? value : 0);
  }, [value, motionValue]);

  return <motion.span className={cx('tabular-nums', className)}>{text}</motion.span>;
}

/* ------------------------------------------------------------------ */
/* Badges                                                              */
/* ------------------------------------------------------------------ */

const OP_STYLES: Record<string, string> = {
  READ: 'text-cyan-300 bg-cyan-400/10 border-cyan-400/20',
  WRITE: 'text-violet-300 bg-violet-400/10 border-violet-400/20',
  CREATE: 'text-emerald-300 bg-emerald-400/10 border-emerald-400/20',
  UNKNOWN: 'text-zinc-300 bg-zinc-400/10 border-zinc-400/20',
};

export const OP_COLOR: Record<string, string> = {
  READ: '#22d3ee',
  WRITE: '#a78bfa',
  CREATE: '#34d399',
  UNKNOWN: '#a1a1aa',
};

export function OpBadge({ op, className }: { op: Op | null | undefined; className?: string }) {
  const key = op ?? 'UNKNOWN';
  return (
    <span
      className={cx(
        'inline-flex items-center rounded-md border px-1.5 py-[1px] font-mono text-[10.5px] font-medium tracking-wide',
        OP_STYLES[key] ?? OP_STYLES.UNKNOWN,
        className,
      )}
    >
      {key}
    </span>
  );
}

export function StatusBadge({ status, rejected }: { status: string; rejected?: boolean }) {
  const ok = status === 'OK';
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 rounded-md border px-1.5 py-[1px] font-mono text-[10.5px] font-medium',
        ok
          ? 'border-emerald-400/20 bg-emerald-400/10 text-emerald-300'
          : 'border-rose-400/25 bg-rose-400/10 text-rose-300',
      )}
    >
      <span className={cx('h-1.5 w-1.5 rounded-full', ok ? 'bg-emerald-400' : 'bg-rose-400')} />
      {rejected ? `REJECTED · ${status}` : status}
    </span>
  );
}

export function Pill({ children, tone = 'neutral', className }: { children: ReactNode; tone?: 'neutral' | 'good' | 'bad' | 'warn' | 'accent'; className?: string }) {
  const tones = {
    neutral: 'border-white/[0.08] bg-white/[0.03] text-zinc-300',
    good: 'border-emerald-400/20 bg-emerald-400/[0.08] text-emerald-300',
    bad: 'border-rose-400/25 bg-rose-400/[0.08] text-rose-300',
    warn: 'border-amber-400/25 bg-amber-400/[0.08] text-amber-300',
    accent: 'border-indigo-400/25 bg-indigo-400/[0.1] text-indigo-200',
  };
  return (
    <span className={cx('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium', tones[tone], className)}>
      {children}
    </span>
  );
}

export function StatusDot({ tone, pulse = false }: { tone: 'good' | 'bad' | 'warn' | 'idle'; pulse?: boolean }) {
  const color = {
    good: 'bg-emerald-400',
    bad: 'bg-rose-500',
    warn: 'bg-amber-400',
    idle: 'bg-zinc-500',
  }[tone];

  return (
    <span className="relative inline-flex h-2 w-2">
      {pulse && <span className={cx('absolute inline-flex h-full w-full animate-ping rounded-full opacity-60', color)} />}
      <span className={cx('relative inline-flex h-2 w-2 rounded-full', color)} />
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Buttons                                                             */
/* ------------------------------------------------------------------ */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  icon,
  children,
  className,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  loading?: boolean;
  icon?: ReactNode;
}) {
  const variants: Record<ButtonVariant, string> = {
    primary:
      'text-white border-indigo-300/20 bg-[linear-gradient(135deg,#6366f1,#8b5cf6_55%,#7c3aed)] shadow-[0_0_0_1px_rgba(255,255,255,0.06)_inset,0_8px_24px_-8px_rgba(124,58,237,0.65)] hover:brightness-110',
    secondary: 'text-zinc-200 border-white/[0.09] bg-white/[0.04] hover:bg-white/[0.07] hover:border-white/[0.14]',
    ghost: 'text-zinc-400 border-transparent hover:text-zinc-100 hover:bg-white/[0.05]',
    danger: 'text-rose-200 border-rose-400/20 bg-rose-500/10 hover:bg-rose-500/15',
  };

  const sizes = {
    sm: 'h-7 px-2.5 text-[12px] gap-1.5 rounded-lg',
    md: 'h-9 px-3.5 text-[13px] gap-2 rounded-[10px]',
  };

  return (
    <motion.button
      whileTap={disabled || loading ? undefined : { scale: 0.97 }}
      transition={{ type: 'spring', stiffness: 500, damping: 30 }}
      disabled={disabled || loading}
      className={cx(
        'inline-flex select-none items-center justify-center border font-medium transition-[background,border-color,filter,color] duration-200 disabled:cursor-not-allowed disabled:opacity-45',
        variants[variant],
        sizes[size],
        className,
      )}
      {...(rest as object)}
    >
      {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : icon}
      {children}
    </motion.button>
  );
}

/* ------------------------------------------------------------------ */
/* Skeleton / empty                                                    */
/* ------------------------------------------------------------------ */

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('skeleton', className)} />;
}

export function EmptyState({ icon, title, hint }: { icon: ReactNode; title: string; hint?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
      <div className="grid h-11 w-11 place-items-center rounded-2xl border border-white/[0.07] bg-white/[0.025] text-zinc-500">
        {icon}
      </div>
      <div>
        <p className="text-[13px] font-medium text-zinc-300">{title}</p>
        {hint && <p className="mt-1 max-w-sm text-[12px] leading-relaxed text-zinc-500">{hint}</p>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Modal                                                               */
/* ------------------------------------------------------------------ */

export function Modal({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  width = 'max-w-lg',
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
        >
          <motion.div
            className="absolute inset-0 bg-black/60 backdrop-blur-[6px]"
            onClick={onClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          />
          <motion.div
            role="dialog"
            aria-modal="true"
            initial={{ opacity: 0, y: 18, scale: 0.96, filter: 'blur(6px)' }}
            animate={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
            exit={{ opacity: 0, y: 10, scale: 0.97, filter: 'blur(4px)' }}
            transition={{ type: 'spring', stiffness: 380, damping: 32 }}
            className={cx(
              'relative w-full overflow-hidden rounded-2xl border border-white/[0.09] bg-ink-850/95 shadow-[0_30px_80px_-20px_rgba(0,0,0,0.85)]',
              width,
            )}
          >
            <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-indigo-300/40 to-transparent" />
            <div className="flex items-start justify-between gap-4 px-6 pt-5 pb-4">
              <div>
                <h2 className="text-[15px] font-semibold text-zinc-100">{title}</h2>
                {subtitle && <p className="mt-1 text-[12.5px] text-zinc-500">{subtitle}</p>}
              </div>
              <button
                onClick={onClose}
                className="rounded-lg p-1.5 text-zinc-500 transition hover:bg-white/[0.06] hover:text-zinc-200"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="px-6 pb-5">{children}</div>
            {footer && (
              <div className="flex items-center justify-end gap-2 border-t border-white/[0.06] bg-white/[0.015] px-6 py-3.5">
                {footer}
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/* ------------------------------------------------------------------ */
/* Page header                                                         */
/* ------------------------------------------------------------------ */

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-zinc-50">{title}</h1>
        <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-zinc-500">{description}</p>
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
