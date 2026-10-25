'use client';

import { useEffect, useState } from 'react';
import { Loader2, Upload } from 'lucide-react';
import { Button, Modal, SegmentedGroup, TextInput } from '@/components/ui';
import { useT } from '@/lib/preferences';
import {
  EMPTY_FRONT_MATTER,
  FRONT_MATTER_KEYS,
  type FrontMatter,
} from '@/lib/thesis/types';

type ChapterOption = {
  path: string;
  name: string;
  title: string;
  selected: boolean;
};

type ExportFormat = 'docx' | 'pdf' | 'both';
type ExportStyle = 'apa' | 'ieee' | 'custom';

type ExportResponse = {
  ok?: boolean;
  out?: { docx?: string; pdf?: string };
  warnings?: { missingCitations?: string[]; unusedEntries?: number };
  counts?: { chapters?: number; tables?: number; figures?: number };
  docxError?: string;
  pdfError?: string;
  error?: string;
  detail?: string;
};

const FIELD_LAYOUT: Array<{ key: keyof FrontMatter; labelKey: string; wide?: boolean }> = [
  { key: 'title', labelKey: 'thesisExport.field.title', wide: true },
  { key: 'author', labelKey: 'thesisExport.field.author' },
  { key: 'nim', labelKey: 'thesisExport.field.nim' },
  { key: 'program', labelKey: 'thesisExport.field.program' },
  { key: 'faculty', labelKey: 'thesisExport.field.faculty' },
  { key: 'institution', labelKey: 'thesisExport.field.institution', wide: true },
  { key: 'city', labelKey: 'thesisExport.field.city' },
  { key: 'year', labelKey: 'thesisExport.field.year' },
  { key: 'supervisor1', labelKey: 'thesisExport.field.supervisor1' },
  { key: 'supervisor2', labelKey: 'thesisExport.field.supervisor2' },
];

function parseFrontMatter(value: unknown): FrontMatter {
  const result = { ...EMPTY_FRONT_MATTER };
  if (value === null || typeof value !== 'object') return result;
  const record = value as Record<string, unknown>;
  for (const key of FRONT_MATTER_KEYS) {
    const field = record[key];
    if (typeof field === 'string') result[key] = field;
  }
  return result;
}

