'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import Image from '@tiptap/extension-image';
import TextAlign from '@tiptap/extension-text-align';
import Placeholder from '@tiptap/extension-placeholder';
import TaskItem from '@tiptap/extension-task-item';
import TaskList from '@tiptap/extension-task-list';
import { Table, TableRow, TableHeader, TableCell } from '@tiptap/extension-table';
import { CitationMark, applyCitationMarks, normalizeCitationEscapes } from '@/components/editor/citation-mark';
import {
  Bold,
  Italic,
  Strikethrough,
  Underline as UnderlineIcon,
  TextQuote,
  BookMarked,
  Sparkles,
} from 'lucide-react';
import { useT } from '@/lib/preferences';
import { Modal } from '@/components/ui';
import { computeLineDiff, countDiff } from '@/lib/diff';
import { Ribbon, readViewPrefs, uploadProjectImage, type ViewPrefs } from './ribbon';

type SaveStatus = 'clean' | 'dirty' | 'saving' | 'error';

/**
 * Isi editor dari STRING MARKDOWN.
 *
 * `setContent(string)` di TipTap memperlakukan string sebagai HTML — markdown
 * mentah jadi satu paragraf berisi "#"/"##" literal, lalu autosave menulis
 * balik dokumen yang sudah rusak (heading & paragraf lebur). Jadi string
 * selalu diparse lewat markdown extension dulu, baru masuk sebagai JSON.
 */
function applyMarkdown(target: Editor, markdown: string): void {
  target.commands.setContent(markdown, { emitUpdate: false, contentType: 'markdown' });
}

const AUTOSAVE_DELAY_MS = 800;

/** Spasi baris pilihan user → multiplier CSS di kertas (tampilan saja). */
const SPACING_CSS: Record<string, string> = {
  '1': '1.45',
  '1.5': '1.9',
  '2': '2.35',
};

/**
 * Simpan isi bab sebelum direvisi agen sebagai versi (reason 'agent').
 * Isi lamanya gak ada lagi di disk — agen sudah menimpa file — jadi konten
 * dikirim dari client.
 */
