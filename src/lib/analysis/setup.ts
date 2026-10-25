import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { isRealInside } from '@/lib/export/paths';
import { runPython } from '@/lib/analysis/runner';

/**
 * Penyiapan dependensi Python untuk `scripts/uji-statistik.py`.
 *
 * Runner analisis memakai `<project>/.venv/bin/python` kalau ada. Project baru
 * belum punya venv, sehingga analisis pertama gagal dengan
 * "No module named 'pandas'". Modul ini menyediakan tiga operasi yang dipakai
 * route `analysis/setup`:
 *
 * - `dependencyStatus` — cek venv + coba import paket (sekali jalan, 20 dtk).
 * - `setupDependencies` — buat venv & pasang `requirements.txt` app, streaming log.
 * - `removeVenv` — reset dengan menghapus `.venv` project.
 *
 * Semua tulisan tetap di dalam folder project: venv di `<project>/.venv`,
 * cache pip dimatikan, dan TMPDIR diarahkan ke `.venv/.tmp` supaya berkas
 * sementara pip tidak berceceran di luar project.
 */

export const REQUIRED_PACKAGES = ['pandas', 'scipy', 'statsmodels'] as const;
export const PROBE_TIMEOUT_MS = 20_000; // sekali import; pandas+scipy bisa lambat di disk dingin
export const SETUP_TIMEOUT_MS = 10 * 60 * 1000; // total venv + upgrade pip + install
export const VENV_DIR = '.venv';

export type DependencyStatus = {
  ready: boolean;
  /** Path absolut `.venv/bin/python`, null kalau venv belum ada. */
  python: string | null;
  venv: boolean;
  /** Paket yang gagal di-import; null = belum bisa dipastikan (venv/probe gagal). */
  packages: string[] | null;
};

export type SetupResult = { exit: number; ready: boolean; seconds: number };

/**
 * Cek per modul, BUKAN asumsi dari isi requirements.txt: paket yang terpasang
 * sebagian (atau rusak karena ABI numpy) tetap dilaporkan dari kegagalan import.
 */
const PROBE_SCRIPT = `
import importlib
import json

missing = []
for name in ${JSON.stringify(REQUIRED_PACKAGES)}:
    try:
        importlib.import_module(name)
    except ImportError:
        missing.append(name)
    except Exception:
        # Modul ada tapi gagal dimuat (pustaka native hilang, ABI tidak cocok).
        # Skrip analisis akan gagal juga, jadi tetap dihitung belum siap.
        missing.append(name)
print(json.dumps({"missing": missing}))
`;

export function venvDir(root: string): string {
  return path.join(root, VENV_DIR);
}

export function venvPythonPath(root: string): string {
  return path.join(venvDir(root), 'bin', 'python');
}

/** Status dependensi project; dipakai GET route dan juga preflight POST. */
export async function dependencyStatus(root: string): Promise<DependencyStatus> {
  const python = venvPythonPath(root);
  if (!(await isExecutableFile(python))) {
    return { ready: false, python: null, venv: false, packages: null };
  }

  const probe = await runPython(python, ['-c', PROBE_SCRIPT], root, PROBE_TIMEOUT_MS);
  const parsed = parseJsonObject(probe.stdout.trim());
  const missing =
    parsed && Array.isArray(parsed.missing)
      ? parsed.missing.filter((name): name is string => typeof name === 'string')
      : null;

  // Interpreter rusak / probe timeout: jangan mengarang daftar paket hilang.
  if (probe.timedOut || probe.code !== 0 || missing === null) {
    return { ready: false, python, venv: true, packages: null };
  }

  return { ready: missing.length === 0, python, venv: true, packages: missing };
}

/**
 * Siapkan venv + dependensi, streaming stdout/stderr apa adanya lewat `send`.
 * Idempoten: kalau semua paket sudah bisa di-import, tidak ada yang dipasang
 * ulang dan hasilnya `{ exit: 0, ready: true, seconds: 0 }`.
 */
