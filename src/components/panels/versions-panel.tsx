'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Clock,
  Eye,
  FileText,
  History,
  Loader2,
  RotateCcw,
  Trash2,
  GitCompareArrows,
} from 'lucide-react';
import { usePreferences, useT, type Locale } from '@/lib/preferences';
import { Modal, TextInput } from '@/components/ui';
import { EmptyState, NoResultsNote, ViewSearchRow, formatSize, type TreeEntry } from '@/components/panels/views-left';
import { ProvenanceModal } from '@/components/panels/provenance-modal';
import { computeLineDiff, type DiffRow } from '@/lib/diff';
import type { SnapshotMeta, SnapshotReason } from '@/lib/versions/types';

// Tab "Riwayat Versi": tiap bab di dokumen/ punya daftar versi (snapshot) isi
// bab sebelum ditulis ulang. Store-nya file di <project>/.riwayat/.
// Kontrak API: /api/projects/<slug>/versions (+ /versions/restore).

type TranslateFn = (key: string, vars?: Record<string, string | number>) => string;

const REASON_KEY: Record<SnapshotReason, string> = {
  edit: 'versions.reasonEdit',
  agent: 'versions.reasonAgent',
  analysis: 'versions.reasonAnalysis',
  restore: 'versions.reasonRestore',
  reject: 'versions.reasonReject',
  manual: 'versions.reasonManual',
  word: 'versions.reasonWord',
};

function reasonLabel(t: TranslateFn, reason: SnapshotReason): string {
  return t(REASON_KEY[reason] ?? 'versions.reasonEdit');
}

function formatDateTime(iso: string, locale: Locale): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(locale === 'id' ? 'id-ID' : 'en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Sidecar snapshot → SnapshotMeta; bentuk rusak dilewati, bukan bikin crash. */
function parseSnapshot(value: unknown): SnapshotMeta | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Partial<SnapshotMeta>;
  if (typeof v.path !== 'string' || v.path === '') return null;
  if (typeof v.file !== 'string' || v.file === '') return null;
  if (typeof v.savedAt !== 'string' || v.savedAt === '') return null;
  if (typeof v.reason !== 'string') return null;
  return {
    path: v.path,
    savedAt: v.savedAt,
    reason: v.reason as SnapshotReason,
    bytes: typeof v.bytes === 'number' && Number.isFinite(v.bytes) ? v.bytes : 0,
    hash: typeof v.hash === 'string' ? v.hash : '',
    file: v.file,
    dir: typeof v.dir === 'string' ? v.dir : '',
  };
}

/** Bab = file .md di folder dokumen/ (dari API tree). */
function chapterPathsFromTree(value: unknown): string[] {
  const tree =
    value && typeof value === 'object' && Array.isArray((value as { tree?: unknown }).tree)
      ? ((value as { tree: unknown[] }).tree)
      : [];
  return tree
    .filter((entry): entry is TreeEntry => {
      if (!entry || typeof entry !== 'object') return false;
      const e = entry as Partial<TreeEntry>;
      return (
        e.type === 'file' &&
        typeof e.path === 'string' &&
        e.path.startsWith('dokumen/') &&
        e.path.endsWith('.md')
      );
    })
    .map((entry) => entry.path)
    .sort();
}

/** Chip aksi kecil (gaya sama chip di panel Revisi). */
const chipClass =
  'inline-flex cursor-pointer items-center gap-1 rounded-full border border-border bg-card px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

