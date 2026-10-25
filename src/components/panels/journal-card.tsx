'use client';

import { useState } from 'react';
import { Download, ExternalLink, FileText, Loader2 } from 'lucide-react';
import { useT } from '@/lib/preferences';
import { parseJournalCard, type JournalCardData } from '@/lib/journals/card';

export { parseJournalCard };

/**
 * Kartu jurnal di dalam chat asisten.
 *
 * Agen mengeluarkan blok berpagar `vibe-journal` berisi metadata paper; blok itu
 * dirender jadi kartu yang bisa dibuka PDF-nya dan bisa di-drag ke file manager
 * (drag tidak mungkin ke Finder — batasan browser, bukan aplikasi).
 */

export function JournalCard({ slug, data }: { slug: string; data: JournalCardData }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pdfUrl = data.doi
    ? `/api/journals/pdf?doi=${encodeURIComponent(data.doi)}&slug=${encodeURIComponent(slug)}`
    : null;

  /** Buka PDF di tab browser baru; cek dulu supaya kegagalan tidak senyap. */
  const openPdf = async () => {
    if (!pdfUrl) {
      setError(t('card.noDoi'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(pdfUrl, { method: 'GET' });
      if (!res.ok) {
        setError(t('card.noPdf'));
        return;
      }
      window.open(pdfUrl, '_blank', 'noopener,noreferrer');
    } catch {
      setError(t('card.noPdf'));
    } finally {
      setBusy(false);
    }
  };

  const dragStart = (event: React.DragEvent) => {
    // Tipe khusus supaya file manager bisa membedakan dari berkas OS.
    event.dataTransfer.setData('application/x-vibe-paper', JSON.stringify(data));
    event.dataTransfer.setData('text/plain', data.title ?? data.doi ?? 'paper');
    event.dataTransfer.effectAllowed = 'copy';
  };

  const authors = (data.authors ?? []).slice(0, 3).join(', ');
  const year = data.year ?? '';

  return (
    <div
      draggable
      onDragStart={dragStart}
      className="my-1.5 cursor-grab rounded-lg border border-border bg-card p-2 text-[12px] active:cursor-grabbing"
      title={t('card.dragHint')}
    >
      <div className="flex items-start gap-1.5">
        <FileText size={13} className="mt-0.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="text-[11px] text-muted-foreground">
            {[authors, year, data.venue].filter(Boolean).join(' · ')}
          </p>
          <p className="mt-0.5 font-medium leading-snug">{data.title ?? data.doi}</p>
          {data.doi && <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">{data.doi}</p>}
        </div>
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => void openPdf()}
          disabled={busy}
          className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[11px] hover:bg-muted disabled:opacity-50"
        >
          {busy ? <Loader2 size={10} className="animate-spin" /> : <ExternalLink size={10} />}
          {busy ? t('card.opening') : t('card.open')}
        </button>
        {data.openAccessUrl && (
          <a
            href={data.openAccessUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[11px] hover:bg-muted"
          >
            <Download size={10} />
            {t('card.source')}
          </a>
        )}
        <span className="text-[10px] text-muted-foreground">{t('card.dragHint')}</span>
      </div>

      {error && <p className="mt-1 text-[11px] text-amber-700">{error}</p>}
    </div>
  );
}
