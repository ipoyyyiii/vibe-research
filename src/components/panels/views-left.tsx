'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent as ReactDragEvent,
} from 'react';
import {
  Calculator,
  FileText,
  FileUp,
  Image as ImageIcon,
  Loader2,
  Play,
  Plus,
  Search,
  ShieldCheck,
  Sigma,
  Table2,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useT } from '@/lib/preferences';
import { requestNewDocument } from '@/components/panels/new-doc-modal';
import { InsertResultModal } from '@/components/panels/insert-result-modal';
import { AnalysisRunModal } from '@/components/panels/analysis-run-modal';
import { SampleSizeModal } from '@/components/panels/sample-size-modal';
import { FormsImportModal } from '@/components/panels/forms-import-modal';
import { SimilarityModal } from '@/components/panels/similarity-modal';
import { Button, Modal } from '@/components/ui';

// ── Views panel kiri berbasis TUJUAN (mental model beeblio) ───────────────────
// Draf, Gambar, Data — semuanya memfilter isi tree (GET /api/projects/<slug>/tree)
// secara client-side, gak butuh API baru. Berkas gambar/data dibuka lewat route
// binary raw project (koordinator): /api/projects/<slug>/raw?path=…

/** Satu baris tree — bentuk persis respons GET /api/projects/<slug>/tree. */
export type TreeEntry = {
  path: string; // relatif dari root project, pemisah selalu '/'
  name: string;
  type: 'dir' | 'file';
  size: number;
};

/** Referensi PDF untuk section di panel Jurnal. */
export type PdfRef = {
  path: string;
  name: string;
  size: number;
};

/** URL tampilan/unduhan mentah berkas project (route binary). */
export function rawUrl(slug: string, path: string): string {
  return `/api/projects/${encodeURIComponent(slug)}/raw?path=${encodeURIComponent(path)}`;
}

// ── Helper murni ─────────────────────────────────────────────────────────────
const parentPathOf = (path: string): string => {
  const index = path.lastIndexOf('/');
  return index === -1 ? '' : path.slice(0, index);
};

const extOf = (name: string): string => {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
};

const stripExt = (name: string, ext: string): string =>
  name.toLowerCase().endsWith(ext) ? name.slice(0, name.length - ext.length - 1) : name;

const byName = (a: TreeEntry, b: TreeEntry): number =>
  a.name.toLowerCase().localeCompare(b.name.toLowerCase());

/** Ukuran pendek buat tampilan font-mono: "240 B" / "12 KB" / "1,3 MB". */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const DRAFT_EXTS = new Set(['md']);
/** .md di root ATAU folder dokumen/ → kartu draf harian. */
export function draftFiles(entries: TreeEntry[]): TreeEntry[] {
  return entries
    .filter(
      (entry) =>
        entry.type === 'file' &&
        DRAFT_EXTS.has(extOf(entry.name)) &&
        (parentPathOf(entry.path) === '' || parentPathOf(entry.path) === 'dokumen'),
    )
    .sort(byName);
}

const FIGURE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);
/** Gambar boleh ada di folder mana pun (termasuk dokumen/). */
export function figureFiles(entries: TreeEntry[]): TreeEntry[] {
  return entries.filter((entry) => entry.type === 'file' && FIGURE_EXTS.has(extOf(entry.name)));
}

const DATA_EXTS = new Set(['csv', 'xlsx', 'xls', 'json']);
export function dataFiles(entries: TreeEntry[]): TreeEntry[] {
  return entries
    .filter((entry) => entry.type === 'file' && DATA_EXTS.has(extOf(entry.name)))
    .sort(byName);
}

/** PDF hasil unduhan jurnal — khusus folder referensi/ (dipakai panel Jurnal). */
export function referencePdfFiles(entries: TreeEntry[]): PdfRef[] {
  return entries
    .filter((entry) => entry.type === 'file' && entry.path.startsWith('referensi/') && extOf(entry.name) === 'pdf')
    .map((entry) => ({ path: entry.path, name: entry.name, size: entry.size }));
}