export async function setupDependencies(
  root: string,
  appRoot: string,
  send: (chunk: string) => void,
): Promise<SetupResult> {
  const startedAt = Date.now();
  const elapsed = () => Math.round((Date.now() - startedAt) / 100) / 10;

  const before = await dependencyStatus(root);
  if (before.ready) {
    send('Dependensi analisis sudah siap — tidak ada paket yang dipasang ulang.\n');
    return { exit: 0, ready: true, seconds: 0 };
  }

  const requirements = path.join(appRoot, 'requirements.txt');
  const hasRequirements = await fsp
    .stat(requirements)
    .then((stat) => stat.isFile())
    .catch(() => false);
  if (!hasRequirements) {
    send(`\nERROR: requirements.txt tidak ditemukan di folder aplikasi (${requirements}).\n`);
    return { exit: 1, ready: false, seconds: elapsed() };
  }

  const venv = venvDir(root);
  // `.venv` berupa symlink ke luar project = menulis di luar project. Tolak.
  if (!(await venvStaysInsideProject(root))) {
    send('\nERROR: .venv di project ini mengarah ke luar folder project — penyiapan dibatalkan.\n');
    return { exit: 1, ready: false, seconds: elapsed() };
  }

  const deadline = startedAt + SETUP_TIMEOUT_MS;
  const env = pythonEnv(venv);

  if (!before.venv) {
    // TMPDIR dibuat dulu supaya `python3 -m venv` (dan pip di dalamnya) tidak
    // menulis berkas sementara ke luar folder project.
    const tmpReady = await fsp
      .mkdir(path.join(venv, '.tmp'), { recursive: true })
      .then(() => true)
      .catch(() => false);
    if (!tmpReady) {
      send(`\nERROR: folder project tidak bisa ditulisi (${venv}).\n`);
      return { exit: 1, ready: false, seconds: elapsed() };
    }

    send(`Membuat virtual environment: python3 -m venv ${venv}\n\n`);
    const made = await streamCommand('python3', ['-m', 'venv', venv], root, env, deadline, send);
    if (made !== 0) {
      send(
        `\nERROR: gagal membuat virtual environment (exit ${made}). ` +
          'Pastikan python3 dan modul venv tersedia di sistem.\n',
      );
      return { exit: made, ready: false, seconds: elapsed() };
    }
    if (!(await isExecutableFile(venvPythonPath(root)))) {
      send('\nERROR: .venv/bin/python tidak terbentuk setelah venv dibuat.\n');
      return { exit: 1, ready: false, seconds: elapsed() };
    }
  }

  // Beberapa venv minim tidak menyertakan skrip `pip`; `python -m pip` setara.
  const pip = path.join(venv, 'bin', 'pip');
  const viaPython = !(await isExecutableFile(pip));
  const pipCommand = viaPython ? venvPythonPath(root) : pip;
  const pipPrefix = viaPython ? ['-m', 'pip'] : [];

  send('Memperbarui pip...\n\n');
  const upgraded = await streamCommand(
    pipCommand,
    [...pipPrefix, 'install', '--upgrade', 'pip'],
    root,
    env,
    deadline,
    send,
  );
  if (upgraded !== 0) {
    send(`\nERROR: gagal memperbarui pip (exit ${upgraded}).\n`);
    return { exit: upgraded, ready: false, seconds: elapsed() };
  }

  send(`Memasang dependensi dari ${requirements}...\n\n`);
  const installed = await streamCommand(
    pipCommand,
    [...pipPrefix, 'install', '-r', requirements],
    root,
    env,
    deadline,
    send,
  );
  if (installed !== 0) {
    send(`\nERROR: pemasangan dependensi gagal (exit ${installed}).\n`);
    return { exit: installed, ready: false, seconds: elapsed() };
  }

  const after = await dependencyStatus(root);
  if (!after.ready) {
    const missing = after.packages?.length ? after.packages.join(', ') : 'tidak terdeteksi';
    send(`\nERROR: paket masih belum bisa dipakai setelah pemasangan: ${missing}.\n`);
    return { exit: 1, ready: false, seconds: elapsed() };
  }

  send('\nDependensi analisis siap dipakai.\n');
  return { exit: 0, ready: true, seconds: elapsed() };
}

