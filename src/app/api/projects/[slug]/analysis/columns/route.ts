import { NextResponse } from 'next/server';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { projects } from '@/lib/db/schema';
import { isRealInside, resolveInside } from '@/lib/export/paths';
import { resolvePython, runPython } from '@/lib/analysis/runner';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET ?path=data/respon.csv → `{ columns, numeric, rows }`.
 *
 * Dipakai panel "Jalankan analisis" untuk mengisi pilihan y/x/items/grup:
 * kolom numerik saja yang masuk akal untuk uji statistik, jadi kolom teks
 * (nama responden, kode, komentar) disaring di sini, bukan di UI.
 */

const MAX_CSV_BYTES = 25 * 1024 * 1024;
const SAMPLE_ROWS = 50; // cukup untuk menebak tipe kolom tanpa membaca seluruh dataset
const NUMERIC_RE = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;

type ColumnInfo = { columns: string[]; numeric: string[]; rows: number };

/**
 * pandas dipakai HANYA kalau file Excel: membaca xlsx tanpa dependency baru
 * (jszip/xlsx) jauh lebih rawan salah, dan project sudah punya pandas di .venv.
 */
const EXCEL_SCRIPT = `
import json
import sys

path = sys.argv[1]
try:
    import pandas as pd
except Exception as exc:
    print(json.dumps({"error": "pandas belum terpasang (%s)" % exc}))
    raise SystemExit(3)

try:
    df = pd.read_excel(path)
except Exception as exc:
    print(json.dumps({"error": "gagal membaca Excel: %s" % exc}))
    raise SystemExit(4)

df.columns = [str(c).strip() for c in df.columns]
sample = df.head(50)

def numeric(series):
    series = series.dropna()
    if len(series) == 0:
        return False
    try:
        pd.to_numeric(series, errors="raise")
        return True
    except Exception:
        return False

columns = [str(c) for c in df.columns]
numeric_cols = [columns[i] for i in range(len(columns)) if numeric(sample.iloc[:, i])]
print(json.dumps({"columns": columns, "numeric": numeric_cols, "rows": int(len(df))}))
`;

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await params;
    const rel = (new URL(request.url).searchParams.get('path') ?? '').trim();
    if (!rel) {
      return NextResponse.json({ error: 'Parameter path wajib diisi' }, { status: 400 });
    }

    const rows = await db.select().from(projects).where(eq(projects.slug, slug)).limit(1);
    const folder = rows[0]?.folderPath;
    if (!folder) return NextResponse.json({ error: 'Project tidak ditemukan' }, { status: 404 });

    const root = await fsp.realpath(folder).catch(() => null);
    if (!root) return NextResponse.json({ error: 'Folder project tidak ditemukan' }, { status: 404 });

    const abs = resolveInside(root, rel);
    if (!abs) {
      return NextResponse.json({ error: 'Path di luar folder project' }, { status: 400 });
    }
    const stat = await fsp.stat(abs).catch(() => null);
    if (!stat?.isFile()) {
      return NextResponse.json({ error: 'File data tidak ditemukan' }, { status: 404 });
    }
    if (!(await isRealInside(root, abs))) {
      return NextResponse.json({ error: 'Path di luar folder project' }, { status: 400 });
    }

    const ext = path.extname(abs).toLowerCase();
    if (ext === '.csv' || ext === '.tsv' || ext === '.txt') {
      if (stat.size > MAX_CSV_BYTES) {
        return NextResponse.json(
          { error: 'File CSV terlalu besar untuk dipindai (>25 MB)' },
          { status: 400 },
        );
      }
      const text = await fsp.readFile(abs, 'utf8').catch(() => null);
      if (text === null) {
        return NextResponse.json({ error: 'Gagal membaca file CSV' }, { status: 400 });
      }
      return NextResponse.json(parseCsv(text));
    }

    if (ext === '.xlsx' || ext === '.xlsm') {
      const result = await excelColumns(root, abs);
      if (!result.ok) {
        return NextResponse.json({ error: result.error }, { status: 400 });
      }
      return NextResponse.json(result.info);
    }

    return NextResponse.json(
      { error: 'Hanya file CSV atau XLSX yang bisa dipindai kolomnya' },
      { status: 400 },
    );
  } catch (error) {
    console.error('[api/projects/analysis/columns] GET gagal:', error);
    return NextResponse.json({ error: 'Gagal membaca kolom data' }, { status: 500 });
  }
}

// ── CSV ──────────────────────────────────────────────────────────────────────

/**
 * Parser satu lintasan: dalam satu kali baca dapat header, sampel 50 baris, dan
 * jumlah baris — file kuesioner bisa puluhan ribu baris jadi tidak di-parse dua kali.
 */
