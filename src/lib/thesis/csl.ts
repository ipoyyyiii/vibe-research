import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Gaya sitasi kustom (`.csl`) milik kampus.
 *
 * Banyak kampus punya format sendiri yang tidak sama dengan APA/IEEE bawaan
 * aplikasi. File CSL disimpan DI DALAM project supaya ikut pindah komputer dan
 * ikut backup, lalu diteruskan ke pandoc (`--csl`) saat ekspor.
 */

export const CUSTOM_CSL_DIR = '.vibe-research';
export const CUSTOM_CSL_FILE = `${CUSTOM_CSL_DIR}/style.csl`;
const MAX_CSL_BYTES = 512 * 1024;

export type CustomCslInfo = {
  exists: boolean;
  /** Judul dari `<title>` di dalam file CSL, kalau ada. */
  title: string | null;
  bytes: number;
};

export async function customCslPath(folder: string): Promise<string> {
  return path.join(folder, CUSTOM_CSL_FILE);
}

export async function readCustomCsl(folder: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(folder, CUSTOM_CSL_FILE), 'utf8');
  } catch {
    return null;
  }
}

export async function customCslInfo(folder: string): Promise<CustomCslInfo> {
  const content = await readCustomCsl(folder);
  if (content === null) return { exists: false, title: null, bytes: 0 };
  const title = /<title>([^<]{1,200})<\/title>/i.exec(content);
  return {
    exists: true,
    title: title ? title[1].trim() : null,
    bytes: Buffer.byteLength(content, 'utf8'),
  };
}

/** Pesan kesalahan, atau null kalau file terlihat seperti CSL yang sah. */
export function validateCsl(content: string): string | null {
  const text = content.trim();
  if (text === '') return 'File CSL kosong.';
  if (Buffer.byteLength(text, 'utf8') > MAX_CSL_BYTES) return 'File CSL terlalu besar (maksimal 512 KB).';
  if (!/<style\b/i.test(text)) return 'Ini bukan file CSL: tag <style> tidak ditemukan.';
  if (!/<citation\b/i.test(text)) return 'File CSL tidak punya bagian <citation>.';
  if (!/<bibliography\b/i.test(text)) return 'File CSL tidak punya bagian <bibliography>.';
  return null;
}

export async function writeCustomCsl(
  folder: string,
  content: string,
): Promise<CustomCslInfo> {
  const problem = validateCsl(content);
  if (problem) throw new Error(problem);
  const dir = path.join(folder, CUSTOM_CSL_DIR);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(folder, CUSTOM_CSL_FILE);
  const temp = `${file}.tmp`;
  await fs.writeFile(temp, content, 'utf8');
  await fs.rename(temp, file);
  return customCslInfo(folder);
}

export async function deleteCustomCsl(folder: string): Promise<void> {
  await fs.rm(path.join(folder, CUSTOM_CSL_FILE), { force: true });
}
