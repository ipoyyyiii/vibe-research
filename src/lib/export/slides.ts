import fs from 'node:fs/promises';
import path from 'node:path';
import pptxgen from 'pptxgenjs';
import { chapterNumber, extractTables, type MarkdownTable } from '@/lib/insert/markdown-tables';
import { parseBib } from '@/lib/journals/bib';
import { discoverChapterPaths, readChapterText } from '@/lib/thesis/chapters';
import { isRealInside, resolveInside, toProjectPath } from './paths';

/**
 * Penyusun slide sidang (.pptx) dari naskah skripsi yang SUDAH ADA.
 *
 * Isi deck diambil apa adanya dari `dokumen/*.md`, `hasil/*.md`, dan
 * `gambar/*.png`: bullet = kalimat asli (tanpa markdown/sitasi), tabel diambil
 * dari laporan analisis, gambar dari grafik uji. Seksi yang tidak ditemukan
 * dilewati — tidak ada kalimat yang dikarang — dan alasannya dicatat di
 * `notes` supaya UI bisa menampilkan peringatan.
 *
 * Batas deck 10–14 slide. Kalau dokumen minim (tanpa Bab 4/5 dan gambar), susunan
 * wajib masih bisa dicapai dengan memisah slide "Rumusan Masalah" dan "Tujuan".
 */

const OUTPUT_REL = 'export/slide-sidang.pptx';
const MAX_SLIDES = 14;
const MIN_SLIDES = 6;
const MAX_BULLET_CHARS = 120;
const MAX_TABLE_COLS = 5;
const MAX_TABLE_ROWS = 8;
const MAX_EXTRA_TABLES = 3;
const EXTRA_TABLE_MIN_SCORE = 15;
const MAX_FILE_BYTES = 4 * 1024 * 1024;

const FONT = 'Calibri';
const ACCENT = '1F4E79';
const TEXT_COLOR = '1F2937';
const MUTED = '6B7280';
const ROW_ALT = 'F2F5F9';
const BORDER_COLOR = 'D0D7E2';

const SLIDE_W = 10;
const SLIDE_H = 5.625;
const MARGIN = 0.6;
const CONTENT_W = SLIDE_W - MARGIN * 2;
const CONTENT_TOP = 1.35;
const CONTENT_BOTTOM = 5.12;
const CONTENT_H = CONTENT_BOTTOM - CONTENT_TOP;

export type SlideDeckOptions = {
  /** Folder absolut project (dari tabel `projects`). */
  folder: string;
  /** Judul deck — route memakai `projects.name`, bukan heading bab. */
  title: string;
  /** Tanggal sidang; default hari ini. */
  date?: Date;
};

export type SlideDeckResult = {
  /** Path relatif project, mis. `export/slide-sidang.pptx`. */
  file: string;
  /** Jumlah slide yang benar-benar ditulis. */
  slides: number;
  /** Peringatan: seksi/bab yang dilewati, batas deck, pustaka kosong, dll. */
  notes: string[];
  /** Ukuran file hasil (byte). */
  bytes: number;
};

type Chapter = { path: string; markdown: string };
type ResultDoc = { path: string; markdown: string; mtime: number };

type TableCandidate = {
  table: MarkdownTable;
  /** Caption hasil `extractTables`, atau heading terdekat kalau caption kosong. */
  caption: string;
  source: string;
  score: number;
  mtime: number;
};

type ImageCandidate = {
  /** Path relatif project, mis. `gambar/uji-scatter-dosen.png`. */
  relative: string;
  /** Path absolut untuk pptxgenjs. */
  absolute: string;
  name: string;
  width: number;
  height: number;
  rank: number;
};

type PickedTable = { header: string[]; rows: string[][] };

type DeckSlide =
  | { kind: 'title'; title: string; subtitle: string; date: string }
  | { kind: 'bullets'; title: string; bullets: string[] }
  | { kind: 'table'; title: string; caption: string; header: string[]; rows: string[][] }
  | { kind: 'figure'; title: string; caption: string; image: string; width: number; height: number }
  | { kind: 'closing'; title: string; heading: string; lines: string[] };

// ── Teks ─────────────────────────────────────────────────────────────────────

