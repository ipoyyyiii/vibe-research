import { NextResponse } from 'next/server';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { projects } from '@/lib/db/schema';
import { readTextFile, writeTextFile } from '@/lib/workspace/files';
import { workspaceError } from '@/lib/workspace/api-error';
import { snapshotCurrent } from '@/lib/versions/store';
import { chapterNumber, extractTables } from '@/lib/insert/markdown-tables';
import { extractFigures } from '@/lib/insert/markdown-figures';

export const dynamic = 'force-dynamic';

async function resolveProjectFolder(slug: string): Promise<string | null> {
  const rows = await db.select().from(projects).where(eq(projects.slug, slug)).limit(1);
  return rows[0]?.folderPath ?? null;
}

/**
 * Variabel fokus dari laporan analisis, dibaca dari seksi regresinya.
 * Dipakai buat menaikkan gambar yang relevan (scatter prediktor, diagnostik,
 * sebaran y) ke atas daftar — tanpa ini daftar penuh histogram butir P1..Pn.
 */
function focusVariables(report: string): { target: string | null; predictors: string[] } {
  const model = /Model:\s*`([^`]+)`\s*~\s*([^\n]+)/i.exec(report);
  if (model) {
    const predictors = [...model[2].matchAll(/`([^`]+)`/g)].map((m) => m[1].toLowerCase());
    return { target: model[1].trim().toLowerCase(), predictors };
  }
  const heading = /Regresi[^\n]*\(`([^`]+)`\)/i.exec(report);
  return { target: heading ? heading[1].trim().toLowerCase() : null, predictors: [] };
}

function figureRank(
  figure: { path: string; alt: string; caption: string },
  focus: { target: string | null; predictors: string[] },
): number {
  const haystack = `${figure.path} ${figure.alt} ${figure.caption}`.toLowerCase();
  if (haystack.includes('scatter') && focus.predictors.some((name) => haystack.includes(name))) return 0;
  if (haystack.includes('resid')) return 1;
  if (haystack.includes('boxplot')) return 2;
  if (focus.target && haystack.includes(focus.target)) return 3;
  if (focus.predictors.some((name) => haystack.includes(name))) return 4;
  return 5;
}

/**
 * Sisipkan blok di akhir seksi sebuah heading (sebelum heading berikutnya
 * dengan level sama/lebih tinggi). Tanpa heading yang cocok → di akhir file.
 */
/**
 * Judul heading untuk pencocokan: buang penanda markdown DAN nomor bagian.
 * Tanpa ini, heading "4.3 Uji Asumsi Klasik" tidak akan pernah cocok dengan
 * judul pilihan pengguna sehingga tabel diam-diam jatuh ke akhir file.
 */
/** Respons 400 saat heading tujuan tidak ada — sebutkan pilihan yang tersedia. */
function headingNotFound(heading: string, chapterPath: string) {
  return NextResponse.json(
    {
      error: `Heading "${heading}" tidak ditemukan di ${chapterPath}. Pilih heading yang ada; hasil tidak disisipkan ke mana pun.`,
    },
    { status: 400 },
  );
}

function normalizeHeading(value: string): string {
  return value
    .replace(/[*_`]/g, '')
    .replace(/^\s*\d+(?:\.\d+)*[.)]?\s+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function insertAfterHeading(
  content: string,
  headingText: string,
  block: string,
): { content: string; matched: boolean } {
  const lines = content.split('\n');
  const wanted = normalizeHeading(headingText);
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^(#{1,6})\s+(.*)$/.exec(lines[i]);
    if (!match) continue;
    if (normalizeHeading(match[2]) === wanted) {
      start = i;
      level = match[1].length;
      break;
    }
  }
  // Heading yang diminta tidak ada: JANGAN menempelkan ke akhir file diam-diam.
  // Untuk naskah skripsi, hasil yang masuk ke tempat salah lebih berbahaya
  // daripada pesan error.
  if (start < 0) return { content, matched: false };
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    const match = /^(#{1,6})\s+/.exec(lines[i]);
    if (match && match[1].length <= level) {
      end = i;
      break;
    }
  }
  const head = lines.slice(0, end).join('\n').replace(/\s+$/, '');
  const tail = lines.slice(end).join('\n');
  return {
    content: tail.trim() ? `${head}\n\n${block}\n${tail}` : `${head}\n\n${block}`,
    matched: true,
  };
}

