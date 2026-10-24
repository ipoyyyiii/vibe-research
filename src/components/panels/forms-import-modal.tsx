'use client';

import { useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, FileUp, Loader2 } from 'lucide-react';
import { Button, Modal } from '@/components/ui';
import { useT } from '@/lib/preferences';
import { parseFormsCsv, toFormsCsv, type FormsColumn } from '@/lib/data/forms-import';
import { uploadToFolder } from '@/components/panels/views-left';

type Preview = { columns: FormsColumn[]; rows: string[][]; warnings: string[] };

const KIND_KEY = {
  identity: 'formsImport.kindIdentity',
  item: 'formsImport.kindItem',
  ignored: 'formsImport.kindIgnored',
} as const;

export function FormsImportModal({ slug, onClose }: { slug: string; onClose: () => void }) {
  const t = useT();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [fileName, setFileName] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const pick = async (file: File | null) => {
    if (!file) return;
    setError(null);
    setSaved(null);
    setFileName(file.name);
    try {
      const text = await file.text();
      const parsed = parseFormsCsv(text);
      if (parsed.columns.length === 0) {
        setPreview(null);
        setError(t('formsImport.empty'));
        return;
      }
      setPreview(parsed);
    } catch {
      setPreview(null);
      setError(t('formsImport.parseFail'));
    }
  };

  const save = async () => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const csv = toFormsCsv(preview.columns, preview.rows);
      const name = (fileName || 'respons-forms').replace(/\.csv$/i, '');
      const file = new File([csv], `${name}-bersih.csv`, { type: 'text/csv' });
      const result = await uploadToFolder(slug, 'data', [file]);
      if (result.saved.length === 0) {
        setError(t('formsImport.saveFail'));
        return;
      }
      setSaved(result.saved[0] ?? `${name}-bersih.csv`);
    } catch {
      setError(t('formsImport.saveFail'));
    } finally {
      setBusy(false);
    }
  };

  // Pohon file disegarkan setelah modal ditutup; kalau langsung, panel
  // menampilkan status loading dan modal (beserta pesan sukses) ikut hilang.
  const close = () => {
    if (saved) window.dispatchEvent(new CustomEvent('workspace:tree-refresh'));
    onClose();
  };

  const items = preview?.columns.filter((column) => column.kind === 'item') ?? [];
  const identity = preview?.columns.filter((column) => column.kind === 'identity') ?? [];

  return (
    <Modal open onClose={close} title={t('formsImport.title')}>
      <div className="space-y-3 text-xs">
        <p className="text-muted-foreground">{t('formsImport.intro')}</p>

        <div className="space-y-1">
          <label className="font-medium" htmlFor="forms-file">
            {t('formsImport.file')}
          </label>
          <input
            id="forms-file"
            ref={inputRef}
            type="file"
            accept=".csv,text/csv"
            onChange={(event) => void pick(event.target.files?.[0] ?? null)}
            className="block w-full text-[11px] file:mr-2 file:cursor-pointer file:rounded-md file:border file:border-border file:bg-background file:px-2 file:py-1 file:text-[11px]"
          />
          {fileName && <p className="text-[10px] text-muted-foreground">{fileName}</p>}
        </div>

        {preview && (
          <>
            <div className="grid grid-cols-2 gap-2 text-[11px]">
              <div className="rounded-md border border-border p-2">
                <p className="font-medium">{t('formsImport.itemsFound', { n: String(items.length) })}</p>
                <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                  {items.map((column) => column.name).join(', ') || '—'}
                </p>
              </div>
              <div className="rounded-md border border-border p-2">
                <p className="font-medium">{t('formsImport.identityFound', { n: String(identity.length) })}</p>
                <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                  {identity.map((column) => column.name).join(', ') || '—'}
                </p>
              </div>
            </div>

            <div className="max-h-44 overflow-auto rounded-md border border-border">
              <table className="w-full border-collapse text-[10px]">
                <thead className="sticky top-0 bg-muted">
                  <tr className="text-left">
                    <th className="px-1.5 py-1 font-medium">{t('formsImport.original')}</th>
                    <th className="px-1.5 py-1 font-medium">{t('formsImport.final')}</th>
                    <th className="px-1.5 py-1 font-medium">{t('formsImport.kind')}</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.columns.map((column) => (
                    <tr key={column.original} className={column.kind === 'ignored' ? 'opacity-50' : ''}>
                      <td className="max-w-[220px] truncate px-1.5 py-1" title={column.original}>
                        {column.original}
                      </td>
                      <td className="px-1.5 py-1 font-mono">{column.name}</td>
                      <td className="px-1.5 py-1">{t(KIND_KEY[column.kind])}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {preview.rows.length > 0 && (
              <p className="text-[10px] text-muted-foreground">
                {t('formsImport.rowsFound', { n: String(preview.rows.length) })}
              </p>
            )}

            {preview.warnings.length > 0 && (
              <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-[11px] text-amber-900">
                <p className="flex items-center gap-1 font-medium">
                  <AlertTriangle size={12} />
                  {t('formsImport.warnings')}
                </p>
                <ul className="mt-1 list-inside list-disc space-y-0.5">
                  {preview.warnings.slice(0, 5).map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}

        {saved && (
          <p className="flex items-center gap-1.5 rounded-md border border-emerald-300 bg-emerald-50 p-2 text-[11px] text-emerald-900">
            <CheckCircle2 size={12} />
            {t('formsImport.saved', { path: saved.includes('/') ? saved : `data/${saved}` })}
          </p>
        )}

        {error && <p className="text-[11px] text-red-600">{error}</p>}

        <div className="flex justify-end gap-2">
          <Button variant="outline" className="h-7 px-2 text-[11px]" onClick={close} disabled={busy}>
            {t('common.close')}
          </Button>
          <Button className="h-7 px-2 text-[11px]" onClick={() => void save()} disabled={!preview || busy}>
            {busy ? <Loader2 size={12} className="mr-1 animate-spin" /> : <FileUp size={12} className="mr-1" />}
            {t('formsImport.save')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
