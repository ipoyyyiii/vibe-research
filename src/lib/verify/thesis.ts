/**
 * Mesin pemeriksa naskah skripsi — deterministik, tanpa LLM.
 *
 * Modul murni: tidak menyentuh `fs`/db, hanya string masuk → temuan keluar.
 * Dipakai `GET /api/projects/[slug]/verify` sebagai gerbang terakhir sebelum
 * ekspor, dan bisa dijalankan langsung lewat `node` (type stripping) karena
 * isinya cuma fungsi.
 *
 * Sembilan aturan, semuanya bisa dijelaskan ulang ke pembimbing:
 *
 * | id                                 | level | inti                                              |
 * |------------------------------------|-------|---------------------------------------------------|
 * | citation.missing-key               | error | `[@key]` tanpa entri di references.bib            |
 * | citation.uncited-entry             | warn  | entri pustaka yang tidak pernah dikutip           |
 * | citation.paragraph-without-source  | warn  | paragraf klaim di bab pustaka tanpa rujukan       |
 * | numbering.table-gap                | error | caption `**Tabel N.M**` harus berurutan 1..n      |
 * | numbering.figure-gap               | error | caption `**Gambar N.M**` harus berurutan 1..n     |
 * | numbering.heading-gap              | warn  | heading `## X.Y` harus berurutan 1..n             |
 * | consistency.sample-size            | warn  | jumlah responden berbeda antar bab                |
 * | structure.abstract-length          | warn  | abstrak melebihi batas kata                       |
 * | structure.required-section         | error | seksi wajib Bab I/III/V tidak ada                 |
 *
 * Semua pesan menyebut berkas (dan baris bila ada) supaya temuan bisa
 * ditelusuri tanpa menjalankan ulang mesinnya.
 */

export type CheckLevel = 'error' | 'warn';

export type CheckResult = {
  id: string;
  level: CheckLevel;
  message: string;
  path?: string;
  line?: number;
};

export type VerifyInput = {
  chapters: Array<{ path: string; content: string }>;
  bibKeys: string[];
  abstract?: string | null;
  /** Batas kata abstrak; default 250. */
  abstractMaxWords?: number;
};

export type VerifySummary = { error: number; warn: number };
export type VerifyOutput = { checks: CheckResult[]; summary: VerifySummary };

/** Dipakai bila `abstractMaxWords` tidak diisi / tidak masuk akal. */
export const DEFAULT_ABSTRACT_MAX_WORDS = 250;

/** Paragraf dianggap "panjang" (klaim) di atas jumlah kata ini. */
const PARAGRAPH_MIN_WORDS = 40;
/** Batas temuan paragraf tanpa rujukan supaya laporan tidak banjir. */
const PARAGRAPH_MAX_FINDINGS = 10;

/** Bab yang wajib menyitasi klaimnya (bukan bab hasil pembahasan sendiri). */
const SOURCE_CHAPTER_TITLES = ['tinjauan pustaka', 'landasan teori'];

/** Seksi wajib per nomor bab. `match` diuji ke teks heading level ≥ 2. */
const REQUIRED_SECTIONS: Record<number, ReadonlyArray<{ label: string; match: RegExp }>> = {
  1: [
    { label: 'Rumusan Masalah', match: /rumusan\s+masalah/i },
    // "Tujuan" menangkap "Tujuan Penelitian", "Tujuan dan Manfaat", dst.
    { label: 'Tujuan', match: /\btujuan\b/i },
  ],
  3: [
    {
      label: 'Populasi atau Sampel',
      match: /populasi|sampel/i,
    },
    { label: 'Analisis', match: /analisis|analisa/i },
  ],
  5: [
    { label: 'Kesimpulan', match: /kesimpulan/i },
    { label: 'Saran', match: /\bsaran\b/i },
  ],
};

const ROMAN: Record<string, number> = {
  i: 1,
  v: 5,
  x: 10,
  l: 50,
  c: 100,
  d: 500,
  m: 1000,
};