/**
 * GET  ?sourcePath=hasil/uji-laporan.md → daftar tabel di file itu.
 * POST { sourcePath, chapterPath, index?, caption? } → sisip tabel yang dipilih
 *      ke akhir bab, dengan nomor "Tabel 3.1" sesuai gaya penulisan skripsi.
 *
 * Ini yang bikin alur "data → analisis → bab" nyambung tanpa harus ngomong
 * sama agent: hasil analisis berupa file markdown, tabelnya bisa langsung
 * dipindah ke draft.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  try {
    const { slug } = await params;
    const folder = await resolveProjectFolder(slug);
    if (!folder) return NextResponse.json({ error: 'Project tidak ditemukan' }, { status: 404 });

    const sourcePath = new URL(request.url).searchParams.get('sourcePath') ?? '';
    if (!sourcePath) {
      return NextResponse.json({ error: 'sourcePath wajib diisi' }, { status: 400 });
    }
    try {
      const { content } = await readTextFile(folder, sourcePath);
      const figures = extractFigures(content);
      // Urutan tampil diprioritaskan, tapi `index` tetap posisi asli di file.
      const focus = focusVariables(content);
      const ordered = [...figures].sort((a, b) => figureRank(a, focus) - figureRank(b, focus));
      return NextResponse.json({ tables: extractTables(content), figures: ordered, focus });
    } catch (error) {
      return workspaceError(error, 'Gagal membaca file hasil');
    }
  } catch (error) {
    console.error('[api/projects/insert-result] GET gagal:', error);
    return NextResponse.json({ error: 'Gagal membaca file hasil' }, { status: 500 });
  }
}

const postSchema = z.object({
  sourcePath: z.string().min(1).max(500),
  chapterPath: z.string().min(1).max(500),
  index: z.number().int().min(0).optional(),
  caption: z.string().max(300).optional(),
  /** 'table' (default) atau 'figure' — gambar diberi nomor "Gambar N.M". */
  kind: z.enum(['table', 'figure']).optional(),
  /** 'end' (default) menempel di akhir bab; 'afterHeading' di akhir seksi heading. */
  position: z.enum(['end', 'afterHeading']).optional(),
  heading: z.string().max(300).optional(),
});

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
    const { sourcePath, chapterPath, index, caption, kind, position, heading } = parsed.data;

    try {
      const source = await readTextFile(folder, sourcePath);

      if (kind === 'figure') {
        const figures = extractFigures(source.content);
        if (figures.length === 0) {
          return NextResponse.json(
            { error: 'File ini gak punya gambar buat disisipin' },
            { status: 400 },
          );
        }
        const figure = figures[index ?? 0];
        if (!figure) {
          return NextResponse.json({ error: 'Gambar gak ditemukan' }, { status: 404 });
        }

        const chapter = await readTextFile(folder, chapterPath);
        const babNumber = chapterNumber(chapterPath, chapter.content);
        const existingFigs = (chapter.content.match(/^\*\*Gambar\s+\d+(?:\.\d+)?\*\*/gm) ?? []).length + 1;
        const number = babNumber ? `Gambar ${babNumber}.${existingFigs}` : `Gambar ${existingFigs}`;

        const label = caption?.trim() || figure.caption || figure.alt || number;
        const block = `![${figure.alt || label}](${figure.path})\n\n**${number}** ${label}\n`;

        let next: string;
        if (position === 'afterHeading' && heading) {
          const placed = insertAfterHeading(chapter.content, heading, block);
          if (!placed.matched) return headingNotFound(heading, chapterPath);
          next = placed.content;
        } else {
          next = `${chapter.content}${chapter.content.endsWith('\n') ? '' : '\n'}${chapter.content.endsWith('\n') ? '\n' : '\n\n'}${block}`;
        }
        await snapshotCurrent(folder, chapterPath, 'analysis').catch(() => undefined);
        await writeTextFile(folder, chapterPath, next);

        return NextResponse.json({ ok: true, number, heading: label, bytes: next.length });
      }

      const tables = extractTables(source.content);
      if (tables.length === 0) {
        return NextResponse.json(
          { error: 'File ini gak punya tabel markdown buat disisipin' },
          { status: 400 },
        );
      }
      const table = tables[index ?? 0];
      if (!table) {
        return NextResponse.json({ error: 'Tabel gak ditemukan' }, { status: 404 });
      }

      const chapter = await readTextFile(folder, chapterPath);
      const babNumber = chapterNumber(chapterPath, chapter.content);
      const existing = extractTables(chapter.content).length + 1;
      const number = babNumber ? `Tabel ${babNumber}.${existing}` : `Tabel ${existing}`;

      const label = caption?.trim() || table.caption || number;
      const block = `**${number}** ${label}\n\n${table.markdown}\n`;

      let next: string;
      if (position === 'afterHeading' && heading) {
        const placed = insertAfterHeading(chapter.content, heading, block);
        if (!placed.matched) return headingNotFound(heading, chapterPath);
        next = placed.content;
      } else {
        next = `${chapter.content}${chapter.content.endsWith('\n') ? '' : '\n'}${chapter.content.endsWith('\n') ? '\n' : '\n\n'}${block}`;
      }
      // Simpan versi bab yang SEBELUM tabel disisipin, biar bisa dibalik.
      await snapshotCurrent(folder, chapterPath, 'analysis').catch(() => undefined);
      await writeTextFile(folder, chapterPath, next);

      return NextResponse.json({ ok: true, number, heading: label, bytes: next.length });
    } catch (error) {
      return workspaceError(error, 'Gagal menyisipkan tabel');
    }
  } catch (error) {
    console.error('[api/projects/insert-result] POST gagal:', error);
    return NextResponse.json({ error: 'Gagal menyisipkan tabel' }, { status: 500 });
  }
}
