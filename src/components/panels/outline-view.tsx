'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Columns3, Loader2, ListTree, Target } from 'lucide-react';
import { useT } from '@/lib/preferences';
import { countMarkdownWords, firstHeading } from '@/lib/outline';
import { mergeChapterHeading } from '@/lib/thesis/headings';
import { requestNewDocument } from '@/components/panels/new-doc-modal';
import {
  DeleteButton,
  DeleteConfirmModal,
  EmptyState,
  ViewSearchRow,
  useFileDelete,
  type TreeEntry,
} from '@/components/panels/views-left';

type ChapterRow = {
  path: string;
  name: string;
  title: string | null;
  words: number | null; // null = masih menghitung
};

const MAX_DOCS = 12;

function targetKey(slug: string, path: string): string {
  return `outline:target:${slug}:${path}`;
}

function readLocalTarget(slug: string, path: string): number {
  try {
    const raw = localStorage.getItem(targetKey(slug, path));
    const n = raw === null ? 0 : Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  } catch {
    return 0;
  }
}

async function saveTargets(slug: string, targets: Record<string, number>): Promise<void> {
  await fetch(`/api/projects/${encodeURIComponent(slug)}/targets`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ targets }),
  }).catch(() => undefined);
}

/**
 * Tab purpose view "Outline": header search + plus (dokumen baru), daftar bab
 * (dokumen/*.md) + hitungan kata + target per bab (kesimpen localStorage, per
 * browser). Baris progress selalu berangka — gak cuma andalan warna (a11y).
 * X di baris bab → konfirmasi → hapus file dokumen.
 */
