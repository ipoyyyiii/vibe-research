/**
 * Impor CSV respons Google Forms → matriks siap statistik.
 *
 * Ekspor Forms itu "manusiawi": header berupa teks pertanyaan panjang, jawaban
 * Likert masih berupa teks ("Sangat setuju"), dan sering ada baris kedua
 * berisi tipe pertanyaan. SPSS/R/Python butuh nama kolom pendek (P1..Pn) dan
 * angka, jadi semua penyesuaian itu dikerjakan di sini — murni string tanpa
 * I/O supaya bisa dites langsung lewat node tanpa server.
 */

export type FormsColumn = {
  original: string;
  name: string;
  kind: 'identity' | 'item' | 'ignored';
  values: string[];
  numeric: boolean;
};

/** Contoh warning dibatasi supaya panel impor tidak kebanjiran pesan. */
const MAX_WARNINGS = 5;
/** Nama kolom final menjadi header CSV → jaga tetap pendek. */
const MAX_NAME_LENGTH = 30;
/** Sel baris tipe pertanyaan selalu pendek; teks panjang berarti data. */
const MAX_TYPE_CELL = 60;

/** Label tipe pertanyaan yang lazim muncul di baris kedua ekspor Forms. */
const QUESTION_TYPE =
  /^(?:pilih\s+(?:satu|beberapa|salah satu|satu atau lebih)|pilihan ganda|multiple choice|checkboxes|kotak centang|kisi\s+(?:pilihan ganda|kotak centang)|grid|short answer|short text|jawaban singkat|teks singkat|paragraph|paragraf|teks panjang|linear scale|skala(?:\s+linear)?(?:\s*\d+\s*[-–]\s*\d+)?|likert(?:\s*\d+\s*[-–]\s*\d+)?|dropdown|unggah file|file upload|tanggal|date|waktu|time|rating|penilaian)\b/i;

/**
 * Kolom metadata (timestamp/email) di baris tipe biasanya cuma mengulang
 * labelnya, bukan berisi jawaban responden. Isi literal "Nama"/"Email" saja
 * tidak cukup untuk menyimpulkan baris tipe — harus ada label tipe pertanyaan.
 */
const META_LABEL = /^(?:timestamp|stempel waktu|waktu(?:\s+pengisian)?|nama(?:\s+lengkap)?|e-?mail|alamat email|id|no|nomor)$/i;

/** Timestamp/ISO date: penanda baris tipe versi lama, sekaligus data yang sah. */
const TIMESTAMP_LIKE =
  /^(?:timestamp|stempel waktu|waktu kirim|\d{4}-\d{2}-\d{2}(?:[t ]\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:z|[+-]\d{2}:?\d{2})?)?|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}(?:[ ,]+\d{1,2}[.:]\d{2}(?::\d{2})?)?)$/i;

/** Kata kunci kolom identitas — nama kolomnya dipertahankan, bukan jadi Pn. */
const IDENTITY_HINTS: RegExp[] = [
  /timestamp/,
  /\bwaktu\b/,
  /\bnama\b/,
  /e-?mail/,
  /\bkelas\b/,
  /jenis\s*kelamin/,
  /\bgender\b/,
  /\busia\b/,
  /\bumur\b/,
  /\bprodi\b/,
  /program\s*studi/,
  /\bangkatan\b/,
  /\bnim\b/,
  /\bnip\b/,
  /\balamat\b/,
  /\b(?:no|nomor)\s*(?:hp|telepon|telp|wa)\b/,
  /\bwhatsapp\b/,
];

/** Label Likert (sudah dinormalisasi) → skor 1..5. */
const LIKERT_TEXT: Record<string, number> = {
  'sangat tidak setuju': 1,
  sts: 1,
  'strongly disagree': 1,
  'tidak setuju': 2,
  ts: 2,
  disagree: 2,
  netral: 3,
  'netral ragu': 3,
  cukup: 3,
  'cukup setuju': 3,
  cs: 3,
  ragu: 3,
  'ragu ragu': 3,
  neutral: 3,
  undecided: 3,
  setuju: 4,
  s: 4,
  agree: 4,
  'sangat setuju': 5,
  ss: 5,
  'strongly agree': 5,
};

/* ------------------------------- parser CSV ------------------------------- */

/**
 * Pilih pemisah dari baris pertama: Forms locale Indonesia memakai ";" karena
 * koma dipakai sebagai desimal. Hitungan di dalam tanda kutip diabaikan supaya
 * jawaban bebas yang mengandung koma tidak salah memilih pemisah.
 */
function detectDelimiter(text: string): string {
  let commas = 0;
  let semicolons = 0;
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"') {
      if (inQuotes && text[i + 1] === '"') {
        i += 1; // escape "" di dalam kutip
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }
    if (inQuotes) continue;
    if (char === ',') commas += 1;
    else if (char === ';') semicolons += 1;
    else if (char === '\n' && commas + semicolons > 0) break;
  }

  return semicolons > commas ? ';' : ',';
}

