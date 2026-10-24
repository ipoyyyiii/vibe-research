import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { isRealInside, resolveInside, toProjectPath } from '@/lib/export/paths';

/**
 * Eksekutor skrip `scripts/uji-statistik.py` di folder project.
 *
 * Semua path (data, laporan, folder gambar) dikunci di dalam folder project
 * lewat helper `resolveInside`/`isRealInside` — argumen CLI relatif juga
 * dijalankan dengan cwd = folder project, jadi skrip tidak pernah bisa menulis
 * laporan ke luar workspace user.
 */

export type AnalysisPreset = 'instrument' | 'regression';

export type AnalysisInput = {
  /** Path data relatif project (mis. `data/respon.csv`). */
  dataPath: string;
  preset: AnalysisPreset;
  /** Kolom target regresi (wajib untuk preset `regression`). */
  y?: string;
  /** Kolom prediktor regresi (wajib minimal satu untuk `regression`). */
  x?: string[];
  /** Butir instrumen; kosong → dideteksi dari header P1..Pn. */
  items?: string[];
  group?: string;
  alpha?: number;
  dpi?: number;
  /** Override laporan; default `hasil/analisis-<stamp>.md`. */
  out?: string;
  /** Override folder gambar; default `gambar`. */
  figuresDir?: string;
  /**
   * Path absolut file data — diisi `runAnalysis` supaya deteksi header butir
   * bisa membaca file nyata tanpa menebak cwd.
   */
  dataAbsPath?: string;
};

export type AnalysisResult = {
  exit: number;
  /** Path laporan relatif project; kosong kalau proses gagal/tidak menulis apa pun. */
  out: string;
  seconds: number;
  /** Gabungan stdout+stderr (apa adanya) untuk ditampilkan ulang. */
  log: string;
};

export const ANALYSIS_TIMEOUT_MS = 10 * 60 * 1000; // 10 menit: regresi + ratusan PNG
const HEADER_BYTES = 64 * 1024; // butir P1..Pn selalu di baris pertama; tidak perlu baca seluruh file
const SCRIPTS_DIR = 'scripts';
const SCRIPT_NAME = 'uji-statistik.py';
const SUPPORTED_DATA = new Set(['.csv', '.tsv', '.txt', '.xlsx', '.xlsm']);

/** Kesalahan yang pesannya layak ditampilkan ke user (path ilegal, kolom kurang, skrip hilang). */
export class AnalysisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnalysisError';
  }
}

/**
 * Python project kalau ada; `.venv` lebih dipilih karena di situ pandas/scipy
 * dipasang (`requirements.txt`), sementara `python3` sistem bisa saja kosong.
 */
export async function resolvePython(folder: string): Promise<string> {
  const venv = path.join(folder, '.venv', 'bin', 'python');
  const ok = await fsp
    .access(venv, fs.constants.X_OK)
    .then(() => fsp.stat(venv))
    .then((stat) => stat.isFile())
    .catch(() => false);
  return ok ? venv : 'python3';
}

/** Nama file laporan default: `hasil/analisis-YYYYMMDD-HHmmss.md` (urut kronologis). */
export function analysisOutPath(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `hasil/analisis-${stamp}.md`;
}

/**
 * Cari kolom butir `P1..Pn` untuk preset instrumen.
 * CSV dibaca header-nya langsung; Excel lewat pandas (`nrows=0`) karena format
 * zip+sharedStrings tidak bisa dibaca sinkron tanpa dependency baru.
 */
export async function detectItemColumns(folder: string, dataAbsPath: string): Promise<string[]> {
  const ext = path.extname(dataAbsPath).toLowerCase();
  if (ext === '.xlsx' || ext === '.xlsm') {
    const python = await resolvePython(folder);
    const items = await detectItemsExcel(python, dataAbsPath, folder);
    if (items.length < 2) {
      throw new AnalysisError(
        `Kolom butir P1..Pn tidak ditemukan di ${path.basename(dataAbsPath)}. Pilih butir manual.`,
      );
    }
    return items;
  }
  return detectItems(dataAbsPath);
}