const ROMAN_LABELS = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];

/** Citation group di dalam satu baris: `[@a]`, `[@a; @b]`, `[@a, hlm. 3]`. */
const CITE_GROUP = /\[([^[\]]*@[^[\]]*)\]/g;
/** Key di dalam group — boleh `-@key` (suppress) dan karakter BibTeX umum. */
const CITE_KEY = /-?@([A-Za-z0-9_][A-Za-z0-9_:.-]*)/g;

const TABLE_CAPTION = /^\s{0,3}\*\*\s*Tabel\s+(\d+)(?:\.(\d+))?\.?\s*\*\*/i;
const FIGURE_CAPTION = /^\s{0,3}\*\*\s*Gambar\s+(\d+)(?:\.(\d+))?\.?\s*\*\*/i;
/** Heading bernomor `## X.Y` — `## X.Y.Z` sengaja tidak ikut (sub-sub seksi). */
const NUMBERED_H2 = /^\s{0,3}##\s+(\d+)\.(\d+)(?=\s|$)/;

/** `n = 80` → ukuran sampel. Huruf kecil supaya `N = …` (populasi) tidak ikut. */
const SAMPLE_N = /\bn\s*=\s*(\d+)/g;
/** `80 responden`, `318 responden`. */
const RESPONDENT_COUNT = /\b(\d+)\s*(?:orang\s+)?responden\b/gi;

/** Word token: huruf/angka, boleh apostrof di tengah (`Cronbach's`). */
const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;

function normalize(markdown: string): string {
  return markdown.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

function countWords(text: string): number {
  const words = text.match(WORD);
  return words ? words.length : 0;
}

/** Potongan teks satu baris untuk pesan — biar temuan bisa dikenali. */
function snippet(text: string, max = 90): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max).trimEnd()}…` : flat;
}

function romanToNumber(raw: string): number | null {
  const text = raw.trim().toLowerCase();
  if (!/^[ivxlcdm]+$/.test(text)) return null;
  let total = 0;
  for (let index = 0; index < text.length; index += 1) {
    const value = ROMAN[text[index]];
    const next = ROMAN[text[index + 1]] ?? 0;
    total += value < next ? -value : value;
  }
  return total > 0 ? total : null;
}

function numberToRoman(value: number): string {
  return ROMAN_LABELS[value - 1] ?? String(value);
}

/** Baris di luar blok kode (fence ``` / ~~~) — heading/caption di dalam kode bukan naskah. */
function eachLine(markdown: string, visit: (line: string, lineNumber: number) => void): void {
  let inFence = false;
  normalize(markdown)
    .split('\n')
    .forEach((line, index) => {
      if (/^\s{0,3}(?:```|~~~)/.test(line)) {
        inFence = !inFence;
        return;
      }
      if (inFence) return;
      visit(line, index + 1);
    });
}

type Heading = { level: number; text: string; line: number };

function headings(markdown: string): Heading[] {
  const found: Heading[] = [];
  eachLine(markdown, (line, lineNumber) => {
    const match = /^\s{0,3}(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (!match) return;
    found.push({
      level: match[1].length,
      text: match[2].replace(/[*_`]/g, '').trim(),
      line: lineNumber,
    });
  });
  return found;
}

