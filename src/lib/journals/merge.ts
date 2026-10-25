import type { JournalCard, JournalSource } from './types';

const SOURCE_ORDER: JournalSource[] = ['openalex', 'crossref', 'doaj', 'semantic-scholar'];

/** Normalisasi DOI → "https://doi.org/<lowercase>" atau null kalau bukan DOI valid. */
export function normalizeDoi(input: string | null | undefined): string | null {
  if (!input) return null;
  const stripped = input
    .trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
    .replace(/^(dx\.)?doi\.org\//i, '');
  const lower = stripped.trim().toLowerCase();
  return lower.startsWith('10.') ? `https://doi.org/${lower}` : null;
}

/** id card: DOI dinormalisasi jika ada, else `${source}:${providerId}`. */
export function buildCardId(
  doi: string | null,
  source: JournalSource,
  providerId: string,
): string {
  return doi ?? `${source}:${providerId}`;
}

function hasAbstract(card: JournalCard): boolean {
  return typeof card.abstract === 'string' && card.abstract.trim() !== '';
}

function pickBase(a: JournalCard, b: JournalCard): JournalCard {
  if (hasAbstract(a) && hasAbstract(b)) {
    // keduanya punya abstract → prefer openalex, kalau bukan prefer citations tertinggi
    if (a.source === 'openalex') return a;
    if (b.source === 'openalex') return b;
    return a.citations >= b.citations ? a : b;
  }
  if (hasAbstract(a)) return a;
  if (hasAbstract(b)) return b;
  return a.citations >= b.citations ? a : b;
}

/** Gabungkan duplikat: base dari item yang punya abstract (prefer openalex) / citations tertinggi; citations = max. */
function mergeDuplicate(a: JournalCard, b: JournalCard): JournalCard {
  const base = pickBase(a, b);
  return { ...base, citations: Math.max(a.citations, b.citations) };
}

function dedupe(cards: JournalCard[]): JournalCard[] {
  const byId = new Map<string, JournalCard>();
  for (const card of cards) {
    const current = byId.get(card.id);
    byId.set(card.id, current ? mergeDuplicate(current, card) : card);
  }
  return [...byId.values()];
}

/** Relevance: split per source, interleave round-robin (openalex → crossref → doaj → semantic-scholar) biar campur adil. */
function interleaveBySource(cards: JournalCard[]): JournalCard[] {
  const bySource: Record<JournalSource, JournalCard[]> = {
    openalex: [],
    crossref: [],
    doaj: [],
    'semantic-scholar': [],
  };
  for (const card of cards) bySource[card.source].push(card);

  const out: JournalCard[] = [];
  let remaining = cards.length;
  while (remaining > 0) {
    for (const source of SOURCE_ORDER) {
      const next = bySource[source].shift();
      if (next) {
        out.push(next);
        remaining -= 1;
      }
    }
  }
  return out;
}

/**
 * Dedup (group by id) + filter yearFrom + sort. Limit (slice) dilakukan pemanggil/route.
 * sort: 'relevance' (interleave per source) | 'citations' (desc) | 'year' (desc, null terakhir).
 */
export function mergeCards(
  cards: JournalCard[],
  opts: { sort: string; yearFrom?: number },
): JournalCard[] {
  let merged = dedupe(cards);

  if (opts.yearFrom != null) {
    const yearFrom = opts.yearFrom;
    merged = merged.filter((card) => card.year != null && card.year >= yearFrom);
  }

  switch (opts.sort) {
    case 'citations':
      return [...merged].sort((a, b) => b.citations - a.citations);
    case 'year':
      // null year diperlakukan -1 supaya selalu di posisi terakhir saat desc
      return [...merged].sort((a, b) => (b.year ?? -1) - (a.year ?? -1));
    default:
      return interleaveBySource(merged);
  }
}
