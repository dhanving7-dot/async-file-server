import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  ArrowDownAZ,
  Clock,
  FileCode2,
  FilePlus2,
  FileText,
  FolderOpen,
  HardDrive,
  Lock,
  RefreshCw,
  Save,
  Search,
  Undo2,
} from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { cx, formatBytes, formatDate, formatMs, formatRelative } from '../lib/format';
import { isOnline, useStore } from '../lib/store';
import { toast } from '../lib/toast';
import type { FileEntry, OperationResult } from '../lib/types';
import { Button, Card, EmptyState, Modal, OpBadge, PageHeader, Skeleton, StatusBadge } from '../components/ui';

const FILENAME_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;

type Sort = 'name' | 'size' | 'modified';

interface OpenFile {
  name: string;
  original: string;
  content: string;
  encoding: 'utf8' | 'base64';
  bytes: number;
}

export default function Files() {
  const online = useStore(isOnline);
  const filesVersion = useStore((s) => s.filesVersion);

  const [files, setFiles] = useState<FileEntry[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>('name');

  const [selected, setSelected] = useState<string | null>(null);
  const [open, setOpen] = useState<OpenFile | null>(null);
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [lastOp, setLastOp] = useState<OperationResult | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const loadFiles = useCallback(async () => {
    setRefreshing(true);
    try {
      const listing = await api.files();
      setFiles(listing.files);
      setListError(null);
    } catch (err) {
      setListError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setRefreshing(false);
    }
  }, []);

  // Re-list whenever the server reports a successful WRITE/CREATE (debounced).
  useEffect(() => {
    if (!online) return;
    const t = setTimeout(loadFiles, files ? 250 : 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filesVersion, online, loadFiles]);

  const readFile = useCallback(async (name: string) => {
    setSelected(name);
    setReading(true);
    try {
      const result = await api.read(name);
      setLastOp(result);
      const content = result.encoding === 'base64' ? '' : result.content ?? '';
      setOpen({ name, original: content, content, encoding: result.encoding ?? 'utf8', bytes: result.bytes });
    } catch (err) {
      const body = err instanceof ApiError ? (err.body as OperationResult | undefined) : undefined;
      if (body?.requestId) setLastOp(body);
      setOpen(null);
      toast('error', `READ ${name} failed`, err instanceof ApiError ? err.message : String(err));
    } finally {
      setReading(false);
    }
  }, []);

  const save = useCallback(async () => {
    if (!open || open.encoding !== 'utf8') return;
    setSaving(true);
    try {
      const result = await api.write(open.name, open.content);
      setLastOp(result);
      setOpen({ ...open, original: open.content, bytes: result.bytes });
      toast('success', `WRITE ${open.name} completed`, `request #${result.requestId} · ${formatBytes(result.bytes)} written by the C server`);
    } catch (err) {
      const body = err instanceof ApiError ? (err.body as OperationResult | undefined) : undefined;
      if (body?.requestId) setLastOp(body);
      toast('error', `WRITE ${open.name} failed`, err instanceof ApiError ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [open]);

  // Ctrl/Cmd + S saves.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = (files ?? []).filter((f) => !q || f.name.toLowerCase().includes(q));
    return list.sort((a, b) =>
      sort === 'name' ? a.name.localeCompare(b.name) : sort === 'size' ? b.size - a.size : b.modified - a.modified,
    );
  }, [files, query, sort]);

  const totalBytes = (files ?? []).reduce((n, f) => n + f.size, 0);
  const dirty = !!open && open.content !== open.original;

  return (
    <div>
      <PageHeader
        title="File manager"
        description="The server's files/ directory. Listing uses the LIST command; opening a file is a real READ and saving is a real WRITE executed by a worker thread."
        actions={
          <>
            <Button size="sm" icon={<RefreshCw className={cx('h-3.5 w-3.5', refreshing && 'animate-spin')} />} onClick={loadFiles} disabled={!online}>
              Refresh
            </Button>
            <Button size="sm" variant="primary" icon={<FilePlus2 className="h-3.5 w-3.5" />} onClick={() => setCreateOpen(true)} disabled={!online}>
              New file
            </Button>
          </>
        }
      />

      <div className="grid gap-3 xl:grid-cols-[minmax(340px,0.9fr)_1.6fr]">
        {/* ------------------------------ list ------------------------------ */}
        <Card className="flex max-h-[calc(100vh-190px)] min-h-[420px] flex-col overflow-hidden" interactive={false}>
          <div className="flex items-center gap-2 border-b border-white/[0.05] p-3">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter files" className="input !py-1.5 !pl-8 !text-[12.5px]" />
            </div>
            <div className="flex rounded-lg border border-white/[0.07] bg-white/[0.02] p-0.5">
              {([
                ['name', ArrowDownAZ],
                ['size', HardDrive],
                ['modified', Clock],
              ] as const).map(([key, Icon]) => (
                <button
                  key={key}
                  title={`Sort by ${key}`}
                  onClick={() => setSort(key)}
                  className={cx('rounded-md p-1.5', sort === key ? 'bg-white/[0.08] text-zinc-100' : 'text-zinc-500 hover:text-zinc-300')}
                >
                  <Icon className="h-3.5 w-3.5" />
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center justify-between px-4 py-2 text-[11px] text-zinc-500">
            <span className="font-mono">files/</span>
            <span>
              {files ? `${files.length} files · ${formatBytes(totalBytes)}` : '—'}
            </span>
          </div>

          <div className="flex-1 overflow-y-auto px-2 pb-2">
            {files === null && !listError ? (
              <div className="space-y-1.5 p-2">
                {Array.from({ length: 8 }).map((_, i) => (
                  <Skeleton key={i} className="h-11" />
                ))}
              </div>
            ) : listError && !files ? (
              <EmptyState icon={<FolderOpen className="h-5 w-5" />} title="Could not list files" hint={listError} />
            ) : visible.length === 0 ? (
              <EmptyState icon={<FolderOpen className="h-5 w-5" />} title={query ? 'No matching files' : 'No files yet'} hint="Create one with “New file”." />
            ) : (
              <AnimatePresence initial={false}>
                {visible.map((f) => (
                  <motion.button
                    key={f.name}
                    layout="position"
                    initial={{ opacity: 0, x: -8 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0 }}
                    disabled={!f.accessible || !online}
                    onClick={() => readFile(f.name)}
                    className={cx(
                      'group relative flex w-full items-center gap-3 rounded-[10px] px-3 py-2 text-left transition-colors disabled:opacity-50',
                      selected === f.name ? 'bg-indigo-400/[0.09]' : 'hover:bg-white/[0.03]',
                    )}
                  >
                    {selected === f.name && <motion.span layoutId="file-sel" className="absolute top-2 bottom-2 left-0 w-[2px] rounded-full bg-indigo-300" />}
                    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-white/[0.07] bg-white/[0.025] text-zinc-400 group-hover:text-zinc-200">
                      {f.accessible ? <FileText className="h-4 w-4" /> : <Lock className="h-3.5 w-3.5" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-[12.5px] text-zinc-200">{f.name}</span>
                      <span className="block text-[11px] text-zinc-500" title={formatDate(f.modified)}>
                        {formatBytes(f.size)} · modified {formatRelative(f.modified)}
                      </span>
                    </span>
                  </motion.button>
                ))}
              </AnimatePresence>
            )}
          </div>
        </Card>

        {/* ----------------------------- editor ----------------------------- */}
        <Card className="flex max-h-[calc(100vh-190px)] min-h-[420px] flex-col overflow-hidden" interactive={false}>
          {!selected ? (
            <div className="flex flex-1 items-center justify-center">
              <EmptyState icon={<FileCode2 className="h-5 w-5" />} title="Select a file to open it" hint="Opening issues a READ request to the C server; the content shown is exactly what the worker returned." />
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-3 border-b border-white/[0.05] px-4 py-3">
                <FileCode2 className="h-4 w-4 text-indigo-300" />
                <span className="font-mono text-[13px] text-zinc-100">{selected}</span>
                <AnimatePresence>
                  {dirty && (
                    <motion.span
                      initial={{ opacity: 0, scale: 0.8 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.8 }}
                      className="rounded-md bg-amber-400/10 px-1.5 py-0.5 text-[10.5px] text-amber-300"
                    >
                      unsaved
                    </motion.span>
                  )}
                </AnimatePresence>
                <div className="ml-auto flex items-center gap-2">
                  <Button size="sm" variant="ghost" icon={<Undo2 className="h-3.5 w-3.5" />} disabled={!dirty} onClick={() => open && setOpen({ ...open, content: open.original })}>
                    Revert
                  </Button>
                  <Button size="sm" icon={<RefreshCw className={cx('h-3.5 w-3.5', reading && 'animate-spin')} />} onClick={() => readFile(selected)} disabled={!online || reading}>
                    Read
                  </Button>
                  <Button
                    size="sm"
                    variant="primary"
                    icon={<Save className="h-3.5 w-3.5" />}
                    loading={saving}
                    onClick={save}
                    disabled={!online || !open || open.encoding !== 'utf8' || !dirty}
                  >
                    Write <span className="kbd ml-1 !border-white/20 !bg-white/10 !text-white/80">Ctrl S</span>
                  </Button>
                </div>
              </div>

              <div className="relative min-h-0 flex-1">
                {reading && !open ? (
                  <div className="space-y-2 p-5">
                    {Array.from({ length: 10 }).map((_, i) => (
                      <Skeleton key={i} className="h-3.5" />
                    ))}
                  </div>
                ) : open && open.encoding === 'base64' ? (
                  <EmptyState icon={<Lock className="h-5 w-5" />} title="Binary file" hint={`${formatBytes(open.bytes)} read successfully. Binary content is not editable as text.`} />
                ) : open ? (
                  <Editor value={open.content} onChange={(content) => setOpen({ ...open, content })} disabled={!online} />
                ) : (
                  <EmptyState icon={<FileText className="h-5 w-5" />} title="File could not be read" hint="See the operation result below." />
                )}
                {reading && open && <div className="absolute inset-x-0 top-0 h-[2px] overflow-hidden"><div className="h-full w-1/3 animate-scan bg-indigo-300/80" /></div>}
              </div>

              <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-white/[0.05] bg-black/20 px-4 py-2.5 text-[11px] text-zinc-500">
                {lastOp ? (
                  <>
                    <span className="text-zinc-400">Last operation</span>
                    <OpBadge op={lastOp.op} />
                    <span className="font-mono text-zinc-300">request #{lastOp.requestId}</span>
                    <StatusBadge status={lastOp.status} />
                    <span className="font-mono">{formatBytes(lastOp.bytes)}</span>
                    <span className="font-mono">round trip {formatMs(lastOp.roundTripMs)}</span>
                    {lastOp.message && <span className="truncate font-mono">{lastOp.message}</span>}
                  </>
                ) : (
                  <span>No operation yet</span>
                )}
                {open && <span className="ml-auto font-mono">{open.content.split('\n').length.toLocaleString()} lines · {formatBytes(new TextEncoder().encode(open.content).length)}</span>}
              </div>
            </>
          )}
        </Card>
      </div>

      <CreateFileModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        existing={files ?? []}
        onCreated={(name) => {
          loadFiles();
          readFile(name);
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Editor with line numbers                                            */
/* ------------------------------------------------------------------ */

function Editor({ value, onChange, disabled }: { value: string; onChange: (v: string) => void; disabled?: boolean }) {
  const gutter = useRef<HTMLDivElement>(null);
  const lines = useMemo(() => {
    const count = Math.min(value.split('\n').length, 200_000);
    let out = '';
    for (let i = 1; i <= count; i++) out += i + '\n';
    return out;
  }, [value]);

  return (
    <div className="absolute inset-0 flex font-mono text-[12.5px] leading-[1.65]">
      <div
        ref={gutter}
        aria-hidden
        className="w-14 shrink-0 overflow-hidden border-r border-white/[0.04] bg-black/20 py-4 pr-3 text-right text-zinc-600 select-none"
      >
        <pre className="font-mono">{lines}</pre>
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onScroll={(e) => {
          if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop;
        }}
        disabled={disabled}
        spellCheck={false}
        wrap="off"
        className="flex-1 resize-none bg-transparent px-4 py-4 text-zinc-200 caret-indigo-300 outline-none placeholder:text-zinc-600 disabled:opacity-60"
        placeholder="Empty file"
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Create modal                                                        */
/* ------------------------------------------------------------------ */

function CreateFileModal({
  open,
  onClose,
  existing,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  existing: FileEntry[];
  onCreated: (name: string) => void;
}) {
  const [name, setName] = useState('');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setName('');
      setContent('');
    }
  }, [open]);

  const valid = FILENAME_RE.test(name);
  const exists = existing.some((f) => f.name === name);
  const error = !name ? null : !valid ? 'Use letters, digits, “.”, “_” or “-” (max 128, not starting with “.”).' : exists ? 'A file with this name already exists.' : null;

  async function create() {
    if (!valid) return;
    setBusy(true);
    try {
      const result = await api.create(name, content || undefined);
      const ids = [result.create?.requestId, result.requestId].filter(Boolean).map((id) => `#${id}`).join(' + ');
      toast('success', `Created ${name}`, `CREATE${content ? ' + WRITE' : ''} · request ${ids} · confirmed by the C server`);
      onClose();
      onCreated(name);
    } catch (err) {
      toast('error', `CREATE ${name} failed`, err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Create a file"
      subtitle="Sends CREATE (O_CREAT | O_EXCL) to the server, then WRITE if you add initial content."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={create} loading={busy} disabled={!valid || exists} icon={<FilePlus2 className="h-3.5 w-3.5" />}>
            Create file
          </Button>
        </>
      }
    >
      <label className="block">
        <span className="mb-1.5 block text-[12px] text-zinc-400">Filename</span>
        <div className="flex items-center rounded-[0.65rem] border border-white/[0.08] bg-white/[0.03] pl-3 focus-within:border-indigo-400/50">
          <span className="font-mono text-[12.5px] text-zinc-500">files/</span>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !error && create()}
            placeholder="notes.txt"
            className="w-full bg-transparent px-1 py-2 font-mono text-[12.5px] text-zinc-100 outline-none placeholder:text-zinc-600"
          />
        </div>
        <AnimatePresence>
          {error && (
            <motion.span initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="mt-1.5 block text-[11.5px] text-rose-300">
              {error}
            </motion.span>
          )}
        </AnimatePresence>
      </label>
      <label className="mt-4 block">
        <span className="mb-1.5 block text-[12px] text-zinc-400">Initial content (optional)</span>
        <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={5} className="input resize-none font-mono" placeholder="Leave empty to create an empty file" />
      </label>
    </Modal>
  );
}
