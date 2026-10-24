import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { projects } from '@/lib/db/schema';
import { exportDefenseSlides } from '@/lib/export/slides';
import { workspaceError } from '@/lib/workspace/api-error';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST → susun slide sidang (.pptx) dari isi project yang sudah ada.
 *
 * Tidak butuh body: judul diambil dari `projects.name`, bab/tabel/gambar dibaca
 * dari folder project. Hasil ditulis ke `export/slide-sidang.pptx` dan
 * `notes` berisi peringatan bagian yang dilewati (mis. Bab 5 tidak ada).
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  try {
    const { slug } = await params;
    const rows = await db.select().from(projects).where(eq(projects.slug, slug)).limit(1);
    const project = rows[0];
    if (!project) {
      return NextResponse.json({ error: 'Project tidak ditemukan' }, { status: 404 });
    }

    const result = await exportDefenseSlides({
      folder: project.folderPath,
      title: project.name,
    });

    return NextResponse.json({
      ok: true,
      file: result.file,
      slides: result.slides,
      notes: result.notes,
    });
  } catch (error) {
    console.error('[api/projects/export/slides] POST gagal:', error);
    return workspaceError(error, 'Ekspor slide sidang gagal');
  }
}
