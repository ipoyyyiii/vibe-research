import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Target kata per bab, disimpan di dalam project (`.vibe-research/targets.json`).
 *
 * Sebelumnya target cuma ada di localStorage browser: hilang kalau ganti
 * browser/komputer dan tidak mungkin dibaca laporan progres yang dibuat di
 * server. File ini yang jadi sumber kebenaran; localStorage hanya dipakai
 * sekali untuk memindahkan target lama.
 */

export const TARGETS_DIR = '.vibe-research';
export const TARGETS_FILE = `${TARGETS_DIR}/targets.json`;
const MAX_TARGET = 1_000_000;

export type ChapterTargets = Record<string, number>;

function isChapterPath(relative: string): boolean {
  return /^dokumen\/[^/]+\.md$/i.test(relative);
}

export function sanitizeTargets(input: unknown): ChapterTargets {
  const clean: ChapterTargets = {};
  if (!input || typeof input !== 'object') return clean;
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!isChapterPath(key)) continue;
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n) || n <= 0) continue;
    clean[key] = Math.min(MAX_TARGET, Math.floor(n));
  }
  return clean;
}

export async function readTargets(folder: string): Promise<ChapterTargets> {
  try {
    const raw = await fs.readFile(path.join(folder, TARGETS_FILE), 'utf8');
    return sanitizeTargets(JSON.parse(raw));
  } catch {
    return {};
  }
}

export async function writeTargets(folder: string, targets: unknown): Promise<ChapterTargets> {
  const clean = sanitizeTargets(targets);
  const dir = path.join(folder, TARGETS_DIR);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(folder, TARGETS_FILE);
  const temp = `${file}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(clean, null, 2)}\n`, 'utf8');
  await fs.rename(temp, file);
  return clean;
}
