/**
 * Link-out pencarian eksternal (tanpa scraping) — dikembalikan route search sebagai `links`,
 * terpisah dari `results` supaya user bisa lanjut mencari manual di sumber yang tidak bisa di-query server.
 *
 * Catatan domain (diuji dari server ini):
 * - `garuda.kemdikbud.go.id` & `sinta.kemdikbud.go.id` → NXDOMAIN (host lama sudah dipensiunkan).
 * - `garuda.kemdiktisaintek.go.id` & `sinta.kemdiktisaintek.go.id` → hidup (HTTP 200, dengan UA browser).
 * Jadi link-out memakai domain baru Kemdiktisaintek; tidak ada scraper, murni URL pencarian.
 */

export type JournalLinks = {
  scholar: string;
  garuda: string;
  sinta: string;
  doaj: string;
};

/** Query dinormalisasi (trim) lalu di-encode sebagai komponen URL. */
function encodeQuery(query: string): string {
  return encodeURIComponent(query.trim());
}

/** Google Scholar — pencarian literatur umum (sering menangkap paper yang tidak ada di API lain). */
export function scholarUrl(query: string): string {
  return `https://scholar.google.com/scholar?q=${encodeQuery(query)}`;
}

/** Garuda (Garba Rujukan Digital) — repositori artikel jurnal Indonesia. */
export function garudaUrl(query: string): string {
  return `https://garuda.kemdiktisaintek.go.id/documents?q=${encodeQuery(query)}`;
}

/** SINTA — pencarian jurnal terakreditasi (S1–S6). */
export function sintaUrl(query: string): string {
  return `https://sinta.kemdiktisaintek.go.id/journals?q=${encodeQuery(query)}`;
}

/**
 * DOAJ — halaman pencarian web (front-end DOAJ memakai parameter `source` berisi query JSON).
 * Untuk data mentah, versi API-nya: https://doaj.org/api/search/articles/<query>
 */
export function doajUrl(query: string): string {
  const source = JSON.stringify({ query: { query_string: { query: query.trim() } } });
  return `https://doaj.org/search/articles?source=${encodeURIComponent(source)}`;
}

/** Semua link-out untuk satu query, siap ditempel ke respons search. */
export function buildSearchLinks(query: string): JournalLinks {
  return {
    scholar: scholarUrl(query),
    garuda: garudaUrl(query),
    sinta: sintaUrl(query),
    doaj: doajUrl(query),
  };
}