export function OutlineView({
  slug,
  entries,
  onOpenFile,
}: {
  slug: string;
  entries: TreeEntry[];
  onOpenFile: (path: string) => void;
}) {
  const t = useT();
  const [rows, setRows] = useState<ChapterRow[]>([]);
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const [targets, setTargets] = useState<Record<string, number>>({});
  const [query, setQuery] = useState('');
  const cancelledRef = useRef(false);
  const del = useFileDelete(slug);

  // Daftar bab dari tree — filter dokumen/*.md (abaikan _* cache/test file).
  const docPaths = useMemo(
    () =>
      entries
        .filter(
          (entry) =>
            entry.type === 'file' &&
            entry.path.startsWith('dokumen/') &&
            entry.path.endsWith('.md') &&
            !/\/_/.test(entry.path),
        )
        .slice(0, MAX_DOCS),
    [entries],
  );

  // Target dibaca dari project (`.vibe-research/targets.json`) supaya laporan
  // progres di server bisa memakainya. Angka lama yang masih tersimpan di
  // localStorage ikut dipindahkan sekali agar tidak hilang.
  useEffect(() => {
    let alive = true;
    (async () => {
      const local: Record<string, number> = {};
      for (const entry of docPaths) {
        const value = readLocalTarget(slug, entry.path);
        if (value > 0) local[entry.path] = value;
      }
      let stored: Record<string, number> = {};
      try {
        const res = await fetch(`/api/projects/${encodeURIComponent(slug)}/targets`);
        const data = (await res.json().catch(() => null)) as
          | { targets?: Record<string, number> }
          | null;
        stored = data?.targets ?? {};
      } catch {
        // Offline/gagal baca: salinan lokal masih lebih baik daripada kosong.
      }
      const merged = { ...local, ...stored };
      const missing = Object.keys(local).some((path) => local[path] !== stored[path]);
      if (missing) void saveTargets(slug, merged);
      if (alive) setTargets(merged);
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, docPaths.map((doc) => doc.path).join('|')]);

  // Hitung kata tiap bab: fetch file text (udah ada API). Ulang pas tree berubah pas entries.
  useEffect(() => {
    cancelledRef.current = false;
    if (docPaths.length === 0) {
      setRows([]);
      return undefined;
    }
    setRows(docPaths.map((doc) => ({ path: doc.path, name: doc.name, title: null, words: null })));

    const load = async () => {
      const fetched = await Promise.allSettled(
        docPaths.map(async (doc) => {
          const res = await fetch(
            `/api/projects/${encodeURIComponent(slug)}/file?path=${encodeURIComponent(doc.path)}`,
          );
          if (!res.ok) throw new Error('fetch gagal');
          const data = (await res.json()) as { content?: string };
          const md = data.content ?? '';
          // Dua H1 di awal bab digabung supaya daftar menampilkan judul bab,
          // bukan cuma "BAB I" — sama seperti daftar isi dan laporan progres.
          const merged = mergeChapterHeading(md);
          return { path: doc.path, words: countMarkdownWords(md), title: firstHeading(merged) };
        }),
      );

      if (cancelledRef.current) return;
      setRows((prev) =>
        prev.map((row) => {
          const hit = fetched.find(
            (item) => item.status === 'fulfilled' && item.value.path === row.path,
          );
          if (hit && hit.status === 'fulfilled') {
            return { ...row, words: hit.value.words, title: hit.value.title };
          }
          return { ...row, words: 0, title: null };
        }),
      );
    };

    void load();
    return () => {
      cancelledRef.current = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, docPaths.map((doc) => doc.path).join('|')]);

  const saveTarget = useCallback(
    (path: string, value: number) => {
      const clean = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
      const next = { ...targets, [path]: clean };
      setTargets(next);
      void saveTargets(slug, next);
    },
    [slug, targets],
  );

  // Filter client-side: cocok (title ?? name) + path, case-insensitive.
  const shownRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (row) =>
        (row.title ?? row.name.replace(/\.md$/i, '')).toLowerCase().includes(q) ||
        row.path.toLowerCase().includes(q),
    );
  }, [rows, query]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-border px-3 py-2">
        <p className="flex items-center gap-1.5 font-serif text-sm font-semibold tracking-tight">
          <ListTree size={13} className="text-primary" />
          {t('outline.title')}
        </p>
        <p className="mt-0.5 text-[10px] text-muted-foreground">{t('outline.targetHint')}</p>
        <div className="mt-2">
          <ViewSearchRow
            searchPh={t('es.searchOutline')}
            filter={query}
            onFilter={setQuery}
            onPlus={requestNewDocument}
            plusTitle={t('es.outlineAction')}
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {docPaths.length === 0 ? (
          <div className="flex h-full flex-col">
            <EmptyState
              icon={Columns3}
              title={t('es.outlineTitle')}
              desc={t('es.outlineDesc')}
              action={{ label: t('es.outlineAction'), onClick: requestNewDocument }}
            />
          </div>
        ) : rows.length === 0 ? (
          // Menunggu hitung kata jalan — jangan kedip es.noResults duluan.
          null
        ) : shownRows.length === 0 ? (
          <p className="px-3 py-6 text-center text-[11px] text-muted-foreground">{t('es.noResults')}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {shownRows.map((row) => {
              const target = targets[row.path] ?? 0;
              const pct = target > 0 && (row.words ?? 0) > 0 ? Math.min(100, Math.round(((row.words ?? 0) / target) * 100)) : 0;
              const done = target > 0 && (row.words ?? 0) >= target;
              return (
                <li
                  key={row.path}
                  className="group rounded-md border border-transparent px-2 py-1.5 transition-colors hover:border-border hover:bg-card"
                >
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      title={t('outline.openHint')}
                      onClick={() => onOpenFile(row.path)}
                      className="flex min-h-[24px] min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
                    >
                      <span className="min-w-0 flex-1 truncate text-[12px] leading-5 text-foreground">
                        {row.title ?? row.name.replace(/\.md$/i, '')}
                      </span>
                      <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                        {row.words === null ? <Loader2 size={10} className="inline animate-spin" /> : `${row.words.toLocaleString('id-ID')}`}
                      </span>
                    </button>
                    <DeleteButton
                      onClick={() => del.requestDelete(row.path, row.name)}
                      label={t('es.removeFile')}
                      className="-mr-1"
                    />
                  </div>

                  {target > 0 && (
                    <div className="mt-1 flex items-center gap-2">
                      <div className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
                        <div
                          className={`h-full rounded-full transition-all duration-300 ${done ? 'bg-green-600' : 'bg-amber-600'}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <span className={`shrink-0 font-mono text-[10px] ${done ? 'text-green-700 dark:text-green-400' : 'text-muted-foreground'}`}>
                        {pct}%
                      </span>
                    </div>
                  )}

                  {editingPath === row.path ? (
                    <form
                      className="mt-1 flex items-center gap-1"
                      onSubmit={(event) => {
                        event.preventDefault();
                        setEditingPath(null);
                      }}
                    >
                      <Target size={11} className="shrink-0 text-muted-foreground" />
                      <input
                        autoFocus
                        type="number"
                        min={0}
                        step={100}
                        defaultValue={target}
                        onBlur={(event) => {
                          saveTarget(row.path, Number(event.target.value));
                          setEditingPath(null);
                        }}
                        aria-label={t('outline.target')}
                        className="h-6 w-full min-w-0 rounded border border-border bg-background px-1.5 font-mono text-[11px] outline-none focus-visible:ring-1 focus-visible:ring-primary"
                      />
                    </form>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setEditingPath(row.path)}
                      className="mt-0.5 flex h-5 cursor-pointer items-center gap-1 text-[10px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
                    >
                      <Target size={10} />
                      {target > 0 ? (row.words ?? 0).toLocaleString('id-ID') + ' / ' + target.toLocaleString('id-ID') : ''}
                      {target > 0 ? ` · ${t('outline.target')}` : t('outline.target')}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <DeleteConfirmModal
        pending={del.pending}
        deleting={del.deleting}
        onCancel={del.cancelDelete}
        onConfirm={() => void del.performDelete()}
      />
    </div>
  );
}
