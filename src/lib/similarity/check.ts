/**
 * Cek kemiripan lokal — murni (tanpa fs/db) supaya bisa diuji langsung.
 *
 * Membandingkan kalimat bab dengan abstrak paper yang disimpan user memakai
 * Jaccard atas shingle 5 kata. Ini BUKAN Turnitin: pembandingnya cuma pustaka
 * lokal milik project, jadi hasilnya untuk mencegah plagiarisme tak sengaja.
 */

export type SentenceHit = {
  path: string;
  line: number;
  sentence: string;
  sourceTitle: string;
  sourceKey: string;
  score: number;
  matched: string;
};

export type SimilarityOptions = {
  /** Ambang minimal 0..1; default 0.8. */
  threshold?: number;
  /** Kalimat dengan kata kurang dari ini dilewati; default 8. */
  minWords?: number;
};

export const DEFAULT_THRESHOLD = 0.8;
export const DEFAULT_MIN_WORDS = 8;
const SHINGLE_SIZE = 5;

const HEADING_LINE = /^\s{0,3}#{1,6}(?:\s|$)/;
const FENCE_LINE = /^\s{0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE = /^\s{0,3}(`{3,}|~{3,})\s*$/;
const SETEXT_UNDERLINE = /^\s{0,3}(?:=+|-+)\s*$/;
const HORIZONTAL_RULE = /^\s{0,3}(?:\*{3,}|_{3,})\s*$/;
const LIST_MARKER = /^\s{0,3}(?:[-*+]|\d{1,3}[.)])\s+/;
const BLOCKQUOTE_MARKER = /^\s{0,3}(?:>\s?)+/;
const CAPTION_LINE = /^\s*\*\*(?:Tabel|Gambar)\s+\d/i;
const INDENTED_CODE = /^(?: {4,}|\t)/;
const CITATION = /\[[^\]\n]*@[^\]\n]*\]/g;
const IMAGE = /!\[/;
const TABLE = /\|/;

/** Singkatan yang titiknya bukan akhir kalimat. */
const ABBREVIATIONS = new Set([
  'al',
  'cf',
  'cth',
  'dkk',
  'dll',
  'dr',
  'dsb',
  'dst',
  'e.g',
  'ed',
  'eds',
  'et',
  'etc',
  'hal',
  'hlm',
  'i.e',
  'ibid',
  'ir',
  'loc',
  'mis',
  'no',
  'op',
  'p',
  'pp',
  'prof',
  's.d',
  'sda',
  'vol',
  'vs',
]);

type BlockLine = { line: number; text: string; list: boolean };

/** Bersihkan penanda markdown yang bukan isi kalimat + buang sitasi `[@…]`. */
function cleanProseLine(raw: string): string {
  let text = raw.replace(/\r$/, '').replace(BLOCKQUOTE_MARKER, '');
  let previous = '';
  while (text !== previous) {
    previous = text;
    text = text.replace(LIST_MARKER, '');
  }
  text = text.replace(CITATION, ' ');
  // Sitasi yang dibuang bisa menyisakan spasi sebelum tanda baca: "dosen ." → "dosen."
  text = text.replace(/\s+([,.;:!?])/g, '$1');
  return text.replace(/\s+/g, ' ').trim();
}

function lineIndexForOffset(starts: number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  let answer = 0;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (starts[mid] <= offset) {
      answer = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return answer;
}

function isDecimalPoint(text: string, index: number): boolean {
  return index > 0 && index + 1 < text.length && /\d/.test(text[index - 1]) && /\d/.test(text[index + 1]);
}

/** `et al.` / `hlm.` / inisial `A.` bukan batas kalimat. */
function isAbbreviation(text: string, index: number): boolean {
  const before = /[\p{L}][\p{L}.'’-]*$/u.exec(text.slice(0, index));
  if (!before) return false;
  const token = before[0].toLowerCase().replace(/\.+$/, '');
  if (token.length === 1 && /^[a-z]$/.test(token) && /[A-Z]/.test(before[0][0])) return true;
  return ABBREVIATIONS.has(token);
}

function sentenceStart(text: string, index: number): number {
  let cursor = index;
  while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
  if (cursor >= text.length) return text.length;
  const char = text[cursor];
  // Kalimat baru lazim diawali huruf kapital/angka/kutip; selain itu anggap
  // singkatan (mis. "et al. menunjukkan") supaya tidak salah potong.
  return /[A-Z0-9"'“”‘’([{-]/.test(char) ? cursor : -1;
}

function pushSentence(
  out: Array<{ sentence: string; line: number }>,
  text: string,
  from: number,
  to: number,
  lineStarts: number[],
  lineNumbers: number[],
): void {
  let start = from;
  let end = to;
  while (start < end && /\s/.test(text[start])) start += 1;
  while (end > start && /\s/.test(text[end - 1])) end -= 1;
  if (end <= start) return;
  const sentence = text.slice(start, end).replace(/\s+/g, ' ').trim();
  if (!sentence) return;
  out.push({ sentence, line: lineNumbers[lineIndexForOffset(lineStarts, start)] });
}

/** Pecah satu blok paragraf (baris-baris yang menyambung) jadi kalimat. */
function splitBlock(block: BlockLine[]): Array<{ sentence: string; line: number }> {
  if (block.length === 0) return [];
  let text = '';
  const lineStarts: number[] = [];
  const lineNumbers: number[] = [];
  for (let index = 0; index < block.length; index += 1) {
    if (index > 0) text += ' ';
    lineStarts.push(text.length);
    lineNumbers.push(block[index].line);
    text += block[index].text;
  }

  const sentences: Array<{ sentence: string; line: number }> = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char !== '.' && char !== '!' && char !== '?' && char !== '…') continue;
    if (char === '.' && isDecimalPoint(text, index)) continue;

    let after = index + 1;
    while (after < text.length && /["'”’)\]]/.test(text[after])) after += 1;
    const next = sentenceStart(text, after);
    if (next === -1) continue;
    if (char === '.' && isAbbreviation(text, index)) continue;

    pushSentence(sentences, text, start, after, lineStarts, lineNumbers);
    start = after;
    index = after - 1;
  }
  pushSentence(sentences, text, start, text.length, lineStarts, lineNumbers);
  return sentences;
}

/**
 * Pecah markdown jadi kalimat beserta nomor baris 1-based asalnya.
 * Heading, tabel, gambar, blok kode, dan caption dilewati; sitasi `[@…]`
 * dibuang dari kalimat (isinya tetap dinilai).
 */
export function splitSentences(text: string): Array<{ sentence: string; line: number }> {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const sentences: Array<{ sentence: string; line: number }> = [];
  let block: BlockLine[] = [];
  let fence: { char: string; length: number } | null = null;

  const flush = () => {
    if (block.length === 0) return;
    sentences.push(...splitBlock(block));
    block = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const trimmed = raw.trim();

    if (fence) {
      const close = FENCE_CLOSE.exec(raw);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) fence = null;
      continue;
    }

    const opening = FENCE_LINE.exec(raw);
    if (opening) {
      flush();
      fence = { char: opening[1][0], length: opening[1].length };
      continue;
    }

    if (trimmed === '') {
      flush();
      continue;
    }

    // Heading setext: baris teks di atas garis `===`/`---` adalah judul.
    if (SETEXT_UNDERLINE.test(raw)) {
      const last = block[block.length - 1];
      if (last && !last.list) block.pop();
      flush();
      continue;
    }

    if (HORIZONTAL_RULE.test(raw) || HEADING_LINE.test(raw) || CAPTION_LINE.test(raw)) {
      flush();
      continue;
    }

    if (IMAGE.test(raw) || TABLE.test(raw) || INDENTED_CODE.test(raw)) {
      flush();
      continue;
    }

    const cleaned = cleanProseLine(raw);
    if (!cleaned) {
      flush();
      continue;
    }
    block.push({ line: index + 1, text: cleaned, list: LIST_MARKER.test(raw) });
  }

  flush();
  return sentences;
}

/** Normalisasi + kata: lowercase, tanda baca jadi pemisah, spasi dirapikan. */
function words(text: string): string[] {
  const normalized = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return normalized ? normalized.split(' ') : [];
}

/** Jumlah kata setelah normalisasi — dipakai untuk filter kalimat pendek. */
export function countWords(text: string): number {
  return words(text).length;
}

/**
 * Shingle n-gram kata. Teks lebih pendek dari `size` tetap menghasilkan satu
 * shingle utuh supaya perbandingan kalimat pendek tidak selalu 0.
 */
export function shingles(text: string, size = SHINGLE_SIZE): Set<string> {
  const tokens = words(text);
  const width = Number.isFinite(size) ? Math.max(1, Math.floor(size)) : SHINGLE_SIZE;
  if (tokens.length === 0) return new Set();
  if (tokens.length < width) return new Set([tokens.join(' ')]);
  const result = new Set<string>();
  for (let index = 0; index + width <= tokens.length; index += 1) {
    result.add(tokens.slice(index, index + width).join(' '));
  }
  return result;
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  let shared = 0;
  for (const item of small) {
    if (large.has(item)) shared += 1;
  }
  return shared === 0 ? 0 : shared / (left.size + right.size - shared);
}

/** Jaccard atas shingle 5 kata (0..1). */
export function similarity(a: string, b: string): number {
  return jaccard(shingles(a), shingles(b));
}

type SourceUnit = { sentence: string; shingles: Set<string> };

type SourceEntry = {
  key: string;
  title: string;
  abstract: string;
  order: number;
  shingles: Set<string>;
  units: SourceUnit[];
};

/** Abstrak itu teks biasa — pakai pemecah kalimat tanpa aturan markdown bab. */
function splitPlainSentences(text: string): Array<{ sentence: string; line: number }> {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return [];
  return splitBlock([{ line: 1, text: flat, list: false }]);
}

function clampThreshold(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_THRESHOLD;
  return Math.min(1, Math.max(0, value));
}

function clampMinWords(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MIN_WORDS;
  return Math.max(0, Math.floor(value));
}

function compareText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Cari kalimat bab yang mirip dengan abstrak sumber.
 *
 * Satu kalimat hanya menyimpan sumber dengan skor terbaik. Hasil diurutkan
 * skor menurun lalu path/baris/kunci sumber supaya deterministik. Saat jumlah
 * sumber > 50 dipakai indeks shingle→sumber agar tidak membandingkan semua
 * pasangan kalimat × sumber.
 */
export function findOverlaps(
  chapters: Array<{ path: string; content: string }>,
  sources: Array<{ key: string; title: string; abstract: string }>,
  options: SimilarityOptions = {},
): SentenceHit[] {
  const threshold = clampThreshold(options.threshold);
  const minWords = clampMinWords(options.minWords);

  const usable: SourceEntry[] = [];
  for (const source of sources) {
    const abstract = typeof source.abstract === 'string' ? source.abstract.trim() : '';
    if (!abstract) continue;
    const units = splitPlainSentences(abstract).map((item) => ({
      sentence: item.sentence,
      shingles: shingles(item.sentence),
    }));
    if (units.length === 0) units.push({ sentence: abstract, shingles: shingles(abstract) });
    const indexed = new Set<string>();
    for (const unit of units) {
      for (const shingle of unit.shingles) indexed.add(shingle);
    }
    usable.push({
      key: source.key,
      title: source.title,
      abstract,
      order: usable.length,
      shingles: indexed,
      units,
    });
  }

  const index =
    usable.length > 50
      ? (() => {
          const map = new Map<string, number[]>();
          usable.forEach((source, sourceIndex) => {
            for (const shingle of source.shingles) {
              const list = map.get(shingle);
              if (list) list.push(sourceIndex);
              else map.set(shingle, [sourceIndex]);
            }
          });
          return map;
        })()
      : null;

  const hits: SentenceHit[] = [];
  for (const chapter of chapters) {
    for (const item of splitSentences(chapter.content)) {
      if (countWords(item.sentence) < minWords) continue;
      const sentenceShingles = shingles(item.sentence);
      if (sentenceShingles.size === 0) continue;

      let bestIndex = -1;
      let bestScore = 0;
      let bestMatched = '';
      const consider = (sourceIndex: number) => {
        const source = usable[sourceIndex];
        for (const unit of source.units) {
          const score = jaccard(sentenceShingles, unit.shingles);
          if (
            score > bestScore ||
            (score === bestScore &&
              (bestIndex === -1 || source.order < usable[bestIndex].order))
          ) {
            bestScore = score;
            bestIndex = sourceIndex;
            bestMatched = unit.sentence;
          }
        }
      };

      if (index) {
        const candidates = new Set<number>();
        for (const shingle of sentenceShingles) {
          const list = index.get(shingle);
          if (!list) continue;
          for (const sourceIndex of list) candidates.add(sourceIndex);
        }
        for (const sourceIndex of [...candidates].sort((a, b) => a - b)) consider(sourceIndex);
      } else {
        for (let sourceIndex = 0; sourceIndex < usable.length; sourceIndex += 1) consider(sourceIndex);
      }

      if (bestIndex === -1 || bestScore < threshold) continue;
      const source = usable[bestIndex];
      hits.push({
        path: chapter.path,
        line: item.line,
        sentence: item.sentence,
        sourceTitle: source.title,
        sourceKey: source.key,
        score: bestScore,
        matched: bestMatched || source.abstract,
      });
    }
  }

  hits.sort(
    (a, b) =>
      b.score - a.score ||
      compareText(a.path, b.path) ||
      a.line - b.line ||
      compareText(a.sourceKey, b.sourceKey),
  );
  return hits;
}
