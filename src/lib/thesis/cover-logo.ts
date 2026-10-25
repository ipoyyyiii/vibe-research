import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Logo kampus untuk sampul skripsi.
 *
 * Disimpan di dalam project (`.vibe-research/logo.png|jpg`) supaya ikut pindah
 * komputer dan ikut backup. Hanya PNG/JPEG: DOCX membutuhkan raster, dan SVG
 * akan gagal dirender Word tanpa fallback tambahan.
 */

export const LOGO_DIR = '.vibe-research';
const MAX_BYTES = 2 * 1024 * 1024;
const EXTENSIONS = ['png', 'jpg'] as const;
export type LogoExtension = (typeof EXTENSIONS)[number];

export type CoverLogo = {
  exists: boolean;
  /** Path relatif project, mis. `.vibe-research/logo.png`. */
  path: string | null;
  ext: LogoExtension | null;
  bytes: number;
};

const EMPTY: CoverLogo = { exists: false, path: null, ext: null, bytes: 0 };

/** Deteksi dari isi file, bukan dari nama berkas yang dikirim browser. */
function sniff(buffer: Buffer): LogoExtension | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'png';
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'jpg';
  }
  return null;
}

export async function readCoverLogo(folder: string): Promise<(CoverLogo & { buffer: Buffer }) | null> {
  for (const ext of EXTENSIONS) {
    const abs = path.join(folder, LOGO_DIR, `logo.${ext}`);
    try {
      const buffer = await fs.readFile(abs);
      return {
        exists: true,
        path: `${LOGO_DIR}/logo.${ext}`,
        ext,
        bytes: buffer.length,
        buffer,
      };
    } catch {
      // coba ekstensi berikutnya
    }
  }
  return null;
}

export async function coverLogoInfo(folder: string): Promise<CoverLogo> {
  const found = await readCoverLogo(folder);
  if (!found) return EMPTY;
  return { exists: true, path: found.path, ext: found.ext, bytes: found.bytes };
}

export async function writeCoverLogo(
  folder: string,
  base64: string,
): Promise<CoverLogo> {
  const buffer = Buffer.from(base64, 'base64');
  if (buffer.length === 0) throw new Error('File logo kosong.');
  if (buffer.length > MAX_BYTES) throw new Error('Logo terlalu besar (maksimal 2 MB).');
  const ext = sniff(buffer);
  if (!ext) throw new Error('Format logo harus PNG atau JPG.');

  const dir = path.join(folder, LOGO_DIR);
  await fs.mkdir(dir, { recursive: true });
  await deleteCoverLogo(folder);
  const abs = path.join(dir, `logo.${ext}`);
  const temp = `${abs}.tmp`;
  await fs.writeFile(temp, buffer);
  await fs.rename(temp, abs);
  return coverLogoInfo(folder);
}

export async function deleteCoverLogo(folder: string): Promise<void> {
  await Promise.all(
    EXTENSIONS.map((ext) => fs.rm(path.join(folder, LOGO_DIR, `logo.${ext}`), { force: true })),
  );
}

/** Dimensi gambar dari header PNG/JPEG — dipakai menghitung ukuran di DOCX. */
export function imageSize(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      const length = buffer.readUInt16BE(offset + 2);
      // SOF0..SOF15 (kecuali DHT/JPG/DAC) memuat dimensi.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
      }
      offset += 2 + length;
    }
  }
  return null;
}
