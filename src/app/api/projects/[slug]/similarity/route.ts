import { NextResponse } from 'next/server';
import fs from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { projects, savedPapers } from '@/lib/db/schema';
import type { JournalCard } from '@/lib/journals/types';
import {
  countWords,
  findOverlaps,
  splitSentences,
  DEFAULT_MIN_WORDS,
  DEFAULT_THRESHOLD,
  type SentenceHit,
} from '@/lib/similarity/check';
import { isExcludedChapterName, naturalCompare, readChapterText } from '@/lib/thesis/chapters';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Cek kemiripan lokal: kalimat bab vs abstrak paper tersimpan di project ini.
 * Bukan Turnitin — pembandingnya cuma pustaka lokal, tanpa basis data global.
 */

type SourceRow = { key: string; title: string; abstract: string };

type PaperSourceScan = {
  total: number;
  missingAbstract: number;
  invalid: number;
  sources: SourceRow[];
};

function parseThreshold(raw: string | null): { threshold: number; note: string | null } {
  if (raw === null || raw.trim() === '') return { threshold: DEFAULT_THRESHOLD, note: null };
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return {
      threshold: DEFAULT_THRESHOLD,
      note: `Nilai threshold "${raw}" tidak valid; dipakai ${DEFAULT_THRESHOLD}`,
    };
  }
  const clamped = Math.min(1, Math.max(0.5, parsed));
  if (clamped !== parsed) {
    return {
      threshold: clamped,
      note: `Threshold ${parsed} di luar rentang 0.5–1; dipakai ${clamped}`,
    };
  }
  return { threshold: clamped, note: null };
}

/** Baris saved_papers → sumber pembanding (abstrak kosong/null dilewati). */
async function readPaperSources(slug: string): Promise<PaperSourceScan> {
  const rows = await db
    .select({ paperId: savedPapers.paperId, bibKey: savedPapers.bibKey, data: savedPapers.data })
    .from(savedPapers)
    .where(eq(savedPapers.slug, slug));

  const sources: SourceRow[] = [];
  let missingAbstract = 0;
  let invalid = 0;

  for (const row of rows) {
    let card: Partial<JournalCard> | null = null;
    try {
      const parsed: unknown = JSON.parse(row.data);
      if (parsed && typeof parsed === 'object') card = parsed as Partial<JournalCard>;
    } catch {
      card = null;
    }
    if (!card) {
      invalid += 1;
      continue;
    }

    const abstract = typeof card.abstract === 'string' ? card.abstract.trim() : '';
    if (!abstract) {
      missingAbstract += 1;
      continue;
    }
    const title =
      typeof card.title === 'string' && card.title.trim() ? card.title.trim() : row.bibKey || row.paperId;
    sources.push({
      key: row.bibKey || row.paperId,
      title,
      abstract,
    });
  }

  return { total: rows.length, missingAbstract, invalid, sources };
}

/** Semua `dokumen/*.md` yang layak diperiksa (lewati `_…` + file uji/draf). */
async function listChapterPaths(folder: string): Promise<string[]> {
  const dir = path.join(folder, 'dokumen');
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => /\.md$/i.test(name))
    .filter((name) => !name.startsWith('_'))
    .filter((name) => !isExcludedChapterName(name))
    .sort(naturalCompare)
    .map((name) => `dokumen/${name}`);
}

function requestedChapter(raw: string): string | null {
  const match = /^dokumen\/([^/\\]+\.md)$/i.exec(raw);
  if (!match) return null;
  const name = match[1];
  if (name.startsWith('_') || isExcludedChapterName(name)) return null;
  return `dokumen/${name}`;
}

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await params;
    const rows = await db.select().from(projects).where(eq(projects.slug, slug)).limit(1);
    const project = rows[0];
    if (!project) return NextResponse.json({ error: 'Project tidak ditemukan' }, { status: 404 });

    const url = new URL(request.url);
    const rawThreshold = url.searchParams.get('threshold');
    const { threshold, note: thresholdNote } = parseThreshold(rawThreshold);
    const rawPath = url.searchParams.get('path')?.trim() ?? '';

    let chapterPaths: string[];
    if (rawPath) {
      const selected = requestedChapter(rawPath);
      if (!selected) {
        return NextResponse.json(
          { error: 'Path harus berkas dokumen/*.md yang bukan file uji/draf' },
          { status: 400 },
        );
      }
      const available = await listChapterPaths(project.folderPath);
      if (!available.includes(selected)) {
        return NextResponse.json({ error: `Berkas tidak ditemukan: ${rawPath}` }, { status: 404 });
      }
      chapterPaths = [selected];
    } else {
      chapterPaths = await listChapterPaths(project.folderPath);
    }

    const chapters: Array<{ path: string; content: string }> = [];
    const failed: string[] = [];
    for (const chapterPath of chapterPaths) {
      try {
        chapters.push({ path: chapterPath, content: await readChapterText(project.folderPath, chapterPath) });
      } catch {
        failed.push(chapterPath);
      }
    }

    const scan = await readPaperSources(slug);
    const hits: SentenceHit[] = findOverlaps(chapters, scan.sources, { threshold });
    let sentences = 0;
    for (const chapter of chapters) {
      for (const item of splitSentences(chapter.content)) {
        if (countWords(item.sentence) >= DEFAULT_MIN_WORDS) sentences += 1;
      }
    }

    const notes: string[] = [];
    if (thresholdNote) notes.push(thresholdNote);
    if (scan.total === 0) {
      notes.push('Tidak ada paper tersimpan');
    } else {
      if (scan.missingAbstract > 0) {
        notes.push(`${scan.missingAbstract} paper belum punya abstrak sehingga tidak ikut dibandingkan`);
      }
      if (scan.invalid > 0) {
        notes.push(`${scan.invalid} data paper tidak bisa dibaca dan dilewati`);
      }
    }
    if (failed.length > 0) {
      const list = failed.slice(0, 3).join(', ');
      notes.push(`${failed.length} berkas gagal dibaca: ${list}${failed.length > 3 ? ', …' : ''}`);
    }
    if (chapters.length === 0) {
      notes.push('Tidak ada berkas .md di dokumen/ yang bisa diperiksa');
    } else if (sentences === 0) {
      notes.push(`Tidak ada kalimat minimal ${DEFAULT_MIN_WORDS} kata untuk dibandingkan`);
    }

    return NextResponse.json({
      hits,
      summary: {
        chapters: chapters.length,
        sentences,
        sources: scan.sources.length,
        flagged: hits.length,
        threshold,
      },
      notes,
    });
  } catch (error) {
    console.error('[api/projects/similarity] GET gagal:', error);
    return NextResponse.json({ error: 'Gagal memeriksa kemiripan' }, { status: 500 });
  }
}