/** Buang markdown inline + sitasi `[@key]` — bullet harus terbaca seperti kalimat. */
export function cleanText(input: string): string {
  let text = input;
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1'); // gambar → alt
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1'); // link → teks
  text = text.replace(/\[[^\]]*@[^\]]*\]/g, ''); // [@key] / [@a; @b]
  text = text.replace(/\[\^[^\]]*\]/g, ''); // footnote
  text = text.replace(/<\/?[a-zA-Z][^>]*>/g, ''); // HTML
  text = text.replace(/`([^`]*)`/g, '$1'); // inline code
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1'); // bold **…**
  text = text.replace(/__([^_]+)__/g, '$1'); // bold __…__
  text = text.replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=[\s).,;:!?]|$)/g, '$1$2'); // italic *…*
  text = text.replace(/(^|[\s(])_([^_\s][^_]*?)_(?=[\s).,;:!?]|$)/g, '$1$2'); // italic _…_
  text = text.replace(/~~([^~]+)~~/g, '$1'); // strikethrough
  text = text.replace(/^\s*#{1,6}\s*/, ''); // tanda heading
  text = text.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ''); // bullet / nomor
  text = text.replace(/^\s*>\s?/, ''); // blockquote
  text = text.replace(/[*_]{2,}/g, ''); // sisa penanda tebal/miring
  text = text.replace(/\s+/g, ' ').trim();
  text = text.replace(/\(\s*\)/g, ''); // kurung kosong sisa sitasi
  text = text.replace(/\s+([,.;:!?])/g, '$1'); // spasi sebelum tanda baca
  text = text.replace(/\s{2,}/g, ' ').trim();
  return text;
}

/** Potong ke `max` karakter di batas kata (tidak pernah memotong kata). */
export function clipText(input: string, max: number): string {
  const value = input.trim();
  if (value.length <= max) return value;
  const cut = value.slice(0, Math.max(1, max - 1));
  const space = cut.lastIndexOf(' ');
  const head = space >= Math.floor(max * 0.4) ? cut.slice(0, space) : cut;
  const tidy = head.replace(/[\s,;:–—-]+$/u, '');
  return `${tidy || value.slice(0, Math.max(1, max - 1))}…`;
}

/** Pecah paragraf jadi kalimat — desimal ("0.05") dan singkatan tidak dipecah. */
export function splitSentences(input: string): string[] {
  const text = input.trim();
  if (text === '') return [];
  const sentences: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char !== '.' && char !== '!' && char !== '?') continue;
    const previous = text[index - 1] ?? '';
    const next = text[index + 1] ?? '';
    if (char === '.' && /\d/.test(previous) && /\d/.test(next)) continue; // 0.05
    if (!/\s/.test(next)) continue;

    let cursor = index + 1;
    while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
    const follow = text[cursor] ?? '';
    if (!/[A-Z0-9“(]/.test(follow)) continue;

    const sentence = text.slice(start, index + 1).trim();
    if (sentence !== '') sentences.push(sentence);
    start = cursor;
    index = cursor - 1;
  }
  const tail = text.slice(start).trim();
  if (tail !== '') sentences.push(tail);
  return sentences;
}

/** Blok teks sebuah seksi: paragraf utuh, butir list, kutipan; tabel/gambar dibuang. */
function textBlocks(body: string): string[] {
  const blocks: string[] = [];
  let buffer: string[] = [];

  const flush = () => {
    const text = buffer.join(' ').trim();
    if (text !== '') blocks.push(text);
    buffer = [];
  };

  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') {
      flush();
      continue;
    }
    if (/^#{1,6}\s/.test(line)) {
      flush();
      continue;
    }
    if (line.startsWith('|') || line.startsWith('![') || line.startsWith('```')) {
      flush();
      continue;
    }
    if (/^>\s?/.test(line)) {
      flush();
      blocks.push(line.replace(/^>\s?/, ''));
      continue;
    }
    const item = /^(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      flush();
      blocks.push(item[1]);
      continue;
    }
    buffer.push(line);
  }
  flush();
  return blocks;
}

function bulletsFromBlocks(blocks: string[], max: number): string[] {
  const bullets: string[] = [];
  for (const block of blocks) {
    for (const sentence of splitSentences(cleanText(block))) {
      const bullet = clipText(sentence, MAX_BULLET_CHARS);
      if (bullet.length < 12) continue;
      if (bullets.includes(bullet)) continue;
      bullets.push(bullet);
      if (bullets.length >= max) return bullets;
    }
  }
  return bullets;
}

// ── Seksi ────────────────────────────────────────────────────────────────────

