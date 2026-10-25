import { addCaptionAnchors, captionLabel, type CaptionEntry } from './chapters';
import { hasProgramPrefix } from './front-matter';
import type { FrontMatter } from './types';

const PLACEHOLDER = '…………………………';

export type PdfHeading = { level: number; id: string; text: string };

export type PdfChapterInput = {
  path: string;
  markdown: string;
  captions: CaptionEntry[];
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, '');
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeHtml(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (entity, code: string) => {
    if (code.startsWith('#')) {
      const hex = code[1]?.toLowerCase() === 'x';
      const parsed = Number.parseInt(code.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : entity;
    }
    return ENTITIES[code.toLowerCase()] ?? entity;
  });
}

function textOf(value: string): string {
  return decodeHtml(stripTags(value)).replace(/\s+/g, ' ').trim();
}

function valueOr(value: string, fallback = PLACEHOLDER): string {
  return escapeHtml(value.trim() || fallback);
}

/** "Fakultas Psikologi" → "Psikologi" supaya label "Fakultas" tidak dobel. */
function facultyName(value: string): string {
  return valueOr(value).replace(/^fakultas\b\s*/i, '');
}

/** Markdown isi (bab) untuk PDF; anchor caption disisipkan untuk target-counter. */
export function buildPdfBodyMarkdown(chapters: PdfChapterInput[]): string {
  const parts = chapters.map((chapter, index) => {
    const anchored = addCaptionAnchors(chapter.markdown.trimEnd(), chapter.captions);
    return `${index > 0 ? '<div class="chapter-break"></div>\n\n' : ''}${anchored}`;
  });
  return `${parts.join('\n\n')}\n`;
}

/** Ambil heading H1–H3 (id dipakai TOC) dari fragmen HTML pandoc. */
export function extractHeadings(html: string): PdfHeading[] {
  const headings: PdfHeading[] = [];
  const pattern = /<h([1-6])\b([^>]*)>([\s\S]*?)<\/h\1>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    const level = Number(match[1]);
    if (level > 3) continue;
    const id = /\bid="([^"]+)"/.exec(match[2])?.[1];
    const text = textOf(match[3]);
    if (!id || text.length === 0) continue;
    headings.push({ level, id: decodeHtml(id), text });
  }
  return headings;
}

/** Buang H1 pembuka dari fragmen abstrak; teksnya dipakai sebagai judul halaman. */
export function takeLeadingH1(html: string): { heading: string | null; body: string } {
  const match = /^\s*<h1\b[^>]*>([\s\S]*?)<\/h1>\s*/i.exec(html);
  if (!match) return { heading: null, body: html.trim() };
  return { heading: textOf(match[1]) || null, body: html.slice(match[0].length).trim() };
}

export function buildTocHtml(headings: PdfHeading[]): string {
  if (headings.length === 0) return '<p class="empty-list">Daftar isi kosong.</p>';
  const entries = headings
    .map(
      (heading) =>
        `<div class="toc-entry toc-${heading.level}">` +
        `<a href="#${escapeHtml(heading.id)}">${escapeHtml(heading.text)}</a></div>`,
    )
    .join('');
  return `<nav class="toc">${entries}</nav>`;
}

export function buildListHtml(
  entries: CaptionEntry[],
  bodyHtml: string,
  emptyText: string,
): string {
  if (entries.length === 0) return `<p class="empty-list">${escapeHtml(emptyText)}</p>`;
  const rows = entries
    .map((entry) => {
      const label = escapeHtml(captionLabel(entry));
      if (bodyHtml.includes(`id="${entry.anchor}"`)) {
        return `<div class="list-entry"><a href="#${escapeHtml(entry.anchor)}">${label}</a></div>`;
      }
      return `<div class="list-entry"><span>${label}</span></div>`;
    })
    .join('');
  return `<nav class="list">${rows}</nav>`;
}

function coverHtml(frontMatter: FrontMatter, logoPath?: string | null): string {
  return (
    '<section class="page cover">' +
    (logoPath ? `<p class="cover-logo"><img src="${escapeHtml(logoPath)}" alt="Logo institusi" /></p>` : '') +
    '<p class="cover-label">SKRIPSI</p>' +
    `<p class="cover-title">${valueOr(frontMatter.title, 'JUDUL SKRIPSI')}</p>` +
    '<p class="cover-line">Diajukan sebagai salah satu syarat untuk memperoleh gelar Sarjana</p>' +
    `<p class="cover-author">${valueOr(frontMatter.author)}</p>` +
    `<p class="cover-meta">NIM ${valueOr(frontMatter.nim)}</p>` +
    `<p class="cover-meta">${hasProgramPrefix(frontMatter.program) ? '' : 'Program Studi '}${valueOr(frontMatter.program)}</p>` +
    `<p class="cover-meta">Fakultas ${facultyName(frontMatter.faculty)}</p>` +
    `<p class="cover-meta cover-institution">${valueOr(frontMatter.institution).toUpperCase()}</p>` +
    `<p class="cover-meta cover-place">${valueOr(frontMatter.city)}, ${valueOr(frontMatter.year)}</p>` +
    '</section>'
  );
}

