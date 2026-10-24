import fs from 'node:fs/promises';
import path from 'node:path';
import { isRealInside, resolveInside } from '../export/paths';
import { mergeChapterHeading } from './headings';

export { mergeChapterHeading };

export const ABSTRACT_PATH = 'dokumen/abstrak.md';
const MAX_CHAPTER_BYTES = 4 * 1024 * 1024;
const EXCLUDED_NAME_WORDS = new Set(['uji', 'test', 'percobaan', 'draft']);

export type CaptionEntry = {
  kind: 'table' | 'figure';
  /** Nomor caption tanpa label, mis. `3.1`. Kosong kalau gambar tanpa caption. */
  number: string;
  title: string;
  anchor: string;
  /** Indeks baris 0-based di file markdown asal. */
  line: number;
};

export type CaptionScan = {
  tables: CaptionEntry[];
  figures: CaptionEntry[];
};

const TABLE_CAPTION = /^\s*\*\*Tabel\s+([0-9]+(?:\.[0-9]+)*)\.?\*\*\s*(.*?)\s*$/i;
const FIGURE_CAPTION = /^\s*\*\*Gambar\s+([0-9]+(?:\.[0-9]+)*)\.?\*\*\s*(.*?)\s*$/i;
const IMAGE_LINE = /^\s*!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/;

function chunks(value: string): string[] {
  return value.match(/\d+|\D+/g) ?? [value];
}

/** Urutan alami: bab2 sebelum bab10, tanpa locale collation. */
export function naturalCompare(a: string, b: string): number {
  const left = chunks(a);
  const right = chunks(b);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const l = left[index] ?? '';
    const r = right[index] ?? '';
    const lNum = /^\d+$/.test(l);
    const rNum = /^\d+$/.test(r);
    if (lNum && rNum) {
      const diff = Number(l) - Number(r);
      if (diff !== 0) return diff;
      continue;
    }
    if (l !== r) return l.localeCompare(r, 'id', { sensitivity: 'base' });
  }
  return 0;
}

/** Nama file draf/uji coba: token kata persis, jadi `pengujian.md` tetap ikut. */
export function isExcludedChapterName(fileName: string): boolean {
  const words = fileName.toLowerCase().match(/[a-z]+/g) ?? [];
  return words.some((word) => EXCLUDED_NAME_WORDS.has(word));
}

/** Semua `dokumen/*.md` (kecuali abstrak + file uji/draf), urut alami. */
export async function discoverChapterPaths(folder: string): Promise<string[]> {
  const dir = resolveInside(folder, 'dokumen');
  if (!dir || !(await isRealInside(folder, dir))) return [];
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => /\.md$/i.test(name))
    .filter((name) => name.toLowerCase() !== 'abstrak.md')
    .filter((name) => !isExcludedChapterName(name))
    .sort(naturalCompare)
    .map((name) => `dokumen/${name}`);
}

/** Baca bab .md dengan guard path + batas ukuran. */
export async function readChapterText(folder: string, relative: string): Promise<string> {
  const abs = resolveInside(folder, relative);
  if (!abs) throw new Error(`Path bab ilegal: ${relative}`);
  if (!/\.md$/i.test(abs)) throw new Error(`Bukan file .md: ${relative}`);
  const stat = await fs.stat(abs).catch(() => null);
  if (!stat?.isFile()) throw new Error(`Bab tidak ditemukan: ${relative}`);
  if (stat.size > MAX_CHAPTER_BYTES) throw new Error(`Bab terlalu besar: ${relative}`);
  if (!(await isRealInside(folder, abs))) throw new Error(`Bab keluar dari project: ${relative}`);
  return fs.readFile(abs, 'utf8');
}