// ── Empty state ss7 + util unggah (dipakai juga panel Jurnal & Perpustakaan) ──

/** Catatan kecil di EmptyState — gagal (error) atau info/sukses singkat (ok). */
export type EmptyStateNote = { text: string; tone: 'ok' | 'error' };

export type EmptyStateAction = {
  label: string;
  onClick: () => void;
  /** True → spinner (Loader2), tombol mati sementara. */
  busy?: boolean;
  /** Ikon tombol — default Plus ala ss7; aksi non-tambah pakai ikon lain. */
  icon?: LucideIcon;
};

/**
 * Empty state ss7: ikon dalam lingkaran muted + judul + deskripsi pendek +
 * tombol primary bulat. Ambil warna dari design token murni — buang hardcode.
 */
export function EmptyState({
  icon: Icon,
  title,
  desc,
  action,
  note = null,
  compact = false,
}: {
  icon: LucideIcon;
  title: string;
  desc: string;
  action?: EmptyStateAction;
  note?: EmptyStateNote | null;
  /** Versi ringan buat strip section di dalam daftar scroll (bukan whole-pane). */
  compact?: boolean;
}) {
  const ActionIcon = action ? (action.busy ? Loader2 : (action.icon ?? Plus)) : null;
  return (
    <div
      className={
        compact
          ? 'flex flex-col items-center justify-center gap-2 px-4 py-5 text-center'
          : 'flex h-full flex-col items-center justify-center gap-2 px-6 py-10 text-center'
      }
    >
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
        <Icon size={20} className="text-muted-foreground" />
      </span>
      <p className="text-[13px] font-medium text-foreground">{title}</p>
      <p className="max-w-[220px] text-[11px] leading-snug text-muted-foreground">{desc}</p>
      {note && (
        <p className={`text-[11px] ${note.tone === 'error' ? 'text-destructive' : 'text-accent'}`}>
          {note.text}
        </p>
      )}
      {action && ActionIcon && (
        <button
          type="button"
          onClick={action.busy ? undefined : action.onClick}
          disabled={action.busy}
          aria-busy={action.busy ? true : undefined}
          className="mt-1 inline-flex cursor-pointer items-center gap-1.5 rounded-full bg-primary px-3.5 py-1.5 text-xs font-medium text-primary-foreground transition-colors [transition-property:color,background-color] hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ActionIcon size={13} className={action.busy ? 'animate-spin' : ''} />
          {action.label}
        </button>
      )}
    </div>
  );
}

/** Overlay drop ss7 — dashed primary + pill label; pointer dilepas biar drop kena container. */
export function DropOverlay({ label }: { label: string }) {
  return (
    <div className="pointer-events-none absolute inset-2 z-20 flex items-start justify-center rounded-lg border border-dashed border-primary bg-primary/5">
      <span className="rounded-full bg-primary px-3 py-1 text-[11px] font-medium text-primary-foreground">
        {label}
      </span>
    </div>
  );
}

/**
 * Baris header view: search input rounded-full (ikon Search kiri, placeholder
 * dari key es.search*) + tombol bulat plus — plus SELALU tampil (bukan cuma
 * saat kosong) dan drag file OS tetap hidup di container view (DropOverlay).
 * Gaya persis header Pane Pengetahuan ss7 (ref commit 8144d4f).
 */
