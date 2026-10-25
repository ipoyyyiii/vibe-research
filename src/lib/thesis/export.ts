import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { checkCitations } from '../citations/check';
import { injectDocxSources } from '../citations/docx-sources';
import { isRealInside, resolveInside, toProjectPath } from '../export/paths';
import { parseBib, type BibEntry } from '../journals/bib';
import {
  ABSTRACT_PATH,
  discoverChapterPaths,
  mergeChapterHeading,
  readChapterText,
  scanCaptions,
  splitAbstractMarkdown,
  type CaptionEntry,
} from './chapters';
import { applyThesisLayout, buildDocxMarkdown } from './docx';
import {
  buildFrontMatterHtml,
  buildPdfBodyMarkdown,
  buildThesisHtml,
  buildTocHtml,
  extractHeadings,
  takeLeadingH1,
} from './pdf';
import type { FrontMatter } from './types';

const exec = promisify(execFile);

const BIB_FILE = 'references.bib';
const BIBLIOGRAPHY_TITLE = 'Daftar Pustaka';
const STYLE_CSL: Record<'apa' | 'ieee', string> = {
  apa: 'csl/apa.csl',
  ieee: 'csl/ieee.csl',
};
/** Gaya kustom disimpan di dalam project (lihat lib/thesis/csl.ts). */
const CUSTOM_CSL = '.vibe-research/style.csl';
const DOCX_NAME = 'skripsi-lengkap.docx';
const PDF_NAME = 'skripsi-lengkap.pdf';
const PANDOC_TIMEOUT = 120_000;
const PANDOC_BUFFER = 24 * 1024 * 1024;
/** Alt text gambar bukan caption — caption skripsi memakai baris `**Gambar …**`. */
const PANDOC_FROM = 'markdown-implicit_figures';

export type ThesisExportFormat = 'docx' | 'pdf' | 'both';

export type ThesisExportOptions = {
  folder: string;
  frontMatter: FrontMatter;
  style: 'apa' | 'ieee' | 'custom';
  format: ThesisExportFormat;
  /** Daftar path relatif project; kosong/undefined → semua dokumen/*.md. */
  chapters?: string[];
  appRoot?: string;
};

export type ThesisExportOutcome = {
  out: { docx?: string; pdf?: string };
  warnings: { missingCitations: string[]; unusedEntries: number };
  counts: { chapters: number; tables: number; figures: number };
  docxError?: string;
  pdfError?: string;
};

type BibResult = { exists: boolean; entries: BibEntry[] };

type ChapterFile = {
  path: string;
  markdown: string;
  tables: CaptionEntry[];
  figures: CaptionEntry[];
};

/**
 * Beri kelas `caption` pada paragraf "**Tabel 4.1** …" / "**Gambar 4.1** …".
 * Tanpa penanda ini WeasyPrint bisa menaruh caption di kaki halaman dan
 * tabelnya di halaman berikutnya.
 */
function markCaptionParagraphs(html: string): string {
  const marked = html.replace(/<p>(<strong>(?:Tabel|Gambar)\s)/g, '<p class="caption">$1');
  return keepCaptionWithObject(marked);
}

/**
 * Bungkus caption bersama tabel/gambarnya dalam satu blok `break-inside: avoid`.
 * WeasyPrint mengabaikan `break-after: avoid` pada paragraf, jadi tanpa
 * pembungkus caption bisa tertinggal di kaki halaman. Tabel panjang (> 15 baris)
 * sengaja tidak dibungkus agar tidak terpotong di halaman.
 */
function keepCaptionWithObject(html: string): string {
  const withTables = html.replace(
    /<p class="caption">[\s\S]*?<\/p>\s*<table[\s\S]*?<\/table>/g,
    (block) => ((block.match(/<tr/g) ?? []).length <= 15 ? `<div class="keep-together">${block}</div>` : block),
  );
  return withTables.replace(
    /<p><img[^>]*><\/p>\s*<p class="caption">[\s\S]*?<\/p>/g,
    (block) => `<div class="keep-together">${block}</div>`,
  );
}

function errorText(error: unknown): string {
  if (error !== null && typeof error === 'object') {
    const stderr = (error as { stderr?: unknown }).stderr;
    if (typeof stderr === 'string' && stderr.trim().length > 0) {
      return stderr.trim().slice(0, 600);
    }
  }
  return (error instanceof Error ? error.message : String(error)).slice(0, 600);
}