export function VersionsPanel({ slug }: { slug: string }) {
  const t = useT();
  const [provOpen, setProvOpen] = useState(false);
  const { locale } = usePreferences();
  const [chapters, setChapters] = useState<string[]>([]);
  const [snapshots, setSnapshots] = useState<SnapshotMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [query, setQuery] = useState('');
  /** Pencarian terpisah untuk modal pilih bab (supaya gak ngerubah filter utama). */
  const [pickerQuery, setPickerQuery] = useState('');
  const [note, setNote] = useState<{ text: string; tone: 'ok' | 'error' } | null>(null);
  /** Bab yang daftar versinya dibuka. */
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pendingRestore, setPendingRestore] = useState<SnapshotMeta | null>(null);
  const [pendingDelete, setPendingDelete] = useState<SnapshotMeta | null>(null);
  const [diffView, setDiffView] = useState<{
    meta: SnapshotMeta;
    rows: DiffRow[];
    added: number;
    removed: number;
  } | null>(null);
  const [preview, setPreview] = useState<{ meta: SnapshotMeta; content: string } | null>(null);

  const fetchChapters = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(slug)}/tree`);
      const data: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        setChapters([]);
        return;
      }
      setChapters(chapterPathsFromTree(data));
    } catch {
      setChapters([]);
    }
  }, [slug]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [treeRes, versionsRes] = await Promise.all([
        fetch(`/api/projects/${encodeURIComponent(slug)}/tree`),
        fetch(`/api/projects/${encodeURIComponent(slug)}/versions`),
      ]);
      const treeData: unknown = await treeRes.json().catch(() => null);
      const versionsData: unknown = await versionsRes.json().catch(() => null);
      if (!treeRes.ok) {
        setError(true);
        setChapters([]);
        setSnapshots([]);
        return;
      }
      setChapters(chapterPathsFromTree(treeData));
      const raw =
        versionsRes.ok &&
        versionsData &&
        typeof versionsData === 'object' &&
        Array.isArray((versionsData as { snapshots?: unknown }).snapshots)
          ? ((versionsData as { snapshots: unknown[] }).snapshots)
          : [];
      setSnapshots(raw.map(parseSnapshot).filter((item): item is SnapshotMeta => item !== null));
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => {
    setSnapshots([]);
    setNote(null);
    setOpen(new Set());
    void fetchData();
  }, [slug, fetchData]);

  // Bab baru / bab dihapus → daftar bab ikut berubah.
  useEffect(() => {
    const refresh = () => void fetchChapters();
    window.addEventListener('workspace:tree-refresh', refresh);
    return () => window.removeEventListener('workspace:tree-refresh', refresh);
  }, [fetchChapters]);

  const byChapter = useMemo(() => {
    const map = new Map<string, SnapshotMeta[]>();
    for (const item of snapshots) {
      const list = map.get(item.path);
      if (list) list.push(item);
      else map.set(item.path, [item]);
    }
    return map;
  }, [snapshots]);

  const q = query.trim().toLowerCase();
  const visibleChapters = useMemo(
    () =>
      q === ''
        ? chapters
        : chapters.filter((path) => path.toLowerCase().includes(q)),
    [chapters, q],
  );

  const toggleChapter = (path: string) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  /** Isi snapshot + isi bab sekarang → diff baris (gaya sama dgn modal diff editor). */
  const openDiff = useCallback(
    async (meta: SnapshotMeta) => {
      setBusy(true);
      try {
        const [snapRes, fileRes] = await Promise.all([
          fetch(
            `/api/projects/${encodeURIComponent(slug)}/versions?path=${encodeURIComponent(meta.path)}&file=${encodeURIComponent(meta.file)}`,
          ),
          fetch(`/api/projects/${encodeURIComponent(slug)}/file?path=${encodeURIComponent(meta.path)}`),
        ]);
        const snapData: unknown = await snapRes.json().catch(() => null);
        const fileData: unknown = await fileRes.json().catch(() => null);
        if (!snapRes.ok) {
          setNote({ text: t('versions.loadFail'), tone: 'error' });
          return;
        }
        const snapshotContent =
          snapData && typeof snapData === 'object' && typeof (snapData as { content?: unknown }).content === 'string'
            ? ((snapData as { content: string }).content)
            : '';
        const current =
          fileRes.ok &&
          fileData &&
          typeof fileData === 'object' &&
          typeof (fileData as { content?: unknown }).content === 'string'
            ? ((fileData as { content: string }).content)
            : '';
        const rows = computeLineDiff(snapshotContent, current);
        setDiffView({
          meta,
          rows,
          added: rows.filter((row) => row.type === 'add').length,
          removed: rows.filter((row) => row.type === 'del').length,
        });
      } catch {
        setNote({ text: t('versions.loadFail'), tone: 'error' });
      } finally {
        setBusy(false);
      }
    },
    [slug, t],
  );

  const openPreview = useCallback(
    async (meta: SnapshotMeta) => {
      setBusy(true);
      try {
        const res = await fetch(
          `/api/projects/${encodeURIComponent(slug)}/versions?path=${encodeURIComponent(meta.path)}&file=${encodeURIComponent(meta.file)}`,
        );
        const data: unknown = await res.json().catch(() => null);
        if (!res.ok) {
          setNote({ text: t('versions.loadFail'), tone: 'error' });
          return;
        }
        const content =
          data && typeof data === 'object' && typeof (data as { content?: unknown }).content === 'string'
            ? ((data as { content: string }).content)
            : '';
        setPreview({ meta, content });
      } catch {
        setNote({ text: t('versions.loadFail'), tone: 'error' });
      } finally {
        setBusy(false);
      }
    },
    [slug, t],
  );

  const performRestore = useCallback(async () => {
    if (!pendingRestore) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(slug)}/versions/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: pendingRestore.path, file: pendingRestore.file }),
      });
      if (!res.ok) {
        setNote({ text: t('versions.saveFail'), tone: 'error' });
        return;
      }
      setNote({ text: t('versions.restored'), tone: 'ok' });
      setPendingRestore(null);
      window.dispatchEvent(
        new CustomEvent('workspace:file-restored', { detail: { path: pendingRestore.path } }),
      );
      window.dispatchEvent(new CustomEvent('workspace:tree-refresh'));
      await fetchData();
    } catch {
      setNote({ text: t('versions.saveFail'), tone: 'error' });
    } finally {
      setBusy(false);
    }
  }, [pendingRestore, slug, t, fetchData]);

  const performDelete = useCallback(async () => {
    if (!pendingDelete) return;
    setBusy(true);
    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(slug)}/versions?path=${encodeURIComponent(pendingDelete.path)}&file=${encodeURIComponent(pendingDelete.file)}`,
        { method: 'DELETE' },
      );
      if (!res.ok) {
        setNote({ text: t('versions.saveFail'), tone: 'error' });
        return;
      }
      setNote({ text: t('versions.deleted'), tone: 'ok' });
      setPendingDelete(null);
      await fetchData();
    } catch {
      setNote({ text: t('versions.saveFail'), tone: 'error' });
    } finally {
      setBusy(false);
    }
  }, [pendingDelete, slug, t, fetchData]);

  /** Simpan versi manual dari isi bab yang ada di disk sekarang. */
  const saveManual = useCallback(
    async (path: string) => {
      setBusy(true);
      try {
        const res = await fetch(`/api/projects/${encodeURIComponent(slug)}/versions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path, reason: 'manual' }),
        });
        if (!res.ok) {
          setNote({ text: t('versions.saveFail'), tone: 'error' });
          return;
        }
        setNote({ text: t('versions.snapshotSaved'), tone: 'ok' });
        setPickerOpen(false);
        setOpen((prev) => new Set(prev).add(path));
        await fetchData();
      } catch {
        setNote({ text: t('versions.saveFail'), tone: 'error' });
      } finally {
        setBusy(false);
      }
    },
    [slug, t, fetchData],
  );

  return (
    <div className="flex min-h-full flex-col">
      <div className="shrink-0 px-2 py-2">
        <ViewSearchRow
          searchPh={t('versions.searchPlaceholder')}
          filter={query}
          onFilter={setQuery}
          onPlus={() => {
            setPickerQuery('');
            setPickerOpen(true);
          }}
          plusTitle={t('versions.addAction')}
          plusBusy={busy}
        />
        {chapters.length > 0 && (
          <button
            type="button"
            onClick={() => setProvOpen(true)}
            title={t('prov.hint')}
            className="mt-1.5 inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <GitCompareArrows size={12} />
            {t('prov.action')}
          </button>
        )}
      </div>

      {note && (
        <p
          className={`shrink-0 px-3 pb-1.5 text-[11px] ${
            note.tone === 'error' ? 'text-destructive' : 'text-accent'
          }`}
          role="status"
        >
          {note.text}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {loading ? (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">…</p>
        ) : error ? (
          <p className="px-3 py-6 text-center text-xs text-destructive">{t('versions.loadFail')}</p>
        ) : chapters.length === 0 ? (
          <EmptyState
            icon={History}
            title={t('versions.emptyTitle')}
            desc={t('versions.emptyDesc')}
          />
        ) : visibleChapters.length === 0 ? (
          <NoResultsNote />
        ) : (
          <ul className="flex flex-col gap-1 px-2 pb-2">
            {visibleChapters.map((path) => {
              const list = byChapter.get(path) ?? [];
              const isOpen = open.has(path);
              return (
                <li key={path} className="rounded-md border border-border bg-card p-2">
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => toggleChapter(path)}
                      aria-expanded={isOpen}
                      title={path}
                      className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left"
                    >
                      {isOpen ? (
                        <ChevronDown size={13} className="shrink-0 text-muted-foreground" />
                      ) : (
                        <ChevronRight size={13} className="shrink-0 text-muted-foreground" />
                      )}
                      <FileText size={13} className="shrink-0 text-muted-foreground" />
                      <span className="truncate text-[11px] font-medium text-foreground">
                        {path.replace(/^dokumen\//, '')}
                      </span>
                    </button>
                    <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      {t('versions.chapterCount', { n: list.length })}
                    </span>
                  </div>

                  {isOpen &&
                    (list.length === 0 ? (
                      <p className="mt-1.5 px-1 text-[10px] leading-snug text-muted-foreground">
                        {t('versions.noHistory')}
                      </p>
                    ) : (
                      <ul className="mt-1.5 space-y-1">
                        {list.map((meta) => (
                          <li key={meta.file} className="rounded border border-border bg-background p-1.5">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <Clock size={11} className="shrink-0 text-muted-foreground" />
                              <span className="text-[11px] text-foreground">
                                {formatDateTime(meta.savedAt, locale)}
                              </span>
                              <span className="font-mono text-[10px] text-muted-foreground">
                                {formatSize(meta.bytes)}
                              </span>
                              <span className="ml-auto rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                                {reasonLabel(t, meta.reason)}
                              </span>
                            </div>
                            <div className="mt-1 flex flex-wrap items-center gap-1">
                              <button
                                type="button"
                                onClick={() => void openDiff(meta)}
                                disabled={busy}
                                className={chipClass}
                              >
                                <History size={10} />
                                {t('versions.viewDiff')}
                              </button>
                              <button
                                type="button"
                                onClick={() => void openPreview(meta)}
                                disabled={busy}
                                className={chipClass}
                              >
                                <Eye size={10} />
                                {t('versions.preview')}
                              </button>
                              <button
                                type="button"
                                onClick={() => setPendingRestore(meta)}
                                disabled={busy}
                                className={chipClass}
                              >
                                <RotateCcw size={10} />
                                {t('versions.restore')}
                              </button>
                              <button
                                type="button"
                                onClick={() => setPendingDelete(meta)}
                                disabled={busy}
                                className={`${chipClass} hover:text-destructive`}
                              >
                                <Trash2 size={10} />
                                {t('versions.deleteSnapshot')}
                              </button>
                            </div>
                          </li>
                        ))}
                      </ul>
                    ))}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <Modal open={pickerOpen} onClose={() => setPickerOpen(false)} title={t('versions.addTitle')}>
        <TextInput
          value={pickerQuery}
          onChange={(event) => setPickerQuery(event.target.value)}
          placeholder={t('versions.pickerSearch')}
          aria-label={t('versions.pickerSearch')}
          className="h-9 text-xs"
        />
        <div className="mt-2 max-h-[45vh] overflow-y-auto rounded-md border border-border">
          {chapters.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">
              {t('versions.pickerEmpty')}
            </p>
          ) : (
            <ul>
              {chapters
                .filter(
                  (path) =>
                    pickerQuery.trim() === '' ||
                    path.toLowerCase().includes(pickerQuery.trim().toLowerCase()),
                )
                .map((path) => (
                  <li key={path} className="border-b border-border last:border-b-0">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void saveManual(path)}
                      className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-xs text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <FileText size={12} className="shrink-0 text-muted-foreground" />
                      <span className="truncate">{path}</span>
                    </button>
                  </li>
                ))}
            </ul>
          )}
        </div>
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={() => setPickerOpen(false)}
            className="cursor-pointer rounded-md px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
          >
            {t('common.close')}
          </button>
        </div>
      </Modal>

      <Modal open={!!pendingRestore} onClose={() => setPendingRestore(null)} title={t('versions.restoreTitle')}>
        <p className="text-sm text-foreground">
          {t('versions.restoreConfirm', {
            date: pendingRestore ? formatDateTime(pendingRestore.savedAt, locale) : '',
          })}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => setPendingRestore(null)}
            disabled={busy}
            className="cursor-pointer rounded-md px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={() => void performRestore()}
            disabled={busy}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />}
            {t('versions.restore')}
          </button>
        </div>
      </Modal>

      <Modal open={!!pendingDelete} onClose={() => setPendingDelete(null)} title={t('versions.deleteTitle')}>
        <p className="text-sm text-foreground">
          {t('versions.deleteConfirm', {
            date: pendingDelete ? formatDateTime(pendingDelete.savedAt, locale) : '',
          })}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => setPendingDelete(null)}
            disabled={busy}
            className="cursor-pointer rounded-md px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={() => void performDelete()}
            disabled={busy}
            className="cursor-pointer rounded-md bg-destructive px-3 py-1.5 text-sm font-medium text-destructive-foreground transition-colors hover:bg-destructive/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('common.delete')}
          </button>
        </div>
      </Modal>

      {/* Diff versi vs isi bab sekarang — gaya sama dgn modal diff di editor. */}
      <Modal
        open={diffView !== null}
        onClose={() => setDiffView(null)}
        title={t('versions.diffTitle')}
        wide
      >
        {diffView && (
          <>
            <p className="mb-2 text-[11px] text-muted-foreground">{t('versions.diffHint')}</p>
            <div className="mb-2 font-mono text-[11px]">
              <span className="text-green-700 dark:text-green-400">+{diffView.added}</span>{' '}
              <span className="text-red-700 dark:text-red-400">−{diffView.removed}</span>
            </div>
            <div className="max-h-[55vh] overflow-y-auto rounded-md border border-border bg-muted/40 font-mono text-[11px] leading-4">
              {diffView.rows.map((row, index) => (
                <div
                  key={`${row.type}:${index}`}
                  className={
                    row.type === 'add'
                      ? 'bg-green-50 px-3 py-px text-green-800 dark:bg-green-950/40 dark:text-green-300'
                      : row.type === 'del'
                        ? 'bg-red-50 px-3 py-px text-red-800 dark:bg-red-950/40 dark:text-red-300'
                        : 'px-3 py-px text-muted-foreground'
                  }
                >
                  <span className="inline-block w-4 shrink-0 select-none">
                    {row.type === 'add' ? '+' : row.type === 'del' ? '−' : ' '}
                  </span>
                  <span className="whitespace-pre-wrap break-words">{row.text || ' '}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </Modal>

      <Modal
        open={preview !== null}
        onClose={() => setPreview(null)}
        title={t('versions.previewTitle')}
        wide
      >
        {preview && (
          <pre className="max-h-[55vh] overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/40 p-3 font-mono text-[11px] leading-4 text-foreground">
            {preview.content}
          </pre>
        )}
      </Modal>
      {provOpen && (
        <ProvenanceModal slug={slug} chapters={chapters} onClose={() => setProvOpen(false)} />
      )}
    </div>
  );
}