/**
 * Susun argumen CLI. Sengaja dibatasi pada flag preset supaya user tidak bisa
 * menyelipkan argumen lain (mis. `--no-figures`) lewat nama kolom.
 */
export function buildAnalysisArgs(input: AnalysisInput): string[] {
  const args = ['--data', input.dataPath];

  if (input.preset === 'instrument') {
    // Butir kosong = user belum memilih; mayoritas kuesioner memakai P1..Pn,
    // jadi deteksi header lebih ramah daripada memaksa pilih satu per satu.
    let items = cleanColumns(input.items ?? [], 'butir');
    if (items.length === 0) {
      const source = input.dataAbsPath ?? input.dataPath;
      items = detectItems(source);
    }
    if (items.length < 2) {
      throw new AnalysisError('Preset instrumen butuh minimal 2 butir (mis. P1,P2,P3).');
    }
    args.push('--items', items.join(','));
  } else {
    const y = cleanColumn(input.y, 'target (y)');
    if (!y) throw new AnalysisError('Preset regresi butuh kolom target (y).');
    const xs = cleanColumns(input.x ?? [], 'prediktor (x)');
    if (xs.length === 0) throw new AnalysisError('Preset regresi butuh minimal satu prediktor (x).');
    args.push('--y', y, '--x', xs.join(','));
  }

  const group = cleanColumn(input.group, 'grup');
  if (group) args.push('--group', group);

  if (input.alpha !== undefined) {
    if (!Number.isFinite(input.alpha) || input.alpha <= 0 || input.alpha >= 1) {
      throw new AnalysisError('Alpha harus di antara 0 dan 1 (mis. 0.05).');
    }
    args.push('--alpha', String(input.alpha));
  }

  args.push('--out', input.out?.trim() || analysisOutPath());
  args.push('--figures-dir', input.figuresDir?.trim() || 'gambar');

  if (input.dpi !== undefined) {
    if (!Number.isInteger(input.dpi) || input.dpi <= 0) {
      throw new AnalysisError('DPI harus bilangan bulat positif (mis. 150).');
    }
    args.push('--dpi', String(input.dpi));
  }

  return args;
}

export type RunAnalysisOptions = { timeoutMs?: number };

/**
 * Jalankan skrip statistik project. Output dikirim per chunk ke `onChunk`
 * (dipakai route untuk streaming) dan tetap dikumpulkan di `log`.
 * Validasi path/argumen terjadi SEBELUM spawn, jadi path ilegal tidak pernah
 * sampai jadi proses.
 */