/**
 * Parser CSV RFC 4180 minimal: kutip ganda, "" sebagai escape, pemisah dan
 * newline di dalam kutip, serta CRLF. Baris yang seluruhnya kosong dibuang
 * supaya tidak jadi baris data palsu di hasil konversi.
 */
function parseCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else if (char === '\r') {
        // Newline di dalam kutip diseragamkan jadi "\n" supaya jawaban yang
        // diekspor dari Windows dan Linux tidak beda byte.
        field += '\n';
        if (text[i + 1] === '\n') i += 1;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"' && field === '') {
      inQuotes = true;
      continue;
    }
    if (char === delimiter) {
      row.push(field);
      field = '';
      continue;
    }
    if (char === '\r' || char === '\n') {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }
    field += char;
  }

  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ''));
}

/* --------------------------- heuristik kolom ------------------------------ */

/**
 * Baris tipe Forms = semua sel non-kosongnya penanda tipe (label pertanyaan,
 * timestamp/ISO date, atau label metadata pendek). Wajib ada minimal satu
 * label tipe pertanyaan: baris yang isinya cuma timestamp adalah data asli,
 * bukan baris tipe, jadi tidak boleh ikut terbuang.
 */
/**
 * Tipe jawaban teks bebas ("Teks singkat", "Paragraf", …). Kolom seperti ini
 * sering berisi saran/kritik: harus tetap disimpan, tapi TIDAK boleh menjadi
 * P1..Pn karena isinya bukan skala dan akan merusak uji validitas.
 */
const FREE_TEXT_TYPE =
  /^(?:teks singkat|short answer|short text|jawaban singkat|paragraf|paragraph|teks panjang|long answer|tanggal|date|waktu|time|unggah file|file upload|url|link)$/i;

function isFreeTextCell(cell: string): boolean {
  const cleaned = cell.replace(/[:(\s]+$/g, '').replace(/^\s+/, '').trim();
  return FREE_TEXT_TYPE.test(cleaned);
}

function isFormsTypeRow(row: string[]): boolean {
  const cells = row.map((cell) => cell.trim()).filter((cell) => cell !== '');
  if (cells.length === 0) return false;

  let questionLabels = 0;
  for (const cell of cells) {
    if (cell.length > MAX_TYPE_CELL) return false;
    const cleaned = cell.replace(/[:\s]+$/g, '').replace(/\s+/g, ' ').trim();
    if (QUESTION_TYPE.test(cleaned)) {
      questionLabels += 1;
      continue;
    }
    // Kolom identitas (Nama, Kelas, Jenis Kelamin, …) di baris tipe biasanya
    // cuma mengulang labelnya, jadi ikut diterima sebagai sel baris tipe.
    if (TIMESTAMP_LIKE.test(cleaned) || META_LABEL.test(cleaned) || isIdentityColumn(cleaned)) continue;
    return false;
  }

  return questionLabels > 0;
}

/** "Jenis Kelamin (L/P)" → "jenis_kelamin_l_p" (batas 30 karakter). */
function slugify(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, MAX_NAME_LENGTH)
    .replace(/_+$/g, '');
}

/** Slug kosong / tabrakan nama diberi fallback + sufiks _2, _3, … */
function uniqueName(base: string, used: Set<string>): string {
  const root = base.slice(0, MAX_NAME_LENGTH).replace(/_+$/g, '') || 'kolom';
  let name = root;
  let counter = 1;
  while (used.has(name)) {
    counter += 1;
    const suffix = `_${counter}`;
    const stem = root.slice(0, MAX_NAME_LENGTH - suffix.length).replace(/_+$/g, '') || 'kolom';
    name = `${stem}${suffix}`;
  }
  used.add(name);
  return name;
}

/** Identitas = metadata responden; cukup dicek dari teks header aslinya. */
function isIdentityColumn(original: string): boolean {
  const text = original.toLowerCase().replace(/[^a-z0-9@]+/g, ' ');
  if (text.includes('@')) return true;
  return IDENTITY_HINTS.some((pattern) => pattern.test(text));
}

/** "Sangat Setuju (SS)" → "ss"; tanda baca & singkatan dalam kurung dibuang. */
function normalizeAnswer(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Satu jawaban → skor 1..5; null berarti bukan skala yang dikenal. */
function likertScaleValue(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  // Angka apa adanya (1..5). Di luar itu (mis. "6") bukan skala valid.
  const direct = Number(trimmed.replace(',', '.'));
  if (Number.isFinite(direct)) {
    return Number.isInteger(direct) && direct >= 1 && direct <= 5 ? direct : null;
  }

  // "4. Setuju" / "5) SS" — nomor urut di depan jawaban dibuang dulu.
  const withoutOrdinal = trimmed.replace(/^[1-5]\s*[.)-]\s*/, '');
  return LIKERT_TEXT[normalizeAnswer(withoutOrdinal)] ?? null;
}