export function ViewSearchRow({
  searchPh,
  filter,
  onFilter,
  onPlus,
  plusTitle,
  plusBusy = false,
}: {
  searchPh: string;
  filter: string;
  onFilter: (value: string) => void;
  onPlus: () => void;
  /** Label buka plus: aria-label + title (WCAG — ikon butuh teks). */
  plusTitle: string;
  /** True → spinner di plus (unggah jalan). */
  plusBusy?: boolean;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <div className="relative min-w-0 flex-1">
        <Search
          size={13}
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
        />
        <input
          type="text"
          value={filter}
          onChange={(event) => onFilter(event.target.value)}
          placeholder={searchPh}
          aria-label={searchPh}
          className="h-9 w-full rounded-full border border-border bg-card pl-8 pr-3 text-xs text-foreground outline-none transition-colors [transition-property:color,background-color,border-color] placeholder:text-muted-foreground/70 focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>
      <button
        type="button"
        onClick={onPlus}
        disabled={plusBusy}
        aria-label={plusTitle}
        title={plusTitle}
        className="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors [transition-property:color,background-color] hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
      >
        {plusBusy ? <Loader2 size={14} className="animate-spin" /> : <Plus size={15} />}
      </button>
    </div>
  );
}

/** Pesan "search tanpa hasil" — kecil, miring tengah per baris tampilan. */
export function NoResultsNote() {
  const t = useT();
  return <p className="px-3 py-6 text-center text-[11px] text-muted-foreground">{t('es.noResults')}</p>;
}

/**
 * Tombol X hapus pattern ss7: ikon X 12, sentuh ≥36px, tekanan merah
 * destructive, muncul pas group hover (di baris lewat wrapper .group, di kartu
 * gambar pojok absolut via className). Label = t('es.removeFile').
 */
export function DeleteButton({
  onClick,
  label,
  className = '',
}: {
  onClick: () => void;
  label: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={`flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground opacity-0 transition-colors [transition-property:color,opacity] hover:text-destructive hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100 ${className}`}
    >
      <X size={12} />
    </button>
  );
}

// ── Alur hapus file: konfirmasi Modal → DELETE /api/projects/{slug}/file ─────

/** Kandidat hapus — path + nama file (nama dipakai body konfirmasi). */
export type PendingFileDelete = { path: string; name: string } | null;

/**
 * State alur hapus file buat semua view: klik X → buka Modal konfirmasi →
 * DELETE via route file yang sudah ada; sukses → dispatch
 * 'workspace:tree-refresh' — list auto-update karena entries dari prop.
 */
