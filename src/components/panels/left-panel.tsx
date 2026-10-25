'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, FilePlus2, FileSpreadsheet, FileText, Folder, FolderOpen, FolderPlus, Plus, Search, X, type LucideIcon } from 'lucide-react';
import { useT } from '@/lib/preferences';
import { Modal, TextInput } from '@/components/ui';
import { DOC_CREATED_EVENT, requestNewDocument } from '@/components/panels/new-doc-modal';
import { JournalPanel } from '@/components/panels/journal-panel';
import { OutlineView } from '@/components/panels/outline-view';
import { LibraryPanel } from '@/components/panels/library-panel';
import { ZoteroPanel } from '@/components/panels/zotero-panel';
import { MatrixPanel } from '@/components/panels/matrix-panel';
import { RevisionPanel } from '@/components/panels/revision-panel';
import { VersionsPanel } from '@/components/panels/versions-panel';
import { type LeftTab } from '@/components/workspace/icon-rail';
import {
  DropOverlay,
  EmptyState,
  DataView,
  DraftsView,
  FiguresView,
  dataFiles,
  draftFiles,
  figureFiles,
  referencePdfFiles,
  type EmptyStateNote,
  type TreeEntry,
} from '@/components/panels/views-left';

type TreeNode = TreeEntry & { children: TreeNode[] };

function buildTree(entries: TreeEntry[]): TreeNode[] {
  const root: TreeNode = { path: '', name: '', type: 'dir', size: 0, children: [] };
  const dirNodes = new Map<string, TreeNode>();
  dirNodes.set('', root);

  for (const entry of entries) {
    const parent = dirNodes.get(parentPathOf(entry.path));
    if (!parent) continue;
    const node: TreeNode = { ...entry, children: [] };
    parent.children.push(node);
    if (entry.type === 'dir') dirNodes.set(entry.path, node);
  }
  return root.children;
}

function parentPathOf(p: string): string {
  const index = p.lastIndexOf('/');
  return index === -1 ? '' : p.slice(0, index);
}

const TEXT_EXTS = ['.md', '.txt', '.json', '.jsonc', '.csv', '.ris', '.bib', '.tex'];
const isTextFile = (name: string) => TEXT_EXTS.some((ext) => name.toLowerCase().endsWith(ext));

/** Ekstensi yang dapet badge di tree — sisanya (mis. .json) tampil polos. */
const BADGE_EXTS = new Set(['md', 'pdf', 'bib', 'docx', 'txt', 'png', 'jpg']);

function extBadge(name: string): string | null {
  const dot = name.lastIndexOf('.');
  if (dot === -1) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  return BADGE_EXTS.has(ext) ? ext.toUpperCase() : null;
}

