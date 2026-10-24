import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { EMPTY_WORKBOOK_BASE64 } from '@/lib/gridcraft/empty-workbook';

// ── Guard & resolusi file dalam folder project ───────────────────────────────
// Base project FOLDER sudah di-verifikasi realpath saat attach (paths.ts),
// jadi jangkar di sini = direktori nyata di disk.

export type TreeEntry = {
  path: string; // relatif dari root project, selalu pakai '/'
  name: string;
  type: 'dir' | 'file';
  size: number;
};

const SKIP_DIRS = new Set([
  '.opencode',
  'node_modules',
  '.git',
  '.venv',
  'venv',
  'site-packages',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.ipynb_checkpoints',
  '.next',
  '.turbo',
  '.cache',
  '.riwayat',
  '.vibe-research',
]);
const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2 MB batas file teks editor
const TEXT_EXTENSIONS = new Set(['.md', '.txt', '.json', '.jsonc', '.csv', '.ris', '.bib', '.tex']);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
/** Tipe yang buka di GridCraft (tab Excel). */
export const SPREADSHEET_EXTENSIONS = new Set(['.xlsx', '.csv', '.tsv']);
export const MAX_UPLOAD_SIZE = 10 * 1024 * 1024; // 10 MB

export function isImageFile(name: string): boolean {
  return IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase());
}

export function isSpreadsheetFile(name: string): boolean {
  return SPREADSHEET_EXTENSIONS.has(path.extname(name).toLowerCase());
}

const FILE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.pdf': 'application/pdf',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json',
  '.jsonc': 'application/json',
  '.csv': 'text/csv; charset=utf-8',
  '.tsv': 'text/tab-separated-values; charset=utf-8',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.bib': 'text/plain; charset=utf-8',
  '.ris': 'text/plain; charset=utf-8',
  '.tex': 'text/plain; charset=utf-8',
};

export function guessMime(name: string): string {
  return FILE_MIME[path.extname(name).toLowerCase()] ?? 'application/octet-stream';
}

/** Simpan gambar upload ke gambar/ — nama di-sanitize + timestamp biar unik. */
export async function saveUploadedImage(
  baseReal: string,
  fileName: string,
  data: Buffer,
): Promise<{ path: string; name: string }> {
  if (!isImageFile(fileName)) throw new WorkspaceError('UNSUPPORTED_TYPE');
  if (data.byteLength > MAX_UPLOAD_SIZE) throw new WorkspaceError('FILE_TOO_BIG');

  const targetDir = path.join(baseReal, 'gambar');
  fs.mkdirSync(targetDir, { recursive: true });
  const dirReal = fs.realpathSync(targetDir);
  if (dirReal !== baseReal && !dirReal.startsWith(baseReal + path.sep)) {
    throw new WorkspaceError('PATH_OUT_OF_PROJECT');
  }

  const safe = path
    .basename(fileName)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+/, '');
  const name = `${Date.now()}-${safe || 'gambar.png'}`;
  await fsp.writeFile(path.join(targetDir, name), data);
  return { path: `gambar/${name}`, name };
}

/** Baca file (binary ok — utk gambar/PDF viewer). Guard realpath + dalam project. */
export async function readBinaryFile(baseReal: string, relative: string): Promise<{ buffer: Buffer; mime: string }> {
  const abs = safeResolve(baseReal, relative);
  let real: string;
  try {
    real = fs.realpathSync(abs);
  } catch {
    throw new WorkspaceError('FILE_NOT_FOUND');
  }
  if (real !== baseReal && !real.startsWith(baseReal + path.sep)) {
    throw new WorkspaceError('PATH_OUT_OF_PROJECT');
  }
  const stat = await fsp.stat(real);
  if (!stat.isFile()) throw new WorkspaceError('FILE_NOT_FOUND');
  if (stat.size > MAX_UPLOAD_SIZE) throw new WorkspaceError('FILE_TOO_BIG');
  const buffer = await fsp.readFile(real);
  return { buffer, mime: guessMime(real) };
}