export async function runAnalysis(
  folder: string,
  input: AnalysisInput,
  onChunk: (chunk: string) => void,
  options: RunAnalysisOptions = {},
): Promise<AnalysisResult> {
  const root = await realFolder(folder);

  const dataAbs = await inputFile(root, input.dataPath, 'File data');
  const ext = path.extname(dataAbs).toLowerCase();
  if (ext === '.xls') {
    throw new AnalysisError('Format .xls lama tidak didukung. Simpan ulang sebagai .xlsx atau CSV.');
  }
  if (!SUPPORTED_DATA.has(ext)) {
    throw new AnalysisError(
      `Tipe file data tidak didukung (${ext || 'tanpa ekstensi'}). Pakai CSV atau XLSX.`,
    );
  }

  const outRel = input.out?.trim() || analysisOutPath();
  const outAbs = await outputPath(root, outRel, 'Laporan', 'file');
  if (path.extname(outAbs).toLowerCase() !== '.md') {
    throw new AnalysisError('Laporan analisis harus berekstensi .md.');
  }

  const figuresRel = input.figuresDir?.trim() || 'gambar';
  const figuresAbs = await outputPath(root, figuresRel, 'Folder gambar', 'dir');

  const script = await resolveScript(root);
  const python = await resolvePython(root);
  // Panel analisis tidak mengirim `items` (pilihan butir cuma ditampilkan),
  // jadi deteksi P1..Pn dikerjakan di sini — termasuk untuk file Excel.
  const items =
    input.preset === 'instrument' && (input.items?.length ?? 0) === 0
      ? await detectItemColumns(root, dataAbs)
      : input.items;
  const args = buildAnalysisArgs({
    ...input,
    items,
    dataPath: toProjectPath(root, dataAbs),
    dataAbsPath: dataAbs,
    out: toProjectPath(root, outAbs),
    // Yang dikirim ke skrip = path hasil validasi, bukan string mentah user
    // (mis. `/etc` bisa lolos validasi sebagai `<project>/etc`).
    figuresDir: toProjectPath(root, figuresAbs),
  });

  const startedAt = Date.now();
  const run = await execScript(
    python,
    [script, ...args],
    root,
    options.timeoutMs ?? ANALYSIS_TIMEOUT_MS,
    onChunk,
  );
  const seconds = Math.round((Date.now() - startedAt) / 100) / 10;

  // `out` hanya dikembalikan kalau filenya benar-benar ada — UI tidak boleh
  // menawarkan membuka laporan yang gagal ditulis.
  const wrote =
    run.exit === 0 && (await fsp.stat(outAbs).then((stat) => stat.isFile()).catch(() => false));

  return {
    exit: run.exit,
    out: wrote ? toProjectPath(root, outAbs) : '',
    seconds,
    log: run.log,
  };
}

// ── util internal ────────────────────────────────────────────────────────────

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function realFolder(folder: string): Promise<string> {
  const real = await fsp.realpath(folder).catch(() => null);
  if (!real) throw new AnalysisError('Folder project tidak ditemukan di disk.');
  const stat = await fsp.stat(real).catch(() => null);
  if (!stat?.isDirectory()) throw new AnalysisError('Folder project tidak ditemukan di disk.');
  return real;
}

/** File yang wajib ada, harus file biasa, dan realpath-nya tetap di dalam project. */
async function inputFile(root: string, rel: string, label: string): Promise<string> {
  const clean = rel.trim();
  if (!clean) throw new AnalysisError(`${label} wajib diisi.`);
  const abs = resolveInside(root, clean);
  if (!abs) throw new AnalysisError(`Path ${label.toLowerCase()} di luar folder project: ${rel}`);
  const stat = await fsp.stat(abs).catch(() => null);
  if (!stat?.isFile()) throw new AnalysisError(`${label} tidak ditemukan: ${rel}`);
  // resolveInside cuma memeriksa teks path; symlink bisa menunjuk keluar project.
  if (!(await isRealInside(root, abs))) {
    throw new AnalysisError(`Path ${label.toLowerCase()} mengarah ke luar folder project: ${rel}`);
  }
  return abs;
}

/**
 * Path keluaran (laporan/folder gambar) yang boleh belum ada. Ancestor terdekat
 * yang sudah ada diverifikasi realpath-nya supaya symlink tidak dipakai kabur.
 */
async function outputPath(
  root: string,
  rel: string,
  label: string,
  kind: 'file' | 'dir',
): Promise<string> {
  const clean = rel.trim();
  if (!clean) throw new AnalysisError(`${label} wajib diisi.`);
  const abs = resolveInside(root, clean);
  if (!abs || abs === root) {
    throw new AnalysisError(`Path ${label.toLowerCase()} di luar folder project: ${rel}`);
  }

  const existing = await fsp.lstat(abs).catch(() => null);
  if (existing) {
    if (kind === 'file' && !existing.isFile()) {
      throw new AnalysisError(`${label} harus berupa file: ${rel}`);
    }
    if (kind === 'dir' && !existing.isDirectory()) {
      throw new AnalysisError(`${label} harus berupa folder: ${rel}`);
    }
    if (!(await isRealInside(root, abs))) {
      throw new AnalysisError(`Path ${label.toLowerCase()} mengarah ke luar folder project: ${rel}`);
    }
    return abs;
  }

  let probe = abs;
  while (probe !== root && !(await fsp.lstat(probe).then(() => true).catch(() => false))) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  if (!(await isRealInside(root, probe))) {
    throw new AnalysisError(`Path ${label.toLowerCase()} mengarah ke luar folder project: ${rel}`);
  }
  return abs;
}