function statementHtml(frontMatter: FrontMatter): string {
  const title = valueOr(frontMatter.title);
  return (
    '<section class="page">' +
    '<h1 class="page-title">HALAMAN PERNYATAAN</h1>' +
    '<p>Yang bertanda tangan di bawah ini:</p>' +
    `<p class="identity">Nama: ${valueOr(frontMatter.author)}</p>` +
    `<p class="identity">NIM: ${valueOr(frontMatter.nim)}</p>` +
    `<p class="identity">${hasProgramPrefix(frontMatter.program) ? '' : 'Program Studi: '}${valueOr(frontMatter.program)}</p>` +
    `<p class="identity">Fakultas: ${facultyName(frontMatter.faculty)}</p>` +
    `<p class="statement-body">Menyatakan bahwa skripsi yang berjudul &quot;${title}&quot; ` +
    'adalah hasil karya saya sendiri, bukan plagiarisme, dan semua sumber yang dikutip telah ' +
    'disebutkan dalam daftar pustaka. Apabila di kemudian hari terbukti terdapat plagiarisme ' +
    'dalam skripsi ini, saya bersedia menerima sanksi sesuai ketentuan yang berlaku.</p>' +
    '<p>Demikian pernyataan ini saya buat dengan sebenarnya.</p>' +
    '<div class="signature">' +
    `<p>${valueOr(frontMatter.city)}, ${valueOr(frontMatter.year)}</p>` +
    '<p class="signature-space"></p>' +
    `<p>${valueOr(frontMatter.author)}</p>` +
    `<p>NIM ${valueOr(frontMatter.nim)}</p>` +
    '</div></section>'
  );
}

function approvalHtml(frontMatter: FrontMatter): string {
  const title = valueOr(frontMatter.title);
  return (
    '<section class="page">' +
    '<h1 class="page-title">HALAMAN PENGESAHAN</h1>' +
    `<p class="approval-intro">Skripsi berjudul &quot;${title}&quot; yang disusun oleh ` +
    `${valueOr(frontMatter.author)} (NIM ${valueOr(frontMatter.nim)}) telah diperiksa dan ` +
    'disetujui untuk diujikan.</p>' +
    '<table class="signature-table"><thead><tr>' +
    '<th>Pembimbing I</th><th>Pembimbing II</th><th>Ketua Program Studi</th>' +
    '</tr></thead><tbody>' +
    '<tr class="signature-space-row"><td></td><td></td><td></td></tr>' +
    `<tr><td>${valueOr(frontMatter.supervisor1)}</td>` +
    `<td>${valueOr(frontMatter.supervisor2)}</td><td>${PLACEHOLDER}</td></tr>` +
    '<tr><td>NIP. ……………</td><td>NIP. ……………</td><td>NIP. ……………</td></tr>' +
    '</tbody></table></section>'
  );
}

export type FrontMatterHtmlInput = {
  frontMatter: FrontMatter;
  abstract: { heading: string; html: string } | null;
  tables: CaptionEntry[];
  figures: CaptionEntry[];
  bodyHtml: string;
  tocHtml: string;
  /** Path relatif project ke logo sampul, mis. `.vibe-research/logo.png`. */
  logoPath?: string | null;
};

export function buildFrontMatterHtml(input: FrontMatterHtmlInput): string {
  const abstract = input.abstract
    ? '<section class="page"><h1 class="page-title">' +
      `${escapeHtml(input.abstract.heading)}</h1>` +
      `<div class="abstract-body">${input.abstract.html}</div></section>`
    : '';
  return (
    '<div class="frontmatter">' +
    coverHtml(input.frontMatter, input.logoPath) +
    statementHtml(input.frontMatter) +
    approvalHtml(input.frontMatter) +
    abstract +
    '<section class="page"><h1 class="page-title">DAFTAR ISI</h1>' +
    input.tocHtml +
    '</section>' +
    '<section class="page"><h1 class="page-title">DAFTAR TABEL</h1>' +
    buildListHtml(input.tables, input.bodyHtml, 'Belum ada tabel.') +
    '</section>' +
    '<section class="page"><h1 class="page-title">DAFTAR GAMBAR</h1>' +
    buildListHtml(input.figures, input.bodyHtml, 'Belum ada gambar.') +
    '</section>' +
    '</div>'
  );
}

export function buildThesisHtml(input: {
  title: string;
  frontMatterHtml: string;
  bodyHtml: string;
}): string {
  const title = escapeHtml(input.title.trim() || 'Skripsi');
  return (
    '<!DOCTYPE html>\n<html lang="id">\n<head>\n<meta charset="utf-8">\n' +
    `<title>${title}</title>\n</head>\n<body>\n` +
    `${input.frontMatterHtml}\n<div class="body">\n${input.bodyHtml}\n</div>\n` +
    '</body>\n</html>\n'
  );
}