/** Fetch pohon berkas; refetch on window-focus (file hasil copy manual langsung	muncul). */
function useFileTree(slug: string, version: number) {
  const [entries, setEntries] = useState<TreeEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const fetchTree = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(slug)}/tree`);
      const data = await res.json();
      if (res.ok) {
        setEntries(data.tree ?? []);
        setError(false);
      } else {
        setError(true);
      }
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => {
    void fetchTree();
  }, [fetchTree, version]);

  // Refetch saat window fokus KEMBALI (bukan tiap fokus-event) + throttle 3 detik,
  // biar gak numpuk request saat tab fwd VS Code flicker.
  const lastFetchRef = useRef(Date.now());
  useEffect(() => {
    let visible = true;
    const maybeFetch = () => {
      if (!visible || document.visibilityState !== 'visible') return;
      const now = Date.now();
      if (now - lastFetchRef.current < 3000) return;
      lastFetchRef.current = now;
      void fetchTree();
    };
    const onVisibility = () => {
      visible = document.visibilityState === 'visible';
      maybeFetch();
    };
    window.addEventListener('focus', maybeFetch);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('focus', maybeFetch);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [fetchTree]);

  // Aksi panel ditempat lain (bikin draf, unggah) minta refresh LANGSUNG —
  // gak lelew throttle fokus 3 detik.
  useEffect(() => {
    const refresh = () => void fetchTree();
    window.addEventListener('workspace:tree-refresh', refresh);
    return () => window.removeEventListener('workspace:tree-refresh', refresh);
  }, [fetchTree]);

  return { entries, loading, error };
}

export function LeftPanel({
  slug,
  treeVersion,
  openFile,
  onOpenFile,
  onFileDeleted,
  activeTab,
  onActiveTabChange,
}: {
  slug: string;
  treeVersion: number;
  openFile: string | null;
  onOpenFile: (path: string) => void;
  onFileDeleted: (wasOpen: boolean) => void;
  /** Tab aktif rail — state-nya di shell (rail tampil permanen di sana). */
  activeTab: LeftTab;
  onActiveTabChange: (tab: LeftTab) => void;
}) {
  const t = useT();
  const { entries, loading, error } = useFileTree(slug, treeVersion);
  const [paperDrop, setPaperDrop] = useState(false);

  // Kartu jurnal dari chat bisa di-drag ke panel ini: yang dikirim bukan berkas
  // OS, melainkan metadata paper. PDF-nya diunduh server ke referensi/papers/.
  const isPaperDrag = (event: React.DragEvent) =>
    Array.from(event.dataTransfer.types ?? []).includes('application/x-vibe-paper');

  const onPaperDragOver = (event: React.DragEvent) => {
    if (!isPaperDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setPaperDrop(true);
  };

  const onPaperDrop = (event: React.DragEvent) => {
    if (!isPaperDrag(event)) return;
    event.preventDefault();
    setPaperDrop(false);
    const raw = event.dataTransfer.getData('application/x-vibe-paper');
    if (!raw) return;
    let doi = '';
    try {
      const parsed = JSON.parse(raw) as { doi?: unknown };
      if (typeof parsed.doi === 'string') doi = parsed.doi;
    } catch {
      return;
    }
    if (!doi) return;
    void fetch(
      `/api/journals/pdf?doi=${encodeURIComponent(doi)}&slug=${encodeURIComponent(slug)}`,
    ).then((res) => {
      if (res.ok) window.dispatchEvent(new CustomEvent('workspace:tree-refresh'));
    });
  };

  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['dokumen', 'referensi']));
  const [journalMode, setJournalMode] = useState<'search' | 'saved'>('search');
  const [pendingDelete, setPendingDelete] = useState<TreeEntry | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [filter, setFilter] = useState('');
  /** Path folder yang lagi jadi drop target internal-move (highlight ring). */
  const [dropFolder, setDropFolder] = useState<string | null>(null);
  /** File OS lagi hover pane → overlay "Ilepas buat unggah". */
  const [filesDropActive, setFilesDropActive] = useState(false);
  /** Move/upload lagi jalan → aksi drag berikutnya ditahan biar gak dobel. */
  const [mutating, setMutating] = useState(false);
  /** Catatan hasil aksi (error move/upload / jumlah file masuk). */
  const [note, setNote] = useState<EmptyStateNote | null>(null);
  // ── File manager: menu + header, naming modal, menu klik-kanan tree ─────────
  const [plusOpen, setPlusOpen] = useState(false);
  /** Modal penamaan node baru: kind + folder induk relatif ('' = root). */
  const [nodeNaming, setNodeNaming] = useState<{ kind: 'file' | 'folder'; parent: string } | null>(null);
  const [nodeName, setNodeName] = useState('');
  const [creatingNode, setCreatingNode] = useState(false);
  const [createNodeErr, setCreateNodeErr] = useState<string | null>(null);
  /** Menu klik-kanan: posisi + node sumber (null = area kosong/root). */
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; node: TreeEntry | null } | null>(null);

  // Menu klik-kanan & + tutup saat klik di luar / tekan Escape.
  useEffect(() => {
    if (!ctxMenu && !plusOpen) return;
    const close = () => {
      setCtxMenu(null);
      setPlusOpen(false);
    };
    window.addEventListener('click', close);
    window.addEventListener('blur', close);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [ctxMenu, plusOpen]);

  /** Spreadsheet baru dari menu + tree: POST → tree refresh + buka tab Excel. */
  const requestNewSpreadsheet = async () => {
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(slug)}/spreadsheets`, {
        method: 'POST',
      });
      if (!res.ok) {
        setNote({ text: t('tree.createErr'), tone: 'error' });
        return;
      }
      const data = (await res.json()) as { document?: { path?: string } };
      window.dispatchEvent(new CustomEvent('workspace:tree-refresh'));
      if (data.document?.path) {
        window.dispatchEvent(new CustomEvent(DOC_CREATED_EVENT, { detail: { path: data.document.path } }));
      }
    } catch {
      setNote({ text: t('tree.createErr'), tone: 'error' });
    }
  };

  // Klik chip sitasi di editor (fase 6) → lompat ke tab Jurnal + mode Tersimpan.
  // Dipasang di sini karena journalMode = state internal panel ini; switch tab
  // lewat onActiveTabChange (controlled — state activeTab milik shell).
  useEffect(() => {
    const onOpenBib = (event: Event) => {
      const detail = (event as CustomEvent<{ key?: string }>).detail;
      if (!detail?.key) return;
      onActiveTabChange('journals');
      setJournalMode('saved');
    };
    window.addEventListener('workspace:open-bib-entry', onOpenBib);
    return () => window.removeEventListener('workspace:open-bib-entry', onOpenBib);
  }, [onActiveTabChange]);

  // Filter client-side by path (case-insensitive). Folder induk ikut disertakan
  // biar hasil tetap muncul di dalam pohonnya — buildTree butuh parent dir-nya ada.
  const normalizedFilter = filter.trim().toLowerCase();
  const filterActive = normalizedFilter.length > 0;
  const filteredEntries = filterActive
    ? (() => {
        const matched = entries.filter((entry) => entry.path.toLowerCase().includes(normalizedFilter));
        const keep = new Set<string>(matched.map((entry) => entry.path));
        for (const entry of matched) {
          let parent = parentPathOf(entry.path);
          while (parent && !keep.has(parent)) {
            keep.add(parent);
            parent = parentPathOf(parent);
          }
        }
        return entries.filter((entry) => keep.has(entry.path));
      })()
    : entries;
  const nodes = buildTree(filteredEntries);

  /** Jumlah file langsung di dalam folder (buat teks konfirmasi hapus folder). */
  const fileCountIn = (folderPath: string) =>
    entries.filter((entry) => entry.type === 'file' && entry.path.startsWith(`${folderPath}/`)).length;

  const chipCount = (count: number) => t('lib.fileCount', { n: count });

  /** PDF unduhan jurnal di referensi/ — tampil juga sebagai section di tab Jurnal. */
  const pdfFiles = useMemo(() => referencePdfFiles(entries), [entries]);

  const toggleExpand = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const performDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      const url =
        pendingDelete.type === 'dir'
          ? `/api/projects/${encodeURIComponent(slug)}/folders?path=${encodeURIComponent(pendingDelete.path)}`
          : `/api/projects/${encodeURIComponent(slug)}/file?path=${encodeURIComponent(pendingDelete.path)}`;
      const res = await fetch(url, { method: 'DELETE' });
      if (res.ok) {
        window.dispatchEvent(new CustomEvent('workspace:tree-refresh'));
        if (pendingDelete.type === 'file') onFileDeleted(openFile === pendingDelete.path);
      } else {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setNote({ text: data?.error ?? t('tree.deleteErr'), tone: 'error' });
      }
    } finally {
      setDeleting(false);
      setPendingDelete(null);
    }
  };

  /** File/folder baru via modal naming — endpoint beda per jenis. */
  const submitNewNode = async () => {
    if (!nodeNaming || creatingNode) return;
    const name = nodeName.trim();
    if (name.length === 0) return;
    setCreatingNode(true);
    setCreateNodeErr(null);
    try {
      const endpoint = nodeNaming.kind === 'folder' ? 'folders' : 'files';
      const res = await fetch(`/api/projects/${encodeURIComponent(slug)}/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parent: nodeNaming.parent, name }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setCreateNodeErr(data?.error ?? t('tree.createErr'));
        return;
      }
      const data = (await res.json()) as { folder?: { path: string }; file?: { path: string } };
      const createdPath = data.folder?.path ?? data.file?.path;
      if (nodeNaming.parent) {
        // Auto-expand folder induk biar yang baru kebuat kelihatan.
        setExpanded((prev) => new Set(prev).add(nodeNaming.parent));
      }
      window.dispatchEvent(new CustomEvent('workspace:tree-refresh'));
      setNodeNaming(null);
      setNodeName('');
      if (createdPath) setNote({ text: t('tree.created', { name: createdPath }), tone: 'ok' });
    } catch {
      setCreateNodeErr(t('tree.createErr'));
    } finally {
      setCreatingNode(false);
    }
  };

  /**
   * Pindah file di disk: drag baris file → baris folder. Target = folder sama
   * nama file-nya; kalau file yang dibuka ikut pindah, kabari editor dulu
   * ('workspace:file-moved') sebelum tree di-refresh.
   */
  const moveFile = async (from: string, targetFolder: string) => {
    const name = from.split('/').pop() ?? from;
    const to = `${targetFolder}/${name}`;
    if (to === from) return; // folder yang sama → gak ada yang keubah
    setNote(null);
    setMutating(true);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(slug)}/file/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setNote({ text: data?.error ?? t('es.moveErr'), tone: 'error' });
        return;
      }
      if (openFile === from) {
        // Event dulu → editor update path sebelum tree refetch bikin row pindah.
        window.dispatchEvent(
          new CustomEvent('workspace:file-moved', { detail: { from, to } }),
        );
      }
      window.dispatchEvent(new CustomEvent('workspace:tree-refresh'));
    } catch {
      setNote({ text: t('es.moveErr'), tone: 'error' });
    } finally {
      setMutating(false);
    }
  };

  /** Drag file OS → baris folder: unggah via upload-folder (folder bebas boleh). */
  const uploadToFolderPath = async (folderPath: string, files: File[]) => {
    if (files.length === 0) return;
    setNote(null);
    setMutating(true);
    try {
      const body = new FormData();
      body.append('folder', folderPath);
      for (const file of files) body.append('files', file);
      const res = await fetch(`/api/projects/${encodeURIComponent(slug)}/upload-folder`, {
        method: 'POST',
        body,
      });
      const data = (await res.json().catch(() => null)) as
        | { saved?: string[]; error?: string }
        | null;
      if (!res.ok) {
        setNote({ text: data?.error ?? t('es.uploadFail'), tone: 'error' });
        return;
      }
      const saved = data?.saved?.length ?? 0;
      if (saved > 0) {
        setNote({ text: t('es.uploaded', { n: saved }), tone: 'ok' });
        window.dispatchEvent(new CustomEvent('workspace:tree-refresh'));
      } else {
        setNote({ text: t('es.uploadFail'), tone: 'error' });
      }
    } catch {
      setNote({ text: t('es.uploadFail'), tone: 'error' });
    } finally {
      setMutating(false);
    }
  };

  // Drag bisa berakhir di luar semua target (drop di luar, tombol Esc) —
  // listener jaring aman biar highlight folder/overlay gak nyangkut.
  useEffect(() => {
    const clearDrag = () => {
      setDropFolder(null);
      setFilesDropActive(false);
    };
    window.addEventListener('drop', clearDrag);
    window.addEventListener('dragend', clearDrag);
    return () => {
      window.removeEventListener('drop', clearDrag);
      window.removeEventListener('dragend', clearDrag);
    };
  }, []);

  const renderNode = (node: TreeNode, depth: number): React.ReactNode => {
    if (node.type === 'dir') {
      // Saat filter aktif semua folder yang relevan dibuka otomatis — hasil search langsung kelihatan.
      const isOpen = filterActive || expanded.has(node.path);
      // Drop target: move file internal (ring) & unggah file OS. Drop ≠ klik —
      // expand-click tetap jalan kayak sedia.
      const dropTarget = dropFolder === node.path;
      return (
        <li key={node.path}>
          <button
            onClick={() => toggleExpand(node.path)}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setPlusOpen(false);
              setCtxMenu({ x: event.clientX, y: event.clientY, node });
            }}
            onDragEnter={(event) => {
              const next = event.relatedTarget as Node | null;
              if (next && event.currentTarget.contains(next)) return;
              setDropFolder(node.path);
            }}
            onDragOver={(event) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = event.dataTransfer.types.includes(
                'application/x-rd-path',
              )
                ? 'move'
                : 'copy';
              setDropFolder(node.path);
            }}
            onDragLeave={(event) => {
              const next = event.relatedTarget as Node | null;
              if (next && event.currentTarget.contains(next)) return;
              if (dropFolder === node.path) setDropFolder(null);
            }}
            onDrop={(event) => {
              event.preventDefault();
              event.stopPropagation(); // jangan sampe pane juga ngulur drop-nya
              setDropFolder(null);
              setFilesDropActive(false);
              if (mutating) return;
              const from = event.dataTransfer.getData('application/x-rd-path');
              if (from) {
                void moveFile(from, node.path);
                return;
              }
              const files = Array.from(event.dataTransfer.files ?? []);
              if (files.length > 0) void uploadToFolderPath(node.path, files);
            }}
            className={`group flex w-full cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
              dropTarget ? 'ring-2 ring-primary bg-primary/5' : 'hover:bg-muted'
            }`}
            style={{ paddingLeft: `${depth * 12 + 8}px` }}
          >
            {isOpen ? (
              <ChevronDown size={13} className="shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight size={13} className="shrink-0 text-muted-foreground" />
            )}
            {isOpen ? (
              <FolderOpen size={13} className="shrink-0 text-muted-foreground" />
            ) : (
              <Folder size={13} className="shrink-0 text-muted-foreground" />
            )}
            <span className="truncate">{node.name}</span>
            <span className="ml-auto flex shrink-0 items-center gap-1">
              {/* X hover folder — hapus folder + isinya (modal konfirmasi sama). */}
              <span
                role="button"
                tabIndex={-1}
                aria-label={t('tree.removeFolder')}
                title={t('tree.removeFolder')}
                onClick={(event) => {
                  event.stopPropagation();
                  setPendingDelete(node);
                }}
                className="hidden shrink-0 cursor-pointer text-muted-foreground transition-colors hover:text-destructive group-hover:inline-flex"
              >
                <X size={12} />
              </span>
            </span>
          </button>
          {isOpen && node.children.map((child) => renderNode(child, depth + 1))}
        </li>
      );
    }

    const openable = isTextFile(node.name);
    const active = openFile === node.path;
    const badge = extBadge(node.name);
    return (
      <li
        key={node.path}
      >
        <button
          onClick={() => openable && onOpenFile(node.path)}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setPlusOpen(false);
            setCtxMenu({ x: event.clientX, y: event.clientY, node });
          }}
          // Drag sumber: path file dibawa via typed dataTransfer (blok agent
          // & move antar folder pakai tipe yang sama), marker move biar UI drop jelas.
          draggable
          onDragStart={(event) => {
            event.dataTransfer.setData('application/x-rd-path', node.path);
            event.dataTransfer.effectAllowed = 'move';
          }}
          className={`group flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs transition-colors ${
            active
              ? 'bg-primary/10 font-medium text-primary'
              : openable
                ? 'cursor-pointer text-foreground hover:bg-muted'
                : 'cursor-not-allowed text-foreground opacity-55'
          }`}
          style={{ paddingLeft: `${depth * 12 + 8}px` }}
          title={!openable ? t('tree.fase3Hint') : node.path}
        >
          <FileText
            size={13}
            className={`shrink-0 ${active ? 'text-primary' : 'text-muted-foreground'}`}
          />
          <span className="truncate">{node.name}</span>
          <span className="ml-auto flex shrink-0 items-center gap-1">
            {badge && (
              <span className="rounded bg-muted px-1 text-[9px] font-mono uppercase text-muted-foreground">
                {badge}
              </span>
            )}
            {/* X hover — buka modal konfirmasi hapus yang ada (klik terpisah,
                gak nembak klik buka file). */}
            <span
              role="button"
              tabIndex={-1}
              aria-label={t('es.removeFile')}
              title={t('es.removeFile')}
              onClick={(event) => {
                event.stopPropagation();
                setPendingDelete(node);
              }}
              className="hidden shrink-0 cursor-pointer text-muted-foreground transition-colors hover:text-destructive group-hover:inline-flex"
            >
              <X size={12} />
            </span>
          </span>
        </button>
      </li>
    );
  };

  const tabHeader = (title: string, chip?: string) => (
    <header className="shrink-0 border-b border-border bg-card px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-serif text-sm font-semibold tracking-tight text-card-foreground">{title}</h2>
        {chip && (
          <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-mono text-muted-foreground">
            {chip}
          </span>
        )}
      </div>
    </header>
  );

  /** Kerangka tab view tujuan: header + area scroll, plus status load/error tree yang sama. */
  const viewPane = (title: string, chip: string, view: React.ReactNode) => (
    <div className="flex min-w-0 flex-1 flex-col bg-background text-foreground">
      {tabHeader(title, chip)}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <p className="px-2 py-4 text-xs text-muted-foreground">…</p>
        ) : error ? (
          <p className="px-2 py-4 text-xs text-destructive">{t('err.loadFocus')}</p>
        ) : (
          view
        )}
      </div>
    </div>
  );

  return (
    <aside
      className={`flex h-full ${paperDrop ? 'ring-2 ring-inset ring-primary/40' : ''}`}
      onDragOver={onPaperDragOver}
      onDragLeave={() => setPaperDrop(false)}
      onDrop={onPaperDrop}
    >
      {activeTab === 'drafts' &&
        viewPane(
          t('views.drafts'),
          chipCount(draftFiles(entries).length),
          <DraftsView slug={slug} entries={entries} onOpenFile={onOpenFile} />,
        )}

      {activeTab === 'outline' &&
        viewPane(
          t('left.tabOutline'),
          chipCount(
            entries.filter((entry) => entry.type === 'file' && entry.path.startsWith('dokumen/') && entry.path.endsWith('.md'))
              .length,
          ),
          <OutlineView slug={slug} entries={entries} onOpenFile={onOpenFile} />,
        )}

      {activeTab === 'zotero' && (
        <div className="flex min-w-0 flex-1 flex-col bg-background text-foreground">
          {tabHeader(t('left.tabZotero'))}
          <ZoteroPanel slug={slug} />
        </div>
      )}

      {activeTab === 'matrix' && (
        <div className="flex min-w-0 flex-1 flex-col bg-background text-foreground">
          {tabHeader(t('matrix.title'))}
          <MatrixPanel slug={slug} />
        </div>
      )}

      {activeTab === 'revision' && (
        <div className="flex min-w-0 flex-1 flex-col bg-background text-foreground">
          {tabHeader(t('revision.title'))}
          <RevisionPanel slug={slug} />
        </div>
      )}

      {activeTab === 'versions' && (
        <div className="flex min-w-0 flex-1 flex-col bg-background text-foreground">
          {tabHeader(t('versions.title'))}
          <VersionsPanel slug={slug} />
        </div>
      )}

      {activeTab === 'figures' &&
        viewPane(
          t('views.figures'),
          chipCount(figureFiles(entries).length),
          <FiguresView slug={slug} entries={entries} />,
        )}

      {activeTab === 'data' &&
        viewPane(
          t('views.data'),
          chipCount(dataFiles(entries).length),
          <DataView slug={slug} entries={entries} onOpenFile={onOpenFile} />,
        )}

      {activeTab === 'journals' && (
        <div className="flex min-w-0 flex-1 flex-col bg-background text-foreground">
          {tabHeader(t('journal.header'), t('journal.pdfChip', { n: String(pdfFiles.length) }))}          <div className="flex shrink-0 gap-1 border-b border-border bg-card px-2 pb-1.5">
            <button
              type="button"
              onClick={() => setJournalMode('search')}
              className={`cursor-pointer rounded-full px-2.5 py-1 text-[11px] transition-colors ${
                journalMode === 'search'
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-muted'
              }`}
            >
              {t('journal.search')}
            </button>
            <button
              type="button"
              onClick={() => setJournalMode('saved')}
              className={`cursor-pointer rounded-full px-2.5 py-1 text-[11px] transition-colors ${
                journalMode === 'saved'
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-muted'
              }`}
            >
              {t('library.tabSaved')}
            </button>
          </div>
          <div className="flex min-h-0 flex-1 flex-col">
            {journalMode === 'search' ? (
              <JournalPanel slug={slug} pdfFiles={pdfFiles} onOpenPdf={onOpenFile} />
            ) : (
              <LibraryPanel
                slug={slug}
                onSearch={() => setJournalMode('search')}
                pdfCount={pdfFiles.length}
              />
            )}
          </div>
        </div>
      )}

      {activeTab === 'files' && (
        <div className="relative flex min-w-0 flex-1 flex-col bg-background text-foreground">
          {tabHeader(t('tabs.file'), t('lib.fileCount', { n: entries.length }))}
          <div className="shrink-0 border-b border-border px-3 py-2">
            <div className="flex items-center gap-2">
              <div className="relative min-w-0 flex-1">
                <Search
                  size={13}
                  className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
                />
                <input
                  type="text"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  placeholder={t('lib.searchPlaceholder')}
                  aria-label={t('lib.searchPlaceholder')}
                  className="h-8 w-full rounded-md border border-border bg-background pl-7 pr-2 text-xs text-foreground transition-colors placeholder:text-muted-foreground"
                />
              </div>
              <div className="relative">
                <button
                  type="button"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation(); // jangan langsung ketutup listener click global
                    setPlusOpen((v) => !v);
                  }}
                  aria-label={t('common.create')}
                  title={t('common.create')}
                  aria-haspopup="menu"
                  className="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors [transition-property:color,background-color] hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Plus size={16} />
                </button>
                {plusOpen && (
                  <div
                    role="menu"
                    onClick={(event) => event.stopPropagation()}
                    className="absolute right-0 top-10 z-50 w-48 rounded-lg border border-border bg-card p-1 shadow-lg"
                  >
                    <MenuItem
                      icon={FilePlus2}
                      label={t('tree.newFile')}
                      onClick={() => {
                        setPlusOpen(false);
                        setNodeName('');
                        setCreateNodeErr(null);
                        setNodeNaming({ kind: 'file', parent: '' });
                      }}
                    />
                    <MenuItem
                      icon={FolderPlus}
                      label={t('tree.newFolder')}
                      onClick={() => {
                        setPlusOpen(false);
                        setNodeName('');
                        setCreateNodeErr(null);
                        setNodeNaming({ kind: 'folder', parent: '' });
                      }}
                    />
                    <div className="mx-1 my-1 h-px bg-border" />
                    <MenuItem icon={FileText} label={t('common.newDocument')} onClick={requestNewDocument} />
                    <MenuItem icon={FileSpreadsheet} label={t('tree.newSheet')} onClick={requestNewSpreadsheet} />
                  </div>
                )}
              </div>
            </div>
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
          <div
            className="min-h-0 flex-1 overflow-y-auto px-1 py-2"
            onContextMenu={(event) => {
              // Klik kanan area kosong → New file/New folder di root.
              event.preventDefault();
              setCtxMenu({ x: event.clientX, y: event.clientY, node: null });
            }}
            onDragEnter={(event) => {
              // File OS decak pane mana pun → minta user ilepas di sini
              // (target akhirnya tetap baris folder — drop di luar basa-basi doang).
              if (event.dataTransfer.types.includes('Files')) setFilesDropActive(true);
            }}
            onDragOver={(event) => {
              event.preventDefault(); // biar browser gak buka file-nya pas drop ngawur
              if (event.dataTransfer.types.includes('Files')) setFilesDropActive(true);
            }}
            onDragLeave={(event) => {
              const next = event.relatedTarget as Node | null;
              if (next && event.currentTarget.contains(next)) return;
              setFilesDropActive(false);
            }}
            onDrop={(event) => {
              event.preventDefault();
              setFilesDropActive(false);
              // Drop file OS di latar pane (bukan baris folder) → peluk doang,
              // target folder-nya belum jelas.
            }}
          >
            {loading ? (
              <p className="px-2 py-4 text-xs text-muted-foreground">…</p>
            ) : error ? (
              <p className="px-2 py-4 text-xs text-destructive">{t('err.loadFocus')}</p>
            ) : entries.length === 0 ? (
              <EmptyState
                icon={Folder}
                title={t('es.filesTitle')}
                desc={t('es.filesDesc')}
                action={{ label: t('es.filesAction'), onClick: requestNewDocument }}
              />
            ) : filterActive && nodes.length === 0 ? (
              <p className="px-2 py-4 text-xs text-muted-foreground">{t('es.noResults')}</p>
            ) : (
              <ul>{nodes.map((node) => renderNode(node, 0))}</ul>
            )}
          </div>
          {filesDropActive && <DropOverlay label={t('es.drop')} />}
        </div>
      )}

      <Modal open={!!pendingDelete} onClose={() => setPendingDelete(null)} title={t('common.delete')}>
        <p className="text-sm text-foreground">
          {pendingDelete?.type === 'dir'
            ? t('tree.deleteFolderConfirm', { name: pendingDelete.name, n: fileCountIn(pendingDelete.path) })
            : t('tree.deleteConfirm', { name: pendingDelete?.name ?? '' })}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => setPendingDelete(null)}
            className="cursor-pointer rounded-md px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            disabled={deleting}
            onClick={() => void performDelete()}
            className="cursor-pointer rounded-md bg-destructive px-3 py-1.5 text-sm font-medium text-destructive-foreground transition-colors hover:bg-destructive/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('common.delete')}
          </button>
        </div>
      </Modal>
      {/* Modal naming: file baru / folder baru (dari menu + atau klik kanan). */}
      <Modal
        open={!!nodeNaming}
        onClose={() => {
          setNodeNaming(null);
          setCreateNodeErr(null);
        }}
        title={nodeNaming?.kind === 'folder' ? t('tree.nameFolderTitle') : t('tree.nameFileTitle')}
      >
        <div className="space-y-4">
          <div>
            <label htmlFor="new-node-name" className="mb-1 block text-sm font-medium">
              {nodeNaming?.kind === 'folder' ? t('tree.nameFolderLabel') : t('tree.nameFileLabel')}
            </label>
            <TextInput
              id="new-node-name"
              value={nodeName}
              onChange={(event) => setNodeName(event.target.value)}
              placeholder={nodeNaming?.kind === 'folder' ? t('tree.folderNamePh') : t('tree.fileNamePh')}
              autoFocus
              disabled={creatingNode}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && nodeName.trim()) void submitNewNode();
              }}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              {t('tree.nameParentHint', { dir: nodeNaming?.parent || t('tree.rootName') })}
            </p>
          </div>
          {createNodeErr && <p className="text-xs text-destructive">{createNodeErr}</p>}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setNodeNaming(null);
                setCreateNodeErr(null);
              }}
              className="cursor-pointer rounded-md px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              disabled={creatingNode || nodeName.trim().length === 0}
              onClick={() => void submitNewNode()}
              className="cursor-pointer rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {creatingNode ? '…' : t('common.create')}
            </button>
          </div>
        </div>
      </Modal>

      {/* Menu klik-kanan tree: kontekstual per node (folder/file) atau area kosong. */}
      {ctxMenu && (
        <div
          role="menu"
          onClick={(event) => event.stopPropagation()}
          style={{ left: Math.min(ctxMenu.x, (typeof window !== 'undefined' ? window.innerWidth : 500) - 200), top: ctxMenu.y }}
          className="fixed z-50 w-48 rounded-lg border border-border bg-card p-1 shadow-lg"
        >
          {(ctxMenu.node?.type === 'file' || ctxMenu.node?.type === 'dir') && (
            <>
              {ctxMenu.node.type === 'dir' && (
                <>
                  <MenuItem
                    icon={FilePlus2}
                    label={t('tree.newFile')}
                    onClick={() => {
                      setNodeName('');
                      setCreateNodeErr(null);
                      setNodeNaming({ kind: 'file', parent: ctxMenu.node!.path });
                      setCtxMenu(null);
                    }}
                  />
                  <MenuItem
                    icon={FolderPlus}
                    label={t('tree.newFolder')}
                    onClick={() => {
                      setNodeName('');
                      setCreateNodeErr(null);
                      setNodeNaming({ kind: 'folder', parent: ctxMenu.node!.path });
                      setCtxMenu(null);
                    }}
                  />
                  <div className="mx-1 my-1 h-px bg-border" />
                </>
              )}
              <MenuItem icon={X} label={t('tree.remove')} onClick={() => { const node = ctxMenu.node!; setCtxMenu(null); setPlusOpen(false); setPendingDelete(node); }} />
            </>
          )}
          {ctxMenu.node === null && (
            <>
              <MenuItem
                icon={FilePlus2}
                label={t('tree.newFile')}
                onClick={() => {
                  setNodeName('');
                  setCreateNodeErr(null);
                  setNodeNaming({ kind: 'file', parent: '' });
                  setCtxMenu(null);
                }}
              />
              <MenuItem
                icon={FolderPlus}
                label={t('tree.newFolder')}
                onClick={() => {
                  setNodeName('');
                  setCreateNodeErr(null);
                  setNodeNaming({ kind: 'folder', parent: '' });
                  setCtxMenu(null);
                }}
              />
            </>
          )}
        </div>
      )}
    </aside>
  );
}

/** Baris item menu file manager (mirip menu + tab-bar: ikon + label). */
function MenuItem({
  icon: Icon,
  label,
  onClick,
  disabled,
  title,
}: {
  icon: LucideIcon;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      title={title}
      className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
    >
      <Icon size={13} className="shrink-0 text-muted-foreground" />
      <span className="truncate">{label}</span>
    </button>
  );
}
