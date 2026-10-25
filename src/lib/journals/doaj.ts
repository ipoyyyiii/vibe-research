import type { JournalCard } from './types';
import { buildCardId, normalizeDoi } from './merge';

/**
 * DOAJ (Directory of Open Access Journals) — Search API publik, tanpa API key, tanpa batas ketat.
 * Basis: `https://doaj.org/api/search/articles/<query>?pageSize=N`.
 * Kuat untuk literatur Indonesia: banyak jurnal terakreditasi SINTA terindeks DOAJ (journal.country = "ID").
 */
const DOAJ_SEARCH_BASE = 'https://doaj.org/api/search/articles';
const DOAJ_ARTICLE_BASE = 'https://doaj.org/article';
const DOAJ_SOURCE = 'doaj' as const;

interface DoajIdentifier {
  id?: string | null;
  type?: string | null;
}

interface DoajJournal {
  title?: string | null;
  publisher?: string | null;
  country?: string | null;
}

interface DoajLink {
  url?: string | null;
  type?: string | null;
  content_type?: string | null;
}

interface DoajAuthor {
  name?: string | null;
}

/** `bibjson` DOAJ: semua field opsional — record DOAJ sering bolong (tanpa DOI/abstract/link). */
interface DoajBibjson {
  title?: string | null;
  year?: string | number | null;
  abstract?: string | null;
  author?: DoajAuthor[] | null;
  journal?: DoajJournal | null;
  identifier?: DoajIdentifier[] | null;
  link?: DoajLink[] | null;
}

interface DoajArticle {
  id?: string | null;
  bibjson?: DoajBibjson | null;
}

function cleanText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed !== '' ? trimmed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** DOAJ mengirim `year` sebagai string ("2016"), kadang number — ambil 4 digit pertama. */
export function parseDoajYear(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : null;
  if (typeof value !== 'string') return null;
  const match = /(\d{4})/.exec(value);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isNaN(parsed) ? null : parsed;
}

/** DOI dari `bibjson.identifier` (type "doi"); identifier lain (pissn/eissn) diabaikan. */
function pickDoi(identifiers: unknown): string | null {
  if (!Array.isArray(identifiers)) return null;
  for (const identifier of identifiers) {
    if (!isRecord(identifier)) continue;
    if (typeof identifier.type !== 'string') continue;
    if (identifier.type.trim().toLowerCase() !== 'doi') continue;
    const doi = normalizeDoi(cleanText(identifier.id));
    if (doi) return doi;
  }
  return null;
}

/** Link fulltext: prefer PDF, lalu link bertipe "fulltext", lalu URL pertama yang ada. */
function pickFulltextLink(links: unknown): string | null {
  if (!Array.isArray(links)) return null;
  const usable = links.filter((link): link is DoajLink => isRecord(link) && cleanText(link.url) !== null);
  if (usable.length === 0) return null;

  const first = (predicate: (link: DoajLink) => boolean): string | null => {
    const hit = usable.find(predicate);
    return hit ? cleanText(hit.url) : null;
  };

  return (
    first((link) => (link.content_type ?? '').toLowerCase().includes('pdf')) ??
    first((link) => (link.type ?? '').toLowerCase() === 'fulltext') ??
    first(() => true)
  );
}

/** Map satu record DOAJ → JournalCard; null kalau tidak ada title atau id yang bisa dibentuk. */
export function mapDoajArticle(article: DoajArticle): JournalCard | null {
  const bib = article?.bibjson;
  if (!isRecord(bib)) return null;

  const title = cleanText(bib.title);
  if (!title) return null;

  const doi = pickDoi(bib.identifier);
  const providerId = cleanText(article.id);
  const id = doi ?? (providerId ? buildCardId(null, DOAJ_SOURCE, providerId) : null);
  if (!id) return null;

  const fulltext = pickFulltextLink(bib.link);
  const authors = Array.isArray(bib.author)
    ? bib.author
        .map((author) => (isRecord(author) ? cleanText(author.name) : null) ?? '')
        .filter((name) => name !== '')
    : [];

  return {
    id,
    title,
    authors,
    year: parseDoajYear(bib.year),
    venue: cleanText(isRecord(bib.journal) ? bib.journal.title : null),
    doi,
    // DOAJ tidak menyediakan hitungan sitasi.
    citations: 0,
    abstract: cleanText(bib.abstract),
    openAccessUrl: fulltext,
    landingUrl: providerId ? `${DOAJ_ARTICLE_BASE}/${providerId}` : fulltext,
    source: DOAJ_SOURCE,
  };
}

/**
 * Pencarian artikel DOAJ. Selalu return array (error / abort / query kosong → []), tidak pernah throw.
 * `signal` opsional dipakai route untuk timeout provider.
 */
export async function fetchDoaj(
  query: string,
  limit: number,
  signal?: AbortSignal,
): Promise<JournalCard[]> {
  const q = query.trim();
  if (q === '' || limit <= 0) return [];

  try {
    const url = new URL(`${DOAJ_SEARCH_BASE}/${encodeURIComponent(q)}`);
    url.searchParams.set('pageSize', String(limit));

    const res = await fetch(url, {
      signal,
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return [];

    const data = (await res.json()) as { results?: DoajArticle[] };
    const items = Array.isArray(data.results) ? data.results : [];
    return items
      .map(mapDoajArticle)
      .filter((card): card is JournalCard => card !== null)
      .slice(0, limit);
  } catch {
    return [];
  }
}
