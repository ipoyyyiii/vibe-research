'use client';

import { useState } from 'react';
import { AlertTriangle, ExternalLink, FileSearch, Info, Loader2, Play } from 'lucide-react';
import { Button, Modal } from '@/components/ui';
import { useT } from '@/lib/preferences';
import type { SentenceHit } from '@/lib/similarity/check';

type SimilaritySummary = {
  chapters: number;
  sentences: number;
  sources: number;
  flagged: number;
  threshold: number;
};

type SimilarityResponse = {
  hits: SentenceHit[];
  summary: SimilaritySummary;
  notes: string[];
};

type Props = {
  slug: string;
  onClose: () => void;
  /** Kalau diberikan, tombol "Buka" di tiap baris membuka berkas bab terkait. */
  onOpenFile?: (path: string) => void;
};

/**
 * Modal cek kemiripan lokal (presentasional): semua angka dari
 * `GET /api/projects/[slug]/similarity`, bukan perkiraan client.
 */
export function SimilarityModal({ slug, onClose, onOpenFile }: Props) {
  const t = useT();
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [result, setResult] = useState<SimilarityResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setStatus('loading');
    setError(null);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(slug)}/similarity`, {
        cache: 'no-store',
      });
      const data = (await res.json().catch(() => null)) as
        | (SimilarityResponse & { error?: string })
        | null;
      if (!res.ok || !data || !Array.isArray(data.hits) || !data.summary) {
        setResult(null);
        setError(data && typeof data.error === 'string' ? data.error : t('sim.fail'));
        setStatus('error');
        return;
      }
      setResult({
        hits: data.hits,
        summary: data.summary,
        notes: Array.isArray(data.notes) ? data.notes : [],
      });
      setStatus('ready');
    } catch {
      setResult(null);
      setError(t('sim.fail'));
      setStatus('error');
    }
  };

  const busy = status === 'loading';

  return (
    <Modal open onClose={onClose} title={t('sim.title')} wide>
      <div className="space-y-3 text-xs">
        <p className="text-[11px] text-muted-foreground">{t('sim.intro')}</p>

        {busy && (
          <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Loader2 size={12} className="animate-spin" />
            {t('sim.running')}
          </p>
        )}

        {status === 'error' && (
          <div className="flex items-start gap-1.5 rounded-md border border-red-300 bg-red-50 p-2 text-[11px] text-red-900">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            <span>{error ?? t('sim.fail')}</span>
          </div>
        )}

        {status === 'ready' && result && (
          <>
            <p className="rounded-md border border-border bg-muted/40 p-2 text-[11px]">
              {t('sim.summary', {
                chapters: result.summary.chapters,
                sentences: result.summary.sentences,
                sources: result.summary.sources,
                flagged: result.summary.flagged,
              })}
            </p>

            {result.notes.length > 0 && (
              <ul className="space-y-1">
                {result.notes.map((note, index) => (
                  <li
                    key={`${index}-${note}`}
                    className="flex items-start gap-1.5 text-[11px] text-muted-foreground"
                  >
                    <Info size={12} className="mt-0.5 shrink-0" />
                    <span>{note}</span>
                  </li>
                ))}
              </ul>
            )}

            {result.summary.sources === 0 ? (
              <p className="flex items-start gap-1.5 rounded-md border border-amber-300 bg-amber-50 p-2 text-[11px] text-amber-900">
                <FileSearch size={13} className="mt-0.5 shrink-0" />
                {t('sim.empty')}
              </p>
            ) : result.hits.length === 0 ? null : (
              <ul className="space-y-2">
                {result.hits.map((hit, index) => {
                  const percent = Math.round(hit.score * 100);
                  return (
                    <li
                      key={`${hit.path}:${hit.line}:${hit.sourceKey}:${index}`}
                      className="rounded-md border border-border p-2"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate font-mono text-[10px] text-muted-foreground">
                          {hit.path}:{hit.line}
                        </span>
                        <span className="shrink-0 rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold text-red-800 dark:bg-red-950 dark:text-red-200">
                          {percent}%
                        </span>
                      </div>
                      <p className="mt-1 text-[11px] leading-relaxed">{hit.sentence}</p>
                      <div className="mt-1 flex items-center justify-between gap-2">
                        <p className="min-w-0 truncate text-[10px] text-muted-foreground">
                          {t('sim.source')} {hit.sourceTitle}{' '}
                          <span className="font-mono">({hit.sourceKey})</span>
                        </p>
                        <span className="shrink-0 text-[10px] font-medium">
                          {t('sim.hit', { score: `${percent}%` })}
                        </span>
                        {onOpenFile && (
                          <Button
                            variant="outline"
                            className="h-6 shrink-0 px-2 text-[10px]"
                            onClick={() => onOpenFile(hit.path)}
                          >
                            <ExternalLink size={11} className="mr-1" />
                            {t('sim.open')}
                          </Button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="outline" className="h-7 px-2 text-[11px]" onClick={onClose} disabled={busy}>
            {t('common.close')}
          </Button>
          <Button className="h-7 px-2 text-[11px]" onClick={() => void run()} disabled={busy}>
            {busy ? <Loader2 size={12} className="mr-1 animate-spin" /> : <Play size={12} className="mr-1" />}
            {busy ? t('sim.running') : t('sim.run')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