/** Judul bab: gabungan H1 di awal berkas (`# BAB II` + `# TINJAUAN PUSTAKA`). */
function chapterTitle(path: string, markdown: string): string {
  const lines = normalize(markdown).split('\n').slice(0, 15);
  const titles = lines
    .map((line) => /^\s{0,3}#\s+(.+)$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => match[1].replace(/[*_`]/g, '').trim());

  if (titles.length > 0) return titles.slice(0, 2).join(' ');
  return path
    .replace(/^.*\//, '')
    .replace(/\.md$/i, '')
    .replace(/[-_]+/g, ' ')
    .trim();
}

/** Nomor bab: dari heading `BAB IV`, fallback nama berkas (`bab4-…`). */
function chapterNumber(path: string, markdown: string): number | null {
  const head = normalize(markdown).split('\n').slice(0, 15).join('\n');
  const bab = /\bBAB\s+([IVXLCDM]+|\d+)\b/i.exec(head);
  if (bab) {
    const raw = bab[1];
    const value = /^\d+$/.test(raw) ? Number(raw) : romanToNumber(raw);
    if (value !== null && value > 0) return value;
  }

  const fromName = /(?:^|[^a-z])(?:bab|chapter)[\s_-]*(\d+)/i.exec(path);
  if (fromName) return Number(fromName[1]);

  const leading = /(\d+)/.exec(path.split('/').pop() ?? '');
  return leading ? Number(leading[1]) : null;
}

/** Semua sitasi `[@key]` pada naskah, urut kemunculan, baris 1-based. */
export function extractCitations(markdown: string): Array<{ key: string; line: number }> {
  const citations: Array<{ key: string; line: number }> = [];

  normalize(markdown)
    .split('\n')
    .forEach((line, index) => {
      CITE_GROUP.lastIndex = 0;
      let group: RegExpExecArray | null;
      while ((group = CITE_GROUP.exec(line)) !== null) {
        CITE_KEY.lastIndex = 0;
        let cite: RegExpExecArray | null;
        while ((cite = CITE_KEY.exec(group[1])) !== null) {
          citations.push({ key: cite[1], line: index + 1 });
        }
      }
    });

  return citations;
}

type Chapter = { path: string; content: string };

/** 1. Sitasi yang tidak punya entri pustaka. */
function checkMissingKeys(chapters: Chapter[], bibKeys: Set<string>): CheckResult[] {
  const results: CheckResult[] = [];

  for (const chapter of chapters) {
    // Satu temuan per (berkas, key) — kemunculan berulang cukup dihitung.
    const missing = new Map<string, { line: number; count: number }>();
    for (const citation of extractCitations(chapter.content)) {
      if (bibKeys.has(citation.key)) continue;
      const seen = missing.get(citation.key);
      if (seen) {
        seen.count += 1;
        continue;
      }
      missing.set(citation.key, { line: citation.line, count: 1 });
    }

    for (const [key, entry] of missing) {
      const extra = entry.count > 1 ? `; +${entry.count - 1} kemunculan lain di berkas ini` : '';
      results.push({
        id: 'citation.missing-key',
        level: 'error',
        message: `Sitasi [@${key}] tidak punya entri di references.bib — ${chapter.path} baris ${entry.line}${extra}.`,
        path: chapter.path,
        line: entry.line,
      });
    }
  }

  return results;
}

/** 2. Entri pustaka yang tidak pernah dikutip di bab mana pun. */
function checkUncitedEntries(chapters: Chapter[], bibKeys: string[]): CheckResult[] {
  const cited = new Set<string>();
  for (const chapter of chapters) {
    for (const citation of extractCitations(chapter.content)) cited.add(citation.key);
  }

  const results: CheckResult[] = [];
  for (const key of new Set(bibKeys)) {
    if (cited.has(key)) continue;
    results.push({
      id: 'citation.uncited-entry',
      level: 'warn',
      message: `Entri "${key}" ada di references.bib tetapi tidak pernah disitasi di bab mana pun.`,
    });
  }
  return results;
}

type Paragraph = { text: string; line: number };

/** Paragraf prosa: blok dipisah baris kosong, tanpa heading/tabel/daftar/kode. */
function paragraphs(markdown: string): Paragraph[] {
  const found: Paragraph[] = [];
  const lines = normalize(markdown).split('\n');
  let current: Paragraph | null = null;
  let inFence = false;

  const flush = () => {
    if (current && current.text.trim() !== '') found.push(current);
    current = null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s{0,3}(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      flush();
      continue;
    }
    if (inFence) continue;
    if (line.trim() === '') {
      flush();
      continue;
    }

    const isNonProse =
      /^\s{0,3}#{1,6}\s/.test(line) || // heading
      /^\s*\|/.test(line) || // tabel
      /^\s*(?:[-*+]|\d+[.)])\s/.test(line) || // daftar
      /^\s*>/.test(line) || // kutipan
      /^\s*</.test(line); // html
    if (isNonProse) {
      flush();
      continue;
    }

    if (current === null) current = { text: line.trim(), line: index + 1 };
    else current.text = `${current.text} ${line.trim()}`;
  }
  flush();

  return found;
}

/** 3. Paragraf panjang di bab pustaka yang tidak merujuk sumber apa pun. */
function checkParagraphsWithoutSource(chapters: Chapter[]): CheckResult[] {
  const results: CheckResult[] = [];

  for (const chapter of chapters) {
    const title = chapterTitle(chapter.path, chapter.content).toLowerCase();
    if (!SOURCE_CHAPTER_TITLES.some((keyword) => title.includes(keyword))) continue;

    for (const paragraph of paragraphs(chapter.content)) {
      if (results.length >= PARAGRAPH_MAX_FINDINGS) return results;

      const words = countWords(paragraph.text);
      if (words <= PARAGRAPH_MIN_WORDS) continue;
      if (paragraph.text.includes('[@')) continue;
      if (/\b(?:sumber|menurut)\b/i.test(paragraph.text)) continue;

      results.push({
        id: 'citation.paragraph-without-source',
        level: 'warn',
        message: `Paragraf ${words} kata tanpa rujukan [@…] dan tanpa kata "sumber"/"menurut" — ${chapter.path} baris ${paragraph.line}: "${snippet(paragraph.text)}"`,
        path: chapter.path,
        line: paragraph.line,
      });
    }
  }

  return results;
}

type Numbered = { number: string; major: number; minor: number; line: number };

function scanCaptions(markdown: string, pattern: RegExp): Numbered[] {
  const found: Numbered[] = [];
  eachLine(markdown, (line, lineNumber) => {
    const match = pattern.exec(line);
    if (!match) return;
    const major = Number(match[1]);
    const minor = match[2] === undefined ? 0 : Number(match[2]);
    // `**Tabel 4**` tanpa nomor sub-bab bukan bagian urutan 4.1, 4.2, …
    if (minor <= 0) return;
    found.push({ number: `${major}.${minor}`, major, minor, line: lineNumber });
  });
  return found;
}

function headingNumbers(markdown: string): Numbered[] {
  const found: Numbered[] = [];
  eachLine(markdown, (line, lineNumber) => {
    const match = NUMBERED_H2.exec(line);
    if (!match) return;
    found.push({
      number: `${Number(match[1])}.${Number(match[2])}`,
      major: Number(match[1]),
      minor: Number(match[2]),
      line: lineNumber,
    });
  });
  return found;
}

function dominantMajor(items: Numbered[]): number {
  const counts = new Map<number, number>();
  for (const item of items) counts.set(item.major, (counts.get(item.major) ?? 0) + 1);
  let best = items[0].major;
  let bestCount = 0;
  for (const [major, count] of counts) {
    if (count > bestCount) {
      best = major;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Urutan nomor dalam satu berkas: dobel, hilang, atau turun.
 * Dipakai tabel, gambar, dan heading — tiga aturan dengan logika sama.
 */
function checkSequence(options: {
  id: string;
  level: CheckLevel;
  label: string;
  path: string;
  items: Numbered[];
}): CheckResult[] {
  const { id, level, label, path, items } = options;
  if (items.length === 0) return [];

  const prefix = dominantMajor(items);
  const results: CheckResult[] = [];

  const byMinor = new Map<number, number[]>();
  for (const item of items) {
    const lines = byMinor.get(item.minor) ?? [];
    lines.push(item.line);
    byMinor.set(item.minor, lines);
  }

  // Dobel: nomor yang sama dipakai lebih dari sekali.
  for (const [minor, lines] of byMinor) {
    if (lines.length < 2) continue;
    results.push({
      id,
      level,
      message: `Nomor ${label} ${prefix}.${minor} dobel: muncul ${lines.length}× (baris ${lines.join(', ')}) di ${path}.`,
      path,
      line: lines[1],
    });
  }

  // Lompat: nomor yang seharusnya ada tetapi tidak ada.
  const highest = Math.max(...byMinor.keys());
  for (let minor = 1; minor <= highest; minor += 1) {
    if (byMinor.has(minor)) continue;
    const next = items.find((item) => item.minor > minor);
    results.push({
      id,
      level,
      message: `Nomor ${label} ${prefix}.${minor} hilang — urutan ${label} melompat${
        next ? ` ke ${prefix}.${next.minor}` : ''
      } (${path} baris ${next?.line ?? '-'}).`,
      path,
      line: next?.line,
    });
  }

  // Turun: nomor lebih kecil muncul setelah nomor lebih besar.
  let previous = 0;
  for (const item of items) {
    if (item.minor < previous) {
      results.push({
        id,
        level,
        message: `Nomor ${label} ${item.number} muncul setelah ${label} ${prefix}.${previous} — nomor harus urut naik (${path} baris ${item.line}).`,
        path,
        line: item.line,
      });
    }
    previous = item.minor;
  }

  return results;
}

/** 4 & 5. Caption tabel/gambar per bab. */
function checkCaptionNumbers(chapters: Chapter[], kind: 'table' | 'figure'): CheckResult[] {
  const isTable = kind === 'table';
  const pattern = isTable ? TABLE_CAPTION : FIGURE_CAPTION;
  const results: CheckResult[] = [];

  for (const chapter of chapters) {
    results.push(
      ...checkSequence({
        id: isTable ? 'numbering.table-gap' : 'numbering.figure-gap',
        level: 'error',
        label: isTable ? 'Tabel' : 'Gambar',
        path: chapter.path,
        items: scanCaptions(chapter.content, pattern),
      }),
    );
  }

  return results;
}

/** 6. Heading `## X.Y` per bab. */
function checkHeadingNumbers(chapters: Chapter[]): CheckResult[] {
  const results: CheckResult[] = [];
  for (const chapter of chapters) {
    results.push(
      ...checkSequence({
        id: 'numbering.heading-gap',
        level: 'warn',
        label: 'heading',
        path: chapter.path,
        items: headingNumbers(chapter.content),
      }),
    );
  }
  return results;
}

/** 7. Jumlah responden harus satu angka di Bab III dan Bab IV. */
function checkSampleSize(chapters: Chapter[]): CheckResult[] {
  const values = new Map<number, { path: string; line: number }>();

  for (const chapter of chapters) {
    const number = chapterNumber(chapter.path, chapter.content);
    const inScope =
      number === 3 || number === 4 || /(?:^|[^a-z])(?:bab|chapter)[\s_-]*[34]\b/i.test(chapter.path);
    if (!inScope) continue;

    eachLine(chapter.content, (line, lineNumber) => {
      const found: number[] = [];
      for (const match of line.matchAll(SAMPLE_N)) found.push(Number(match[1]));
      for (const match of line.matchAll(RESPONDENT_COUNT)) found.push(Number(match[1]));
      for (const value of found) {
        if (value <= 0 || values.has(value)) continue;
        values.set(value, { path: chapter.path, line: lineNumber });
      }
    });
  }

  if (values.size < 2) return [];

  const detail = [...values]
    .map(([value, at]) => `${value} (${at.path} baris ${at.line})`)
    .join(', ');
  const [, last] = [...values][values.size - 1];

  return [
    {
      id: 'consistency.sample-size',
      level: 'warn',
      message: `Jumlah responden tidak konsisten: ${detail}. Satu naskah harus memakai satu ukuran sampel.`,
      path: last.path,
      line: last.line,
    },
  ];
}

/**
 * Isi abstrak yang dihitung: mulai setelah heading pembuka, berhenti di baris
 * `Kata kunci`/`Keywords` atau H1 berikutnya (`# ABSTRACT`). Tanpa ini abstrak
 * dua bahasa di satu berkas dihitung dobel.
 */
function abstractBody(abstract: string): string {
  const body: string[] = [];
  for (const line of normalize(abstract).split('\n')) {
    if (/^\s{0,3}#\s+/.test(line)) {
      if (body.some((entry) => entry.trim() !== '')) break;
      continue;
    }
    if (/^\s*\*\*\s*(?:Kata\s*kunci|Keywords?)\b/i.test(line)) break;
    body.push(line);
  }
  return body.join('\n').trim();
}

/** 8. Panjang abstrak (kata). */
function checkAbstractLength(abstract: string | null, maxWords: number): CheckResult[] {
  if (!abstract) return [];
  const body = abstractBody(abstract);
  if (body === '') return [];

  const words = countWords(body);
  if (words <= maxWords) return [];

  return [
    {
      id: 'structure.abstract-length',
      level: 'warn',
      message: `Abstrak ${words} kata, melebihi batas ${maxWords} kata (dokumen/abstrak.md).`,
    },
  ];
}

/** 9. Seksi wajib Bab I, III, V — dicocokkan dari heading level ≥ 2. */
function checkRequiredSections(chapters: Chapter[]): CheckResult[] {
  const results: CheckResult[] = [];

  for (const chapter of chapters) {
    const number = chapterNumber(chapter.path, chapter.content);
    if (number === null) continue;

    const required = REQUIRED_SECTIONS[number];
    if (!required) continue;

    // H1 = judul bab ("BAB V KESIMPULAN DAN SARAN"), bukan seksi — kalau ikut
    // dipindai, kewajiban Bab V lolos sendiri tanpa seksi apa pun.
    const sectionText = headings(chapter.content)
      .filter((heading) => heading.level >= 2)
      .map((heading) => heading.text)
      .join('\n');

    for (const section of required) {
      if (section.match.test(sectionText)) continue;
      results.push({
        id: 'structure.required-section',
        level: 'error',
        message: `Bab ${numberToRoman(number)} tidak punya seksi wajib "${section.label}" — tidak ada heading yang cocok di ${chapter.path}.`,
        path: chapter.path,
      });
    }
  }

  return results;
}

function resolveMaxWords(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return DEFAULT_ABSTRACT_MAX_WORDS;
  return Math.floor(value);
}

/**
 * Jalankan semua pemeriksaan. Urutan temuan mengikuti nomor aturan (stabil),
 * jadi dua naskah yang sama selalu menghasilkan daftar yang sama persis.
 */
export function verifyThesis(input: VerifyInput): VerifyOutput {
  const chapters: Chapter[] = input.chapters.map((chapter) => ({
    path: chapter.path,
    content: normalize(chapter.content),
  }));
  const bibKeys = [...new Set(input.bibKeys.map((key) => key.trim()).filter((key) => key !== ''))];
  const bibSet = new Set(bibKeys);

  const checks: CheckResult[] = [
    ...checkMissingKeys(chapters, bibSet),
    ...checkUncitedEntries(chapters, bibKeys),
    ...checkParagraphsWithoutSource(chapters),
    ...checkCaptionNumbers(chapters, 'table'),
    ...checkCaptionNumbers(chapters, 'figure'),
    ...checkHeadingNumbers(chapters),
    ...checkSampleSize(chapters),
    ...checkAbstractLength(input.abstract ?? null, resolveMaxWords(input.abstractMaxWords)),
    ...checkRequiredSections(chapters),
  ];

  return {
    checks,
    summary: {
      error: checks.filter((check) => check.level === 'error').length,
      warn: checks.filter((check) => check.level === 'warn').length,
    },
  };
}
