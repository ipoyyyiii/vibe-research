'use client';

import { useMemo, useState } from 'react';
import { Copy, Download } from 'lucide-react';
import { Button, Modal } from '@/components/ui';
import { useT } from '@/lib/preferences';
import {
  cochran,
  isaacMichael,
  slovin,
  sampleSizeMarkdown,
  type SampleMethod,
} from '@/lib/stats/sample-size';

const METHOD_LABEL: Record<SampleMethod, string> = {
  slovin: 'Slovin',
  cochran: 'Cochran',
  'isaac-michael': 'Isaac & Michael',
};

type Row = { method: SampleMethod; n: number; formula: string; assumption: string; whenToUse: string };

export function SampleSizeModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [population, setPopulation] = useState('100');
  const [errorText, setErrorText] = useState('5');
  const [copied, setCopied] = useState(false);

  const n = Number(population);
  const e = Number(errorText) / 100;

  const result = useMemo(() => {
    if (!Number.isFinite(n) || n <= 0) return { rows: [] as Row[], error: t('sampleSize.errPopulation') };
    if (!Number.isFinite(e) || e <= 0 || e >= 1) return { rows: [] as Row[], error: t('sampleSize.errMargin') };
    try {
      const rows: Row[] = [
        {
          method: 'slovin',
          n: slovin(n, e),
          formula: 'n = N / (1 + N·e²)',
          assumption: t('sampleSize.assumptionSlovin'),
          whenToUse: t('sampleSize.whenSlovin'),
        },
        {
          method: 'cochran',
          n: cochran(n, { marginOfError: e }),
          formula: 'n₀ = z²·p(1−p)/e², n = n₀ / (1 + (n₀−1)/N)',
          assumption: t('sampleSize.assumptionCochran'),
          whenToUse: t('sampleSize.whenCochran'),
        },
        {
          method: 'isaac-michael',
          n: isaacMichael(n, { marginOfError: e }),
          formula: 'n = z²·N·p(1−p) / (e²(N−1) + z²·p(1−p))',
          assumption: t('sampleSize.assumptionIsaac'),
          whenToUse: t('sampleSize.whenIsaac'),
        },
      ];
      return { rows, error: null as string | null };
    } catch (error) {
      return { rows: [] as Row[], error: error instanceof Error ? error.message : t('sampleSize.errGeneric') };
    }
  }, [n, e, t]);

  // Dokumen yang disalin/diunduh memakai versi akademik dari library (tabel +
  // paragraf justifikasi) supaya bisa langsung ditempel ke Bab 3.
  const markdown = useMemo(() => {
    if (result.error || result.rows.length === 0) return '';
    try {
      return sampleSizeMarkdown({ population: n, marginOfError: e });
    } catch {
      return '';
    }
  }, [result, n, e]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  const download = () => {
    const blob = new Blob([`${markdown}\n`], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'ukuran-sampel.md';
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Modal open onClose={onClose} title={t('sampleSize.title')}>
      <div className="space-y-3 text-xs">
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <label className="font-medium" htmlFor="sample-population">
              {t('sampleSize.population')}
            </label>
            <input
              id="sample-population"
              inputMode="numeric"
              value={population}
              onChange={(event) => setPopulation(event.target.value)}
              className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs"
            />
            <p className="text-[10px] text-muted-foreground">{t('sampleSize.populationHint')}</p>
          </div>
          <div className="space-y-1">
            <label className="font-medium" htmlFor="sample-margin">
              {t('sampleSize.margin')}
            </label>
            <select
              id="sample-margin"
              value={errorText}
              onChange={(event) => setErrorText(event.target.value)}
              className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs"
            >
              <option value="1">1%</option>
              <option value="5">5%</option>
              <option value="10">10%</option>
            </select>
            <p className="text-[10px] text-muted-foreground">{t('sampleSize.marginHint')}</p>
          </div>
        </div>

        {result.error ? (
          <p className="rounded-md border border-red-300 bg-red-50 p-2 text-[11px] text-red-900">{result.error}</p>
        ) : (
          <>
            <table className="w-full border-collapse text-[11px]">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="py-1 pr-2 font-medium">{t('sampleSize.method')}</th>
                  <th className="py-1 pr-2 font-medium">{t('sampleSize.formula')}</th>
                  <th className="py-1 pr-2 text-right font-medium">n</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row) => (
                  <tr key={row.method} className="border-b border-border/60 align-top">
                    <td className="py-1 pr-2 font-medium">{METHOD_LABEL[row.method]}</td>
                    <td className="py-1 pr-2 font-mono text-[10px] text-muted-foreground">{row.formula}</td>
                    <td className="py-1 pr-2 text-right font-mono font-semibold">{row.n}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="rounded-md border border-border bg-muted/40 p-2">
              <p className="font-medium">{t('sampleSize.recommendation')}</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {t('sampleSize.recommendationBody', {
                  n: String(Math.max(...result.rows.map((row) => row.n))),
                })}
              </p>
            </div>
          </>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="outline" className="h-7 px-2 text-[11px]" onClick={onClose}>
            {t('common.close')}
          </Button>
          <Button
            variant="outline"
            className="h-7 px-2 text-[11px]"
            onClick={() => void copy()}
            disabled={!markdown}
          >
            <Copy size={12} className="mr-1" />
            {copied ? t('sampleSize.copied') : t('sampleSize.copy')}
          </Button>
          <Button className="h-7 px-2 text-[11px]" onClick={download} disabled={!markdown}>
            <Download size={12} className="mr-1" />
            {t('sampleSize.download')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
