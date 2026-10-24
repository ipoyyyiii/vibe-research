import { NextResponse } from 'next/server';
import fs from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { matrixRows, paperNotes, projects, revisionItems, savedPapers } from '@/lib/db/schema';
import { countMarkdownWords, firstHeading } from '@/lib/outline';
import { mergeChapterHeading } from '@/lib/thesis/chapters';
import { listAllSnapshots } from '@/lib/versions/store';
import { parseBib } from '@/lib/journals/bib';
import { readTargets } from '@/lib/workspace/targets';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Laporan progres untuk pembimbing: status tiap bab (kata + judul), jumlah
 * pustaka, isi matriks literatur, status revisi, dan riwayat versi.
 *
 * Dikembalikan sebagai markdown supaya bisa ditempel ke chat/email atau
 * diunduh; semua angkanya diambil dari file nyata, bukan perkiraan.
 */

const FIGURE_EXT = /\.(png|jpg|jpeg|webp|gif)$/i;

type ChapterRow = {
  path: string;
  title: string;
  words: number;
  modified: string;
};

async function readChapters(folder: string): Promise<ChapterRow[]> {
  const dir = path.join(folder, 'dokumen');
  let names: string[];
  try {
    names = (await fs.readdir(dir)).filter((name) => /\.md$/i.test(name));
  } catch {
    return [];
  }
  names.sort((a, b) => a.localeCompare(b, 'id', { numeric: true }));

  const rows: ChapterRow[] = [];
  for (const name of names) {
    const abs = path.join(dir, name);
    const [content, stat] = await Promise.all([
      fs.readFile(abs, 'utf8').catch(() => ''),
      fs.stat(abs).catch(() => null),
    ]);
    rows.push({
      path: `dokumen/${name}`,
      // `# BAB I` + `# PENDAHULUAN` di file mentah digabung dulu supaya
      // laporan menampilkan judul bab, bukan cuma "BAB I".
      title: firstHeading(mergeChapterHeading(content)) ?? name.replace(/\.md$/i, ''),
      words: countMarkdownWords(content),
      modified: stat ? new Date(stat.mtime).toISOString().slice(0, 16).replace('T', ' ') : '–',
    });
  }
  return rows;
}

async function countFiles(folder: string, pattern: RegExp): Promise<number> {
  let count = 0;
  const stack: string[] = [folder];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name === '.venv' || entry.name === 'node_modules' || entry.name === '.git') continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(abs);
      else if (entry.isFile() && pattern.test(entry.name)) count += 1;
    }
  }
  return count;
}

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await params;
    const rows = await db.select().from(projects).where(eq(projects.slug, slug)).limit(1);
    const project = rows[0];
    if (!project) return NextResponse.json({ error: 'Project tidak ditemukan' }, { status: 404 });

    const folder = project.folderPath;
    const [chapters, figures, snapshots, papers, matrix, notes, revisions] = await Promise.all([
      readChapters(folder),
      countFiles(folder, FIGURE_EXT),
      listAllSnapshots(folder).catch(() => []),
      db.select().from(savedPapers).where(eq(savedPapers.slug, slug)),
      db.select().from(matrixRows).where(eq(matrixRows.slug, slug)),
      db.select().from(paperNotes).where(eq(paperNotes.slug, slug)),
      db.select().from(revisionItems).where(eq(revisionItems.slug, slug)),
    ]);

    let bibEntries = 0;
    try {
      bibEntries = parseBib(await fs.readFile(path.join(folder, 'references.bib'), 'utf8')).length;
    } catch {
      bibEntries = 0;
    }

    const totalWords = chapters.reduce((sum, chapter) => sum + chapter.words, 0);
    const done = revisions.filter((item) => item.status === 'done').length;
    const doing = revisions.filter((item) => item.status === 'doing').length;
    const todo = revisions.filter((item) => item.status === 'todo').length;
    // Target kata dipakai untuk menjawab "sudah sejauh apa?", bukan cuma
    // "berapa kata sekarang" — inilah yang ditanyakan pembimbing.
    const targets = await readTargets(folder);
    const targeted = chapters.filter((chapter) => (targets[chapter.path] ?? 0) > 0);
    const chapterLines = chapters.length
      ? chapters.map((chapter) => {
          const target = targets[chapter.path] ?? 0;
          const pct = target > 0 ? Math.round((chapter.words / target) * 100) : null;
          return `| \`${chapter.path}\` | ${chapter.title} | ${chapter.words.toLocaleString('id-ID')} | ${
            target > 0 ? target.toLocaleString('id-ID') : '–'
          } | ${pct === null ? '–' : `${pct}%`} | ${chapter.modified} |`;
        })
      : ['| — | _belum ada bab_ | 0 | – | – | – |'];
    const targetWords = targeted.reduce((sum, chapter) => sum + (targets[chapter.path] ?? 0), 0);
    const targetReached = targeted.filter((chapter) => chapter.words >= (targets[chapter.path] ?? 0)).length;
    const targetLine = targeted.length
      ? `| Target kata tercapai | ${targetReached}/${targeted.length} bab (total target ${targetWords.toLocaleString('id-ID')} kata) |`
      : null;

    const markdown = [
      `# Laporan Progres — ${project.name}`,
      '',
      `Folder: \`${folder}\``,
      `Dibuat: ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
      '',
      '## Ringkasan',
      '',
      '| Item | Jumlah |',
      '|---|---|',
      `| Bab | ${chapters.length} |`,
      `| Total kata | ${totalWords.toLocaleString('id-ID')} |`,
      `| Pustaka (references.bib) | ${bibEntries} |`,
      `| Paper tersimpan | ${papers.length} |`,
      `| Baris matriks literatur | ${matrix.length} |`,
      `| Catatan paper | ${notes.length} |`,
      `| Gambar | ${figures} |`,
      `| Snapshot versi | ${snapshots.length} |`,
      `| Revisi dosen | ${done} selesai · ${doing} dikerjakan · ${todo} belum |`,
      ...(targetLine ? [targetLine] : []),
      '',
      '## Status bab',
      '',
      '| Berkas | Judul | Kata | Target | Capaian | Terakhir diubah |',
      '|---|---|---:|---:|---:|---|',
      ...chapterLines,
      '',
      '## Revisi dosen',
      '',
      done + doing + todo === 0
        ? '_Belum ada item revisi._'
        : [
            `- Selesai: **${done}**`,
            `- Sedang dikerjakan: **${doing}**`,
            `- Belum: **${todo}**`,
            '',
            ...revisions
              .filter((item) => item.status !== 'done')
              .slice(0, 10)
              .map((item) => `- [${item.status}] ${item.text.slice(0, 120)}`),
          ].join('\n'),
      '',
      '## Catatan',
      '',
      '- Angka di atas dihitung dari berkas di folder project, bukan perkiraan.',
      '- Riwayat versi tersimpan di `.riwayat/`; backup project mencakup folder itu.',
    ].join('\n');

    return NextResponse.json({
      markdown,
      stats: {
        chapters: chapters.length,
        words: totalWords,
        bibEntries,
        papers: papers.length,
        matrix: matrix.length,
        notes: notes.length,
        figures,
        snapshots: snapshots.length,
        revisions: { todo, doing, done },
      },
    });
  } catch (error) {
    console.error('[api/projects/progress] GET gagal:', error);
    return NextResponse.json({ error: 'Gagal menyusun laporan progres' }, { status: 500 });
  }
}