function parseCsv(raw: string): ColumnInfo {
  const text = raw.replace(/^\uFEFF/, '');
  const delimiter = detectDelimiter(text);
  const decimalComma = delimiter === ';'; // ekspor Excel Indonesia: "3,75"

  let header: string[] = [];
  const sample: string[][] = [];
  let rows = 0;
  let fields: string[] = [];
  let field = '';
  let quoted = false;
  let touched = false;

  const finishRecord = () => {
    fields.push(field);
    field = '';
    const blank = !touched && fields.every((value) => value === '');
    const record = fields.map((value) => value.trim());
    fields = [];
    touched = false;
    if (blank) return; // baris kosong di akhir file bukan data
    if (header.length === 0) {
      header = record;
      return;
    }
    rows += 1;
    if (sample.length < SAMPLE_ROWS) sample.push(record);
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      // Di dalam kutip: "" = satu tanda kutip, koma/baris baru bukan pemisah.
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      touched = true;
    } else if (char === delimiter) {
      fields.push(field);
      field = '';
      touched = true;
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      finishRecord();
    } else {
      field += char;
      touched = true;
    }
  }
  if (touched || field !== '' || fields.length > 0) finishRecord();

  return { columns: header.filter(Boolean), numeric: numericColumns(header, sample, decimalComma), rows };
}

function detectDelimiter(text: string): string {
  const end = text.search(/\r?\n/);
  const line = end >= 0 ? text.slice(0, end) : text;
  const counts = new Map<string, number>([
    [',', 0],
    [';', 0],
    ['\t', 0],
  ]);
  let quoted = false;
  for (const char of line) {
    if (char === '"') {
      quoted = !quoted;
    } else if (!quoted && counts.has(char)) {
      counts.set(char, (counts.get(char) ?? 0) + 1);
    }
  }
  const [delimiter, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return count > 0 ? delimiter : ',';
}

function numericColumns(header: string[], sample: string[][], decimalComma: boolean): string[] {
  const numeric: string[] = [];
  header.forEach((name, index) => {
    if (!name.trim()) return;
    let seen = 0;
    for (const row of sample) {
      const value = (row[index] ?? '').trim();
      if (!value) continue; // sel kosong tidak membatalkan tipe kolom
      seen += 1;
      if (!NUMERIC_RE.test(normalizeNumber(value, decimalComma))) return;
    }
    if (seen > 0) numeric.push(name.trim());
  });
  return numeric;
}

function normalizeNumber(value: string, decimalComma: boolean): string {
  const compact = value.replace(/\s/g, '');
  if (decimalComma) {
    // "1.234,5" → "1234.5"
    return compact.replace(/\./g, '').replace(',', '.');
  }
  // "1,234.5" → "1234.5"; "1,5" dibiarkan supaya tidak salah dianggap angka.
  return /^[-+]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(compact) ? compact.replace(/,/g, '') : compact;
}

// ── XLSX ─────────────────────────────────────────────────────────────────────

async function excelColumns(
  folder: string,
  file: string,
): Promise<{ ok: true; info: ColumnInfo } | { ok: false; error: string }> {
  const python = await resolvePython(folder);
  // pandas dijalankan sekali saja; timeout & pembunuhan proses ada di runner.
  const run = await runPython(python, ['-c', EXCEL_SCRIPT, file], folder);

  if (run.timedOut) {
    return { ok: false, error: 'Membaca file Excel terlalu lama. Konversi ke CSV lalu coba lagi.' };
  }

  const parsed = safeJson(run.stdout.trim());
  if (parsed && typeof parsed.error === 'string') {
    const hint = /pandas|excel|openpyxl/i.test(parsed.error)
      ? ' Konversi file ke CSV agar kolomnya bisa dibaca.'
      : '';
    return { ok: false, error: `Gagal membaca Excel: ${parsed.error}.${hint}` };
  }

  if (run.code !== 0 || !parsed) {
    const detail = run.stderr.trim().split('\n').slice(-3).join(' ').slice(0, 300);
    if (/No module named 'pandas'|ModuleNotFoundError|ImportError/i.test(run.stderr)) {
      return {
        ok: false,
        error:
          'pandas belum terpasang di Python project, jadi file Excel belum bisa dipindai. ' +
          'Konversi file ke CSV (atau pasang pandas di .venv) lalu coba lagi.',
      };
    }
    const reason = detail || (run.code === 127 ? 'Python tidak ditemukan' : 'keluaran tidak dikenali');
    return { ok: false, error: `Gagal membaca Excel: ${reason}. Konversi file ke CSV lalu coba lagi.` };
  }

  const columns = Array.isArray(parsed.columns) ? parsed.columns.map(String) : [];
  const numeric = Array.isArray(parsed.numeric) ? parsed.numeric.map(String) : [];
  const rows = typeof parsed.rows === 'number' && Number.isFinite(parsed.rows) ? parsed.rows : 0;
  if (columns.length === 0) {
    return { ok: false, error: 'File Excel tidak punya kolom yang terbaca. Konversi file ke CSV.' };
  }
  return { ok: true, info: { columns, numeric, rows } };
}

function safeJson(text: string): Record<string, unknown> | null {
  if (!text.startsWith('{')) return null;
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