/** Judul bab dari heading `# …` pertama; fallback nama file. */
export async function readChapterTitle(folder: string, relative: string): Promise<string> {
  const markdown = await readChapterText(folder, relative).catch(() => '');
  const heading = /^\s*#\s+(.+?)\s*$/m.exec(markdown);
  if (heading) return heading[1].replace(/[*_`]/g, '').trim();
  return path
    .basename(relative, path.extname(relative))
    .replace(/[-_]+/g, ' ')
    .trim();
}

function cleanTitle(value: string): string {
  return value.replace(/^\*\*|\*\*$/g, '').replace(/\s+/g, ' ').trim();
}

function uniqueAnchor(base: string, seen: Set<string>): string {
  let anchor = base;
  let suffix = 2;
  while (seen.has(anchor)) {
    anchor = `${base}-${suffix}`;
    suffix += 1;
  }
  seen.add(anchor);
  return anchor;
}

function anchorFor(kind: CaptionEntry['kind'], number: string, ordinal: number): string {
  const prefix = kind === 'table' ? 'tabel' : 'gambar';
  const suffix = number.replace(/\./g, '-') || String(ordinal);
  return `${prefix}-${suffix}`;
}

/**
 * Scan caption sesuai konvensi aplikasi:
 * - tabel: baris `**Tabel 3.1** Judul`
 * - gambar: `![alt](path)` lalu baris `**Gambar 3.1** Judul`; tanpa caption → alt.
 */
export function scanCaptions(markdown: string, seenAnchors = new Set<string>()): CaptionScan {
  const lines = markdown.split('\n');
  const tables: CaptionEntry[] = [];
  const figures: CaptionEntry[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const table = TABLE_CAPTION.exec(line);
    if (table) {
      const number = table[1];
      tables.push({
        kind: 'table',
        number,
        title: cleanTitle(table[2]) || 'Tanpa judul',
        anchor: uniqueAnchor(anchorFor('table', number, tables.length + 1), seenAnchors),
        line: index,
      });
      continue;
    }

    const image = IMAGE_LINE.exec(line);
    if (!image) continue;
    const alt = image[1].trim();
    let captionLine = index + 1;
    while (
      captionLine < lines.length &&
      lines[captionLine].trim() === '' &&
      captionLine - index <= 2
    ) {
      captionLine += 1;
    }
    const figure = FIGURE_CAPTION.exec((lines[captionLine] ?? '').trim());
    const ordinal = figures.length + 1;
    if (figure) {
      const number = figure[1];
      figures.push({
        kind: 'figure',
        number,
        title: cleanTitle(figure[2]) || alt || 'Tanpa judul',
        anchor: uniqueAnchor(anchorFor('figure', number, ordinal), seenAnchors),
        line: index,
      });
    } else if (alt) {
      figures.push({
        kind: 'figure',
        number: '',
        title: alt,
        anchor: uniqueAnchor(anchorFor('figure', '', ordinal), seenAnchors),
        line: index,
      });
    }
  }

  return { tables, figures };
}

/** Label daftar: `Tabel 3.1 — Judul` / `Gambar 3.1 — Judul`. */
export function captionLabel(entry: CaptionEntry): string {
  const number = entry.number ? ` ${entry.number}` : '';
  const label = entry.kind === 'table' ? 'Tabel' : 'Gambar';
  return `${label}${number} — ${entry.title}`;
}

/** Sisipkan anchor HTML pada baris caption (hanya untuk jalur PDF). */
export function addCaptionAnchors(markdown: string, entries: CaptionEntry[]): string {
  if (entries.length === 0) return markdown;
  const lines = markdown.split('\n');
  for (const entry of entries) {
    const line = lines[entry.line];
    if (line === undefined) continue;
    const span = `<span id="${entry.anchor}"></span>`;
    if (entry.kind === 'table') {
      const replaced = line.replace(/(\*\*Tabel\s+[^*]+\*\*)/i, `$1${span}`);
      lines[entry.line] = replaced === line ? `${line}${span}` : replaced;
    } else {
      lines[entry.line] = `${line}${span}`;
    }
  }
  return lines.join('\n');
}

/** Pisahkan heading H1 pembuka abstrak dari isinya. */
export function splitAbstractMarkdown(markdown: string): { heading: string; body: string } {
  const cleaned = markdown.replace(/^\uFEFF/, '').trimStart();
  const heading = /^#\s+(.+?)\s*(?:\r?\n|$)/.exec(cleaned);
  if (!heading) {
    return { heading: 'ABSTRAK', body: markdown.trim() };
  }
  return {
    heading: heading[1].replace(/[*_`]/g, '').trim() || 'ABSTRAK',
    body: cleaned.slice(heading[0].length).trim(),
  };
}
