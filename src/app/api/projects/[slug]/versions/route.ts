import { NextResponse } from 'next/server';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { projects } from '@/lib/db/schema';
import { WorkspaceError } from '@/lib/workspace/files';
import {
  deleteSnapshot,
  listAllSnapshots,
  listSnapshots,
  readSnapshot,
  saveSnapshot,
  snapshotCurrent,
} from '@/lib/versions/store';

export const dynamic = 'force-dynamic';

const reasonSchema = z.enum(['edit', 'agent', 'analysis', 'restore', 'reject', 'manual', 'word']);

const postSchema = z.object({
  path: z.string().min(1).max(500),
  reason: reasonSchema.default('manual'),
  /** Isi bab yang disimpan — kalau kosong, isi bab di disk yang dipakai. */
  content: z.string().max(14 * 1024 * 1024).optional(),
});

async function resolveProjectFolder(slug: string): Promise<string | null> {
  const rows = await db.select().from(projects).where(eq(projects.slug, slug)).limit(1);
  return rows[0]?.folderPath ?? null;
}

/**
 * Riwayat versi bab — store-nya file di `<project>/.riwayat/`.
 * GET    ?path=<bab>            → daftar snapshot bab itu
 * GET    ?path=<bab>&file=<snap> → isi snapshot (preview/diff)
 * GET    (tanpa path)           → semua snapshot (semua bab)
 * POST   { path, reason, content? } → simpan snapshot baru
 * DELETE ?path=<bab>&file=<snap> → hapus snapshot
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  try {
    const { slug } = await params;
    const folder = await resolveProjectFolder(slug);
    if (!folder) return NextResponse.json({ error: 'Project tidak ditemukan' }, { status: 404 });

    const url = new URL(request.url);
    const relative = url.searchParams.get('path');
    const file = url.searchParams.get('file');

    try {
      if (!relative) {
        return NextResponse.json({ snapshots: await listAllSnapshots(folder) });
      }
      if (file) {
        const content = await readSnapshot(folder, relative, file);
        return NextResponse.json({ content });
      }
      return NextResponse.json({ snapshots: await listSnapshots(folder, relative) });
    } catch (error) {
      return workspaceError(error, 'Gagal membaca riwayat versi');
    }
  } catch (error) {
    console.error('[api/versions] GET gagal:', error);
    return NextResponse.json({ error: 'Gagal membaca riwayat versi' }, { status: 500 });
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  try {
    const { slug } = await params;
    const folder = await resolveProjectFolder(slug);
    if (!folder) return NextResponse.json({ error: 'Project tidak ditemukan' }, { status: 404 });

    const parsed = postSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Data tidak valid', details: parsed.error.issues },
        { status: 400 },
      );
    }

    try {
      const snapshot =
        parsed.data.content !== undefined
          ? await saveSnapshot(folder, parsed.data.path, parsed.data.content, parsed.data.reason)
          : await snapshotCurrent(folder, parsed.data.path, parsed.data.reason);
      if (!snapshot) {
        return NextResponse.json(
          { error: 'Isi bab kosong atau tidak ada — tak ada yang bisa disimpan.' },
          { status: 400 },
        );
      }
      return NextResponse.json({ snapshot }, { status: 201 });
    } catch (error) {
      return workspaceError(error, 'Gagal menyimpan versi');
    }
  } catch (error) {
    console.error('[api/versions] POST gagal:', error);
    return NextResponse.json({ error: 'Gagal menyimpan versi' }, { status: 500 });
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

    const url = new URL(request.url);
    const relative = url.searchParams.get('path') ?? '';
    const file = url.searchParams.get('file') ?? '';
    if (!relative || !file) {
      return NextResponse.json({ error: 'path dan file wajib diisi' }, { status: 400 });
    }

    try {
      await deleteSnapshot(folder, relative, file);
      return NextResponse.json({ ok: true });
    } catch (error) {
      return workspaceError(error, 'Gagal menghapus versi');
    }
  } catch (error) {
    console.error('[api/versions] DELETE gagal:', error);
    return NextResponse.json({ error: 'Gagal menghapus versi' }, { status: 500 });
  }
}

function workspaceError(error: unknown, fallback: string): NextResponse {
  if (error instanceof WorkspaceError) {
    const messages: Record<string, string> = {
      INVALID_PATH: 'Path tidak valid',
      PATH_OUT_OF_PROJECT: 'File di luar folder project',
      FILE_NOT_FOUND: 'Versi tidak ditemukan',
      FILE_TOO_BIG: 'File terlalu besar',
      UNSUPPORTED_TYPE: 'Hanya bab .md yang punya riwayat versi',
    };
    return NextResponse.json(
      { error: messages[error.code] ?? fallback, code: error.code },
      { status: 400 },
    );
  }
  console.error('[api/versions] error:', error);
  return NextResponse.json({ error: fallback }, { status: 500 });
}
