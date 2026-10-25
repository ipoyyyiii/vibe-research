import { NextResponse } from 'next/server';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { projects } from '@/lib/db/schema';
import { coverLogoInfo, deleteCoverLogo, writeCoverLogo } from '@/lib/thesis/cover-logo';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function resolveProjectFolder(slug: string): Promise<string | null> {
  const rows = await db.select().from(projects).where(eq(projects.slug, slug)).limit(1);
  return rows[0]?.folderPath ?? null;
}

/** Status logo sampul project. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const folder = await resolveProjectFolder(slug);
  if (!folder) return NextResponse.json({ error: 'Project tidak ditemukan' }, { status: 404 });
  return NextResponse.json({ logo: await coverLogoInfo(folder) });
}

const postSchema = z.object({
  /** Isi berkas dalam base64 (tanpa prefix data URL). */
  data: z.string().min(1).max(4_000_000),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const folder = await resolveProjectFolder(slug);
  if (!folder) return NextResponse.json({ error: 'Project tidak ditemukan' }, { status: 404 });

  const parsed = postSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Data logo tidak valid' }, { status: 400 });
  }
  try {
    const logo = await writeCoverLogo(folder, parsed.data.data);
    return NextResponse.json({ ok: true, logo });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Gagal menyimpan logo';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const folder = await resolveProjectFolder(slug);
  if (!folder) return NextResponse.json({ error: 'Project tidak ditemukan' }, { status: 404 });
  await deleteCoverLogo(folder);
  return NextResponse.json({ ok: true, logo: { exists: false, path: null, ext: null, bytes: 0 } });
}
