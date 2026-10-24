import { NextResponse } from 'next/server';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isRealInside, resolveInside } from '@/lib/export/paths';
import { findPdfTool, resolveProjectFolder } from '@/lib/export/shared';
import { ABSTRACT_PATH, discoverChapterPaths, readChapterTitle } from '@/lib/thesis/chapters';
import { exportThesis, type ThesisExportFormat } from '@/lib/thesis/export';
import { customCslInfo } from '@/lib/thesis/csl';
import { readFrontMatter } from '@/lib/thesis/front-matter';
import { workspaceError } from '@/lib/workspace/api-error';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function isFile(abs: string): Promise<boolean> {
  return fs
    .stat(abs)
    .then((stat) => stat.isFile())
    .catch(() => false);
}

/** Daftar bab default + abstrak untuk modal ekspor. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  try {
    const { slug } = await params;
    const folder = await resolveProjectFolder(slug);
    if (!folder) return NextResponse.json({ error: 'Project tidak ditemukan' }, { status: 404 });

    const paths = await discoverChapterPaths(folder);
    const chapters = await Promise.all(
      paths.map(async (chapterPath) => ({
        path: chapterPath,
        name: path.basename(chapterPath),
        title: await readChapterTitle(folder, chapterPath),
      })),
    );

    const abstractAbs = resolveInside(folder, ABSTRACT_PATH);
    const abstract =
      abstractAbs && (await isRealInside(folder, abstractAbs)) && (await isFile(abstractAbs))
        ? ABSTRACT_PATH
        : null;
    const bibAbs = path.join(folder, 'references.bib');
    const hasBib = (await isRealInside(folder, bibAbs)) && (await isFile(bibAbs));

    return NextResponse.json({ ok: true, chapters, abstract, hasBib });
  } catch (error) {
    console.error('[api/projects/export/thesis] GET gagal:', error);
    return NextResponse.json({ error: 'Gagal memuat daftar bab' }, { status: 500 });
  }
}

/** Ekspor skripsi lengkap: DOCX dan/atau PDF dari semua bab terpilih. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  try {
    const { slug } = await params;
    const folder = await resolveProjectFolder(slug);
    if (!folder) return NextResponse.json({ error: 'Project tidak ditemukan' }, { status: 404 });

    const body = (await request.json().catch(() => null)) as unknown;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'Data tidak valid' }, { status: 400 });
    }
    const record = body as Record<string, unknown>;

    const style = record.style ?? 'apa';
    if (style !== 'apa' && style !== 'ieee' && style !== 'custom') {
      return NextResponse.json({ error: 'Gaya csl gak dikenal' }, { status: 400 });
    }
    if (style === 'custom' && !(await customCslInfo(folder)).exists) {
      return NextResponse.json(
        { error: 'Gaya sitasi kustom belum diunggah (file .csl).' },
        { status: 400 },
      );
    }

    const format = (record.format ?? 'both') as ThesisExportFormat;
    if (format !== 'docx' && format !== 'pdf' && format !== 'both') {
      return NextResponse.json({ error: 'Format ekspor gak dikenal' }, { status: 400 });
    }
    if (format === 'pdf' && (await findPdfTool()) !== 'weasyprint') {
      return NextResponse.json({ error: 'weasyprint belum terpasang' }, { status: 500 });
    }

    let requested: string[] | undefined;
    if (record.chapters !== undefined) {
      if (!Array.isArray(record.chapters)) {
        return NextResponse.json({ error: 'Daftar bab tidak valid' }, { status: 400 });
      }
      requested = record.chapters.filter(
        (item): item is string => typeof item === 'string' && item.trim().length > 0,
      );
      if (requested.length === 0) {
        return NextResponse.json({ error: 'Pilih minimal satu bab' }, { status: 400 });
      }
    }

    let selected: string[];
    if (requested === undefined) {
      selected = await discoverChapterPaths(folder);
    } else {
      selected = [];
      for (const raw of requested) {
        const abs = resolveInside(folder, raw);
        if (!abs || !/\.md$/i.test(abs) || !(await isFile(abs))) {
          return NextResponse.json({ error: `Bab tidak valid: ${raw}` }, { status: 400 });
        }
        selected.push(path.relative(folder, abs).split(path.sep).join('/'));
      }
    }

    const bodyChapters = selected.filter(
      (chapterPath) => chapterPath.toLowerCase() !== ABSTRACT_PATH,
    );
    if (bodyChapters.length === 0) {
      return NextResponse.json(
        { error: 'Tidak ada bab .md di dokumen/ selain abstrak dan file draf' },
        { status: 400 },
      );
    }

    const { frontMatter } = await readFrontMatter(folder);
    const result = await exportThesis({
      folder,
      frontMatter,
      style,
      format,
      chapters: bodyChapters,
    });

    if (!result.out.docx && !result.out.pdf) {
      return NextResponse.json(
        {
          error: 'Ekspor gagal',
          detail: result.docxError ?? result.pdfError,
          warnings: result.warnings,
          counts: result.counts,
        },
        { status: 500 },
      );
    }

    return NextResponse.json({
      ok: true,
      out: result.out,
      warnings: result.warnings,
      counts: result.counts,
      ...(result.docxError ? { docxError: result.docxError } : {}),
      ...(result.pdfError ? { pdfError: result.pdfError } : {}),
    });
  } catch (error) {
    console.error('[api/projects/export/thesis] POST gagal:', error);
    return workspaceError(error, 'Ekspor skripsi gagal');
  }
}
