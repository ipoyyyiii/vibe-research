export type JournalCardData = {
  doi?: string;
  title?: string;
  authors?: string[];
  year?: number | string | null;
  venue?: string | null;
  openAccessUrl?: string | null;
};

/** Parse isi blok; null kalau bukan JSON yang masuk akal. */
export function parseJournalCard(raw: string): JournalCardData | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as Record<string, unknown>;
    const doi = typeof record.doi === 'string' ? record.doi : '';
    const title = typeof record.title === 'string' ? record.title : '';
    if (!doi && !title) return null;
    return {
      doi: doi || undefined,
      title: title || undefined,
      authors: Array.isArray(record.authors)
        ? record.authors.filter((item): item is string => typeof item === 'string')
        : undefined,
      year: typeof record.year === 'number' || typeof record.year === 'string' ? record.year : null,
      venue: typeof record.venue === 'string' ? record.venue : null,
      openAccessUrl: typeof record.openAccessUrl === 'string' ? record.openAccessUrl : null,
    };
  } catch {
    return null;
  }
}
