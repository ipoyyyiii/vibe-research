'use client';

import { useEffect, useMemo, useState } from 'react';
import { Bot, Loader2, PencilLine, User } from 'lucide-react';
import { Button, Modal } from '@/components/ui';
import { useT } from '@/lib/preferences';

type Block = { line: number; text: string; kind: 'human' | 'agent' | 'edited' | 'unknown'; at: string | null };
type Summary = { total: number; human: number; agent: number; edited: number; unknown: number };

const KIND_STYLE = {
  human: { icon: User, box: 'border-l-neutral-400 bg-neutral-50 text-neutral-800', key: 'prov.kindHuman' },
  agent: { icon: Bot, box: 'border-l-violet-500 bg-violet-50 text-violet-900', key: 'prov.kindAgent' },
  edited: { icon: PencilLine, box: 'border-l-amber-500 bg-amber-50 text-amber-900', key: 'prov.kindEdited' },
  unknown: { icon: User, box: 'border-l-neutral-300 bg-neutral-50 text-neutral-600', key: 'prov.kindUnknown' },
} as const;

export function ProvenanceModal({
  slug,
  chapters,
  defaultPath,
  onClose,
  onOpenFile,
}: {
  slug: string;
  chapters: string[];
  defaultPath?: string;
  onClose: () => void;
  onOpenFile?: (path: string) => void;
}) {
  const t = useT();
  const [path, setPath] = useState(defaultPath ?? chapters[0] ?? '');
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'agent' | 'edited'>('all');

  useEffect(() => {
    if (!path) return;
    let alive = true;
    setBusy(true);
    setError(null);
    (async () => {
      try {
        const res = await fetch(
          `/api/projects/${encodeURIComponent(slug)}/provenance?path=${encodeURIComponent(path)}`,
        );
        const data = (await res.json().catch(() => null)) as
          | { blocks?: Block[]; summary?: Summary; error?: string }
          | null;
        if (!alive) return;
        if (!res.ok || !data?.blocks) {
          setError(data?.error ?? t('prov.fail'));
          return;
        }
        setBlocks(data.blocks);
        setSummary(data.summary ?? null);
      } catch {
        if (alive) setError(t('prov.fail'));
      } finally {
        if (alive) setBusy(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [slug, path, t]);

  const shown = useMemo(
    () => (filter === 'all' ? blocks : blocks.filter((block) => block.kind === filter)),
    [blocks, filter],
  );

  return (
    <Modal open onClose={onClose} title={t('prov.title')} wide>
      <div className="space-y-3 text-xs">
        <p className="text-muted-foreground">{t('prov.intro')}</p>

        <div className="flex flex-wrap items-center gap-2">
          <label className="font-medium" htmlFor="prov-chapter">
            {t('prov.chapter')}
          </label>
          <select
            id="prov-chapter"
            value={path}
            onChange={(event) => setPath(event.target.value)}
            className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-xs"
          >
            {chapters.map((chapter) => (
              <option key={chapter} value={chapter}>
                {chapter}
              </option>
            ))}
          </select>
        </div>

        {summary && (
          <div className="flex flex-wrap gap-1.5">
            {(['all', 'agent', 'edited'] as const).map((value) => {
              const label =
                value === 'all'
                  ? t('prov.filterAll', { n: String(summary.total) })
                  : value === 'agent'
                    ? t('prov.filterAgent', { n: String(summary.agent) })
                    : t('prov.filterEdited', { n: String(summary.edited) });
              return (
                <button
                  key={value}
                  type="button"
                  onClick={() => setFilter(value)}
                  className={`rounded-full border px-2 py-0.5 text-[11px] transition-colors ${
                    filter === value ? 'border-primary bg-primary/10 text-foreground' : 'border-border text-muted-foreground hover:bg-muted'
                  }`}
                >
                  {label}
                </button>
              );
            })}
            <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
              {t('prov.filterHuman', { n: String(summary.human) })}
            </span>
          </div>
        )}

        {busy && (
          <p className="flex items-center gap-2 text-muted-foreground">
            <Loader2 size={13} className="animate-spin" />
            {t('prov.loading')}
          </p>
        )}
        {error && <p className="text-red-600">{error}</p>}

        {!busy && !error && shown.length === 0 && (
          <p className="rounded-md border border-border bg-muted/40 p-2 text-[11px] text-muted-foreground">
            {t('prov.empty')}
          </p>
        )}

        <div className="max-h-[46vh] space-y-1 overflow-y-auto">
          {shown.map((block, index) => {
            const style = KIND_STYLE[block.kind];
            const Icon = style.icon;
            return (
              <div
                key={`${block.line}-${index}`}
                className={`flex items-start gap-2 rounded border border-border border-l-2 px-2 py-1.5 ${style.box}`}
              >
                <Icon size={12} className="mt-0.5 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[10px] opacity-70">{block.line}</span>
                    <span className="rounded bg-white/60 px-1 text-[10px] font-medium">{t(style.key)}</span>
                    {block.at && <span className="text-[10px] opacity-70">{block.at.slice(0, 10)}</span>}
                  </div>
                  <p className="line-clamp-2 text-[11px] leading-snug">{block.text}</p>
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex justify-end gap-2">
          {onOpenFile && path && (
            <Button variant="outline" className="h-7 px-2 text-[11px]" onClick={() => onOpenFile(path)}>
              {t('prov.open')}
            </Button>
          )}
          <Button className="h-7 px-2 text-[11px]" onClick={onClose}>
            {t('common.close')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
