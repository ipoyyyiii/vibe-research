import fs from 'node:fs/promises';
import { safeResolve, WorkspaceError } from '@/lib/workspace/files';
import { EMPTY_FRONT_MATTER, normalizeFrontMatter, type FrontMatter } from './types';

export const FRONT_MATTER_FILE = 'skripsi.json';

export type FrontMatterRead = {
  frontMatter: FrontMatter;
  /** File belum ada lalu dibuat dengan nilai kosong. */
  created: boolean;
  /** File ada tapi JSON-nya tidak valid — nilai default dipakai. */
  invalid: boolean;
};

function guardFile(folder: string): string {
  return safeResolve(folder, FRONT_MATTER_FILE);
}

async function assertNoSymlink(abs: string): Promise<void> {
  const stat = await fs.lstat(abs).catch(() => null);
  if (stat?.isSymbolicLink()) throw new WorkspaceError('PATH_OUT_OF_PROJECT');
}

/** Baca skripsi.json; kalau belum ada, buat dengan field kosong. */
export async function readFrontMatter(folder: string): Promise<FrontMatterRead> {
  const abs = guardFile(folder);
  await assertNoSymlink(abs);

  const raw = await fs.readFile(abs, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });

  if (raw === null) {
    await fs.writeFile(abs, `${JSON.stringify(EMPTY_FRONT_MATTER, null, 2)}\n`, 'utf8');
    return { frontMatter: { ...EMPTY_FRONT_MATTER }, created: true, invalid: false };
  }

  try {
    return { frontMatter: normalizeFrontMatter(JSON.parse(raw)), created: false, invalid: false };
  } catch {
    return { frontMatter: { ...EMPTY_FRONT_MATTER }, created: false, invalid: true };
  }
}

/** Tulis skripsi.json (hanya field yang dikenal). */
export async function writeFrontMatter(folder: string, input: unknown): Promise<FrontMatter> {
  const abs = guardFile(folder);
  await assertNoSymlink(abs);
  const frontMatter = normalizeFrontMatter(input);
  await fs.writeFile(abs, `${JSON.stringify(frontMatter, null, 2)}\n`, 'utf8');
  return frontMatter;
}

/**
 * Label program studi untuk sampul. User sering mengisi field dengan awalan
 * "Program Studi ..." karena nama field-nya begitu, sehingga templat yang juga
 * menambahkan awalan menghasilkan "Program Studi Program Studi ...".
 */
export function programLabel(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '') return '';
  return trimmed;
}

/** True bila nilai sudah memuat kata "program studi" di awal. */
export function hasProgramPrefix(value: string): boolean {
  return /^\s*program\s+studi\b/i.test(value);
}