/** Hapus `.venv` project. `false` = memang belum ada. */
export async function removeVenv(root: string): Promise<boolean> {
  const venv = venvDir(root);
  const stat = await fsp.lstat(venv).catch(() => null);
  if (!stat) return false;
  if (stat.isSymbolicLink()) {
    // Hapus tautannya saja; isi target di luar project bukan milik kita.
    await fsp.unlink(venv);
    return true;
  }
  await fsp.rm(venv, { recursive: true, force: true, maxRetries: 3 });
  return true;
}

// ── util internal ────────────────────────────────────────────────────────────

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function isExecutableFile(file: string): Promise<boolean> {
  try {
    await fsp.access(file, fs.constants.X_OK);
    const stat = await fsp.stat(file);
    return stat.isFile();
  } catch {
    return false;
  }
}

/** `.venv` boleh belum ada; kalau ada dan berupa symlink, targetnya harus di project. */
async function venvStaysInsideProject(root: string): Promise<boolean> {
  const venv = venvDir(root);
  const stat = await fsp.lstat(venv).catch(() => null);
  if (!stat) return true;
  if (!stat.isSymbolicLink()) return true;
  return isRealInside(root, venv);
}

function pythonEnv(venv: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // Log muncul baris demi baris, bukan setumpuk di akhir.
    PYTHONUNBUFFERED: '1',
    PYTHONIOENCODING: 'utf-8',
    PIP_NO_INPUT: '1',
    PIP_DISABLE_PIP_VERSION_CHECK: '1',
    // Tanpa cache: tidak ada tulisan ke ~/.cache/pip. TMPDIR di dalam .venv
    // membuat berkas build sementara ikut terhapus saat DELETE.
    PIP_NO_CACHE_DIR: '1',
    TMPDIR: path.join(venv, '.tmp'),
  };
}

/**
 * Jalankan satu perintah sambil meneruskan stdout+stderr ke `send`.
 * Proses dibuat dalam process group sendiri supaya timeout juga mematikan
 * anak-anaknya (pip memanggil build backend sebagai subprocess).
 */
function streamCommand(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  deadline: number,
  send: (chunk: string) => void,
): Promise<number> {
  return new Promise((resolve) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      send('\nWaktu penyiapan melewati batas 10 menit — proses dihentikan.\n');
      resolve(124);
      return;
    }

    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } catch (error) {
      send(`\nGagal menjalankan ${command}: ${messageOf(error)}\n`);
      resolve(127);
      return;
    }

    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      send('\nWaktu penyiapan melewati batas 10 menit — proses dihentikan.\n');
      stopProcessTree(child);
    }, remaining);

    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(timedOut ? 124 : code);
    };

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => send(chunk));
    child.stderr?.on('data', (chunk: string) => send(chunk));

    child.on('error', (error) => {
      // ENOENT (python3 tidak ada) / izin ditolak: jangan biarkan UI menggantung.
      send(`\nGagal menjalankan ${command}: ${messageOf(error)}\n`);
      finish(127);
    });
    child.on('close', (code) => finish(code ?? 1));
  });
}

function stopProcessTree(child: ChildProcess): void {
  const signal = (name: NodeJS.Signals) => {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, name);
      else child.kill(name);
    } catch {
      // Proses sudah selesai — tidak ada yang perlu dimatikan.
    }
  };
  signal('SIGTERM');
  setTimeout(() => signal('SIGKILL'), 3000).unref();
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