function parseChapters(value: unknown): ChapterOption[] {
  if (!Array.isArray(value)) return [];
  const options: ChapterOption[] = [];
  for (const item of value) {
    if (item === null || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const path = typeof record.path === 'string' ? record.path : '';
    if (!path) continue;
    options.push({
      path,
      name: typeof record.name === 'string' ? record.name : path,
      title: typeof record.title === 'string' ? record.title : '',
      selected: true,
    });
  }
  return options;
}

export function ThesisExportModal({
  open,
  onClose,
  slug,
}: {
  open: boolean;
  onClose: () => void;
  slug: string;
}) {
  const t = useT();
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [frontMatter, setFrontMatter] = useState<FrontMatter>({ ...EMPTY_FRONT_MATTER });
  const [chapters, setChapters] = useState<ChapterOption[]>([]);
  const [abstract, setAbstract] = useState<string | null>(null);
  const [hasBib, setHasBib] = useState(true);
  const [format, setFormat] = useState<ExportFormat>('both');
  const [style, setStyle] = useState<ExportStyle>('apa');
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const [result, setResult] = useState<ExportResponse | null>(null);
  const [csl, setCsl] = useState<{ exists: boolean; title: string | null; bytes: number } | null>(null);
  const [cslBusy, setCslBusy] = useState(false);
  const [logo, setLogo] = useState<{ exists: boolean; path: string | null; bytes: number } | null>(null);
  const [logoBusy, setLogoBusy] = useState(false);
  const [logoError, setLogoError] = useState<string | null>(null);
  const [cslError, setCslError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setError(null);
    setErrorDetail(null);
    setResult(null);
    setSaveState('idle');

    const load = async () => {
      try {
        const [frontRes, chaptersRes] = await Promise.all([
          fetch(`/api/projects/${encodeURIComponent(slug)}/front-matter`),
          fetch(`/api/projects/${encodeURIComponent(slug)}/export/thesis`),
        ]);
        const frontData = (await frontRes.json().catch(() => null)) as
          | { frontMatter?: unknown }
          | null;
        const chapterData = (await chaptersRes.json().catch(() => null)) as
          | { chapters?: unknown; abstract?: unknown; hasBib?: unknown }
          | null;
        if (!frontRes.ok || !chaptersRes.ok) {
          if (!cancelled) setLoadError(t('thesisExport.loadFailed'));
          return;
        }
        if (cancelled) return;
        setFrontMatter(parseFrontMatter(frontData?.frontMatter));
        setChapters(parseChapters(chapterData?.chapters));
        setAbstract(typeof chapterData?.abstract === 'string' ? chapterData.abstract : null);
        setHasBib(chapterData?.hasBib !== false);
        const cslRes = await fetch(`/api/projects/${encodeURIComponent(slug)}/csl`);
        const cslData = (await cslRes.json().catch(() => null)) as
          | { csl?: { exists: boolean; title: string | null; bytes: number } }
          | null;
        if (!cancelled) setCsl(cslData?.csl ?? null);
        const logoRes = await fetch(`/api/projects/${encodeURIComponent(slug)}/cover-logo`);
        const logoData = (await logoRes.json().catch(() => null)) as
          | { logo?: { exists: boolean; path: string | null; bytes: number } }
          | null;
        if (!cancelled) setLogo(logoData?.logo ?? null);
      } catch {
        if (!cancelled) setLoadError(t('err.server'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [open, slug, t]);

  const setField = (key: keyof FrontMatter, value: string) => {
    setFrontMatter((current) => ({ ...current, [key]: value }));
    setSaveState('idle');
  };

  const toggleChapter = (path: string) => {
    setChapters((current) =>
      current.map((chapter) =>
        chapter.path === path ? { ...chapter, selected: !chapter.selected } : chapter,
      ),
    );
  };

  const setAllChapters = (selected: boolean) => {
    setChapters((current) => current.map((chapter) => ({ ...chapter, selected })));
  };

  const saveFrontMatter = async (): Promise<boolean> => {
    setSaveState('saving');
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(slug)}/front-matter`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(frontMatter),
      });
      if (!res.ok) {
        setSaveState('error');
        return false;
      }
      setSaveState('saved');
      return true;
    } catch {
      setSaveState('error');
      return false;
    }
  };

  const runExport = async () => {
    const selected = chapters.filter((chapter) => chapter.selected).map((chapter) => chapter.path);
    if (selected.length === 0) {
      setError(t('thesisExport.noChaptersSelected'));
      return;
    }

    setBusy(true);
    setError(null);
    setErrorDetail(null);
    setResult(null);
    const saved = await saveFrontMatter();
    if (!saved) {
      setError(t('thesisExport.saveFailed'));
      setBusy(false);
      return;
    }

    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(slug)}/export/thesis`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format, style, chapters: selected }),
      });
      const data = (await res.json().catch(() => null)) as ExportResponse | null;
      const hasOutput = Boolean(data?.out?.docx || data?.out?.pdf);
      if (!res.ok || !data?.ok || !hasOutput) {
        setError(data?.error ?? t('thesisExport.failed'));
        setErrorDetail(data?.detail ?? data?.docxError ?? data?.pdfError ?? null);
        return;
      }
      setResult(data);
      window.dispatchEvent(new CustomEvent('workspace:tree-refresh'));
    } catch {
      setError(t('err.server'));
    } finally {
      setBusy(false);
    }
  };

  const uploadCsl = async (file: File | null) => {
    if (!file) return;
    setCslBusy(true);
    setCslError(null);
    try {
      const content = await file.text();
      const res = await fetch(`/api/projects/${encodeURIComponent(slug)}/csl`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: file.name, content }),
      });
      const data = (await res.json().catch(() => null)) as
        | { csl?: { exists: boolean; title: string | null; bytes: number }; error?: string }
        | null;
      if (!res.ok || !data?.csl) {
        setCslError(data?.error ?? t('thesisExport.cslFailed'));
        return;
      }
      setCsl(data.csl);
      setStyle('custom');
    } catch {
      setCslError(t('thesisExport.cslFailed'));
    } finally {
      setCslBusy(false);
    }
  };

  const removeCsl = async () => {
    setCslBusy(true);
    setCslError(null);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(slug)}/csl`, { method: 'DELETE' });
      if (!res.ok) {
        setCslError(t('thesisExport.cslFailed'));
        return;
      }
      setCsl({ exists: false, title: null, bytes: 0 });
      if (style === 'custom') setStyle('apa');
    } finally {
      setCslBusy(false);
    }
  };

  const uploadLogo = async (file: File | null) => {
    if (!file) return;
    setLogoBusy(true);
    setLogoError(null);
    try {
      const buffer = await file.arrayBuffer();
      const data = btoa(String.fromCharCode(...new Uint8Array(buffer)));
      const res = await fetch(`/api/projects/${encodeURIComponent(slug)}/cover-logo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data }),
      });
      const json = (await res.json().catch(() => null)) as
        | { logo?: { exists: boolean; path: string | null; bytes: number }; error?: string }
        | null;
      if (!res.ok || !json?.logo) {
        setLogoError(json?.error ?? t('thesisExport.logoFailed'));
        return;
      }
      setLogo(json.logo);
    } catch {
      setLogoError(t('thesisExport.logoFailed'));
    } finally {
      setLogoBusy(false);
    }
  };

  const removeLogo = async () => {
    setLogoBusy(true);
    setLogoError(null);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(slug)}/cover-logo`, { method: 'DELETE' });
      if (!res.ok) {
        setLogoError(t('thesisExport.logoFailed'));
        return;
      }
      setLogo({ exists: false, path: null, bytes: 0 });
    } finally {
      setLogoBusy(false);
    }
  };

  const openInPanel = (path: string) => {
    window.dispatchEvent(new CustomEvent('workspace:doc-created', { detail: { path } }));
  };

  const rawUrl = (path: string) =>
    `/api/projects/${encodeURIComponent(slug)}/raw?path=${encodeURIComponent(path)}`;

  // Ekspor berjalan satu permintaan (tanpa streaming tahap), jadi yang bisa
  // ditampilkan dengan jujur adalah waktu berjalan + ekspektasi durasi.
  useEffect(() => {
    if (!busy) {
      setElapsed(0);
      return undefined;
    }
    const started = Date.now();
    const timer = window.setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [busy]);

  const missingCitations = result?.warnings?.missingCitations ?? [];
  const unusedEntries = result?.warnings?.unusedEntries ?? 0;
  const selectedCount = chapters.filter((chapter) => chapter.selected).length;

  return (
    <Modal
      open={open}
      onClose={busy ? () => undefined : onClose}
      title={t('thesisExport.title')}
      wide
    >
      <div className="space-y-4 text-xs">
        <p className="text-muted-foreground">{t('thesisExport.hint')}</p>

        {loading && (
          <p className="flex items-center gap-2 text-muted-foreground">
            <Loader2 size={13} className="animate-spin" />
            {t('thesisExport.loading')}
          </p>
        )}
        {loadError && <p className="text-red-600">{loadError}</p>}

        {!loading && !loadError && (
          <>
            <section>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-xs font-semibold">{t('thesisExport.fieldsTitle')}</h3>
                <div className="flex items-center gap-2">
                  {saveState === 'saved' && (
                    <span className="text-[11px] text-green-700">{t('thesisExport.saved')}</span>
                  )}
                  {saveState === 'error' && (
                    <span className="text-[11px] text-red-600">{t('thesisExport.saveFailed')}</span>
                  )}
                  <Button
                    variant="outline"
                    className="h-7 px-2 py-0 text-[11px]"
                    disabled={busy || saveState === 'saving'}
                    onClick={() => void saveFrontMatter()}
                  >
                    {saveState === 'saving' ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      t('thesisExport.save')
                    )}
                  </Button>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {FIELD_LAYOUT.map((field) => (
                  <label
                    key={field.key}
                    className={`space-y-1 ${field.wide ? 'col-span-2' : ''}`}
                  >
                    <span className="block text-[11px] text-muted-foreground">
                      {t(field.labelKey)}
                    </span>
                    <TextInput
                      className="py-1.5 text-xs"
                      value={frontMatter[field.key]}
                      onChange={(event) => setField(field.key, event.target.value)}
                      disabled={busy}
                    />
                  </label>
                ))}
              </div>
            </section>

            <section>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-xs font-semibold">
                  {t('thesisExport.chaptersTitle')} ({selectedCount}/{chapters.length})
                </h3>
                <div className="flex gap-2">
                  <button
                    type="button"
                    className="text-[11px] text-primary underline underline-offset-2"
                    onClick={() => setAllChapters(true)}
                  >
                    {t('thesisExport.selectAll')}
                  </button>
                  <button
                    type="button"
                    className="text-[11px] text-primary underline underline-offset-2"
                    onClick={() => setAllChapters(false)}
                  >
                    {t('thesisExport.selectNone')}
                  </button>
                </div>
              </div>
              <p className="mb-2 text-[11px] text-muted-foreground">{t('thesisExport.chaptersHint')}</p>
              {chapters.length === 0 ? (
                <p className="text-[11px] text-muted-foreground">{t('thesisExport.noChapters')}</p>
              ) : (
                <ul className="max-h-40 space-y-1 overflow-y-auto rounded border border-border p-2">
                  {chapters.map((chapter) => (
                    <li key={chapter.path}>
                      <label className="flex cursor-pointer items-start gap-2 rounded px-1 py-0.5 hover:bg-muted">
                        <input
                          type="checkbox"
                          className="mt-0.5"
                          checked={chapter.selected}
                          onChange={() => toggleChapter(chapter.path)}
                          disabled={busy}
                        />
                        <span className="min-w-0">
                          <span className="block truncate text-[11px] font-medium">
                            {chapter.title || chapter.name}
                          </span>
                          <span className="block truncate text-[10px] text-muted-foreground">
                            {chapter.path}
                          </span>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-1 text-[11px] text-muted-foreground">
                {abstract ? t('thesisExport.abstractIncluded') : t('thesisExport.noAbstract')}
              </p>
              {!hasBib && <p className="mt-1 text-[11px] text-amber-700">{t('thesisExport.noBib')}</p>}
            </section>

            <section className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <span className="block text-[11px] text-muted-foreground">
                  {t('thesisExport.formatTitle')}
                </span>
                <SegmentedGroup
                  options={[
                    { value: 'docx', label: t('thesisExport.format.docx') },
                    { value: 'pdf', label: t('thesisExport.format.pdf') },
                    { value: 'both', label: t('thesisExport.format.both') },
                  ]}
                  active={format}
                  onSelect={(value) => setFormat(value as ExportFormat)}
                />
              </div>
              <div className="space-y-1">
                <span className="block text-[11px] text-muted-foreground">
                  {t('thesisExport.styleTitle')}
                </span>
                <SegmentedGroup
                  options={[
                    { value: 'apa', label: t('thesisExport.style.apa') },
                    { value: 'ieee', label: t('thesisExport.style.ieee') },
                    { value: 'custom', label: t('thesisExport.style.custom'), disabled: !csl?.exists },
                  ]}
                  active={style}
                  onSelect={(value) => setStyle(value as ExportStyle)}
                />
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <label className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] transition-colors hover:bg-muted">
                    {cslBusy ? <Loader2 size={11} className="animate-spin" /> : <Upload size={11} />}
                    {t('thesisExport.cslUpload')}
                    <input
                      type="file"
                      accept=".csl,application/xml,text/xml"
                      className="hidden"
                      onChange={(event) => void uploadCsl(event.target.files?.[0] ?? null)}
                    />
                  </label>
                  {csl?.exists ? (
                    <>
                      <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
                        {t('thesisExport.cslActive', {
                          name: csl.title ?? 'style.csl',
                          kb: (csl.bytes / 1024).toFixed(1),
                        })}
                      </span>
                      <button
                        type="button"
                        onClick={() => void removeCsl()}
                        className="text-[11px] text-red-600 underline underline-offset-2"
                      >
                        {t('thesisExport.cslRemove')}
                      </button>
                    </>
                  ) : (
                    <span className="text-[11px] text-muted-foreground">{t('thesisExport.cslHint')}</span>
                  )}
                </div>
                {cslError && <p className="text-[11px] text-red-600">{cslError}</p>}
              </div>
              <div className="space-y-1">
                <span className="block text-[11px] text-muted-foreground">
                  {t('thesisExport.logoTitle')}
                </span>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] transition-colors hover:bg-muted">
                    {logoBusy ? <Loader2 size={11} className="animate-spin" /> : <Upload size={11} />}
                    {t('thesisExport.logoUpload')}
                    <input
                      type="file"
                      accept="image/png,image/jpeg"
                      className="hidden"
                      onChange={(event) => void uploadLogo(event.target.files?.[0] ?? null)}
                    />
                  </label>
                  {logo?.exists ? (
                    <>
                      <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
                        {t('thesisExport.logoActive', { kb: (logo.bytes / 1024).toFixed(1) })}
                      </span>
                      <button
                        type="button"
                        onClick={() => void removeLogo()}
                        className="text-[11px] text-red-600 underline underline-offset-2"
                      >
                        {t('thesisExport.logoRemove')}
                      </button>
                    </>
                  ) : (
                    <span className="text-[11px] text-muted-foreground">{t('thesisExport.logoHint')}</span>
                  )}
                </div>
                {logoError && <p className="text-[11px] text-red-600">{logoError}</p>}
              </div>
            </section>

            {busy && (
              <p className="flex items-center gap-2 text-muted-foreground">
                <Loader2 size={13} className="animate-spin" />
                {t('thesisExport.exportingSeconds', { n: String(elapsed) })}
              </p>
            )}
            {error && (
              <div className="space-y-1">
                <p className="text-red-600">{error}</p>
                {errorDetail && (
                  <p className="break-words font-mono text-[10px] text-muted-foreground">
                    {errorDetail}
                  </p>
                )}
              </div>
            )}

            {result && (
              <section className="space-y-2 rounded border border-border p-2">
                <p className="font-medium text-green-700">{t('thesisExport.done')}</p>
                {result.out?.docx && (
                  <p className="rounded border border-amber-300 bg-amber-50 p-2 text-[11px] text-amber-900">
                    {t('thesisExport.tocHint')}
                  </p>
                )}
                {(['docx', 'pdf'] as const).map((kind) => {
                  const output = result.out?.[kind];
                  if (!output) return null;
                  return (
                    <div key={kind} className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate font-mono text-[11px]">{output}</span>
                      <div className="flex shrink-0 items-center gap-1">
                        <Button
                          variant="outline"
                          className="h-7 px-2 py-0 text-[11px]"
                          onClick={() => openInPanel(output)}
                        >
                          {t('thesisExport.open')}
                        </Button>
                        <a
                          href={rawUrl(output)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex h-7 items-center rounded-md border border-neutral-300 px-2 text-[11px] text-neutral-700 transition-colors hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
                        >
                          {t('thesisExport.download')}
                        </a>
                      </div>
                    </div>
                  );
                })}
                {result.counts && (
                  <p className="text-[11px] text-muted-foreground">
                    {t('thesisExport.counts', {
                      chapters: result.counts.chapters ?? 0,
                      tables: result.counts.tables ?? 0,
                      figures: result.counts.figures ?? 0,
                    })}
                  </p>
                )}
                {result.pdfError && (
                  <p className="text-[11px] text-amber-700">
                    {t('thesisExport.pdfFailed', { message: result.pdfError })}
                  </p>
                )}
                {result.docxError && (
                  <p className="text-[11px] text-amber-700">
                    {t('thesisExport.docxFailed', { message: result.docxError })}
                  </p>
                )}
                {missingCitations.length > 0 && (
                  <p className="text-[11px] text-red-600">
                    {t('thesisExport.missingCitations', {
                      keys: `${missingCitations.slice(0, 6).join(', ')}${
                        missingCitations.length > 6 ? '…' : ''
                      }`,
                    })}
                  </p>
                )}
                {unusedEntries > 0 && (
                  <p className="text-[11px] text-muted-foreground">
                    {t('thesisExport.unused', { n: unusedEntries })}
                  </p>
                )}
              </section>
            )}

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={onClose} disabled={busy}>
                {t('thesisExport.close')}
              </Button>
              <Button
                onClick={() => void runExport()}
                disabled={busy || loading || chapters.length === 0}
              >
                {busy ? (
                  <>
                    <Loader2 size={13} className="animate-spin" />
                    {t('thesisExport.exportingShort')}
                  </>
                ) : (
                  t('thesisExport.export')
                )}
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
