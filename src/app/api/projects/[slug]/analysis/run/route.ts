import { NextResponse } from 'next/server';
import fs from 'node:fs/promises';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { projects } from '@/lib/db/schema';
import { isRealInside, resolveInside } from '@/lib/export/paths';
import {
  AnalysisError,
  buildAnalysisArgs,
  detectItemColumns,
  runAnalysis,
} from '@/lib/analysis/runner';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST → jalankan `scripts/uji-statistik.py` untuk satu file data.
 *
 * Balasan berupa stream text/plain berisi log mentah (stdout+stderr skrip) —
 * analisis regresi bisa puluhan detik, jadi user melihat progresnya langsung.
 * Baris terakhir selalu `__DONE__ {"exit":..,"out":..,"seconds":..}` sebagai
 * penanda selesai (diparse UI).
 */

const bodySchema = z.object({
  dataPath: z.string().trim().min(1).max(500),
  preset: z.enum(['instrument', 'regression']),
  y: z.string().trim().min(1).max(120).optional(),
  x: z.array(z.string().trim().min(1).max(120)).max(50).optional(),
  items: z.array(z.string().trim().min(1).max(120)).max(500).optional(),
  group: z.string().trim().min(1).max(120).optional(),
  alpha: z.number().gt(0).lt(1).optional(),
  dpi: z.number().int().min(50).max(600).optional(),
});

type DonePayload = { exit: number; out: string; seconds: number };

function doneLine(payload: DonePayload): string {
  return `\n__DONE__ ${JSON.stringify(payload)}\n`;
}

function messageOf(error: unknown): string {
  if (error instanceof AnalysisError) return error.message;
  return error instanceof Error ? error.message : 'Analisis gagal dijalankan';
}

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await params;

    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Data tidak valid', details: parsed.error.issues },
        { status: 400 },
      );
    }
    const input = parsed.data;
    if (input.preset === 'regression' && (!input.y || !input.x?.length)) {
      return NextResponse.json(
        { error: 'Preset regresi butuh kolom y dan minimal satu kolom x' },
        { status: 400 },
      );
    }

    const rows = await db.select().from(projects).where(eq(projects.slug, slug)).limit(1);
    const folder = rows[0]?.folderPath;
    if (!folder) return NextResponse.json({ error: 'Project tidak ditemukan' }, { status: 404 });

    // Semua pemeriksaan dilakukan SEBELUM stream dibuka: kesalahan user masih
    // bisa dijawab JSON 400/404, bukan log yang putus di tengah jalan.
    const root = await fs.realpath(folder).catch(() => null);
    if (!root) return NextResponse.json({ error: 'Folder project tidak ditemukan' }, { status: 404 });

    const dataAbs = resolveInside(root, input.dataPath);
    if (!dataAbs) {
      return NextResponse.json({ error: 'Path data di luar folder project' }, { status: 400 });
    }
    const dataStat = await fs.stat(dataAbs).catch(() => null);
    if (!dataStat?.isFile()) {
      return NextResponse.json({ error: 'File data tidak ditemukan' }, { status: 404 });
    }
    if (!(await isRealInside(root, dataAbs))) {
      return NextResponse.json({ error: 'Path data di luar folder project' }, { status: 400 });
    }
    // Deteksi butir (CSV dibaca header, Excel lewat pandas) + validasi argumen
    // dikerjakan di preflight supaya user dapat JSON 400, bukan stream yang
    // mati di tengah jalan. Hasilnya dipakai ulang oleh runAnalysis.
    let items = input.items;
    try {
      if (input.preset === 'instrument' && (input.items?.length ?? 0) === 0) {
        items = await detectItemColumns(root, dataAbs);
      }
      buildAnalysisArgs({ ...input, items, dataAbsPath: dataAbs });
    } catch (error) {
      return NextResponse.json({ error: messageOf(error) }, { status: 400 });
    }
    const prepared = { ...input, items };

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
          const result = await runAnalysis(root, prepared, send);
          send(doneLine({ exit: result.exit, out: result.out, seconds: result.seconds }));
        } catch (error) {
          console.error('[api/projects/analysis/run] gagal:', error);
          send(`\nERROR: ${messageOf(error)}\n`);
          send(doneLine({ exit: 1, out: '', seconds: 0 }));
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
    console.error('[api/projects/analysis/run] POST gagal:', error);
    return NextResponse.json({ error: 'Gagal menjalankan analisis' }, { status: 500 });
  }
}
