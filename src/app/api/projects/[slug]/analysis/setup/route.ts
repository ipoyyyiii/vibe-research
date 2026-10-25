import { NextResponse } from 'next/server';
import fsp from 'node:fs/promises';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { projects } from '@/lib/db/schema';
import { workspaceError } from '@/lib/workspace/api-error';
import {
  dependencyStatus,
  removeVenv,
  setupDependencies,
  type SetupResult,
} from '@/lib/analysis/setup';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Dependensi Python untuk panel "Jalankan analisis".
 *
 * GET    → status venv + paket (tanpa mengubah apa pun).
 * POST   → buat `.venv`, upgrade pip, pasang `requirements.txt` app; log
 *          di-stream seperti route `analysis/run`, diakhiri
 *          `__DONE__ {"exit":..,"ready":..,"seconds":..}` supaya UI bisa
 *          menandai selesai tanpa menebak dari isi log.
 * DELETE → reset dengan menghapus `.venv` project.
 *
 * Project dicari lewat tabel `projects` (slug → folderPath), sama seperti route
 * analisis lain. Semua penulisan terjadi di `<project>/.venv`; `appRoot`
 * (tempat requirements.txt) adalah cwd proses Next, bukan folder project.
 */

const bodySchema = z.strictObject({});

function doneLine(payload: SetupResult): string {
  return `\n__DONE__ ${JSON.stringify(payload)}\n`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Penyiapan dependensi gagal';
}

async function projectFolder(slug: string): Promise<string | null> {
  const rows = await db.select().from(projects).where(eq(projects.slug, slug)).limit(1);
  return rows[0]?.folderPath ?? null;
}

async function projectRoot(folder: string): Promise<string | null> {
  return fsp.realpath(folder).catch(() => null);
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  try {
    const { slug } = await params;
    const folder = await projectFolder(slug);
    if (!folder) return NextResponse.json({ error: 'Project tidak ditemukan' }, { status: 404 });

    const root = await projectRoot(folder);
    if (!root) {
      return NextResponse.json({ error: 'Folder project tidak ditemukan' }, { status: 404 });
    }

    return NextResponse.json(await dependencyStatus(root));
  } catch (error) {
    console.error('[api/projects/analysis/setup] GET gagal:', error);
    return workspaceError(error, 'Gagal memeriksa dependensi analisis');
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  try {
    const { slug } = await params;

    const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Body tidak valid', details: parsed.error.issues },
        { status: 400 },
      );
    }

    const folder = await projectFolder(slug);
    if (!folder) return NextResponse.json({ error: 'Project tidak ditemukan' }, { status: 404 });

    // Validasi folder SEBELUM stream dibuka: user masih dapat JSON 404, bukan
    // log yang putus tanpa penanda selesai.
    const root = await projectRoot(folder);
    if (!root) {
      return NextResponse.json({ error: 'Folder project tidak ditemukan' }, { status: 404 });
    }

    const appRoot = process.cwd();
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let open = true;
        const send = (text: string) => {
          if (!open || !text) return;
          try {
            controller.enqueue(encoder.encode(text));
          } catch {
            open = false; // client memutus koneksi
          }
        };

        try {
          const result = await setupDependencies(root, appRoot, send);
          send(doneLine(result));
        } catch (error) {
          console.error('[api/projects/analysis/setup] gagal:', error);
          send(`\nERROR: ${messageOf(error)}\n`);
          send(doneLine({ exit: 1, ready: false, seconds: 0 }));
        } finally {
          open = false;
          try {
            controller.close();
          } catch {
            // sudah tertutup
          }
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (error) {
    console.error('[api/projects/analysis/setup] POST gagal:', error);
    return workspaceError(error, 'Gagal menyiapkan dependensi analisis');
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  try {
    const { slug } = await params;
    const folder = await projectFolder(slug);
    if (!folder) return NextResponse.json({ error: 'Project tidak ditemukan' }, { status: 404 });

    const root = await projectRoot(folder);
    if (!root) {
      return NextResponse.json({ error: 'Folder project tidak ditemukan' }, { status: 404 });
    }

    await removeVenv(root);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[api/projects/analysis/setup] DELETE gagal:', error);
    return workspaceError(error, 'Gagal menghapus dependensi analisis');
  }
}
