import { NextResponse } from 'next/server';
import fs from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { projects } from '@/lib/db/schema';
import { parseBib } from '@/lib/journals/bib';
import { countMarkdownWords } from '@/lib/outline';
import { ABSTRACT_PATH, discoverChapterPaths, readChapterText } from '@/lib/thesis/chapters';
import { extractCitations, verifyThesis } from '@/lib/verify/thesis';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Batas bab yang diperiksa — cukup untuk skripsi, route tetap responsif. */
const MAX_CHAPTERS = 60;

/**
 * GET → periksa naskah project sebelum ekspor (deterministik, tanpa model).
 *
 * Yang dibaca:
 * - `dokumen/*.md` — lewat `discoverChapterPaths`, jadi `abstrak.md`, berkas
 *   uji/draf, dan `instrumen*` otomatis dilewati.
 * - `dokumen/abstrak.md` — terpisah, untuk cek panjang abstrak.
 * - `references.bib` — entri pustaka untuk cek sitasi.
 *
 * `?abstractMaxWords=200` mengubah batas kata abstrak (default 250).
 * Respons: `{ checks, summary, counts: { chapters, words, citations } }`.
 */
export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await params;
    const rows = await db.select().from(projects).where(eq(projects.slug, slug)).limit(1);
    const project = rows[0];
    if (!project) return NextResponse.json({ error: 'Project tidak ditemukan' }, { status: 404 });

    const folder = project.folderPath;
    const paths = (await discoverChapterPaths(folder)).slice(0, MAX_CHAPTERS);

    const chapters: Array<{ path: string; content: string }> = [];
    for (const chapterPath of paths) {
      // Satu berkas rusak/hilang jangan menggagalkan seluruh pemeriksaan.
      const content = await readChapterText(folder, chapterPath).catch(() => null);
      if (content !== null) chapters.push({ path: chapterPath, content });
    }

    const abstract = await readChapterText(folder, ABSTRACT_PATH).catch(() => null);
    const bibContent = await fs
      .readFile(path.join(folder, 'references.bib'), 'utf8')
      .catch(() => null);
    const bibKeys = bibContent === null ? [] : parseBib(bibContent).map((entry) => entry.key);

    const rawMaxWords = new URL(request.url).searchParams.get('abstractMaxWords');
    const parsedMaxWords = rawMaxWords === null ? Number.NaN : Number(rawMaxWords);
    const abstractMaxWords =
      Number.isFinite(parsedMaxWords) && parsedMaxWords > 0 ? Math.floor(parsedMaxWords) : undefined;

    const { checks, summary } = verifyThesis({ chapters, bibKeys, abstract, abstractMaxWords });

    return NextResponse.json({
      checks,
      summary,
      counts: {
        chapters: chapters.length,
        words: chapters.reduce((total, chapter) => total + countMarkdownWords(chapter.content), 0),
        citations: chapters.reduce(
          (total, chapter) => total + extractCitations(chapter.content).length,
          0,
        ),
      },
    });
  } catch (error) {
    console.error('[api/projects/verify] GET gagal:', error);
    return NextResponse.json({ error: 'Gagal memeriksa naskah' }, { status: 500 });
  }
}
