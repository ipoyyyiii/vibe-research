'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Loader2, Play, Terminal, XCircle } from 'lucide-react';
import { Button, Modal, SegmentedGroup } from '@/components/ui';
import { useT } from '@/lib/preferences';

type DataFile = { path: string; name: string };
type Preset = 'instrument' | 'regression';

type Props = {
  slug: string;
  files: DataFile[];
  onOpenFile?: (path: string) => void;
  onClose: () => void;
  /** Dipanggil setelah analisis sukses supaya daftar hasil ikut disegarkan. */
  onFinished?: () => void;
};

type Columns = { columns: string[]; numeric: string[]; rows: number };

export function AnalysisRunModal({ slug, files, onOpenFile, onClose, onFinished }: Props) {
  const t = useT();
  const [dataPath, setDataPath] = useState(files[0]?.path ?? '');
  const [columns, setColumns] = useState<Columns | null>(null);
  const [columnsError, setColumnsError] = useState<string | null>(null);
  const [preset, setPreset] = useState<Preset>('regression');
  const [target, setTarget] = useState('');
  const [predictors, setPredictors] = useState<string[]>([]);
  const [group, setGroup] = useState('');
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState('');
  const [outcome, setOutcome] = useState<{ exit: number; out: string; seconds: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [depsReady, setDepsReady] = useState<boolean | null>(null);
  const [depsBusy, setDepsBusy] = useState(false);
  const logRef = useRef<HTMLPreElement | null>(null);

  const itemColumns = useMemo(
    () => (columns?.columns ?? []).filter((name) => /^P\d+$/i.test(name)),
    [columns],
  );

  // Dependensi Python diperiksa sekali saat dialog dibuka, supaya user tahu
  // sebelum menunggu analisis yang pasti gagal.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`/api/projects/${encodeURIComponent(slug)}/analysis/setup`);
        const data = (await res.json().catch(() => null)) as { ready?: boolean } | null;
        if (alive) setDepsReady(Boolean(data?.ready));
      } catch {
        if (alive) setDepsReady(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [slug]);

  // Kolom dibaca dari file yang dipilih; pemilihan file lain mengulang probe.
  useEffect(() => {
    if (!dataPath) return;
    let alive = true;
    setColumns(null);
    setColumnsError(null);
    setTarget('');
    setPredictors([]);
    setGroup('');
    (async () => {
      try {
        const res = await fetch(
          `/api/projects/${encodeURIComponent(slug)}/analysis/columns?path=${encodeURIComponent(dataPath)}`,
        );
        const data = (await res.json().catch(() => null)) as (Columns & { error?: string }) | null;
        if (!alive) return;
        if (!res.ok || !data?.columns) {
          setColumnsError(data?.error ?? t('analysisRun.columnsFail'));
          return;
        }
        setColumns({ columns: data.columns, numeric: data.numeric ?? [], rows: data.rows ?? 0 });
        const numeric = data.numeric ?? [];
        setTarget(numeric[0] ?? '');
        setPredictors(numeric.slice(1, 3));
      } catch {
        if (alive) setColumnsError(t('analysisRun.columnsFail'));
      }
    })();
    return () => {
      alive = false;
    };
  }, [slug, dataPath, t]);

  useEffect(() => {
    const node = logRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [log]);

  const validate = (): string | null => {
    if (!dataPath) return t('analysisRun.needFile');
    if (preset === 'regression') {
      if (!target) return t('analysisRun.needTarget');
      if (predictors.length === 0) return t('analysisRun.needPredictor');
    }
    if (preset === 'instrument' && itemColumns.length === 0) return t('analysisRun.needItems');
    return null;
  };

  const run = async () => {
    setError(null);
    const problem = validate();
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setLog('');
    setOutcome(null);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(slug)}/analysis/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dataPath,
          preset,
          y: preset === 'regression' ? target : undefined,
          x: preset === 'regression' ? predictors : undefined,
          group: group || undefined,
        }),
      });
      if (!res.ok || !res.body) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? t('analysisRun.fail'));
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const marker = buffer.indexOf('__DONE__');
        if (marker >= 0) {
          setLog(buffer.slice(0, marker));
          try {
            const parsed = JSON.parse(buffer.slice(marker + 8).trim()) as {
              exit: number;
              out: string;
              seconds: number;
            };
            setOutcome(parsed);
          } catch {
            setError(t('analysisRun.fail'));
          }
          buffer = '';
          break;
        }
        setLog(buffer);
      }
    } catch {
      setError(t('analysisRun.fail'));
    } finally {
      setBusy(false);
    }
  };

  // Daftar "Hasil analisis" disegarkan saat modal ditutup, bukan saat analisis
  // selesai: refresh memicu panel menampilkan status loading dan itu melepas
  // modal dari DOM, sehingga pesan suksesnya tidak sempat terbaca.
  const close = () => {
    if (outcome?.exit === 0) onFinished?.();
    onClose();
  };

  /** Pasang pandas/scipy/statsmodels ke `.venv` project, streaming ke log. */
  const installDeps = async () => {
    setDepsBusy(true);
    setError(null);
    setLog('');
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(slug)}/analysis/setup`, {
        method: 'POST',
      });
      if (!res.ok || !res.body) {
        setError(t('analysisRun.depsFail'));
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const marker = buffer.indexOf('__DONE__');
        if (marker >= 0) {
          setLog(buffer.slice(0, marker));
          try {
            const parsed = JSON.parse(buffer.slice(marker + 8).trim()) as { exit: number; ready: boolean };
            setDepsReady(parsed.ready);
            if (!parsed.ready) setError(t('analysisRun.depsFail'));
          } catch {
            setError(t('analysisRun.depsFail'));
          }
          buffer = '';
          break;
        }
        setLog(buffer);
      }
    } catch {
      setError(t('analysisRun.depsFail'));
    } finally {
      setDepsBusy(false);
    }
  };

  const numericOptions = columns?.numeric ?? [];
  const allOptions = columns?.columns ?? [];

  return (
    <Modal open onClose={close} title={t('analysisRun.title')}>
      <div className="space-y-3 text-xs">
        {files.length === 0 && (
          <p className="rounded-md border border-border bg-muted/40 p-2 text-[11px] text-muted-foreground">
            {t('analysisRun.noData')}
          </p>
        )}

        <div className="space-y-1">
          <label className="font-medium" htmlFor="analysis-data">
            {t('analysisRun.dataFile')}
          </label>
          <select
            id="analysis-data"
            value={dataPath}
            onChange={(event) => setDataPath(event.target.value)}
            className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs"
          >
            {files.map((file) => (
              <option key={file.path} value={file.path}>
                {file.path}
              </option>
            ))}
          </select>
          <p className="text-[11px] text-muted-foreground">
            {columns
              ? t('analysisRun.columnsInfo', { rows: String(columns.rows), cols: String(columns.columns.length) })
              : columnsError ?? t('analysisRun.columnsLoading')}
          </p>
        </div>

        {depsReady === false && (
          <div className="space-y-1 rounded-md border border-amber-300 bg-amber-50 p-2 text-[11px] text-amber-900">
            <p>{t('analysisRun.depsMissing')}</p>
            <Button
              variant="outline"
              className="h-6 px-2 text-[11px]"
              disabled={depsBusy}
              onClick={() => void installDeps()}
            >
              {depsBusy ? <Loader2 size={11} className="mr-1 animate-spin" /> : null}
              {depsBusy ? t('analysisRun.depsInstalling') : t('analysisRun.depsInstall')}
            </Button>
          </div>
        )}

        <div className="space-y-1">
          <span className="font-medium">{t('analysisRun.preset')}</span>
          <SegmentedGroup
            active={preset}
            onSelect={(value) => setPreset(value === 'instrument' ? 'instrument' : 'regression')}
            options={[
              { value: 'regression', label: t('analysisRun.presetRegression') },
              { value: 'instrument', label: t('analysisRun.presetInstrument') },
            ]}
          />
        </div>

        {preset === 'regression' ? (
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <label className="font-medium" htmlFor="analysis-y">
                {t('analysisRun.target')}
              </label>
              <select
                id="analysis-y"
                value={target}
                onChange={(event) => setTarget(event.target.value)}
                className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs"
              >
                <option value="">{t('analysisRun.pick')}</option>
                {numericOptions.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <span className="font-medium">{t('analysisRun.predictors')}</span>
              <div className="max-h-28 space-y-0.5 overflow-y-auto rounded-md border border-border p-1.5">
                {numericOptions
                  .filter((name) => name !== target)
                  .map((name) => (
                    <label key={name} className="flex items-center gap-1.5 text-[11px]">
                      <input
                        type="checkbox"
                        checked={predictors.includes(name)}
                        onChange={(event) =>
                          setPredictors((prev) =>
                            event.target.checked ? [...prev, name] : prev.filter((item) => item !== name),
                          )
                        }
                      />
                      {name}
                    </label>
                  ))}
                {numericOptions.length === 0 && (
                  <p className="text-[11px] text-muted-foreground">{t('analysisRun.noNumeric')}</p>
                )}
              </div>
            </div>
          </div>
        ) : (
          <p className="rounded-md border border-border bg-muted/40 p-2 text-[11px] text-muted-foreground">
            {itemColumns.length > 0
              ? t('analysisRun.itemsDetected', { n: String(itemColumns.length), list: itemColumns.join(', ') })
              : t('analysisRun.needItems')}
          </p>
        )}

        <div className="space-y-1">
          <label className="font-medium" htmlFor="analysis-group">
            {t('analysisRun.group')}
          </label>
          <select
            id="analysis-group"
            value={group}
            onChange={(event) => setGroup(event.target.value)}
            className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs"
          >
            <option value="">{t('analysisRun.groupNone')}</option>
            {allOptions.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>

        {busy && (
          <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Loader2 size={12} className="animate-spin" />
            {t('analysisRun.running')}
          </p>
        )}

        {log && (
          <pre
            ref={logRef}
            className="max-h-48 overflow-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-[10px] leading-relaxed"
          >
            {log}
          </pre>
        )}

        {outcome && outcome.exit === 0 && (
          <div className="flex items-start gap-1.5 rounded-md border border-emerald-300 bg-emerald-50 p-2 text-[11px] text-emerald-900">
            <CheckCircle2 size={13} className="mt-0.5 shrink-0" />
            <span>
              {t('analysisRun.done', { out: outcome.out, seconds: outcome.seconds.toFixed(1) })}
              {onOpenFile && outcome.out && (
                <button
                  type="button"
                  onClick={() => onOpenFile(outcome.out)}
                  className="ml-1 underline underline-offset-2"
                >
                  {t('analysisRun.openReport')}
                </button>
              )}
            </span>
          </div>
        )}

        {outcome && outcome.exit !== 0 && (
          <div className="flex items-start gap-1.5 rounded-md border border-red-300 bg-red-50 p-2 text-[11px] text-red-900">
            <XCircle size={13} className="mt-0.5 shrink-0" />
            <span>{t('analysisRun.exitFail', { code: String(outcome.exit) })}</span>
          </div>
        )}

        {error && (
          <p className="flex items-start gap-1.5 text-[11px] text-red-600">
            <Terminal size={12} className="mt-0.5 shrink-0" />
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="outline" className="h-7 px-2 text-[11px]" onClick={close} disabled={busy}>
            {t('common.close')}
          </Button>
          <Button className="h-7 px-2 text-[11px]" onClick={() => void run()} disabled={busy}>
            {busy ? <Loader2 size={12} className="mr-1 animate-spin" /> : <Play size={12} className="mr-1" />}
            {busy ? t('analysisRun.runningShort') : t('analysisRun.submit')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