async function resolveScript(root: string): Promise<string> {
  const inProject = path.join(root, SCRIPTS_DIR, SCRIPT_NAME);
  const installed = await fsp.stat(inProject).then((stat) => stat.isFile()).catch(() => false);
  if (installed) return inProject;

  // Project yang belum pernah memasang skrip tetap bisa dianalisis memakai
  // template bawaan app — tanpa menulis file baru ke folder user.
  const template = path.join(process.cwd(), 'assets', 'templates', SCRIPT_NAME);
  const available = await fsp.stat(template).then((stat) => stat.isFile()).catch(() => false);
  if (available) return template;

  throw new AnalysisError(
    'Skrip scripts/uji-statistik.py belum ada di project ini. Pasang dulu lewat panel Data.',
  );
}

function cleanColumn(raw: string | undefined, label: string): string | null {
  const name = (raw ?? '').trim();
  if (!name) return null;
  if (name.length > 120) throw new AnalysisError(`Nama kolom ${label} terlalu panjang.`);
  // Argumen dikirim sebagai array (tanpa shell), tapi nama berawalan `-` tetap
  // bisa dibaca argparse sebagai flag, dan koma memecah daftar kolom.
  if (name.includes(',')) {
    throw new AnalysisError(`Nama kolom ${label} "${name}" mengandung koma — tidak didukung.`);
  }
  if (name.startsWith('-')) {
    throw new AnalysisError(`Nama kolom ${label} "${name}" diawali tanda minus — tidak didukung.`);
  }
  return name;
}