async function saveAgentVersion(
  slug: string,
  filePath: string,
  content: string,
): Promise<void> {
  try {
    await fetch(`/api/projects/${encodeURIComponent(slug)}/versions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath, content, reason: 'agent' }),
    });
  } catch {
    // diam — riwayat bukan hal kritis
  }
}

export function ThesisEditor({
  slug,
  filePath,
  onWordsChange,
}: {
  slug: string;
  filePath: string;
  /** Lapor hitungan kata (fase 5) — dipakai footer panel tengah. */
  onWordsChange?: (words: number) => void;
}) {
  const t = useT();
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(
          `/api/projects/${encodeURIComponent(slug)}/file?path=${encodeURIComponent(filePath)}`,
        );
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setLoadError(t('err.openFile'));
          return;
        }
        setMarkdown(data.content ?? '');
      } catch {
        if (!cancelled) setLoadError(t('err.server'));
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [slug, filePath, t]);

  if (loadError) {
    return <div className="flex h-full items-center justify-center p-8 text-sm text-red-600">{loadError}</div>;
  }
  if (markdown === null) {
    return <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">…</div>;
  }
  return <EditorSurface slug={slug} filePath={filePath} initialMarkdown={markdown} onWordsChange={onWordsChange} />;
}

function EditorSurface({
  slug,
  filePath,
  initialMarkdown,
  onWordsChange,
}: {
  slug: string;
  filePath: string;
  initialMarkdown: string;
  /** Lapor hitungan kata ke tab tengah (footer center, fase 5). */
  onWordsChange?: (words: number) => void;
}) {
  const t = useT();
  const [status, setStatus] = useState<SaveStatus>('clean');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [words, setWords] = useState(0);
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const [imgError, setImgError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const filePathRef = useRef(filePath);
  filePathRef.current = filePath;

  // Review edit agent (fase 5): konten before/after satu edit terakhir.
  const [review, setReview] = useState<{ before: string; after: string; added: number; removed: number } | null>(null);
  const [diffOpen, setDiffOpen] = useState(false);
  // Callback words via ref biar gak ngeracik ulang effect tiap render parent.
  const wordsCbRef = useRef(onWordsChange);
  wordsCbRef.current = onWordsChange;

  const publishWords = useCallback((ed: Editor) => {
    const n = countWords(ed);
    setWords(n);
    wordsCbRef.current?.(n);
  }, []);

  // Prefs tampilan (font/ukuran/spasi) — ke server gak ikut disimpan (md = konten).
  const [prefs, setPrefsState] = useState<ViewPrefs>(() => readViewPrefs());
  const setPrefs = useCallback((p: ViewPrefs) => {
    setPrefsState(p);
    localStorage.setItem('editor:font', p.fontFamily.value);
    localStorage.setItem('editor:fontSize', String(p.fontSize));
    localStorage.setItem('editor:lineSpacing', p.lineSpacing);
  }, []);

  // Dipanggil editorProps.handlePaste / handleDrop — disetel setelah editor siap.
  const insertRef = useRef<((files: File[]) => void) | null>(null);

  // Chip sitasi: map key → label hover "Judul (Tahun) — Venue" (dari references.bib).
  const bibLabelsRef = useRef<Map<string, string>>(new Map());
  // Ref ke fungsi label-kan chip — dipanggil ulang pas fetch bib selesai.
  const applyChipLabelsRef = useRef<(() => void) | null>(null);

  const editor = useEditor({
    // Wajib utk Next.js SSR — cegah hydration mismatch (editor dirender client-side)
    immediatelyRender: false,
    extensions: [
      StarterKit,
      Markdown.configure({ markedOptions: { gfm: true } }),
      // Chip sitasi `[@key]` — chip tampil, file tetap plain buat pandoc.
      CitationMark,
      // Override render: src relatif di .md (gambar/x.png) → URL raw API utk tampilan;
      // keluaran markdown tetap path relatif.
      createMappedImage(slug),
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      Placeholder.configure({ placeholder: t('editor.startTyping') }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Table.configure({ resizable: false }),
      TableRow,
      TableHeader,
      TableCell,
    ],
    content: '',
    // Konten awal = markdown (bukan HTML) → parse dulu, baru chip sitasi.
    onCreate: ({ editor: created }) => {
      applyMarkdown(created, initialMarkdown);
      applyCitationMarks(created);
    },
    editorProps: {
      attributes: {
        class: 'tiptap paper outline-none',
      },
      // Klik chip sitasi → bubuarkan event buat panel kiri (tanpa preventDefault).
      handleDOMEvents: {
        click: (_view, event) => {
          const chip = (event.target as HTMLElement | null)?.closest?.('span[data-citation-key]');
          if (!chip) return false;
          const key = chip.getAttribute('data-citation-key');
          if (!key) return false;
          // Konsumsi event oleh left-panel (fase 6).
          window.dispatchEvent(new CustomEvent('workspace:open-bib-entry', { detail: { key } }));
          return false; // kursor & seleksi tetap jalan normal
        },
      },
      handlePaste: (_view, event) => {
        const files = [...(event.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
        if (files.length === 0) return false;
        event.preventDefault();
        insertRef.current?.(files);
        return true;
      },
      handleDrop: (_view, event, _slice, moved) => {
        if (moved) return false;
        const files = [...(event.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith('image/'));
        if (files.length === 0) return false;
        event.preventDefault();
        insertRef.current?.(files);
        return true;
      },
    },
    onUpdate: ({ editor }) => {
      setStatus('dirty');
      publishWords(editor);
      scheduleSave();
    },
  });

  // Fetch references.bib sekali → map label chip sitasi (bib gak ada → map kosong).
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/projects/${encodeURIComponent(slug)}/bib`);
        if (!res.ok) return;
        const data = (await res.json()) as {
          entries?: Array<{ key: string; title?: string; year?: string | number; venue?: string }>;
        };
        if (cancelled || !Array.isArray(data.entries)) return;
        const labels = new Map<string, string>();
        for (const e of data.entries) {
          if (!e?.key) continue;
          const year = e.year == null || e.year === '' ? '' : String(e.year);
          const label = `${e.title ?? e.key}${year ? ` (${year})` : ''}${e.venue ? ` — ${e.venue}` : ''}`;
          labels.set(e.key, label);
        }
        bibLabelsRef.current = labels;
        applyChipLabelsRef.current?.(); // chip yang udah terpasang → label lengkap sekarang
      } catch {
        // diam — tanpa bib chip tetap ada, fallback label = key
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  // Hover title chip: scan ulang tiap update — ProseMirror bisa strip attr title saat re-render.
  useEffect(() => {
    if (!editor) return;
    const labelChips = () => {
      const labels = bibLabelsRef.current;
      const chips = editor.view.dom.querySelectorAll<HTMLElement>('span[data-citation-key]');
      chips.forEach((el) => {
        const key = el.getAttribute('data-citation-key');
        if (!key) return;
        const label = labels.get(key) ?? key; // fallback: key mentah
        if (el.title !== label) el.title = label;
      });
    };
    applyChipLabelsRef.current = labelChips;
    const onUpdate = () => queueMicrotask(labelChips); // biarkan DOM di-patch transaksi dulu
    editor.on('update', onUpdate);
    labelChips(); // chip awal dari onCreate/applyCitationMarks
    return () => {
      editor.off('update', onUpdate);
      applyChipLabelsRef.current = null;
    };
  }, [editor]);

  // Handler upload + sisip gambar (dipakai paste & drag-drop).
  useEffect(() => {
    if (!editor) return;
    insertRef.current = async (files: File[]) => {
      for (const file of files) {
        const result = await uploadProjectImage(slug, file);
        if (!result.ok) setImgError(result.error === 'server' || result.error === 'upload:server' ? t('err.server') : result.error);
        if (result.ok) {
          editor.chain().focus().setImage({ src: result.path }).run();
        } else {
          setImgError(result.error);
        }
      }
    };
    return () => {
      insertRef.current = null;
    };
  }, [editor, slug, t]);

  // Agent mengubah file → refetch (hidup: file yang sama, gak lagi berhas edit)
  useEffect(() => {
    const onAgentChange = (event: Event) => {
      const detail = (event as CustomEvent<{ file?: string }>).detail;
      const changed = detail?.file ?? '';
      if (!changed) return;
      // event server biasanya path absolut; cocokkan ekornya
      if (!changed.endsWith(filePath)) return;
      if (status !== 'clean') return; // user lagi ngetik → jangan timpah
      let cancelled = false;
      const refetch = async () => {
        try {
          if (!editor) return;
          // Simpan tampilan user SAAT INI sebagai "before" review (fase 5) —
          // termasuk edit belum tersimpan, supaya Tolak bisa tulis-ulang semula.
          const before = editor.getMarkdown();
          const res = await fetch(
            `/api/projects/${encodeURIComponent(slug)}/file?path=${encodeURIComponent(filePath)}`,
          );
          const data = await res.json();
          if (cancelled || !res.ok || !editor) return;
          const md = (data.content ?? '') as string;
          const current = editor.getMarkdown();
          if (md === current) return;
          applyMarkdown(editor, md);
          // Agent gak ngerti chip → `[@key]` mentah dari file: chip-kan lagi.
          applyCitationMarks(editor);
          setStatus('clean');
          publishWords(editor);
          if (before !== md) {
            const stats = countDiff(before, md);
            setReview({ before, after: md, added: stats.added, removed: stats.removed });
            // Agen sudah menimpa file di disk → isi SEBELUM-nya dikirim dari
            // client supaya jadi versi 'sebelum revisi agen'.
            void saveAgentVersion(slug, filePath, normalizeCitationEscapes(before));
          }
        } catch {
          // diamkan — autosave nanti
        }
      };
      void refetch();
      return () => {
        cancelled = true;
      };
    };
    window.addEventListener('workspace:agent-change', onAgentChange);
    return () => window.removeEventListener('workspace:agent-change', onAgentChange);
  }, [editor, slug, filePath, status, publishWords]);

  // Versi dipulihkan dari panel Riwayat Versi → isi bab berubah di disk;
  // ambil ulang tanpa banner review.
  useEffect(() => {
    const onRestored = (event: Event) => {
      const changed = (event as CustomEvent<{ path?: string }>).detail?.path ?? '';
      if (!changed || changed !== filePath) return;
      let cancelled = false;
      const refetch = async () => {
        try {
          if (!editor) return;
          const res = await fetch(
            `/api/projects/${encodeURIComponent(slug)}/file?path=${encodeURIComponent(filePath)}`,
          );
          const data = await res.json();
          if (cancelled || !res.ok || !editor) return;
          const md = (data.content ?? '') as string;
          if (md === editor.getMarkdown()) return;
          applyMarkdown(editor, md);
          applyCitationMarks(editor);
          publishWords(editor);
          setStatus('clean');
        } catch {
          // diamkan — autosave/restore berikutnya nutupin
        }
      };
      void refetch();
      return () => {
        cancelled = true;
      };
    };
    window.addEventListener('workspace:file-restored', onRestored);
    return () => window.removeEventListener('workspace:file-restored', onRestored);
  }, [editor, slug, filePath, publishWords]);

  const save = useCallback(async () => {
    if (!editor || editor.isDestroyed) return;
    // Escape `[@key]` → balik plain biar pandoc --citeproc kenal pas ekspor.
    const md = normalizeCitationEscapes(editor.getMarkdown());
    setStatus('saving');
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(slug)}/file`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        // reason 'edit' → isi bab yang lama disimpan sebagai versi sebelum ditimpa.
        body: JSON.stringify({ path: filePathRef.current, content: md, reason: 'edit' }),
      });
      if (!res.ok) {
        // Tampilkan alasan dari server: "isi kosong ditolak" jauh lebih
        // menolong daripada "gagal menyimpan" tanpa keterangan.
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setSaveError(data?.error ?? t('editor.saveFailed'));
        setStatus('error');
        return;
      }
      setSaveError(null);
      setStatus('clean');
      setLastSavedAt(new Date());
    } catch {
      setSaveError(t('editor.saveFailed'));
      setStatus('error');
    }
  }, [editor, slug, t]);

  const scheduleSave = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => void save(), AUTOSAVE_DELAY_MS);
  }, [save]);

  // Review fase 5 — Tolak: tulis-ulang isi "before" (termasuk edit user yang belum tersimpan).
  const rejectReview = useCallback(async () => {
    if (!review || !editor || editor.isDestroyed) return;
    const { before, after, added, removed } = review;
    setReview(null);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(slug)}/file`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        // reason 'reject' → versi agen yang ditolak disimpan dulu sebagai cadangan.
        body: JSON.stringify({ path: filePathRef.current, content: before, reason: 'reject' }),
      });
      if (!res.ok) {
        setStatus('error');
        setReview({ before, after, added, removed });
        return;
      }
      applyMarkdown(editor, before);
      applyCitationMarks(editor);
      publishWords(editor);
      setStatus('clean');
    } catch {
      setStatus('error');
    }
  }, [review, editor, slug, publishWords]);

  // ⌘S / Ctrl+S = simpan sekarang
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        if (timerRef.current) clearTimeout(timerRef.current);
        void save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save]);

  useEffect(() => {
    if (editor) publishWords(editor);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [editor, publishWords]);

  if (!editor) return null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Ribbon editor={editor} slug={slug} filePath={filePath} prefs={prefs} setPrefs={setPrefs} />
      {imgError && (
        <p className="shrink-0 bg-red-50 px-3 py-1 text-[11px] text-red-600 dark:bg-red-950/40">
          {t('toolbar.uploadFailed')}: {imgError}
        </p>
      )}
      {/* Banner review edit agent (fase 5) — muncul pas agent nulis file ini. */}
      {review && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-amber-300 bg-amber-50 px-3 py-1 text-[11px] text-amber-800 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
          <Sparkles size={12} className="shrink-0" />
          <span className="font-medium">{t('review.title')}</span>
          <span className="font-mono text-[10px]">
            <span className="text-green-700 dark:text-green-400">+{review.added}</span>{' '}
            <span className="text-red-700 dark:text-red-400">−{review.removed}</span>
          </span>
          <span className="min-w-2 flex-1" />
          <button
            type="button"
            onClick={() => setDiffOpen(true)}
            className="cursor-pointer rounded border border-amber-300 px-1.5 py-0.5 transition-colors hover:bg-amber-100 dark:border-amber-700 dark:hover:bg-amber-900/50"
          >
            {t('review.openDiff')}
          </button>
          <button
            type="button"
            onClick={() => void rejectReview()}
            className="cursor-pointer rounded border border-amber-300 px-1.5 py-0.5 font-medium transition-colors hover:bg-amber-100 dark:border-amber-700 dark:hover:bg-amber-900/50"
          >
            {t('review.reject')}
          </button>
          <button
            type="button"
            onClick={() => setReview(null)}
            className="cursor-pointer rounded px-1.5 py-0.5 transition-colors hover:bg-amber-100 dark:hover:bg-amber-900/50"
          >
            {t('review.keep')}
          </button>
        </div>
      )}
      <SelectionBubbleMenu editor={editor} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div
          className="paper-wrap mx-auto my-6 max-w-[820px] rounded-lg bg-card px-12 py-10 text-card-foreground shadow-sm ring-1 ring-border"
          style={{
            fontFamily: prefs.fontFamily.css,
            fontSize: `${prefs.fontSize}pt`,
            lineHeight: SPACING_CSS[prefs.lineSpacing] ?? '1.9',
          }}
        >
          <EditorContent editor={editor} />
        </div>
      </div>
      <footer className="flex h-8 shrink-0 items-center justify-between border-t border-border px-4 text-[11px] text-muted-foreground">
        <span>
          {words} {t('editor.words')}
        </span>
        <SaveStatusLabel status={status} lastSavedAt={lastSavedAt} message={saveError} />
      </footer>

      {/* Diff review (fase 5): baris hijau=masuk, merah=kelaar. */}
      <Modal open={diffOpen} onClose={() => setDiffOpen(false)} title={t('review.openDiff')} wide>
        {review && (
          <>
            <p className="mb-3 text-[11px] text-muted-foreground">{t('review.rejectHint')}</p>
            <div className="max-h-[55vh] overflow-y-auto rounded-md border border-border bg-muted/40 font-mono text-[11px] leading-4">
              {computeLineDiff(review.before, review.after).map((row, index) => (
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
    </div>
  );
}

function SaveStatusLabel({
  status,
  lastSavedAt,
  message,
}: {
  status: SaveStatus;
  lastSavedAt: Date | null;
  message?: string | null;
}) {
  const t = useT();
  if (status === 'saving') return <span className="text-amber-600">{t('editor.saving')}</span>;
  if (status === 'error') return <span className="text-red-600">{message ?? t('editor.saveFailed')}</span>;
  if (status === 'dirty') return <span>{t('editor.unsaved')}</span>;
  return (
    <span>
      {t('editor.saved')}
      {lastSavedAt ? ` · ${lastSavedAt.toLocaleTimeString()}` : ''}
    </span>
  );
}

function countWords(editor: Editor): number {
  const text = editor.state.doc.textContent;
  const matches = text.match(/\S+/g);
  return matches ? matches.length : 0;
}

/** Bubble menu ringan saat seleksi teks (ribbon sudah menangani sisanya). */
function SelectionBubbleMenu({ editor }: { editor: Editor }) {
  const t = useT();
  const btn = (active: boolean) => `bubble-btn ${active ? 'is-active' : ''}`;
  const disabledPhase = (hint: string) => ({ disabled: true, title: hint });

  return (
    <BubbleMenu editor={editor} className="bubble">
      <button type="button" className={btn(editor.isActive('bold'))} title={t('toolbar.bold')} onClick={() => editor.chain().focus().toggleBold().run()}>
        <Bold size={14} />
      </button>
      <button type="button" className={btn(editor.isActive('italic'))} title={t('toolbar.italic')} onClick={() => editor.chain().focus().toggleItalic().run()}>
        <Italic size={14} />
      </button>
      <button type="button" className={btn(editor.isActive('underline'))} title={t('toolbar.underline')} onClick={() => editor.chain().focus().toggleUnderline().run()}>
        <UnderlineIcon size={14} />
      </button>
      <button type="button" className={btn(editor.isActive('strike'))} title={t('toolbar.strike')} onClick={() => editor.chain().focus().toggleStrike().run()}>
        <Strikethrough size={14} />
      </button>
      <span className="bubble-sep" />
      <button type="button" className={btn(editor.isActive('blockquote'))} title="❝" onClick={() => editor.chain().focus().toggleBlockquote().run()}>
        <TextQuote size={14} />
      </button>
      <span className="bubble-sep" />
      <button type="button" className="bubble-btn" {...disabledPhase(t('toolbar.citeHint'))} title={`${t('toolbar.cite')} · ${t('toolbar.citeHint')}`}>
        <BookMarked size={14} />
      </button>
      <button type="button" className="bubble-btn" {...disabledPhase(t('toolbar.askHint'))} title={`${t('toolbar.ask')} · ${t('toolbar.askHint')}`}>
        <Sparkles size={14} />
      </button>
    </BubbleMenu>
  );
}

/** Extension Image dengan mapping src → URL raw API (tampilan), .md tetap relatif. */
function createMappedImage(slug: string) {
  return Image.extend({
    renderHTML({ node, HTMLAttributes }) {
      const src: string = (HTMLAttributes.src as string) ?? (node.attrs.src as string) ?? '';
      // Path relatif workspace (gambar/xxx.png) → serve via raw API.
      if (src && !/^(https?:\/\/|data:|blob:|\/)/i.test(src)) {
        return [
          'img',
          {
            ...HTMLAttributes,
            src: `/api/projects/${encodeURIComponent(slug)}/raw?path=${encodeURIComponent(src)}`,
            'data-workspace-src': src,
          },
        ];
      }
      return ['img', HTMLAttributes];
    },
  });
}
