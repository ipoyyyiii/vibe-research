import { NextResponse } from 'next/server';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { projects } from '@/lib/db/schema';
import {
  customCslInfo,
  deleteCustomCsl,
  validateCsl,
  writeCustomCsl,
} from '@/lib/thesis/csl';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function resolveProjectFolder(slug: string): Promise<string | null> {
  const rows = await db.select().from(projects).where(eq(projects.slug, slug)).limit(1);
  return rows[0]?.folderPath ?? null;
}

/** Status gaya sitasi kustom project ini. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const folder = await resolveProjectFolder(slug);
  if (!folder) return NextResponse.json({ error: 'Project tidak ditemukan' }, { status: 404 });
  return NextResponse.json({ csl: await customCslInfo(folder) });
}

const postSchema = z.object({
  name: z.string().max(200).optional(),
  content: z.string().min(1).max(600_000),
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
    return NextResponse.json({ error: 'Isi file CSL tidak valid' }, { status: 400 });
  }
  const problem = validateCsl(parsed.data.content);
  if (problem) return NextResponse.json({ error: problem }, { status: 400 });

  try {
    const csl = await writeCustomCsl(folder, parsed.data.content);
    return NextResponse.json({ ok: true, csl });
  } catch (error) {
    console.error('[api/projects/csl] POST gagal:', error);
    const message = error instanceof Error ? error.message : 'Gagal menyimpan file CSL';
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
  await deleteCustomCsl(folder);
  return NextResponse.json({ ok: true, csl: { exists: false, title: null, bytes: 0 } });
}