/**
 * Konversi satu kolom item. Sel kosong dianggap "tidak dijawab" (bukan nilai
 * salah), sedangkan nilai tak dikenal dibiarkan apa adanya + dicatat sebagai
 * warning — data peneliti tidak boleh hilang diam-diam.
 */
function convertLikertColumn(
  values: string[],
  name: string,
  warnings: string[],
): { values: string[]; numeric: boolean } {
  let numeric = true;
  let hasAnswer = false;

  const converted = values.map((raw) => {
    if (raw === '') return '';
    hasAnswer = true;
    const answer = likertScaleValue(raw);
    if (answer === null) {
      numeric = false;
      if (warnings.length < MAX_WARNINGS) {
        warnings.push(
          `${name}: nilai "${raw}" tidak dikenali sebagai skala Likert 1-5 dan dibiarkan apa adanya.`,
        );
      }
      return raw;
    }
    return String(answer);
  });

  return { values: converted, numeric: numeric && hasAnswer };
}

/* --------------------------------- API ------------------------------------ */

/**
 * CSV Forms → kolom final + baris data (tanpa header dan tanpa baris tipe).
 *
 * Catatan: `columns[].values` dan `rows` selalu sinkron — konversi Likert
 * ditulis balik ke `rows` supaya `toFormsCsv(parseFormsCsv(x))` konsisten dan
 * data yang diekspor ke skrip statistik sudah numerik.
 */
export function parseFormsCsv(text: string): {
  columns: FormsColumn[];
  rows: string[][];
  warnings: string[];
} {
  const clean = text.replace(/^\uFEFF/, '');
  if (clean.trim() === '') return { columns: [], rows: [], warnings: [] };

  const rawRows = parseCsv(clean, detectDelimiter(clean));
  if (rawRows.length === 0) return { columns: [], rows: [], warnings: [] };

  const header = rawRows[0].map((cell) => cell.trim());
  let body = rawRows.slice(1);

  // Baris 2 hanya dibuang kalau benar-benar penanda tipe Forms. Kalau bukan,
  // baris itu jawaban responden pertama dan harus tetap jadi data.
  const typeRow = body.length > 0 && isFormsTypeRow(body[0]) ? body[0] : null;
  if (typeRow) body = body.slice(1);

  const width = header.length;
  const rows = body.map((row) =>
    Array.from({ length: width }, (_, index) => (row[index] ?? '').trim()),
  );

  const warnings: string[] = [];
  const usedNames = new Set<string>();
  const columns: FormsColumn[] = [];
  let itemCount = 0;

  header.forEach((original, index) => {
    const values = rows.map((row) => row[index]);

    if (isIdentityColumn(original)) {
      columns.push({
        original,
        name: uniqueName(slugify(original), usedNames),
        kind: 'identity',
        values,
        numeric: false,
      });
      return;
    }

    if (values.every((value) => value === '')) {
      columns.push({
        original,
        name: uniqueName(slugify(original), usedNames),
        kind: 'ignored',
        values,
        numeric: false,
      });
      return;
    }

    // Tipe di baris kedua Forms menentukan: kolom teks bebas disimpan apa
    // adanya (nama aslinya), bukan dinomori P1..Pn.
    if (typeRow && isFreeTextCell(typeRow[index] ?? '')) {
      columns.push({
        original,
        name: uniqueName(slugify(original), usedNames),
        kind: 'identity',
        values,
        numeric: false,
      });
      return;
    }

    itemCount += 1;
    const name = `P${itemCount}`;
    const converted = convertLikertColumn(values, name, warnings);
    converted.values.forEach((value, rowIndex) => {
      rows[rowIndex][index] = value;
    });
    columns.push({
      original,
      name,
      kind: 'item',
      values: converted.values,
      numeric: converted.numeric,
    });
  });

  return { columns, rows, warnings };
}

/** Satu sel CSV: kutip hanya kalau mengandung pemisah, kutip, newline, atau spasi tepi. */
function csvCell(value: string): string {
  if (!/[",\r\n]/.test(value) && !/^\s|\s$/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Kolom final + baris → CSV (pemisah koma, header = nama kolom final).
 * Kolom `ignored` dibuang karena isinya kosong dan hanya mengotori header.
 */
export function toFormsCsv(columns: FormsColumn[], rows: string[][]): string {
  const kept = columns
    .map((column, index) => ({ column, index }))
    .filter((entry) => entry.column.kind !== 'ignored');

  const lines = [kept.map((entry) => csvCell(entry.column.name)).join(',')];
  for (const row of rows) {
    lines.push(kept.map((entry) => csvCell(row[entry.index] ?? '')).join(','));
  }
  return lines.join('\n');
}
