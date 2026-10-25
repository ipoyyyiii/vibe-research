import { NextResponse } from 'next/server';
import { fetchOpenAlex } from '@/lib/journals/openalex';
import { fetchCrossref } from '@/lib/journals/crossref';
import { fetchSemanticScholar } from '@/lib/journals/semanticscholar';
import { fetchDoaj } from '@/lib/journals/doaj';
import { buildSearchLinks } from '@/lib/journals/links';
import { mergeCards } from '@/lib/journals/merge';
import type { JournalCard, JournalSearchResult, JournalSource } from '@/lib/journals/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const PROVIDER_TIMEOUT_MS = 10_000;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 20;

function parseLimit(raw: string | null): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (Number.isNaN(parsed)) return DEFAULT_LIMIT;
  return Math.min(Math.max(parsed, 1), MAX_LIMIT);
}

function parseYearFrom(raw: string | null): number | undefined {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** Jalankan provider dengan timeout via AbortController — timeout = reject (di-skip oleh allSettled). */
function runProvider<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  return run(controller.signal).finally(() => clearTimeout(timer));
}

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const q = (params.get('q') ?? '').trim();
    if (q.length < 2) {
      return NextResponse.json({ error: 'Query wajib diisi minimal 2 karakter' }, { status: 400 });
    }
    const sortParam = params.get('sort');
    const sort = sortParam === 'citations' || sortParam === 'year' ? sortParam : 'relevance';
    const limit = parseLimit(params.get('limit'));
    const yearFrom = parseYearFrom(params.get('yearFrom'));

    const providers: Array<{
      source: JournalSource;
      run: () => Promise<JournalCard[]>;
    }> = [
      {
        source: 'openalex',
        run: () => runProvider((signal) => fetchOpenAlex(q, limit, { yearFrom, signal })),
      },
      {
        source: 'crossref',
        run: () => runProvider((signal) => fetchCrossref(q, limit, { signal })),
      },
      {
        source: 'doaj',
        run: () => runProvider((signal) => fetchDoaj(q, limit, signal)),
      },
      {
        source: 'semantic-scholar',
        run: () => runProvider((signal) => fetchSemanticScholar(q, limit, { signal })),
      },
    ];

    const startedAt = Date.now();
    const settled = await Promise.allSettled(providers.map((provider) => provider.run()));

    // Provider yang gagal/timeout (rejected) di-skip — provider internal-fail tetap return [].
    const sourcesUsed: JournalSource[] = [];
    const cards: JournalCard[] = [];
    settled.forEach((outcome, index) => {
      const { source } = providers[index];
      if (outcome.status !== 'fulfilled') return;
      sourcesUsed.push(source);
      cards.push(...outcome.value);
    });

    const merged = mergeCards(cards, { sort, yearFrom });
    const payload: JournalSearchResult = {
      results: merged.slice(0, limit),
      sourcesUsed,
      tookMs: Date.now() - startedAt,
      // Link-out manual ke sumber yang tidak bisa di-query server (Garuda/SINTA) + fallback umum.
      links: buildSearchLinks(q),
    };
    return NextResponse.json(payload);
  } catch (error) {
    console.error('[api/journals/search] GET gagal:', error);
    return NextResponse.json({ error: 'Gagal mencari jurnal' }, { status: 500 });
  }
}
