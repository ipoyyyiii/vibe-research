/**
 * Perapian heading bab — modul murni (tanpa `node:fs`) supaya bisa dipakai
 * juga di komponen client seperti Outline.
 */

/** Hanya baris pembuka bab yang boleh dirapikan; heading isi tidak disentuh. */
const HEADING_SCAN_LINES = 10;
const BAB_HEADING = /^ {0,3}#[ \t]+BAB[ \t]+([IVXLCDM]+|\d+)\s*$/i;
const ANY_H1 = /^ {0,3}#[ \t]+(.+?)\s*$/;
/** Judul halaman depan/belakang yang bukan judul bab, jadi tidak ikut digabung. */
const NON_CHAPTER_TITLE =
  /^(?:BAB|ABSTRAK|ABSTRACT|DAFTAR|HALAMAN|LEMBAR|RIWAYAT|KATA|UCAPAN|PRAKATA|PERNYATAAN|PENGESAHAN|LAMPIRAN)\b/i;

/**
 * Gabungkan heading bab ganda menjadi satu H1: `# BAB I` + `# PENDAHULUAN`
 * menjadi `# BAB I PENDAHULUAN`.
 *
 * Alasannya: selama bab punya dua H1, Daftar Isi (TOC field DOCX maupun TOC
 * HTML untuk PDF) menampilkan tiap bab dua baris — "BAB I … 1" lalu
 * "PENDAHULUAN … 1" — padahal satu bab cukup satu entri.
 */
export function mergeChapterHeading(markdown: string): string {
  const lines = markdown.split('\n');
  const limit = Math.min(lines.length, HEADING_SCAN_LINES);

  let babIndex = -1;
  for (let index = 0; index < limit; index += 1) {
    if (lines[index].trim() !== '') {
      babIndex = index;
      break;
    }
  }
  if (babIndex < 0) return markdown;
  const bab = BAB_HEADING.exec(lines[babIndex]);
  if (!bab) return markdown;

  let titleIndex = babIndex + 1;
  while (titleIndex < limit && lines[titleIndex].trim() === '') titleIndex += 1;
  if (titleIndex >= limit) return markdown;
  const title = ANY_H1.exec(lines[titleIndex]);
  if (!title) return markdown;
  const titleText = title[1].trim();
  if (NON_CHAPTER_TITLE.test(titleText)) return markdown;

  lines.splice(babIndex, titleIndex - babIndex + 1, `# BAB ${bab[1]} ${titleText}`);
  return lines.join('\n');
}