function normalizeHeading(value: string): string {
  return cleanText(value)
    .toLowerCase()
    .replace(/^\d+(?:\.\d+)*[.)]?\s+/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function headingAt(line: string): { level: number; text: string } | null {
  const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
  if (!match) return null;
  return { level: match[1].length, text: match[2].replace(/[*_`]/g, '').trim() };
}

/** Isi semua seksi (`##`) yang judulnya cocok — seksi tanpa isi dilewati. */
export function findSections(markdown: string, names: string[]): string[] {
  const lines = markdown.split(/\r?\n/);
  const wanted = names.map(normalizeHeading).filter((name) => name !== '');
  const bodies: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const heading = headingAt(lines[index]);
    // Hanya heading seksi (##–####); H1 dipakai untuk judul bab.
    if (!heading || heading.level < 2 || heading.level > 4) continue;
    const normalized = normalizeHeading(heading.text);
    const match = wanted.some(
      (name) => normalized === name || normalized.startsWith(`${name} `),
    );
    if (!match) continue;

    const body: string[] = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const next = headingAt(lines[cursor]);
      if (next && next.level <= heading.level) break;
      body.push(lines[cursor]);
    }
    if (body.some((line) => line.trim() !== '')) bodies.push(body.join('\n'));
  }
  return bodies;
}

function bulletsFromSections(markdown: string, names: string[], max: number): string[] {
  const blocks: string[] = [];
  for (const body of findSections(markdown, names)) blocks.push(...textBlocks(body));
  return bulletsFromBlocks(blocks, max);
}

// ── Muat data project ────────────────────────────────────────────────────────

async function loadChapters(folder: string): Promise<Map<number, Chapter>> {
  const chapters = new Map<number, Chapter>();
  const paths = await discoverChapterPaths(folder).catch(() => []);
  for (const relative of paths) {
    let markdown: string;
    try {
      markdown = await readChapterText(folder, relative);
    } catch {
      continue;
    }
    const number = chapterNumber(relative, markdown);
    if (number === null || chapters.has(number)) continue;
    chapters.set(number, { path: relative, markdown });
  }
  return chapters;
}

async function loadResultDocs(folder: string): Promise<ResultDoc[]> {
  const dir = resolveInside(folder, 'hasil');
  if (!dir || !(await isRealInside(folder, dir))) return [];
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const docs: ResultDoc[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !/\.md$/i.test(entry.name)) continue;
    const absolute = path.join(dir, entry.name);
    if (!(await isRealInside(folder, absolute))) continue;
    const stat = await fs.stat(absolute).catch(() => null);
    if (!stat?.isFile() || stat.size > MAX_FILE_BYTES) continue;
    const markdown = await fs.readFile(absolute, 'utf8').catch(() => null);
    if (markdown === null) continue;
    docs.push({ path: `hasil/${entry.name}`, markdown, mtime: stat.mtimeMs });
  }

  return docs.sort((a, b) => b.mtime - a.mtime);
}

const TABLE_SCORES: Array<[RegExp, number]> = [
  [/\bregresi\b|koefisien regresi/, 60],
  [/ringkasan model|goodness of fit|anova/, 35],
  [/validitas|reliabilitas|cronbach/, 30],
  [/deskriptif/, 25],
  [/ringkasan asumsi|asumsi klasik/, 22],
  [/\bkorelasi\b/, 20],
  [/normalitas/, 15],
  [/heteroskedastisitas|multikolinearitas|linearitas|autokorelasi/, 10],
  [/gambaran data/, 5],
];

function normKey(value: string): string {
  return cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function scoreTable(table: MarkdownTable, caption: string): number {
  const haystack = caption.toLowerCase();
  let score = 0;
  for (const [pattern, weight] of TABLE_SCORES) {
    if (pattern.test(haystack)) score = Math.max(score, weight);
  }
  if (score === 0) score = 4;
  score += table.header.length <= MAX_TABLE_COLS ? 5 : -(table.header.length - MAX_TABLE_COLS) * 3;
  if (table.rows.length >= 2) score += 2;
  return score;
}

/**
 * `extractTables` hanya melihat 6 baris ke belakang, jadi tabel yang dipisah
 * prosa panjang dari heading-nya (mis. laporan validitas) kehilangan caption.
 * Di sini caption kosong diisi heading terdekat di atas tabel.
 */
function captionFromHeading(markdown: string, table: MarkdownTable): string {
  const firstLine = table.markdown.split('\n')[0]?.trim();
  if (!firstLine) return '';
  const at = markdown.indexOf(firstLine);
  if (at < 0) return '';
  const before = markdown.slice(0, at).split(/\r?\n/);
  for (let index = before.length - 1; index >= 0; index -= 1) {
    const heading = headingAt(before[index]);
    if (heading) return cleanText(heading.text);
  }
  return '';
}

/** Tabel hasil, terurut skor relevansi; duplikat antar versi laporan dibuang. */
function collectTables(docs: ResultDoc[]): TableCandidate[] {
  const candidates: TableCandidate[] = [];
  const seen = new Set<string>();

  for (const doc of docs) {
    for (const table of extractTables(doc.markdown)) {
      if (table.header.length < 2 || table.rows.length === 0) continue;
      const caption = cleanText(table.caption) || captionFromHeading(doc.markdown, table);
      const key = `${normKey(caption)}|${table.header.map(normKey).join('|')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({
        table,
        caption,
        source: doc.path,
        score: scoreTable(table, caption),
        mtime: doc.mtime,
      });
    }
  }

  return candidates.sort(
    (a, b) => b.score - a.score || b.mtime - a.mtime || a.table.index - b.table.index,
  );
}

function dependentVariable(tables: TableCandidate[]): string | null {
  for (const candidate of tables) {
    const match = /regresi[^()]*\(`?([A-Za-z0-9_]+)`?\)/i.exec(candidate.caption);
    if (match) return match[1];
  }
  return null;
}

/** Prioritas gambar sidang: scatter → boxplot → residual → histogram variabel dependen. */
function imageRank(name: string, dependent: string | null): number {
  const base = name.toLowerCase();
  if (base.includes('scatter')) return 100;
  if (base.includes('boxplot')) return 90;
  if (base.includes('resid')) return 80;
  if (base.includes('hist')) {
    if (dependent && base.includes(`uji-${dependent.toLowerCase()}-hist`)) return 75;
    return 60;
  }
  if (base.includes('qq')) return 15;
  return 40;
}

/** Baca dimensi PNG/JPEG tanpa dependency tambahan, buat perhitungan `contain`. */
async function readImageSize(absolute: string): Promise<{ width: number; height: number } | null> {
  const handle = await fs.open(absolute, 'r').catch(() => null);
  if (!handle) return null;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 24) return null;
    // Cukup baca bagian awal file: header PNG 24 byte, SOF JPEG biasanya dekat awal.
    const length = Math.min(stat.size, 256 * 1024);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    const view = buffer.subarray(0, bytesRead);
    if (view.length < 24) return null;
    const isPng =
      view[0] === 0x89 && view[1] === 0x50 && view[2] === 0x4e && view[3] === 0x47 &&
      view[4] === 0x0d && view[5] === 0x0a && view[6] === 0x1a && view[7] === 0x0a;
    if (isPng) {
      const width = view.readUInt32BE(16);
      const height = view.readUInt32BE(20);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    if (view[0] === 0xff && view[1] === 0xd8) {
      let index = 2;
      while (index + 9 < view.length) {
        if (view[index] !== 0xff) {
          index += 1;
          continue;
        }
        const marker = view[index + 1];
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
          index += 2;
          continue;
        }
        const segmentLength = view.readUInt16BE(index + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          const height = view.readUInt16BE(index + 5);
          const width = view.readUInt16BE(index + 7);
          return width > 0 && height > 0 ? { width, height } : null;
        }
        index += 2 + segmentLength;
      }
    }
    return null;
  } finally {
    await handle.close();
  }
}

async function loadImages(
  folder: string,
  dependent: string | null,
  notes: string[],
): Promise<ImageCandidate[]> {
  const dir = resolveInside(folder, 'gambar');
  if (!dir || !(await isRealInside(folder, dir))) return [];
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const images: ImageCandidate[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !/\.(png|jpe?g)$/i.test(entry.name)) continue;
    const absolute = path.join(dir, entry.name);
    if (!(await isRealInside(folder, absolute))) continue;
    const size = await readImageSize(absolute);
    if (!size) {
      notes.push(`Gambar ${entry.name} dilewati: format tidak terbaca.`);
      continue;
    }
    images.push({
      relative: `gambar/${entry.name}`,
      absolute,
      name: entry.name,
      width: size.width,
      height: size.height,
      rank: imageRank(entry.name, dependent),
    });
  }

  return images.sort((a, b) => b.rank - a.rank || a.name.localeCompare(b.name));
}

type FigureCaption = { caption: string; alt: string };

/** Caption `**Gambar 4.14** …` dari bab/laporan untuk nama file gambar tertentu. */
function collectFigureCaptions(docs: Array<{ markdown: string }>): Map<string, FigureCaption> {
  const map = new Map<string, FigureCaption>();

  for (const doc of docs) {
    const lines = doc.markdown.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const image = /^\s*!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(lines[index]);
      if (!image) continue;

      const name = path.posix.basename(image[2].replace(/\\/g, '/'));
      let caption = '';
      for (let cursor = index + 1; cursor < Math.min(lines.length, index + 4); cursor += 1) {
        const line = lines[cursor].trim();
        if (line === '') continue;
        const figure = /^\*\*Gambar\s+([0-9]+(?:\.[0-9]+)*)\.?\*\*\s*(.*)$/i.exec(line);
        if (figure) {
          const title = cleanText(figure[2]);
          caption = title === '' ? `Gambar ${figure[1]}` : `Gambar ${figure[1]} — ${title}`;
        }
        break;
      }

      const alt = cleanText(image[1]);
      const current = map.get(name);
      if (!current || (current.caption === '' && caption !== '')) {
        map.set(name, { caption: caption || current?.caption || '', alt: alt || current?.alt || '' });
      }
    }
  }

  return map;
}

async function readBibliography(
  folder: string,
): Promise<{ exists: boolean; count: number }> {
  const absolute = resolveInside(folder, 'references.bib');
  if (!absolute || !(await isRealInside(folder, absolute))) return { exists: false, count: 0 };
  const raw = await fs.readFile(absolute, 'utf8').catch(() => null);
  if (raw === null) return { exists: false, count: 0 };
  const entries = parseBib(raw).filter((entry) => entry.key.trim() !== '');
  return { exists: true, count: entries.length };
}

// ── Pemilihan isi tabel ──────────────────────────────────────────────────────

const COLUMN_PRIORITY: RegExp[] = [
  /^(variabel|nama|kolom|butir|item|indikator|prediktor|uji|asumsi|statistik)$/i,
  /^(keputusan|kesimpulan|validitas|keterangan)$/i,
  /^(p|sig|signifikansi|p-value|p \(f\))$/i,
  /^(b|koef|koefisien)(\s*\(.*\))?$|^(β|beta)(\s*\(.*\))?$/i,
  /^(t|f|w|z|statistik)$/i,
  /^(r|r²|r2|r[- ]?hitung|r[- ]?tabel)(\s*\(.*\))?$/i,
  /^(mean|rerata|rata-rata|median|sd|std)/i,
];

function pickColumns(header: string[]): number[] {
  if (header.length <= MAX_TABLE_COLS) return header.map((_, index) => index);
  const picked = [0];
  for (const priority of COLUMN_PRIORITY) {
    for (let index = 1; index < header.length && picked.length < MAX_TABLE_COLS; index += 1) {
      if (picked.includes(index)) continue;
      if (priority.test(header[index].trim())) picked.push(index);
    }
  }
  for (let index = 1; index < header.length && picked.length < MAX_TABLE_COLS; index += 1) {
    if (!picked.includes(index)) picked.push(index);
  }
  return picked.sort((a, b) => a - b);
}

function tableCells(table: MarkdownTable): PickedTable {
  const columns = pickColumns(table.header);
  const header = columns.map((index) => clipText(cleanText(table.header[index] ?? ''), 26) || '—');
  const rows = table.rows
    .map((row) => columns.map((index) => clipText(cleanText(row[index] ?? ''), 48)))
    .filter((row) => row.some((cell) => cell !== ''))
    .slice(0, MAX_TABLE_ROWS);
  return { header, rows };
}

function isNumericColumn(rows: string[][], index: number): boolean {
  const values = rows.map((row) => row[index] ?? '').filter((value) => value !== '');
  if (values.length === 0) return false;
  const numeric = values.filter((value) => /^[-–−]?\d[\d.,%±…\s]*$/.test(value));
  return numeric.length >= Math.ceil(values.length * 0.7);
}

// ── Susun deck ───────────────────────────────────────────────────────────────

function formatDate(date: Date): string {
  if (Number.isNaN(date.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('id-ID', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

function figureSlide(
  image: ImageCandidate,
  captions: Map<string, FigureCaption>,
  title: string,
): DeckSlide {
  const info = captions.get(image.name);
  const fallback = `Grafik ${image.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ')}`;
  const caption = info?.caption || info?.alt || fallback;
  return {
    kind: 'figure',
    title,
    caption: clipText(caption, 110),
    image: image.absolute,
    width: image.width,
    height: image.height,
  };
}

function tableSlide(candidate: TableCandidate, main: boolean): DeckSlide {
  const caption = candidate.caption || path.basename(candidate.source, '.md');
  const cells = tableCells(candidate.table);
  return {
    kind: 'table',
    title: main ? 'Hasil Penelitian' : `Hasil — ${clipText(caption, 40)}`,
    caption: `Tabel — ${clipText(caption, 90)}`,
    header: cells.header,
    rows: cells.rows,
  };
}

// ── Render pptx ──────────────────────────────────────────────────────────────

type PptxDeck = InstanceType<typeof pptxgen>;
type PptxSlide = ReturnType<PptxDeck['addSlide']>;
type TableCellOptions = NonNullable<Parameters<PptxSlide['addTable']>[0][number][number]['options']>;

function addBackground(slide: PptxSlide): void {
  slide.background = { color: 'FFFFFF' };
}

function addAccentLine(
  slide: PptxSlide,
  x: number,
  y: number,
  w: number,
  h = 0.04,
): void {
  slide.addShape('rect', {
    x,
    y,
    w,
    h,
    fill: { color: ACCENT },
    line: { color: ACCENT, pt: 0 },
  });
}

function addTitle(slide: PptxSlide, title: string): void {
  slide.addText(title, {
    x: MARGIN,
    y: 0.26,
    w: CONTENT_W,
    h: 0.72,
    fontSize: 28,
    bold: true,
    color: ACCENT,
    fontFace: FONT,
    valign: 'middle',
    fit: 'shrink',
  });
  addAccentLine(slide, MARGIN, 1.05, 1.5);
}

function addSlideNumber(slide: PptxSlide, position: number): void {
  slide.addText(String(position), {
    x: SLIDE_W - 1.1,
    y: SLIDE_H - 0.42,
    w: 0.5,
    h: 0.26,
    fontSize: 10,
    color: '8A8F98',
    fontFace: FONT,
    align: 'right',
    valign: 'middle',
  });
}

function renderTitleSlide(pptx: PptxDeck, spec: Extract<DeckSlide, { kind: 'title' }>): PptxSlide {
  const slide = pptx.addSlide();
  addBackground(slide);
  slide.addShape('rect', {
    x: MARGIN,
    y: 1.2,
    w: 0.08,
    h: 1.55,
    fill: { color: ACCENT },
    line: { color: ACCENT, pt: 0 },
  });
  slide.addText(spec.title, {
    x: MARGIN + 0.3,
    y: 1.05,
    w: CONTENT_W - 0.3,
    h: 1.55,
    fontSize: 28,
    bold: true,
    color: ACCENT,
    fontFace: FONT,
    valign: 'middle',
    fit: 'shrink',
  });
  slide.addText(spec.subtitle, {
    x: MARGIN + 0.3,
    y: 2.7,
    w: CONTENT_W - 0.3,
    h: 0.45,
    fontSize: 20,
    color: TEXT_COLOR,
    fontFace: FONT,
    valign: 'middle',
  });
  addAccentLine(slide, MARGIN + 0.3, 3.28, 1.2);
  if (spec.date !== '') {
    slide.addText(spec.date, {
      x: MARGIN + 0.3,
      y: 3.4,
      w: CONTENT_W - 0.3,
      h: 0.35,
      fontSize: 14,
      color: MUTED,
      fontFace: FONT,
      valign: 'middle',
    });
  }
  addAccentLine(slide, MARGIN, 5.08, CONTENT_W, 0.03);
  return slide;
}

function renderBulletSlide(pptx: PptxDeck, spec: Extract<DeckSlide, { kind: 'bullets' }>): PptxSlide {
  const slide = pptx.addSlide();
  addBackground(slide);
  addTitle(slide, spec.title);
  slide.addText(
    spec.bullets.map((bullet) => ({ text: bullet, options: { bullet: true, breakLine: true } })),
    {
      x: MARGIN + 0.1,
      y: CONTENT_TOP,
      w: CONTENT_W - 0.2,
      h: CONTENT_H,
      fontSize: 16,
      color: TEXT_COLOR,
      fontFace: FONT,
      valign: 'top',
      lineSpacingMultiple: 1.3,
      paraSpaceAfter: 12,
      fit: 'shrink',
    },
  );
  return slide;
}

function renderTableSlide(pptx: PptxDeck, spec: Extract<DeckSlide, { kind: 'table' }>): PptxSlide {
  const slide = pptx.addSlide();
  addBackground(slide);
  addTitle(slide, spec.title);

  slide.addText(spec.caption, {
    x: MARGIN,
    y: 1.22,
    w: CONTENT_W,
    h: 0.3,
    fontSize: 12,
    italic: true,
    color: MUTED,
    fontFace: FONT,
    valign: 'middle',
  });

  const headerRow = spec.header.map((cell) => ({
    text: cell,
    options: {
      bold: true,
      color: 'FFFFFF',
      fill: { color: ACCENT },
      fontSize: 11,
      fontFace: FONT,
      align: 'left',
      valign: 'middle',
    } satisfies TableCellOptions,
  }));

  const bodyRows = spec.rows.map((row, rowIndex) =>
    spec.header.map((_, columnIndex) => ({
      text: row[columnIndex] ?? '',
      options: {
        color: TEXT_COLOR,
        fill: { color: rowIndex % 2 === 0 ? 'FFFFFF' : ROW_ALT },
        fontSize: 11,
        fontFace: FONT,
        align: isNumericColumn(spec.rows, columnIndex) ? 'right' : 'left',
        valign: 'middle',
      } satisfies TableCellOptions,
    })),
  );

  const weights = spec.header.map((_, index) => (index === 0 ? 1.6 : 1));
  const weightSum = weights.reduce((total, weight) => total + weight, 0);
  const colW = weights.map((weight) => (CONTENT_W * weight) / weightSum);

  slide.addTable([headerRow, ...bodyRows], {
    x: MARGIN,
    y: 1.58,
    w: CONTENT_W,
    colW,
    border: { type: 'solid', color: BORDER_COLOR, pt: 0.5 },
    fontFace: FONT,
    fontSize: 11,
    color: TEXT_COLOR,
    valign: 'middle',
    margin: 0.05,
    autoPage: false,
  });
  return slide;
}

function renderFigureSlide(pptx: PptxDeck, spec: Extract<DeckSlide, { kind: 'figure' }>): PptxSlide {
  const slide = pptx.addSlide();
  addBackground(slide);
  addTitle(slide, spec.title);

  const box = { x: MARGIN, y: CONTENT_TOP, w: CONTENT_W, h: CONTENT_H - 0.5 };
  const ratio = spec.width > 0 && spec.height > 0 ? spec.width / spec.height : 16 / 9;
  const width = Math.min(box.w, box.h * ratio);
  const height = width / ratio;
  slide.addImage({
    path: spec.image,
    x: box.x + (box.w - width) / 2,
    y: box.y + (box.h - height) / 2,
    w: width,
    h: height,
  });

  slide.addText(spec.caption, {
    x: MARGIN,
    y: CONTENT_BOTTOM - 0.45,
    w: CONTENT_W,
    h: 0.35,
    fontSize: 11,
    italic: true,
    color: MUTED,
    fontFace: FONT,
    align: 'center',
    valign: 'middle',
  });
  return slide;
}

function renderClosingSlide(pptx: PptxDeck, spec: Extract<DeckSlide, { kind: 'closing' }>): PptxSlide {
  const slide = pptx.addSlide();
  addBackground(slide);
  addTitle(slide, spec.title);
  slide.addText(spec.heading, {
    x: MARGIN,
    y: 2.0,
    w: CONTENT_W,
    h: 0.8,
    fontSize: 28,
    bold: true,
    color: ACCENT,
    fontFace: FONT,
    align: 'center',
    valign: 'middle',
  });
  if (spec.lines.length > 0) {
    slide.addText(spec.lines.join('\n'), {
      x: MARGIN,
      y: 2.95,
      w: CONTENT_W,
      h: 0.9,
      fontSize: 14,
      color: TEXT_COLOR,
      fontFace: FONT,
      align: 'center',
      valign: 'top',
      lineSpacingMultiple: 1.2,
    });
  }
  return slide;
}

function renderSlide(pptx: PptxDeck, spec: DeckSlide): PptxSlide {
  switch (spec.kind) {
    case 'title':
      return renderTitleSlide(pptx, spec);
    case 'table':
      return renderTableSlide(pptx, spec);
    case 'figure':
      return renderFigureSlide(pptx, spec);
    case 'closing':
      return renderClosingSlide(pptx, spec);
    case 'bullets':
    default:
      return renderBulletSlide(pptx, spec);
  }
}

// ── Entry point ──────────────────────────────────────────────────────────────

async function ensureExportDir(folder: string): Promise<string> {
  const dir = resolveInside(folder, 'export');
  if (!dir) throw new Error('Folder export tidak valid');
  await fs.mkdir(dir, { recursive: true });
  const real = await fs.realpath(dir);
  if (real !== folder && !real.startsWith(folder + path.sep)) {
    throw new Error('Folder export keluar dari project');
  }
  return real;
}

/**
 * Susun + tulis `export/slide-sidang.pptx` untuk satu folder project.
 * Tidak ada server/Next yang dibutuhkan — aman dipanggil dari route maupun skrip uji.
 */
export async function exportDefenseSlides(options: SlideDeckOptions): Promise<SlideDeckResult> {
  const folder = await fs.realpath(options.folder);
  const notes: string[] = [];
  const deckTitle = options.title.trim() || 'Skripsi';
  const dateLabel = formatDate(options.date ?? new Date());

  const chapters = await loadChapters(folder);
  const resultDocs = await loadResultDocs(folder);
  const tables = collectTables(resultDocs);
  const dependent = dependentVariable(tables);
  const images = await loadImages(folder, dependent, notes);
  const captions = collectFigureCaptions([
    ...Array.from(chapters.values()).map((chapter) => ({ markdown: chapter.markdown })),
    ...resultDocs.map((doc) => ({ markdown: doc.markdown })),
  ]);
  const bibliography = await readBibliography(folder);

  const bab1 = chapters.get(1);
  const bab3 = chapters.get(3);
  const bab4 = chapters.get(4);
  const bab5 = chapters.get(5);

  // ── Isi per seksi (kalimat asli, tanpa mengarang) ──
  const latar = bab1
    ? bulletsFromSections(bab1.markdown, ['Latar Belakang', 'Latar Belakang Masalah'], 3)
    : [];
  if (!bab1) {
    notes.push('Bab 1 tidak ditemukan, slide latar belakang dan rumusan masalah dilewati.');
  } else if (latar.length === 0) {
    notes.push('Seksi "Latar Belakang" tidak ditemukan di Bab 1, slide latar belakang dilewati.');
  }

  const masalah = bab1
    ? bulletsFromSections(bab1.markdown, ['Rumusan Masalah', 'Perumusan Masalah'], 4)
    : [];
  const tujuan = bab1
    ? bulletsFromSections(bab1.markdown, ['Tujuan Penelitian', 'Tujuan'], 3)
    : [];
  if (bab1 && masalah.length === 0 && tujuan.length === 0) {
    notes.push('Seksi "Rumusan Masalah"/"Tujuan" tidak ditemukan, slide rumusan masalah dilewati.');
  }

  let metode = bab3 ? bulletsFromBlocks(textBlocks(bab3.markdown), 3) : [];
  if (metode.length === 0 && bab1) {
    const fallback = bulletsFromSections(
      bab1.markdown,
      ['Metode Penelitian', 'Metode', 'Teknik Analisis Data', 'Teknik Analisis'],
      3,
    );
    if (fallback.length > 0) {
      metode = fallback;
      notes.push(
        bab3
          ? 'Bab 3 tidak memuat paragraf metode, slide metode diambil dari Bab 1.'
          : 'Bab 3 tidak ditemukan, slide metode diambil dari Bab 1.',
      );
    }
  }
  if (metode.length === 0) {
    notes.push(
      bab3
        ? 'Bagian metode tidak ditemukan di Bab 3/Bab 1, slide metode dilewati.'
        : 'Bab 3 tidak ditemukan, slide metode dilewati.',
    );
  }

  const pembahasan = bab4
    ? bulletsFromSections(
        bab4.markdown,
        ['Pembahasan', 'Pembahasan Hasil', 'Diskusi', 'Diskusi Hasil'],
        3,
      )
    : [];
  if (!bab4) {
    notes.push('Bab 4 tidak ditemukan, slide pembahasan dilewati.');
  } else if (pembahasan.length === 0) {
    notes.push('Seksi "Pembahasan" tidak ditemukan di Bab 4, slide pembahasan dilewati.');
  }

  const kesimpulan = bab5
    ? bulletsFromSections(bab5.markdown, ['Kesimpulan', 'Simpulan'], 4)
    : [];
  const saran = bab5
    ? bulletsFromSections(bab5.markdown, ['Saran', 'Saran Penelitian', 'Implikasi'], 4)
    : [];
  if (!bab5) {
    notes.push('Bab 5 tidak ditemukan, slide kesimpulan dan saran dilewati.');
  } else {
    if (kesimpulan.length === 0) {
      notes.push('Seksi "Kesimpulan" tidak ditemukan di Bab 5, slide kesimpulan dilewati.');
    }
    if (saran.length === 0) {
      notes.push('Seksi "Saran" tidak ditemukan di Bab 5, slide saran dilewati.');
    }
  }

  if (tables.length === 0) {
    notes.push('Tidak ada tabel di hasil/, slide hasil dilewati.');
  }
  if (images.length === 0) {
    notes.push('Tidak ada gambar .png/.jpg di gambar/, slide grafik dilewati.');
  }
  if (!bibliography.exists) {
    notes.push('references.bib tidak ditemukan, jumlah pustaka tidak ditampilkan.');
  } else if (bibliography.count === 0) {
    notes.push('references.bib tidak berisi entri, jumlah pustaka tidak ditampilkan.');
  }

  // ── Susunan wajib ──
  const buildHead = (splitProblem: boolean): DeckSlide[] => {
    const head: DeckSlide[] = [
      { kind: 'title', title: deckTitle, subtitle: 'Sidang Skripsi', date: dateLabel },
    ];

    if (latar.length > 0) {
      head.push({ kind: 'bullets', title: 'Latar Belakang', bullets: latar });
    }

    if (masalah.length > 0 && tujuan.length > 0) {
      if (splitProblem) {
        head.push({ kind: 'bullets', title: 'Rumusan Masalah', bullets: masalah });
        head.push({ kind: 'bullets', title: 'Tujuan Penelitian', bullets: tujuan });
      } else {
        head.push({
          kind: 'bullets',
          title: 'Rumusan Masalah & Tujuan',
          bullets: [...masalah, ...tujuan].slice(0, 5),
        });
      }
    } else if (masalah.length > 0) {
      head.push({ kind: 'bullets', title: 'Rumusan Masalah', bullets: masalah });
    } else if (tujuan.length > 0) {
      head.push({ kind: 'bullets', title: 'Tujuan Penelitian', bullets: tujuan });
    }

    if (metode.length > 0) {
      head.push({ kind: 'bullets', title: 'Metode Penelitian', bullets: metode });
    }
    return head;
  };

  const resultSlides: DeckSlide[] = tables.length > 0 ? [tableSlide(tables[0], true)] : [];
  const figureSlides: DeckSlide[] = images.length > 0 ? [figureSlide(images[0], captions, 'Grafik')] : [];

  const tail: DeckSlide[] = [];
  if (pembahasan.length > 0) {
    tail.push({ kind: 'bullets', title: 'Pembahasan', bullets: pembahasan });
  }
  if (kesimpulan.length > 0) {
    tail.push({ kind: 'bullets', title: 'Kesimpulan', bullets: kesimpulan });
  }
  if (saran.length > 0) {
    tail.push({ kind: 'bullets', title: 'Saran', bullets: saran });
  }
  tail.push({
    kind: 'closing',
    title: 'Penutup',
    heading: 'Terima kasih',
    lines: bibliography.count > 0 ? [`Daftar pustaka: ${bibliography.count} entri`] : [],
  });

  // Dokumen minim: pecah slide gabungan supaya deck tetap ≥ 6 slide.
  const countSlides = (head: DeckSlide[]): number =>
    head.length + resultSlides.length + figureSlides.length + tail.length;
  let head = buildHead(false);
  if (countSlides(head) < MIN_SLIDES) {
    const split = buildHead(true);
    if (countSlides(split) > countSlides(head)) head = split;
  }

  const baseCount = countSlides(head);
  const room = Math.max(0, MAX_SLIDES - baseCount);
  const extraCandidates = tables
    .slice(1)
    .filter((candidate) => candidate.score >= EXTRA_TABLE_MIN_SCORE)
    .slice(0, MAX_EXTRA_TABLES);
  const extraTableSlides = extraCandidates
    .slice(0, room)
    .map((candidate) => tableSlide(candidate, false));
  const extraFigureSlides =
    images.length > 1 && extraTableSlides.length < room
      ? [
          figureSlide(
            images[1],
            captions,
            `Grafik — ${clipText(
              captions.get(images[1].name)?.alt ||
                images[1].name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' '),
              40,
            )}`,
          ),
        ]
      : [];

  const hiddenTables = extraCandidates.length - extraTableSlides.length;
  if (hiddenTables > 0) {
    notes.push(
      `Deck dibatasi ${MAX_SLIDES} slide; ${hiddenTables} tabel hasil tambahan tidak ditampilkan.`,
    );
  }

  const slides: DeckSlide[] = [
    ...head,
    ...resultSlides,
    ...extraTableSlides,
    ...figureSlides,
    ...extraFigureSlides,
    ...tail,
  ].slice(0, MAX_SLIDES);

  if (slides.length < MIN_SLIDES) {
    notes.push(
      `Dokumen minim: hanya ${slides.length} slide (beberapa seksi wajib tidak ditemukan).`,
    );
  }

  // ── Render ──
  const pptx = new pptxgen();
  pptx.layout = 'LAYOUT_16x9';
  pptx.author = 'vibe-research';
  pptx.company = 'vibe-research';
  pptx.title = `${deckTitle} — Sidang Skripsi`;
  pptx.subject = 'Slide sidang skripsi';
  pptx.theme = { headFontFace: FONT, bodyFontFace: FONT };

  slides.forEach((spec, index) => {
    const slide = renderSlide(pptx, spec);
    addSlideNumber(slide, index + 1);
  });

  const outDir = await ensureExportDir(folder);
  const outAbs = path.join(outDir, path.basename(OUTPUT_REL));
  await fs.rm(outAbs, { force: true });
  await pptx.writeFile({ fileName: outAbs });
  const stat = await fs.stat(outAbs);

  return {
    file: toProjectPath(folder, outAbs),
    slides: slides.length,
    notes,
    bytes: stat.size,
  };
}

export const SLIDE_OUTPUT_PATH = OUTPUT_REL;
