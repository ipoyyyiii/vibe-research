'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowUpRight,
  Clock,
  Folder,
  Loader2,
  Plus,
  Search,
  Trash2,
} from 'lucide-react';
import { usePreferences, useT } from '@/lib/preferences';
import { CreateProjectModal } from '@/components/home/create-project-modal';

/**
 * Homepage daftar project (referensi ss6.png, dilokalisir ke token Swiss 2.0).
 * Gantikan redirect auto lama: `/` selalu tampil homepage; buka project =
 * PATCH last-opened dulu baru router.push. Desain app lain di /p/[slug].
 */

type Project = {
  id: number;
  slug: string;
  name: string;
  folderPath: string;
  createdAt: string;
  lastOpenedAt: string | null;
};

/** Milidetik last-opened; null/gak valid → 0 (entri tanpa tanggal turun ke bawah). */
function stamp(iso: string | null): number {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(ms) ? 0 : ms;
}

/** Tanggal pendek ala ss6 ("18 Okt") — null kalau belum pernah / gak valid. */
function dateLabel(iso: string | null, locale: 'id' | 'en'): string | null {
  if (iso == null) return null;
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return null;
  return when.toLocaleDateString(locale === 'en' ? 'en-US' : 'id-ID', {
    day: 'numeric',
    month: 'short',
  });
}

/** Kartu project — seluruh card satu <button>; ikotong delete = sibling overlay. */
function ProjectCard({
  project,
  onOpen,
  onReturn,
}: {
  project: Project;
  onOpen: (slug: string) => void;
  onReturn: (slug: string) => void;
}) {
  const { locale } = usePreferences();
  const t = useT();
  const tanggal = dateLabel(project.lastOpenedAt, locale);

  return (
    <div className="group relative flex">
      <button
        type="button"
        onClick={() => onOpen(project.slug)}
        className="flex w-full cursor-pointer flex-col rounded-xl border border-border bg-card p-4 text-left transition-colors [transition-property:color,background-color,border-color,box-shadow] hover:border-primary/40 hover:shadow-sm"
      >
        <span
          aria-hidden="true"
          className="flex size-10 shrink-0 items-center justify-center self-start rounded-lg bg-muted text-primary"
        >
          <Folder size={18} />
        </span>
        <span className="mt-3 min-w-0 w-full truncate text-[15px] font-medium tracking-tight">
          {project.name}
        </span>
        <span
          dir="ltr"
          className="mt-0.5 min-w-0 w-full truncate text-[11px] text-muted-foreground"
        >
          {project.folderPath}
        </span>
        <span className="mt-4 w-full border-t border-border pt-3">
          <span className="flex w-full items-center justify-between">
            <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <Clock size={12} aria-hidden="true" className="shrink-0" />
              <span className="truncate">{tanggal ?? t('home.neverOpened')}</span>
            </span>
            <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-muted-foreground transition-colors [transition-property:color,background-color] group-hover:text-accent">
              {t('home.open')}
              <ArrowUpRight size={13} aria-hidden="true" />
            </span>
          </span>
        </span>
      </button>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onReturn(project.slug);
        }}
        aria-label={t('w.removeTitle')}
        title={t('w.removeTitle')}
        className="absolute right-2 top-2 z-10 flex size-9 cursor-pointer items-center justify-center rounded-full text-muted-foreground opacity-0 transition-colors [transition-property:color,background-color] hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
      >
        <Trash2 size={15} aria-hidden="true" />
      </button>
    </div>
  );
}