export class WorkspaceError extends Error {
  constructor(public code: string) {
    super(code);
    this.name = 'WorkspaceError';
  }
}

/** Resolve path relatif; lempar INVALID_PATH kalau mau keluar dari root (anti traversal). */
export function safeResolve(baseReal: string, relative: string): string {
  if (typeof relative !== 'string' || relative.length === 0 || relative.includes('\0')) {
    throw new WorkspaceError('INVALID_PATH');
  }
  const resolved = path.resolve(baseReal, relative);
  if (resolved !== baseReal && !resolved.startsWith(baseReal + path.sep)) {
    throw new WorkspaceError('PATH_OUT_OF_PROJECT');
  }
  return resolved;
}

function toRel(baseReal: string, abs: string): string {
  return path.relative(baseReal, abs).split(path.sep).join('/');
}

/** Daftar semua file/folder (flat, sudah diurut: dir dulu, lalu nama). */
export async function listTree(baseReal: string): Promise<TreeEntry[]> {
  const entries: TreeEntry[] = [];
  const stack: string[] = [baseReal];

  while (stack.length > 0) {
    const dirAbs = stack.pop()!;
    const dirents = await fsp.readdir(dirAbs, { withFileTypes: true });
    for (const dirent of dirents) {
      if (SKIP_DIRS.has(dirent.name)) continue;
      const abs = path.join(dirAbs, dirent.name);
      const rel = toRel(baseReal, abs);
      if (dirent.isDirectory()) {
        entries.push({ path: rel, name: dirent.name, type: 'dir', size: 0 });
        stack.push(abs);
      } else if (dirent.isFile()) {
        const size = (await fsp.stat(abs)).size;
        entries.push({ path: rel, name: dirent.name, type: 'file', size });
      }
    }
  }

  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.path.localeCompare(b.path);
  });
  return entries;
}

/** Baca file teks (untuk editor). */
export async function readTextFile(baseReal: string, relative: string): Promise<{ content: string; mtime: number }> {
  const abs = safeResolve(baseReal, relative);
  let real = abs;
  try {
    real = fs.realpathSync(abs);
  } catch {
    throw new WorkspaceError('FILE_NOT_FOUND');
  }
  // Anti symlink-escape: file nyata harus tetap di dalam root project.
  if (real !== baseReal && !real.startsWith(baseReal + path.sep)) {
    throw new WorkspaceError('PATH_OUT_OF_PROJECT');
  }
  const stat = await fsp.stat(real);
  if (!stat.isFile()) throw new WorkspaceError('FILE_NOT_FOUND');
  if (stat.size > MAX_FILE_SIZE) throw new WorkspaceError('FILE_TOO_BIG');
  if (!TEXT_EXTENSIONS.has(path.extname(real).toLowerCase())) throw new WorkspaceError('UNSUPPORTED_TYPE');
  const content = await fsp.readFile(real, 'utf8');
  return { content, mtime: stat.mtimeMs };
}

