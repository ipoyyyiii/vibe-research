import { NextResponse } from 'next/server';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { projects } from '@/lib/db/schema';
import { deleteFile, readTextFile, writeBinaryFile, writeTextFile } from '@/lib/workspace/files';
import { workspaceError as sharedWorkspaceError } from '@/lib/workspace/api-error';
import { snapshotCurrent } from '@/lib/versions/store';

export const dynamic = 'force-dynamic';

async function resolveProjectFolder(slug: string): Promise<string | null> {
  const rows = await db.select().from(projects).where(eq(projects.slug, slug)).limit(1);
  return rows[0]?.folderPath ?? null;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  try {
    const { slug } = await params;
    const folder = await resolveProjectFolder(slug);
    if (!folder) return NextResponse.json({ error: 'Project tidak ditemukan' }, { status: 404 });

    const relative = new URL(request.url).searchParams.get('path') ?? '';
    try {
      const { content, mtime } = await readTextFile(folder, relative);
      return NextResponse.json({ content, mtime });
    } catch (error) {
      return workspaceError(error, 'Gagal membaca file');
    }
  } catch (error) {
    console.error('[api/workspace/file] GET gagal:', error);
    return NextResponse.json({ error: 'Gagal membaca file' }, { status: 500 });
  }
}

const putSchema = z.object({
  path: z.string().min(1).max(500),
  content: z.string().max(14 * 1024 * 1024),
  // 'base64' = tulis binary (xlsx/csv/tsv dari tab Excel); default = teks.
  encoding: z.enum(['text', 'base64']).optional(),
  /** Setuju mengosongkan berkas yang masih berisi. */
  allowEmpty: z.boolean().optional(),
  // Alasan snapshot versi: isi bab yang ada di disk disimpan dulu sebelum ditimpa.
  // Kosong = tanpa riwayat (mis. simpan dari tab Word).
  reason: z.enum(['edit', 'agent', 'analysis', 'restore', 'reject', 'manual']).optional(),
});

/** Simpan isi bab lama sebagai versi sebelum bab ditimpa (gagal = tak memblokir tulis). */
async function snapshotBeforeWrite(
  folder: string,
  relative: string,
  reason: 'edit' | 'agent' | 'analysis' | 'restore' | 'reject' | 'manual',
): Promise<void> {
  try {
    await snapshotCurrent(folder, relative, reason);
  } catch (error) {
    console.error('[api/workspace/file] snapshot versi gagal:', error);
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  try {
    const { slug } = await params;
    const folder = await resolveProjectFolder(slug);
    if (!folder) return NextResponse.json({ error: 'Project tidak ditemukan' }, { status: 404 });

    const parsed = putSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Data tidak valid', details: parsed.error.issues },
        { status: 400 },
      );
    }

    try {
      let mtime: number;
      if (parsed.data.encoding === 'base64') {
        mtime = (await writeBinaryFile(folder, parsed.data.path, parsed.data.content)).mtime;
      } else {
        // Guard anti-hilang: autosave dari editor sempat menimpa bab 6 KB
        // dengan 0 byte setelah Ctrl+Z, tanpa peringatan apa pun. Menulis isi
        // kosong di atas berkas yang berisi harus disengaja (allowEmpty).
        const isEmpty = parsed.data.content.trim() === '';
        if (isEmpty && !parsed.data.allowEmpty) {
          const existing = await readTextFile(folder, parsed.data.path).catch(() => null);
          if (existing && existing.content.trim() !== '') {
            return NextResponse.json(
              {
                error:
                  'Isi kosong ditolak: berkas ini masih berisi teks. Kalau memang ingin mengosongkan, hapus berkasnya atau kirim allowEmpty=true.',
              },
              { status: 409 },
            );
          }
        }
        if (parsed.data.reason) {
          await snapshotBeforeWrite(folder, parsed.data.path, parsed.data.reason);
        }
        mtime = (await writeTextFile(folder, parsed.data.path, parsed.data.content)).mtime;
      }
      return NextResponse.json({ mtime });
    } catch (error) {
      return workspaceError(error, 'Gagal menulis file');
    }
  } catch (error) {
    console.error('[api/workspace/file] PUT gagal:', error);
    return NextResponse.json({ error: 'Gagal menulis file' }, { status: 500 });
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  try {
    const { slug } = await params;
    const folder = await resolveProjectFolder(slug);
    if (!folder) return NextResponse.json({ error: 'Project tidak ditemukan' }, { status: 404 });

    const relative = new URL(request.url).searchParams.get('path') ?? '';
    await deleteFile(folder, relative);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return workspaceError(error, 'Gagal menghapus file');
  }
}

function workspaceError(error: unknown, fallback: string): NextResponse {
  const response = sharedWorkspaceError(error, fallback);
  if (response.status === 500) console.error('[api/workspace/file] error:', error);
  return response;
}
