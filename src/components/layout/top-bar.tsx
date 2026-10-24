'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { FilePlus2, Columns2, Download, Loader2, MessagesSquare } from 'lucide-react';
import { useT } from '@/lib/preferences';
import { Button, IconButton, Modal, StatusDot } from '@/components/ui';
import { NewDocModal, requestNewDocument } from '@/components/panels/new-doc-modal';
import { ThesisExportModal } from '@/components/editor/thesis-export-modal';

/**
 * Bar atas brand ala homepage: mark "R" navy + wordmark `research-desk` —
 * SELURUH brand bisa diklik balik ke halaman awal `/`. Nama project aktif
 * masih tampil kecil di sebelahnya (info context, bukan link).
 *
 * Dialog dokumen baru di-mount SATU kali di sini; komponen lain minta buka
 * lewat `requestNewDocument()` (event global). Sukses buat → event
 * `workspace:doc-created` yang di-listen shell buat buka tabnya.
 */
export function TopBar({
  projectName,
  projectSlug,
  focusMode,
  onToggleFocusMode,
  rightOpen = true,
  onToggleRight,
}: {
  projectName: string;
  projectSlug: string;
  focusMode: boolean;
  onToggleFocusMode: () => void;
  /** Panel kanan (AI Assistant) lagi kebuka? — buat aria-pressed toggle header. */
  rightOpen?: boolean;
  onToggleRight?: () => void;
}) {
  const router = useRouter();
  const t = useT();
  const [menuOpen, setMenuOpen] = useState(false);
  const [slidesBusy, setSlidesBusy] = useState(false);
  const [slidesResult, setSlidesResult] = useState<string | null>(null);
  const [slidesError, setSlidesError] = useState<string | null>(null);
  const [thesisOpen, setThesisOpen] = useState(false);
  const [progressOpen, setProgressOpen] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [progressBusy, setProgressBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const onClick = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [menuOpen]);

  const downloadBackup = () => {
    setMenuOpen(false);
    window.location.href = `/api/projects/${encodeURIComponent(projectSlug)}/backup`;
  };

  /** Slide sidang: dibuat dari bab & hasil yang ada, lalu diunduh. */
  const createSlides = async () => {
    setSlidesBusy(true);
    setSlidesError(null);
    setSlidesResult(null);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectSlug)}/export/slides`, {
        method: 'POST',
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; file?: string; slides?: number; notes?: string[]; error?: string }
        | null;
      if (!res.ok || !data?.ok || !data.file) {
        setSlidesError(data?.error ?? t('topbar.slidesFail'));
        return;
      }
      setSlidesResult(data.file);
      window.dispatchEvent(new CustomEvent('workspace:tree-refresh'));
    } catch {
      setSlidesError(t('topbar.slidesFail'));
    } finally {
      setSlidesBusy(false);
    }
  };

  const openProgress = async () => {
    setMenuOpen(false);
    setProgressOpen(true);
    if (progress) return;
    setProgressBusy(true);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectSlug)}/progress`);
      const data = (await res.json().catch(() => null)) as { markdown?: string; error?: string } | null;
      if (!res.ok || !data?.markdown) {
        setProgress(data?.error ?? t('topbar.progressFail'));
        return;
      }
      setProgress(data.markdown);
    } catch {
      setProgress(t('topbar.progressFail'));
    } finally {
      setProgressBusy(false);
    }
  };

  const copyProgress = async () => {
    if (!progress) return;
    try {
      await navigator.clipboard.writeText(progress);
      setMessage(t('topbar.copied'));
      window.setTimeout(() => setMessage(null), 2500);
    } catch {
      setMessage(t('topbar.progressFail'));
    }
  };

  return (
    <header className="flex h-11 items-center justify-between border-b border-neutral-200 px-3 dark:border-neutral-800">
      <div className="flex min-w-0 items-center gap-2">
        {/* Brand → home: satu zona klik, title + focus ring eksplisit. */}
        <button
          type="button"
          onClick={() => router.push('/')}
          title={t('brand.home')}
          aria-label={t('brand.home')}
          className="flex h-11 shrink-0 cursor-pointer items-center gap-2 rounded-md px-2 -mx-2 transition-colors hover:bg-neutral-100 dark:hover:bg-neutral-800 focus-visible:-mx-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span
            aria-hidden="true"
            className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary font-mono text-[13px] font-medium text-primary-foreground"
          >
            V
          </span>
          <span className="whitespace-nowrap text-sm font-semibold tracking-tight">
            {t('brand.name')}
          </span>
        </button>
        {/* Project aktif: info kecil di samping brand — bukan bagian zona klik. */}
        <span
          aria-hidden="true"
          className="select-none text-xs text-neutral-300 dark:text-neutral-700"
        >
          /
        </span>
        <span className="min-w-0 truncate text-xs text-muted-foreground">{projectName}</span>
      </div>

      <div className="flex items-center gap-2">
        {/* Menu project: ekspor skripsi lengkap, laporan progres, backup */}
        <div ref={menuRef} className="relative">
          <Button
            variant="ghost"
            onClick={() => setMenuOpen((open) => !open)}
            aria-expanded={menuOpen}
            title={t('topbar.export')}
          >
            {t('topbar.export')} ▾
          </Button>
          {menuOpen && (
            <div className="absolute right-0 top-9 z-50 w-56 rounded-md border border-border bg-card p-1 text-xs shadow-lg">
              <button
                type="button"
                className="w-full cursor-pointer rounded px-2 py-1.5 text-left font-medium transition-colors hover:bg-muted"
                onClick={() => {
                  setMenuOpen(false);
                  setThesisOpen(true);
                }}
              >
                {t('topbar.fullThesis')}
              </button>
              <button
                type="button"
                disabled={slidesBusy}
                className="w-full cursor-pointer rounded px-2 py-1.5 text-left transition-colors hover:bg-muted disabled:cursor-wait disabled:opacity-60"
                onClick={() => void createSlides()}
              >
                {slidesBusy ? t('topbar.slidesBusy') : t('topbar.slides')}
              </button>
              {slidesResult && (
                <div className="rounded bg-muted/60 px-2 py-1 text-[11px]">
                  <p className="truncate" title={slidesResult}>
                    {t('topbar.slidesDone')}
                  </p>
                  <a
                    href={`/api/projects/${encodeURIComponent(projectSlug)}/raw?path=${encodeURIComponent(slidesResult)}`}
                    download
                    className="underline underline-offset-2"
                  >
                    {t('topbar.slidesDownload')}
                  </a>
                </div>
              )}
              {slidesError && <p className="px-2 py-1 text-[11px] text-red-600">{slidesError}</p>}
              <button
                type="button"
                className="w-full cursor-pointer rounded px-2 py-1.5 text-left transition-colors hover:bg-muted"
                onClick={() => void openProgress()}
              >
                {t('topbar.progress')}
              </button>
              <div className="my-1 h-px bg-border" />
              <button
                type="button"
                className="flex w-full cursor-pointer items-center gap-1.5 rounded px-2 py-1.5 text-left transition-colors hover:bg-muted"
                onClick={downloadBackup}
              >
                <Download size={12} />
                {t('topbar.backup')}
              </button>
            </div>
          )}
        </div>
        <IconButton onClick={onToggleFocusMode} title="Focus mode (Esc)" className={focusMode ? 'text-blue-500' : ''}>
          <Columns2 size={15} />
        </IconButton>
        {!focusMode && (
          <Button
            variant="ghost"
            onClick={onToggleRight}
            aria-pressed={rightOpen}
            title={rightOpen ? t('layout.rightClose') : t('layout.aiOpen')}
          >
            <MessagesSquare size={15} />
            {t('layout.aiAssistant')}
          </Button>
        )}
        <Button variant="subtle" onClick={requestNewDocument}>
          <FilePlus2 size={15} />
          {t('common.newDocument')}
        </Button>
        <StatusDot tone="amber" title={`OpenCode: ${t('chat.statusOff')} (fase 2)`} />
      </div>

      {/* Dialog dokumen baru — pindah ke new-doc-modal (shared: bisa dipanggil
          lewat event dari panel lain). */}
      <NewDocModal slug={projectSlug} />

      <ThesisExportModal open={thesisOpen} onClose={() => setThesisOpen(false)} slug={projectSlug} />

      <Modal open={progressOpen} onClose={() => setProgressOpen(false)} title={t('topbar.progress')} wide>
        <div className="space-y-3 text-xs">
          {progressBusy && (
            <p className="flex items-center gap-2 text-muted-foreground">
              <Loader2 size={13} className="animate-spin" />
              {t('topbar.progressLoading')}
            </p>
          )}
          {!progressBusy && progress && (
            <pre className="max-h-[60vh] overflow-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-[11px] whitespace-pre-wrap">
              {progress}
            </pre>
          )}
          {message && <p className="text-muted-foreground">{message}</p>}
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button variant="outline" className="h-7 px-2 text-[11px]" onClick={() => void copyProgress()}>
              {t('topbar.progressCopy')}
            </Button>
            <Button variant="outline" className="h-7 px-2 text-[11px]" onClick={() => setProgressOpen(false)}>
              {t('topbar.close')}
            </Button>
          </div>
        </div>
      </Modal>
    </header>
  );
}