/** Tulis file teks (autosave dari editor / manual ⌘S). */
export async function writeTextFile(baseReal: string, relative: string, content: string): Promise<{ mtime: number }> {  const abs = safeResolve(baseReal, relative);
  if (path.extname(abs).toLowerCase() !== '.md') throw new WorkspaceError('UNSUPPORTED_TYPE');

  const parent = path.dirname(abs);
  fs.mkdirSync(parent, { recursive: true });
  // Verifikasi folder induk gak ngelewat symlink ke luar project.
  const parentReal = fs.realpathSync(parent);
  if (parentReal !== baseReal && !parentReal.startsWith(baseReal + path.sep)) {
    throw new WorkspaceError('PATH_OUT_OF_PROJECT');
  }

  try {
    const targetStat = fs.lstatSync(abs);
    if (targetStat.isSymbolicLink()) throw new WorkspaceError('PATH_OUT_OF_PROJECT');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  await fsp.writeFile(abs, content, 'utf8');
  return { mtime: (await fsp.stat(abs)).mtimeMs };
}

/** Tulis file binary spreadsheet (xlsx/csv/tsv) dari tab Excel — payload base64. */
export async function writeBinaryFile(
  baseReal: string,
  relative: string,
  base64: string,
): Promise<{ mtime: number }> {
  const abs = safeResolve(baseReal, relative);
  if (!SPREADSHEET_EXTENSIONS.has(path.extname(abs).toLowerCase())) {
    throw new WorkspaceError('UNSUPPORTED_TYPE');
  }
  const buffer = Buffer.from(base64, 'base64');
  if (buffer.byteLength > MAX_UPLOAD_SIZE) throw new WorkspaceError('FILE_TOO_BIG');

  const parent = path.dirname(abs);
  fs.mkdirSync(parent, { recursive: true });
  const parentReal = fs.realpathSync(parent);
  if (parentReal !== baseReal && !parentReal.startsWith(baseReal + path.sep)) {
    throw new WorkspaceError('PATH_OUT_OF_PROJECT');
  }

  try {
    const targetStat = fs.lstatSync(abs);
    if (targetStat.isSymbolicLink()) throw new WorkspaceError('PATH_OUT_OF_PROJECT');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  await fsp.writeFile(abs, buffer);
  return { mtime: (await fsp.stat(abs)).mtimeMs };
}

/** Hapus file (bukan folder). */
export async function deleteFile(baseReal: string, relative: string): Promise<void> {
  const abs = safeResolve(baseReal, relative);
  let real: string;
  try {
    real = fs.realpathSync(abs);
  } catch {
    throw new WorkspaceError('FILE_NOT_FOUND');
  }
  if (real !== baseReal && !real.startsWith(baseReal + path.sep)) {
    throw new WorkspaceError('PATH_OUT_OF_PROJECT');
  }
  if (await fsp.stat(real).then((s) => s.isDirectory())) {
    throw new WorkspaceError('INVALID_PATH');
  }
  await fsp.rm(real);
}

/** Slug nama file untuk dokumen baru. */
function slugifyName(title: string): string {
  const slug = title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
  return slug || 'dokumen';
}

/** Buat dokumen baru di dokumen/ — nama file PERSIS dari judul user (slugify,
 * TANPA prefix `babN-`) dan heading `# {title}` apa adanya; file existing tidak disentuh. */
export async function createDocument(baseReal: string, title: string): Promise<{ path: string; name: string }> {
  const dokumenDir = path.join(baseReal, 'dokumen');
  fs.mkdirSync(dokumenDir, { recursive: true });
  const parentReal = fs.realpathSync(dokumenDir);
  if (parentReal !== baseReal && !parentReal.startsWith(baseReal + path.sep)) {
    throw new WorkspaceError('PATH_OUT_OF_PROJECT');
  }

  const fileName = `${slugifyName(title)}.md`;
  const relPath = `dokumen/${fileName}`;
  // Kalau nama bentrok → suffix nomor (meski nomor bab beda)
  let finalRel = relPath;
  if (fs.existsSync(path.join(baseReal, finalRel))) {
    finalRel = relPath.replace(/\.md$/, `-2.md`);
  }

  const content = [
    `# ${title}`,
    '',
    'Mulai tulis di sini…',
    '',
  ].join('\n');
  await fsp.writeFile(path.join(baseReal, finalRel), content, 'utf8');

  return { path: finalRel, name: fileName };
}

/** Buat spreadsheet baru di dokumen/ dari template workbook kosong;
 * file existing gak disentuh — nama bentrok dapat suffix -2/-3 dst. */
export async function createSpreadsheet(baseReal: string, baseName = 'data'): Promise<{ path: string; name: string }> {
  const dokumenDir = path.join(baseReal, 'dokumen');
  fs.mkdirSync(dokumenDir, { recursive: true });
  const parentReal = fs.realpathSync(dokumenDir);
  if (parentReal !== baseReal && !parentReal.startsWith(baseReal + path.sep)) {
    throw new WorkspaceError('PATH_OUT_OF_PROJECT');
  }

  let n = 1;
  let finalRel = 'dokumen/data.xlsx';
  while (fs.existsSync(path.join(baseReal, finalRel))) {
    n += 1;
    finalRel = `dokumen/${baseName}-${n}.xlsx`;
  }

  const bytes = Buffer.from(EMPTY_WORKBOOK_BASE64, 'base64');
  await fsp.writeFile(path.join(baseReal, finalRel), bytes);
  return { path: finalRel, name: path.basename(finalRel) };
}

/** Nama node aman: tanpa direktori (anti traversal), karakter liar jadi '_'. */
export function sanitizeNodeName(raw: string): string {
  const base = path
    .basename(raw ?? '')
    .replace(/[^\w.\- ]/g, '_')
    .replace(/^[. _]+/, '')
    .trim();
  return base || 'file';
}

/** Bentrok di disk → suffix `-2`,`-3` sebelum ekstensi. */
export function uniqueNodeName(dir: string, name: string): string {
  const ext = path.extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  let candidate = name;
  for (let index = 2; fs.existsSync(path.join(dir, candidate)); index += 1) {
    candidate = `${stem}-${index}${ext}`;
  }
  return candidate;
}

/** Parent folder projekt valid (realpath di dalam base) → abs path. */
function resolveParentDir(baseReal: string, parentRelative: string): string {
  const rel = parentRelative === '' ? '.' : parentRelative;
  const parent = safeResolve(baseReal, rel);
  fs.mkdirSync(parent, { recursive: true });
  const parentReal = fs.realpathSync(parent);
  if (parentReal !== baseReal && !parentReal.startsWith(baseReal + path.sep)) {
    throw new WorkspaceError('PATH_OUT_OF_PROJECT');
  }
  return parent;
}

/** Folder baru di dalam parent (nesting bebas); bentrok → suffix -2/-3. */
export async function createFolder(
  baseReal: string,
  parentRelative: string,
  rawName: string,
): Promise<{ path: string; name: string }> {
  const parent = resolveParentDir(baseReal, parentRelative);
  const name = sanitizeNodeName(rawName);
  const finalName = uniqueNodeName(parent, name);
  fs.mkdirSync(path.join(parent, finalName), { recursive: true });
  const parentRel = parentRelative === '' ? '' : toRel(baseReal, parent);
  return { path: parentRel ? `${parentRel}/${finalName}` : finalName, name: finalName };
}

/** File baru format bebas: kosong (0B); .xlsx otomatis pakai template workbook,
 * biar gak jadi xlsx rusak yang gak bisa dibuka GridCraft. */
export async function createPlaceholderFile(
  baseReal: string,
  parentRelative: string,
  rawName: string,
): Promise<{ path: string; name: string }> {
  const parent = resolveParentDir(baseReal, parentRelative);
  const name = sanitizeNodeName(rawName);
  const finalName = uniqueNodeName(parent, name);
  const abs = path.join(parent, finalName);
  const data =
    path.extname(finalName).toLowerCase() === '.xlsx'
      ? Buffer.from(EMPTY_WORKBOOK_BASE64, 'base64')
      : Buffer.alloc(0);
  await fsp.writeFile(abs, data);
  const parentRel = parentRelative === '' ? '' : toRel(baseReal, parent);
  return { path: parentRel ? `${parentRel}/${finalName}` : finalName, name: finalName };
}

/** Hapus folder + seluruh isinya (rekursif). Root project ditolak —
 * safeResolve gak nerima '' (INVALID_PATH), symlink juga ditolak. */
export async function deleteFolder(baseReal: string, relative: string): Promise<void> {
  const abs = safeResolve(baseReal, relative);
  const stat = fs.lstatSync(abs);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new WorkspaceError('UNSUPPORTED_TYPE');
  }
  const real = fs.realpathSync(abs);
  if (real !== baseReal && !real.startsWith(baseReal + path.sep)) {
    throw new WorkspaceError('PATH_OUT_OF_PROJECT');
  }
  await fsp.rm(real, { recursive: true });
}