function cleanColumns(raw: string[], label: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of raw) {
    const name = cleanColumn(value, label);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

function splitLine(line: string, delimiter: string): string[] {
  const fields: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quoted) {
      if (char === '"') {
        if (line[i + 1] === '"') {
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
    if (char === '"') quoted = true;
    else if (char === delimiter) {
      fields.push(field);
      field = '';
    } else field += char;
  }
  fields.push(field);
  return fields.map((value) => value.trim());
}

function detectDelimiter(line: string): string {
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

function readFirstLine(file: string): string {
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(HEADER_BYTES);
    const read = fs.readSync(fd, buffer, 0, HEADER_BYTES, 0);
    if (read <= 0) return '';
    const text = buffer.subarray(0, read).toString('utf8').replace(/^\uFEFF/, '');
    const newline = text.search(/\r?\n/);
    return newline >= 0 ? text.slice(0, newline) : text;
  } finally {
    fs.closeSync(fd);
  }
}

/** Cari kolom `P1..Pn` di header. Hanya format teks (CSV/TSV) yang bisa dibaca sinkron. */
function detectItems(file: string): string[] {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.xlsx' || ext === '.xlsm' || ext === '.xls') {
    throw new AnalysisError(
      'Deteksi otomatis butir P1..Pn hanya untuk data CSV. Untuk file Excel, pilih butir dari daftar kolom.',
    );
  }
  let header: string;
  try {
    header = readFirstLine(file);
  } catch (error) {
    throw new AnalysisError(`Gagal membaca header data untuk deteksi butir: ${errorMessage(error)}`);
  }
  const items = splitLine(header, detectDelimiter(header))
    .filter((name) => /^p\d+$/i.test(name))
    .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  if (items.length < 2) {
    throw new AnalysisError(
      `Kolom butir P1..Pn tidak ditemukan di header ${path.basename(file)}. Pilih butir manual.`,
    );
  }
  return items;
}

type ScriptRun = { exit: number; log: string };

const EXCEL_HEADER_SCRIPT = `
import json
import sys

try:
    import pandas as pd
except Exception as exc:
    print(json.dumps({"error": "pandas belum terpasang (%s)" % exc}))
    raise SystemExit(3)

try:
    df = pd.read_excel(sys.argv[1], nrows=0)
except Exception as exc:
    print(json.dumps({"error": "gagal membaca Excel: %s" % exc}))
    raise SystemExit(4)

items = []
for column in df.columns:
    name = str(column).strip()
    if len(name) > 1 and name[0] in "Pp" and name[1:].isdigit():
        items.append(name)
items.sort(key=lambda name: int(name[1:]))
print(json.dumps({"items": items}))
`;

async function detectItemsExcel(python: string, file: string, cwd: string): Promise<string[]> {
  const run = await runPython(python, ['-c', EXCEL_HEADER_SCRIPT, file], cwd);
  const parsed = parseJsonObject(run.stdout.trim());
  if (parsed && typeof parsed.error === 'string') {
    throw new AnalysisError(
      `Deteksi butir dari Excel gagal: ${parsed.error}. Pilih butir manual atau konversi ke CSV.`,
    );
  }
  if (run.code !== 0 || !parsed || !Array.isArray(parsed.items)) {
    const detail = run.stderr.trim().split('\n').slice(-2).join(' ').slice(0, 200);
    const suffix = run.timedOut ? ' (melebihi batas waktu)' : '';
    throw new AnalysisError(
      `Gagal membaca kolom Excel${suffix}${detail ? `: ${detail}` : ''}. ` +
        'Pilih butir manual atau konversi ke CSV.',
    );
  }
  return parsed.items.map(String);
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  if (!text.startsWith('{')) return null;
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export type PythonRun = { code: number; stdout: string; stderr: string; timedOut: boolean };

/** Python sekali jalan (deteksi header Excel) — output kecil, tanpa streaming. */
export function runPython(
  python: string,
  args: string[],
  cwd: string,
  timeoutMs = 60_000,
): Promise<PythonRun> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    let child;
    try {
      child = spawn(python, args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      });
    } catch (error) {
      resolve({ code: 127, stdout: '', stderr: errorMessage(error), timedOut: false });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: timedOut ? 124 : code, stdout, stderr, timedOut });
    };

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      stderr += error.message;
      finish(127);
    });
    child.on('close', (code) => finish(code ?? 1));
  });
}

function execScript(
  python: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  onChunk: (chunk: string) => void,
): Promise<ScriptRun> {
  return new Promise((resolve) => {
    const pieces: string[] = [];
    let settled = false;
    let timedOut = false;

    const push = (text: string) => {
      if (!text) return;
      pieces.push(text);
      onChunk(text);
    };

    let child;
    try {
      child = spawn(python, args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        // Tanpa unbuffered, Python menahan output sampai proses selesai dan
        // stream di UI tampak kosong sampai akhir.
        env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
      });
    } catch (error) {
      push(`\nGagal menjalankan Python (${python}): ${errorMessage(error)}\n`);
      resolve({ exit: 1, log: pieces.join('') });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      push(`\nAnalisis melewati batas ${Math.round(timeoutMs / 60000)} menit — proses dihentikan.\n`);
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!settled) child.kill('SIGKILL');
      }, 3000).unref();
    }, timeoutMs);

    const finish = (exit: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exit: timedOut ? 124 : exit, log: pieces.join('') });
    };

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => push(chunk));
    child.stderr?.on('data', (chunk: string) => push(chunk));

    child.on('error', (error) => {
      // `python3` tidak ada di PATH / venv rusak: jangan biarkan UI menunggu.
      push(`\nGagal menjalankan Python (${python}): ${error.message}\n`);
      finish(1);
    });
    child.on('close', (code) => finish(code ?? 1));
  });
}