export function useFileDelete(slug: string) {
  const [pending, setPending] = useState<PendingFileDelete>(null);
  const [deleting, setDeleting] = useState(false);

  const requestDelete = useCallback((path: string, name: string) => {
    setPending({ path, name });
  }, []);

  const cancelDelete = useCallback(() => setPending(null), []);

  const performDelete = useCallback(async (): Promise<boolean> => {
    if (!pending) return false;
    setDeleting(true);
    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(slug)}/file?path=${encodeURIComponent(pending.path)}`,
        { method: 'DELETE' },
      );
      if (res.ok) window.dispatchEvent(new CustomEvent('workspace:tree-refresh'));
      return res.ok;
    } finally {
      setDeleting(false);
      setPending(null);
    }
  }, [pending, slug]);

  return { pending, deleting, requestDelete, cancelDelete, performDelete };
}

/** Modal konfirmasi hapus — body pakai t('tree.deleteConfirm', { name }) (key sudah tersedia). */
export function DeleteConfirmModal({
  pending,
  deleting,
  onCancel,
  onConfirm,
}: {
  pending: PendingFileDelete;
  deleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = useT();
  return (
    <Modal open={!!pending} onClose={onCancel} title={t('common.delete')}>
      <p className="text-sm text-foreground">{t('tree.deleteConfirm', { name: pending?.name ?? '' })}</p>
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={deleting}
          className="cursor-pointer rounded-md px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t('common.cancel')}
        </button>
        <button
          type="button"
          disabled={deleting}
          onClick={onConfirm}
          className="cursor-pointer rounded-md bg-destructive px-3 py-1.5 text-sm font-medium text-destructive-foreground transition-colors hover:bg-destructive/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t('common.delete')}
        </button>
      </div>
    </Modal>
  );
}

/** Filter client-side case-insensitive: cocok nama ATAU path (ala file tree). */
const textFilter = (query: string): string => query.trim().toLowerCase();

// ── View komponen ────────────────────────────────────────────────────────────

/** Folder target unggahan — persis kontrak backend POST …/upload-folder. */
export type FolderName = 'dokumen' | 'referensi' | 'data';

/** POST multipart { files[], folder } → path yang tersimpan; throw kalau backend nolak. */
export async function uploadToFolder(
  slug: string,
  folder: FolderName,
  files: File[],
): Promise<{ saved: string[]; skipped: string[] }> {
  const body = new FormData();
  body.append('folder', folder);
  for (const file of files) body.append('files', file);
  const res = await fetch(`/api/projects/${encodeURIComponent(slug)}/upload-folder`, {
    method: 'POST',
    body,
  });
  if (!res.ok) throw new Error('unggah ditolak backend');
  const data: unknown = await res.json();
  const readList = (key: 'saved' | 'skipped'): string[] =>
    data && typeof data === 'object' && Array.isArray((data as Record<string, unknown>)[key])
      ? ((data as Record<string, unknown>)[key] as unknown[]).filter(
          (item): item is string => typeof item === 'string',
        )
      : [];
  return { saved: readList('saved'), skipped: readList('skipped') };
}

/**
 * State unggah + dropzone sekali bilik: tombol (alternatif utama WCAG) +
 * drag file OS sebagai bonus. Dipakai view Gambar/Data & strip PDF Jurnal.
 */
export function useFolderUpload(slug: string, folder: FolderName, accept: string) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [savedCount, setSavedCount] = useState(0);
  const [dragActive, setDragActive] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const runFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      setFailed(false);
      setBusy(true);
      try {
        const { saved } = await uploadToFolder(slug, folder, files);
        if (saved.length > 0) {
          setSavedCount(saved.length);
          window.dispatchEvent(new CustomEvent('workspace:tree-refresh'));
        } else {
          setFailed(true);
        }
      } catch {
        setFailed(true);
      } finally {
        setBusy(false);
      }
    },
    [slug, folder],
  );

  // Ganti project → reset catatan; daftar view ikut keisi habis refresh tree.
  useEffect(() => {
    setSavedCount(0);
    setFailed(false);
  }, [slug]);

  const pick = useCallback(() => inputRef.current?.click(), []);

  const onInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    void runFiles(files);
  };

  const onDragEnter = (event: ReactDragEvent) => {
    event.preventDefault();
    if (!busy) setDragActive(true);
  };
  const onDragOver = (event: ReactDragEvent) => {
    event.preventDefault();
    if (!busy) setDragActive(true);
  };
  const onDragLeave = (event: ReactDragEvent) => {
    // dragleave nembak tiap masuk anak elemen — hanya clear kalau beneran keluar.
    const next = event.relatedTarget as Node | null;
    if (next && event.currentTarget.contains(next)) return;
    setDragActive(false);
  };
  const onDrop = (event: ReactDragEvent) => {
    event.preventDefault();
    setDragActive(false);
    if (busy) return;
    void runFiles(Array.from(event.dataTransfer.files ?? []));
  };

  return {
    busy,
    failed,
    savedCount,
    dragActive,
    accept,
    inputRef,
    pick,
    onInputChange,
    dnd: { onDragEnter, onDragOver, onDragLeave, onDrop },
  };
}

// ── View komponen ────────────────────────────────────────────────────────────
type ViewProps = {
  slug: string;
  entries: TreeEntry[];
  onOpenFile?: (path: string) => void;
};

/**
 * Draf: baris kartu, klik → editor tengah. Plus (header & empty state) buka
 * dialog "Dokumen baru" global via requestNewDocument() — nama file ditentukan
 * user (bukan draf-tanggal otomatis lagi). X di baris → konfirmasi → hapus.
 * Kosong → ss7; search tanpa hasil → es.noResults.
 */
export function DraftsView({ slug, entries, onOpenFile }: ViewProps) {
  const t = useT();
  const [query, setQuery] = useState('');
  const [similarityOpen, setSimilarityOpen] = useState(false);
  const del = useFileDelete(slug);
  const drafts = draftFiles(entries);
  const q = textFilter(query);
  const visible = useMemo(
    () => (q ? drafts.filter((d) => d.name.toLowerCase().includes(q) || d.path.toLowerCase().includes(q)) : drafts),
    [drafts, q],
  );

  return (
    <div className="flex min-h-full flex-col">
      <div className="shrink-0 px-2 py-2">
        <ViewSearchRow
          searchPh={t('es.searchDrafts')}
          filter={query}
          onFilter={setQuery}
          onPlus={requestNewDocument}
          plusTitle={t('es.draftsAction')}
        />
        <button
          type="button"
          onClick={() => setSimilarityOpen(true)}
          title={t('sim.hint')}
          className="mt-1.5 inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <ShieldCheck size={12} />
          {t('sim.action')}
        </button>
      </div>
      <div className="min-h-0 flex-1">
        {drafts.length === 0 ? (
          <EmptyState
            icon={FileText}
            title={t('es.draftsTitle')}
            desc={t('es.draftsDesc')}
            action={{ label: t('es.draftsAction'), onClick: requestNewDocument }}
          />
        ) : visible.length === 0 ? (
          <NoResultsNote />
        ) : (
          <ul className="flex flex-col gap-0.5 px-1 py-2">
            {visible.map((draft) => (
              <li key={draft.path}>
                <div className="group flex w-full items-center gap-1 rounded-md px-1 transition-colors hover:bg-muted">
                  <button
                    type="button"
                    onClick={() => onOpenFile?.(draft.path)}
                    title={draft.path}
                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 px-1 py-2 text-left"
                  >
                    <FileText
                      size={14}
                      className="shrink-0 text-muted-foreground transition-colors group-hover:text-primary"
                    />
                    <span className="min-w-0 truncate font-serif text-[13px] text-foreground">
                      {stripExt(draft.name, 'md')}
                    </span>
                    <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">
                      {formatSize(draft.size)}
                    </span>
                  </button>
                  <DeleteButton
                    onClick={() => del.requestDelete(draft.path, draft.name)}
                    label={t('es.removeFile')}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      <DeleteConfirmModal
        pending={del.pending}
        deleting={del.deleting}
        onCancel={del.cancelDelete}
        onConfirm={() => void del.performDelete()}
      />
      {similarityOpen && (
        <SimilarityModal slug={slug} onClose={() => setSimilarityOpen(false)} onOpenFile={onOpenFile} />
      )}
    </div>
  );
}

/**
 * Gambar: grid thumbnail 2 kolom, klik → buka di tab baru. Plus (unggah) pindah
 * ke header row — selalu tampil; drag file OS tetap hidup via DropOverlay.
 * X di kartu (pojok, on-hover) → konfirmasi → hapus file gambar.
 */
export function FiguresView({ slug, entries }: ViewProps) {
  const t = useT();
  const up = useFolderUpload(slug, 'dokumen', 'image/png,image/jpeg,image/webp,image/gif');
  const del = useFileDelete(slug);
  const [query, setQuery] = useState('');
  const figures = figureFiles(entries);
  const q = textFilter(query);
  const visible = useMemo(
    () => (q ? figures.filter((f) => f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q)) : figures),
    [figures, q],
  );
  const note: EmptyStateNote | null = up.failed
    ? { text: t('es.uploadFail'), tone: 'error' }
    : up.savedCount > 0 && figures.length === 0
      ? { text: t('es.uploaded', { n: up.savedCount }), tone: 'ok' }
      : null;

  return (
    <section
      className="relative flex min-h-full flex-col"
      onDragEnter={up.dnd.onDragEnter}
      onDragOver={up.dnd.onDragOver}
      onDragLeave={up.dnd.onDragLeave}
      onDrop={up.dnd.onDrop}
    >
      <div className="shrink-0 px-2 py-2">
        <ViewSearchRow
          searchPh={t('es.searchFigures')}
          filter={query}
          onFilter={setQuery}
          onPlus={up.pick}
          plusTitle={t('es.figuresAction')}
          plusBusy={up.busy}
        />
      </div>
      <div className="min-h-0 flex-1">
        {figures.length === 0 ? (
          <EmptyState
            icon={ImageIcon}
            title={t('es.figuresTitle')}
            desc={t('es.figuresDesc')}
            action={{ label: t('es.figuresAction'), onClick: up.pick, busy: up.busy }}
            note={note}
          />
        ) : visible.length === 0 ? (
          <NoResultsNote />
        ) : (
          <ul className="grid grid-cols-2 gap-2 px-2 py-2">
            {visible.map((figure) => (
              <li key={figure.path}>
                <div className="group relative">
                  <button
                    type="button"
                    onClick={() => window.open(rawUrl(slug, figure.path), '_blank', 'noopener')}
                    title={t('views.openNewTab')}
                    className="block w-full min-w-0 cursor-pointer text-left"
                  >
                    {/* File kampung via route raw — next/image tak dibutuhkan untuk daftar lokal ini */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={rawUrl(slug, figure.path)}
                      alt={figure.name}
                      loading="lazy"
                      className="aspect-square w-full rounded-lg border border-border bg-card object-cover"
                    />
                    <span className="mt-1 block truncate text-[10px] text-muted-foreground">{figure.name}</span>
                    <span className="block font-mono text-[10px] text-muted-foreground">{formatSize(figure.size)}</span>
                  </button>
                  <DeleteButton
                    onClick={() => del.requestDelete(figure.path, figure.name)}
                    label={t('es.removeFile')}
                    className="absolute right-1 top-1 z-10 rounded-full border border-border bg-card/90"
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      <input
        ref={up.inputRef}
        type="file"
        accept={up.accept}
        multiple
        className="hidden"
        onChange={up.onInputChange}
      />
      {up.dragActive && <DropOverlay label={t('es.drop')} />}
      <DeleteConfirmModal
        pending={del.pending}
        deleting={del.deleting}
        onCancel={del.cancelDelete}
        onConfirm={() => void del.performDelete()}
      />
    </section>
  );
}

/**
 * Gambar: baris badge ekstensi + nama + ukuran, klik → buka di tab baru. Plus
 * (unggah folder gambar/) pindah ke header row — selalu tampil; X di baris →
 * konfirmasi → hapus. Kosong → ss7; drag file OS tetap hidup via DropOverlay.
 */
export function DataView({ slug, entries, onOpenFile }: ViewProps) {
  const t = useT();
  const up = useFolderUpload(slug, 'data', '.csv,.xlsx,.xls,.json');
  const del = useFileDelete(slug);
  const [query, setQuery] = useState('');
  const [statsBusy, setStatsBusy] = useState(false);
  const [statsMsg, setStatsMsg] = useState<{ text: string; tone: 'ok' | 'error' } | null>(null);
  const [instrumentBusy, setInstrumentBusy] = useState(false);
  /** Laporan hasil analisis (folder hasil/) yang tabelnya mau disisipin ke bab. */
  const [insertSource, setInsertSource] = useState<string | null>(null);
  const [runOpen, setRunOpen] = useState(false);
  const [sampleOpen, setSampleOpen] = useState(false);
  const [formsOpen, setFormsOpen] = useState(false);
  const data = dataFiles(entries);
  /** Laporan analisis (hasil/*.md) — tabelnya bisa disisipin ke draft. */
  const results = useMemo(
    () =>
      entries
        .filter((entry) => entry.type === 'file' && /^hasil\/.*\.md$/i.test(entry.path))
        .sort(byName),
    [entries],
  );
  const installedStats = useMemo(
    () =>
      entries.find(
        (entry) => entry.type === 'file' && /^scripts\/uji-statistik(?:-\d+)?\.py$/.test(entry.path),
      ),
    [entries],
  );
  const q = textFilter(query);
  const visible = useMemo(
    () => (q ? data.filter((f) => f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q)) : data),
    [data, q],
  );
  const note: EmptyStateNote | null = up.failed
    ? { text: t('es.uploadFail'), tone: 'error' }
    : up.savedCount > 0 && data.length === 0
      ? { text: t('es.uploaded', { n: up.savedCount }), tone: 'ok' }
      : null;

  /** Pasang scripts/uji-statistik.py (lazy — file dibuat hanya saat diklik). */
  const installStats = async () => {
    setStatsBusy(true);
    setStatsMsg(null);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(slug)}/stats-template`, {
        method: 'POST',
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok || !payload?.file?.path) {
        setStatsMsg({ text: t('es.statsFail'), tone: 'error' });
        return;
      }
      setStatsMsg({ text: t('es.statsCreated', { path: payload.file.path }), tone: 'ok' });
      window.dispatchEvent(new CustomEvent('workspace:tree-refresh'));
    } catch {
      setStatsMsg({ text: t('es.statsFail'), tone: 'error' });
    } finally {
      setStatsBusy(false);
    }
  };

  /** Buat template instrumen (kolom P1..Pn + lembar instrumen). */
  const createInstrument = async () => {
    setInstrumentBusy(true);
    setStatsMsg(null);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(slug)}/instrument-template`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const payload = (await res.json().catch(() => null)) as
        | { csv?: string; md?: string; error?: string }
        | null;
      if (!res.ok || !payload?.csv) {
        setStatsMsg({ text: payload?.error ?? t('es.instrumentFail'), tone: 'error' });
        return;
      }
      setStatsMsg({
        text: t('es.instrumentDone', { csv: payload.csv, md: payload.md ?? '' }),
        tone: 'ok',
      });
      window.dispatchEvent(new CustomEvent('workspace:tree-refresh'));
    } catch {
      setStatsMsg({ text: t('es.instrumentFail'), tone: 'error' });
    } finally {
      setInstrumentBusy(false);
    }
  };

  return (
    <section
      className="relative flex min-h-full flex-col"
      onDragEnter={up.dnd.onDragEnter}
      onDragOver={up.dnd.onDragOver}
      onDragLeave={up.dnd.onDragLeave}
      onDrop={up.dnd.onDrop}
    >
      <div className="shrink-0 px-2 py-2">
        <ViewSearchRow
          searchPh={t('es.searchData')}
          filter={query}
          onFilter={setQuery}
          onPlus={up.pick}
          plusTitle={t('es.dataAction')}
          plusBusy={up.busy}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2 px-3 pb-2">
        <button
          type="button"
          onClick={() => void installStats()}
          disabled={statsBusy}
          title={t('es.statsHint')}
          className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
        >
          {statsBusy ? <Loader2 size={12} className="animate-spin" /> : <Sigma size={12} />}
          {t('es.statsAction')}
        </button>
        <button
          type="button"
          onClick={() => void createInstrument()}
          disabled={instrumentBusy}
          title={t('es.instrumentHint')}
          className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
        >
          {instrumentBusy ? <Loader2 size={12} className="animate-spin" /> : <Sigma size={12} />}
          {t('es.instrumentAction')}
        </button>
        <button
          type="button"
          onClick={() => setRunOpen(true)}
          disabled={!installedStats}
          title={installedStats ? t('es.runHint') : t('es.runNeedsScript')}
          className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Play size={12} />
          {t('es.runAction')}
        </button>
        <button
          type="button"
          onClick={() => setSampleOpen(true)}
          title={t('es.sampleHint')}
          className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <Calculator size={12} />
          {t('es.sampleAction')}
        </button>
        <button
          type="button"
          onClick={() => setFormsOpen(true)}
          title={t('es.formsHint')}
          className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <FileUp size={12} />
          {t('es.formsAction')}
        </button>
        {statsMsg ? (
          <span
            className={`text-[11px] ${
              statsMsg.tone === 'error' ? 'text-red-600' : 'text-muted-foreground'
            }`}
          >
            {statsMsg.text}
          </span>
        ) : installedStats ? (
          <span className="text-[11px] text-muted-foreground">
            {t('es.statsInstalled', { path: installedStats.path })}
          </span>
        ) : null}
      </div>
      {results.length > 0 && (
        <div className="shrink-0 border-t border-border px-2 py-2">
          <p className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
            {t('es.resultTitle')}
          </p>
          <ul className="space-y-0.5">
            {results.map((file) => (
              <li key={file.path} className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setInsertSource(file.path)}
                  title={t('es.insertResult')}
                  className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-left transition-colors hover:bg-muted"
                >
                  <span className="shrink-0 rounded bg-muted px-1.5 text-[10px] font-mono uppercase text-muted-foreground">
                    md
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs text-foreground">{file.name}</span>
                </button>
                <Button
                  variant="outline"
                  className="h-6 shrink-0 px-1.5 text-[10px]"
                  onClick={() => setInsertSource(file.path)}
                >
                  {t('es.insertResult')}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="min-h-0 flex-1">
        {data.length === 0 ? (
          <EmptyState
            icon={Table2}
            title={t('es.dataTitle')}
            desc={t('es.dataDesc')}
            action={{ label: t('es.dataAction'), onClick: up.pick, busy: up.busy }}
            note={note}
          />
        ) : visible.length === 0 ? (
          <NoResultsNote />
        ) : (
          <ul className="flex flex-col gap-0.5 px-1 py-2">
            {visible.map((file) => (
              <li key={file.path}>
                <div className="group flex w-full items-center gap-1 rounded-md px-1 transition-colors hover:bg-muted">
                  <button
                    type="button"
                    onClick={() => window.open(rawUrl(slug, file.path), '_blank', 'noopener')}
                    title={t('views.openNewTab')}
                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 px-1 py-2 text-left"
                  >
                    <span className="shrink-0 rounded bg-muted px-1.5 text-[10px] font-mono uppercase text-muted-foreground">
                      {extOf(file.name)}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-xs text-foreground">{file.name}</span>
                    <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{formatSize(file.size)}</span>
                  </button>
                  <DeleteButton
                    onClick={() => del.requestDelete(file.path, file.name)}
                    label={t('es.removeFile')}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      <input
        ref={up.inputRef}
        type="file"
        accept={up.accept}
        multiple
        className="hidden"
        onChange={up.onInputChange}
      />
      {up.dragActive && <DropOverlay label={t('es.drop')} />}
      <DeleteConfirmModal
        pending={del.pending}
        deleting={del.deleting}
        onCancel={del.cancelDelete}
        onConfirm={() => void del.performDelete()}
      />
      {runOpen && (
        <AnalysisRunModal
          slug={slug}
          files={data
            .filter((file) => /\.(csv|xlsx|xls)$/i.test(file.path))
            .map((file) => ({ path: file.path, name: file.name }))}
          onOpenFile={onOpenFile}
          onClose={() => setRunOpen(false)}
          onFinished={() => window.dispatchEvent(new CustomEvent('workspace:tree-refresh'))}
        />
      )}
      {sampleOpen && <SampleSizeModal onClose={() => setSampleOpen(false)} />}
      {formsOpen && <FormsImportModal slug={slug} onClose={() => setFormsOpen(false)} />}
      {insertSource && (
        <InsertResultModal
          slug={slug}
          sourcePath={insertSource}
          onClose={() => setInsertSource(null)}
          onDone={(message) => setStatsMsg({ text: message, tone: 'ok' })}
        />
      )}
    </section>
  );
}