export function HomePage() {
  const router = useRouter();
  const t = useT();
  const [projects, setProjects] = useState<Project[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [query, setQuery] = useState('');
  const [modalOpen, setModalOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/projects');
      const data = await res.json();
      setProjects(data.projects ?? []);
      setStatus('ready');
    } catch {
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** Buka project: catat last-opened dulu (kegagalannya gak blokir navigasi). */
  const buka = async (slug: string) => {
    try {
      await fetch('/api/projects', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug }),
      });
    } catch {
      // Gagal nyatet — tetap buka, homepage selalu bisa dipercaya ulang.
    }
    router.push(`/p/${slug}`);
  };

  /** Lepas project: optimistic hapus dari daftar; folder disk gak disentuh. */
  const buang = async (slug: string) => {
    setProjects((prev) => prev.filter((p) => p.slug !== slug));
    try {
      await fetch('/api/projects', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug }),
      });
    } catch {
      void load();
    }
  };

  // Urut: last-opened terbaru dulu; yang belum pernah dibuka turun ke bawah.
  const sorted = [...projects].sort((a, b) => stamp(b.lastOpenedAt) - stamp(a.lastOpenedAt));
  const needle = query.trim().toLowerCase();
  const filtered = needle
    ? sorted.filter((p) => `${p.name} ${p.folderPath}`.toLowerCase().includes(needle))
    : sorted;

  return (
    <div className="min-h-dvh bg-background text-foreground">
      <header className="sticky top-0 z-30 border-b border-border bg-background/95 backdrop-blur-sm">
        <div className="mx-auto flex h-14 w-full max-w-5xl items-center justify-between px-6">
          <div className="flex items-center gap-2.5">
            <span
              aria-hidden="true"
              className="flex size-8 items-center justify-center rounded-md bg-primary font-mono text-sm font-medium text-primary-foreground"
            >
              V
            </span>
            <span className="text-[15px] font-semibold tracking-tight">{t('brand.name')}</span>
          </div>
          <div
            className="flex items-center gap-1.5 text-xs text-muted-foreground"
            title={t('home.readyHint')}
          >
            <span aria-hidden="true" className="size-2 rounded-full bg-accent" />
            {t('home.ready')}
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl px-6 pb-20">
        {/* Hero */}
        <section className="pt-12">
          <h1 className="text-4xl font-semibold tracking-tight md:text-5xl">{t('home.title')}</h1>
          <p className="mt-3 max-w-xl text-[15px] text-muted-foreground">{t('home.sub')}</p>
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <div className="relative w-full max-w-sm">
              <Search
                size={15}
                aria-hidden="true"
                className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground"
              />
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('home.searchPh')}
                aria-label={t('home.searchPh')}
                className="h-10 w-full rounded-full border border-border bg-card pl-9 pr-4 text-sm outline-none transition-colors [transition-property:color,background-color,border-color] placeholder:text-muted-foreground focus:ring-2 focus:ring-ring"
              />
            </div>
            <button
              type="button"
              onClick={() => setModalOpen(true)}
              aria-haspopup="dialog"
              className="flex h-10 shrink-0 cursor-pointer items-center gap-2 rounded-full bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors [transition-property:color,background-color] hover:bg-primary/90"
            >
              <Plus size={15} aria-hidden="true" />
              {t('home.new')}
            </button>
          </div>
        </section>

        {status === 'loading' ? (
          <div className="mt-12 flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
            <Loader2 size={15} aria-hidden="true" className="animate-spin" />
            {t('home.loading')}
          </div>
        ) : status === 'error' ? (
          <p role="alert" className="mt-12 py-16 text-center text-sm text-destructive">
            {t('err.server')}
          </p>
        ) : projects.length === 0 ? (
          /* Kosong total: hero tengah, DILARANG blank kosong. */
          <div className="mt-14 flex flex-col items-center gap-4 py-10 text-center">
            <span
              aria-hidden="true"
              className="flex size-14 items-center justify-center rounded-2xl bg-muted text-primary"
            >
              <Folder size={24} />
            </span>
            <p className="max-w-sm text-sm text-muted-foreground">{t('home.emptyAll')}</p>
            <button
              type="button"
              onClick={() => setModalOpen(true)}
              aria-haspopup="dialog"
              className="flex h-10 cursor-pointer items-center gap-2 rounded-full bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors [transition-property:color,background-color] hover:bg-primary/90"
            >
              <Plus size={15} aria-hidden="true" />
              {t('home.new')}
            </button>
          </div>
        ) : (
          <section className="mt-12">
            <div className="flex items-center justify-between gap-4">
              <h2 className="text-sm font-medium">{t('home.allProjects')}</h2>
              <span className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
                {t('home.projectCount', { n: filtered.length })}
              </span>
            </div>
            <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {filtered.map((project) => (
                <ProjectCard
                  key={project.id}
                  project={project}
                  onOpen={(slug) => void buka(slug)}
                  onReturn={(slug) => void buang(slug)}
                />
              ))}
              {filtered.length === 0 && (
                <div className="col-span-full flex flex-col items-center gap-2 py-12 text-center">
                  <Search size={18} aria-hidden="true" className="text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">{t('home.emptySearch')}</p>
                </div>
              )}
              <button
                type="button"
                onClick={() => setModalOpen(true)}
                aria-haspopup="dialog"
                className="flex min-h-44 cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border transition-colors [transition-property:color,background-color,border-color] hover:bg-muted/50"
              >
                <span
                  aria-hidden="true"
                  className="flex size-12 items-center justify-center rounded-xl bg-primary text-primary-foreground"
                >
                  <Plus size={20} />
                </span>
                <span className="text-sm font-semibold">{t('home.newProject')}</span>
              </button>
            </div>
          </section>
        )}
      </main>

      <CreateProjectModal open={modalOpen} onClose={() => setModalOpen(false)} />
    </div>
  );
}
