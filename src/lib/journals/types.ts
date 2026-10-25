import type { JournalLinks } from './links';

export type JournalSource = 'openalex' | 'crossref' | 'semantic-scholar' | 'doaj';

export type JournalCard = {
  id: string; // DOI dinormalisasi (lowercase, strip "https://doi.org/") JIKA ada doi; else `${source}:${providerId}`
  title: string;
  authors: string[]; // nama tampil utuh
  year: number | null;
  venue: string | null;
  doi: string | null; // bentuk "https://doi.org/10.xxx/..."
  citations: number;
  abstract: string | null;
  openAccessUrl: string | null; // URL PDF OA kalau provider kasih
  landingUrl: string | null;
  source: JournalSource;
};

export type JournalSearchResult = {
  results: JournalCard[];
  sourcesUsed: JournalSource[];
  tookMs: number;
  /** Link-out pencarian manual ke sumber lain — BUKAN bagian dari `results`. */
  links: JournalLinks;
};
