import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { projects } from '@/lib/db/schema';
import { readTextFile } from '@/lib/workspace/files';
import { workspaceError } from '@/lib/workspace/api-error';
import { listSnapshots, readSnapshot } from '@/lib/versions/store';
import { buildProvenance } from '@/lib/provenance/report';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Batas riwayat yang dibaca: cukup untuk atribusi, tanpa membuka ratusan file. */
const MAX_SNAPSHOTS = 40;

async function resolveProjectFolder(slug: string): Promise<string | null> {
  const rows = await db.select().from(projects).where(eq(projects.slug, slug)).limit(1);
  return rows[0]?.folderPath ?? null;
}

/**
 * GET ?path=dokumen/bab1.md → asal-usul tiap paragraf (manusia / agen / diedit).
 * Snapshot menyimpan isi SEBELUM perubahan, jadi urutannya dibalik dulu.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  try {
    const { slug } = await params;
    const folder = await resolveProjectFolder(slug);
    if (!folder) return NextResponse.json({ error: 'Project tidak ditemukan' }, { status: 404 });

    const path = new URL(request.url).searchParams.get('path') ?? '';
    if (!/^dokumen\/[^/]+\.md$/i.test(path)) {
      return NextResponse.json({ error: 'Path bab tidak valid' }, { status: 400 });
    }

    const current = (await readTextFile(folder, path)).content;
    const metas = (await listSnapshots(folder, path)).slice(0, MAX_SNAPSHOTS).reverse();

    const history: Array<{ content: string; reason: string; savedAt: string }> = [];
    for (const meta of metas) {
      const content = await readSnapshot(folder, path, meta.file).catch(() => null);
      if (content === null) continue;
      history.push({ content, reason: meta.reason, savedAt: meta.savedAt });
    }

    const { blocks, summary } = buildProvenance({ history, current });
    return NextResponse.json({
      path,
      blocks,
      summary,
      snapshots: metas.length,
      truncated: (await listSnapshots(folder, path)).length > MAX_SNAPSHOTS,
    });
  } catch (error) {
    return workspaceError(error, 'Gagal menghitung sumber tulisan');
  }
}
