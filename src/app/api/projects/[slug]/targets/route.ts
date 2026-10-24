import { NextResponse } from 'next/server';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { projects } from '@/lib/db/schema';
import { readTargets, writeTargets } from '@/lib/workspace/targets';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function resolveProjectFolder(slug: string): Promise<string | null> {
  const rows = await db.select().from(projects).where(eq(projects.slug, slug)).limit(1);
  return rows[0]?.folderPath ?? null;
}

/** Target kata per bab — dipakai tab Outline dan laporan progres. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const folder = await resolveProjectFolder(slug);
  if (!folder) return NextResponse.json({ error: 'Project tidak ditemukan' }, { status: 404 });
  return NextResponse.json({ targets: await readTargets(folder) });
}

const putSchema = z.object({
  // Nilai aneh (negatif/terlalu besar) disaring sanitizeTargets, bukan ditolak
  // seluruhnya: satu angka salah tidak boleh membatalkan semua target lain.
  targets: z.record(z.string().max(300), z.number()),
});

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const folder = await resolveProjectFolder(slug);
  if (!folder) return NextResponse.json({ error: 'Project tidak ditemukan' }, { status: 404 });

  const parsed = putSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Data target tidak valid' }, { status: 400 });
  }
  try {
    const targets = await writeTargets(folder, parsed.data.targets);
    return NextResponse.json({ ok: true, targets });
  } catch (error) {
    console.error('[api/projects/targets] PUT gagal:', error);
    return NextResponse.json({ error: 'Gagal menyimpan target kata' }, { status: 500 });
  }
}