function token(): string {
  return `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function isFile(abs: string): Promise<boolean> {
  return fs
    .stat(abs)
    .then((stat) => stat.isFile())
    .catch(() => false);
}

async function ensureExportDir(folder: string): Promise<string> {
  const dir = resolveInside(folder, 'export');
  if (!dir) throw new Error('Folder export tidak valid');
  await fs.mkdir(dir, { recursive: true });
  const real = await fs.realpath(dir);
  if (real !== folder && !real.startsWith(folder + path.sep)) {
    throw new Error('Folder export keluar dari project');
  }
  return real;
}

async function readBib(folder: string): Promise<BibResult> {
  const abs = resolveInside(folder, BIB_FILE);
  if (!abs || !(await isRealInside(folder, abs))) return { exists: false, entries: [] };
  const raw = await fs.readFile(abs, 'utf8').catch(() => null);
  if (raw === null) return { exists: false, entries: [] };
  try {
    return { exists: true, entries: parseBib(raw) };
  } catch {
    return { exists: true, entries: [] };
  }
}

async function resolveChapterPaths(folder: string, requested?: string[]): Promise<string[]> {
  if (requested === undefined) return discoverChapterPaths(folder);
  if (requested.length === 0) throw new Error('Tidak ada bab yang dipilih');

  const seen = new Set<string>();
  const paths: string[] = [];
  for (const raw of requested) {
    const abs = resolveInside(folder, raw);
    if (!abs || !/\.md$/i.test(abs)) throw new Error(`Bab tidak valid: ${raw}`);
    if (!(await isFile(abs))) throw new Error(`Bab tidak ditemukan: ${raw}`);
    const relative = toProjectPath(folder, abs);
    if (relative.toLowerCase() === ABSTRACT_PATH) continue;
    if (seen.has(relative)) continue;
    seen.add(relative);
    paths.push(relative);
  }
  return paths;
}

async function loadChapters(folder: string, requested?: string[]): Promise<ChapterFile[]> {
  const paths = await resolveChapterPaths(folder, requested);
  const seenAnchors = new Set<string>();
  const chapters: ChapterFile[] = [];
  for (const chapterPath of paths) {
    // Dua H1 di awal bab digabung sekali di sini, supaya jalur DOCX (TOC field)
    // dan PDF (TOC HTML) sama-sama tidak menduplikasi entri bab di Daftar Isi.
    const markdown = mergeChapterHeading(await readChapterText(folder, chapterPath));
    const scan = scanCaptions(markdown, seenAnchors);
    chapters.push({ path: chapterPath, markdown, tables: scan.tables, figures: scan.figures });
  }
  return chapters;
}

export async function exportThesis(options: ThesisExportOptions): Promise<ThesisExportOutcome> {
  const folder = await fs.realpath(options.folder);
  const appRoot = options.appRoot ?? process.cwd();
  const chapters = await loadChapters(folder, options.chapters);
  if (chapters.length === 0) {
    throw new Error('Tidak ada bab .md di dokumen/ selain abstrak dan file draf');
  }

  const abstractCandidate = resolveInside(folder, ABSTRACT_PATH);
  const abstractPath =
    abstractCandidate && (await isRealInside(folder, abstractCandidate))
      ? abstractCandidate
      : null;
  const abstractRaw = abstractPath ? await fs.readFile(abstractPath, 'utf8').catch(() => null) : null;
  const abstract = abstractRaw === null ? null : splitAbstractMarkdown(abstractRaw);

  const tables = chapters.flatMap((chapter) => chapter.tables);
  const figures = chapters.flatMap((chapter) => chapter.figures);
  const bib = await readBib(folder);

  const citationText = [
    ...(abstract ? [abstract.body] : []),
    ...chapters.map((chapter) => chapter.markdown),
  ].join('\n\n');
  const citationCheck = checkCitations(
    citationText,
    bib.entries.map((entry) => entry.key),
  );

  const outDir = await ensureExportDir(folder);
  const out: { docx?: string; pdf?: string } = {};
  let docxError: string | undefined;
  let pdfError: string | undefined;

  const csl =
    options.style === 'custom' ? path.join(folder, CUSTOM_CSL) : path.join(appRoot, STYLE_CSL[options.style]);
  if (options.style === 'custom') {
    const exists = await fs
      .stat(csl)
      .then((stat) => stat.isFile())
      .catch(() => false);
    if (!exists) {
      throw new Error('Gaya sitasi kustom belum diunggah. Unggah file .csl di dialog ekspor.');
    }
  }
  const bibliography = path.join(folder, BIB_FILE);
  const bibliographyArgs = bib.exists
    ? [
        '--citeproc',
        '--bibliography',
        bibliography,
        '--csl',
        csl,
        '--metadata',
        `reference-section-title=${BIBLIOGRAPHY_TITLE}`,
      ]
    : [];

  if (options.format === 'docx' || options.format === 'both') {
    const stamp = token();
    const tempMd = path.join(folder, `.tmp-thesis-${stamp}.md`);
    const outAbs = path.join(outDir, DOCX_NAME);
    try {
      await fs.rm(outAbs, { force: true });
      await fs.writeFile(tempMd, buildDocxMarkdown({
        frontMatter: options.frontMatter,
        abstract,
        chapters,
        tables,
        figures,
      }), 'utf8');

      const args = [tempMd, '-f', PANDOC_FROM, '-t', 'docx', '--resource-path', folder];
      const referenceDoc = path.join(appRoot, 'templates', 'skripsi-reference.docx');
      if (await isFile(referenceDoc)) args.push('--reference-doc', referenceDoc);
      args.push(...bibliographyArgs, '-o', outAbs);

      await exec('pandoc', args, { timeout: PANDOC_TIMEOUT, maxBuffer: PANDOC_BUFFER });

      const original = await fs.readFile(outAbs);
      const layout = await applyThesisLayout(original);
      if (!layout.markerFound) {
        console.warn('[lib/thesis/export] marker section tidak ditemukan di DOCX');
      }
      const patched =
        bib.entries.length > 0
          ? await injectDocxSources(
              layout.bytes,
              bib.entries,
              options.style === 'ieee' ? 'ieee' : 'apa',
            )
          : { bytes: layout.bytes, count: 0 };
      await fs.writeFile(outAbs, patched.bytes);
      out.docx = toProjectPath(folder, outAbs);
    } catch (error) {
      docxError = errorText(error);
      console.error('[lib/thesis/export] DOCX gagal:', error);
    } finally {
      await fs.rm(tempMd, { force: true }).catch(() => undefined);
    }
  }

  if (options.format === 'pdf' || options.format === 'both') {
    const stamp = token();
    const bodyMd = path.join(folder, `.tmp-thesis-body-${stamp}.md`);
    const bodyHtmlPath = path.join(folder, `.tmp-thesis-body-${stamp}.html`);
    const abstractHtmlPath = path.join(folder, `.tmp-thesis-abstract-${stamp}.html`);
    const fullHtmlPath = path.join(folder, `.tmp-thesis-full-${stamp}.html`);
    const outAbs = path.join(outDir, PDF_NAME);
    try {
      await fs.rm(outAbs, { force: true });
      const bodyMarkdown = buildPdfBodyMarkdown(
        chapters.map((chapter) => ({
          path: chapter.path,
          markdown: chapter.markdown,
          captions: [...chapter.tables, ...chapter.figures],
        })),
      );
      await fs.writeFile(bodyMd, bodyMarkdown, 'utf8');

      const pandocArgs = [bodyMd, '-f', PANDOC_FROM, '-t', 'html5', '--resource-path', folder];
      pandocArgs.push(...bibliographyArgs, '-o', bodyHtmlPath);
      await exec('pandoc', pandocArgs, { timeout: PANDOC_TIMEOUT, maxBuffer: PANDOC_BUFFER });

      const bodyHtml = markCaptionParagraphs(await fs.readFile(bodyHtmlPath, 'utf8'));
      const tocHtml = buildTocHtml(extractHeadings(bodyHtml));

      let abstractHtml: { heading: string; html: string } | null = null;
      if (abstract && abstractPath) {
        await exec(
          'pandoc',
          [abstractPath, '-f', PANDOC_FROM, '-t', 'html5', '--resource-path', folder, '-o', abstractHtmlPath],
          { timeout: PANDOC_TIMEOUT, maxBuffer: PANDOC_BUFFER },
        );
        const rawHtml = await fs.readFile(abstractHtmlPath, 'utf8');
        const leading = takeLeadingH1(rawHtml);
        abstractHtml = { heading: leading.heading ?? abstract.heading, html: leading.body };
      }

      const frontMatterHtml = buildFrontMatterHtml({
        frontMatter: options.frontMatter,
        abstract: abstractHtml,
        tables,
        figures,
        bodyHtml,
        tocHtml,
      });
      const fullHtml = buildThesisHtml({
        title: options.frontMatter.title,
        frontMatterHtml,
        bodyHtml,
      });
      await fs.writeFile(fullHtmlPath, fullHtml, 'utf8');

      const css = path.join(appRoot, 'assets', 'thesis.css');
      if (!(await isFile(css))) throw new Error('assets/thesis.css tidak ditemukan');
      await exec('weasyprint', ['--stylesheet', css, fullHtmlPath, outAbs], {
        cwd: folder,
        timeout: 180_000,
        maxBuffer: 16 * 1024 * 1024,
      });

      const head = await fs.readFile(outAbs).catch(() => null);
      if (!head || head.subarray(0, 4).toString('utf8') !== '%PDF') {
        throw new Error('weasyprint tidak menghasilkan PDF');
      }
      out.pdf = toProjectPath(folder, outAbs);
    } catch (error) {
      pdfError = errorText(error);
      console.error('[lib/thesis/export] PDF gagal:', error);
    } finally {
      await Promise.all(
        [bodyMd, bodyHtmlPath, abstractHtmlPath, fullHtmlPath].map((temp) =>
          fs.rm(temp, { force: true }).catch(() => undefined),
        ),
      );
    }
  }

  return {
    out,
    warnings: {
      missingCitations: citationCheck.missing,
      unusedEntries: citationCheck.unused.length,
    },
    counts: {
      chapters: chapters.length,
      tables: tables.length,
      figures: figures.length,
    },
    ...(docxError ? { docxError } : {}),
    ...(pdfError ? { pdfError } : {}),
  };
}
