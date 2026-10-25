import JSZip from 'jszip';
import { captionLabel, type CaptionEntry } from './chapters';
import { hasProgramPrefix } from './front-matter';
import type { FrontMatter } from './types';
import { imageSize } from './cover-logo';

export const DOCX_BODY_MARKER = '@@THESIS-BODY-START@@';

const PAGE_BREAK =
  '<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/></w:pPr><w:r><w:br w:type="page"/></w:r></w:p>';

type ParagraphOptions = {
  align?: 'left' | 'center' | 'right';
  bold?: boolean;
  /** Ukuran font dalam half-point (12 pt = 24). */
  size?: number;
  before?: number;
  after?: number;
  keepNext?: boolean;
  line?: number;
  lineRule?: 'auto' | 'exact' | 'atLeast';
};

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function paragraph(text: string, options: ParagraphOptions = {}): string {
  const pPr: string[] = [];
  if (options.keepNext) pPr.push('<w:keepNext/>');
  const spacing: string[] = [];
  if (options.before !== undefined) spacing.push(`w:before="${options.before}"`);
  if (options.after !== undefined) spacing.push(`w:after="${options.after}"`);
  if (options.line !== undefined) {
    spacing.push(`w:line="${options.line}" w:lineRule="${options.lineRule ?? 'auto'}"`);
  }
  if (spacing.length > 0) pPr.push(`<w:spacing ${spacing.join(' ')}/>`);
  if (options.align) pPr.push(`<w:jc w:val="${options.align}"/>`);

  const rPr: string[] = [];
  if (options.bold) rPr.push('<w:b/><w:bCs/>');
  if (options.size !== undefined) {
    rPr.push(`<w:sz w:val="${options.size}"/><w:szCs w:val="${options.size}"/>`);
  }
  if (text.length === 0) return `<w:p>${pPr.length > 0 ? `<w:pPr>${pPr.join('')}</w:pPr>` : ''}</w:p>`;

  return (
    `<w:p>${pPr.length > 0 ? `<w:pPr>${pPr.join('')}</w:pPr>` : ''}` +
    `<w:r>${rPr.length > 0 ? `<w:rPr>${rPr.join('')}</w:rPr>` : ''}` +
    `<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`
  );
}

function pageTitle(text: string): string {
  return paragraph(text, { align: 'center', bold: true, size: 28, before: 0, after: 240, keepNext: true });
}

function openxmlBlock(xml: string): string {
  return ['```{=openxml}', xml, '```', ''].join('\n');
}

const PLACEHOLDER = '…………………………';

function valueOr(value: string, fallback = PLACEHOLDER): string {
  return value.trim() || fallback;
}

/** "Fakultas Psikologi" → "Psikologi" supaya label "Fakultas" tidak dobel. */
function facultyName(value: string): string {
  return valueOr(value).replace(/^fakultas\b\s*/i, '');
}

function coverXml(frontMatter: FrontMatter): string {
  return [
    paragraph('SKRIPSI', { align: 'center', bold: true, size: 28, before: 720, after: 480 }),
    paragraph(frontMatter.title.trim() || 'JUDUL SKRIPSI', {
      align: 'center',
      bold: true,
      size: 32,
      before: 0,
      after: 720,
    }),
    paragraph('Diajukan sebagai salah satu syarat untuk memperoleh gelar Sarjana', {
      align: 'center',
      size: 24,
      after: 480,
    }),
    paragraph(valueOr(frontMatter.author), { align: 'center', bold: true, after: 120 }),
    paragraph(`NIM ${valueOr(frontMatter.nim)}`, { align: 'center', after: 360 }),
    paragraph(`${hasProgramPrefix(frontMatter.program) ? '' : 'Program Studi '}${valueOr(frontMatter.program)}`, { align: 'center', after: 0 }),
    paragraph(`Fakultas ${facultyName(frontMatter.faculty)}`, { align: 'center', after: 0 }),
    paragraph(valueOr(frontMatter.institution).toUpperCase(), {
      align: 'center',
      bold: true,
      after: 960,
    }),
    paragraph(`${valueOr(frontMatter.city)}, ${valueOr(frontMatter.year)}`, {
      align: 'center',
      after: 0,
    }),
  ].join('');
}

function statementXml(frontMatter: FrontMatter): string {
  const title = valueOr(frontMatter.title, '…………………………');
  const paragraphStyle = { align: 'left' as const, after: 120 };
  return [
    pageTitle('HALAMAN PERNYATAAN'),
    paragraph('Yang bertanda tangan di bawah ini:', paragraphStyle),
    paragraph(`Nama: ${valueOr(frontMatter.author)}`, { align: 'left', after: 60 }),
    paragraph(`NIM: ${valueOr(frontMatter.nim)}`, { align: 'left', after: 60 }),
    paragraph(`${hasProgramPrefix(frontMatter.program) ? '' : 'Program Studi: '}${valueOr(frontMatter.program)}`, { align: 'left', after: 60 }),
    paragraph(`Fakultas: ${facultyName(frontMatter.faculty)}`, { align: 'left', after: 240 }),
    paragraph(
      `Menyatakan bahwa skripsi yang berjudul "${title}" adalah hasil karya saya sendiri, bukan plagiarisme, dan semua sumber yang dikutip telah disebutkan dalam daftar pustaka. Apabila di kemudian hari terbukti terdapat plagiarisme dalam skripsi ini, saya bersedia menerima sanksi sesuai ketentuan yang berlaku.`,
      { align: 'left', after: 180 },
    ),
    paragraph('Demikian pernyataan ini saya buat dengan sebenarnya.', {
      align: 'left',
      after: 720,
    }),
    paragraph(`${valueOr(frontMatter.city)}, ${valueOr(frontMatter.year)}`, {
      align: 'right',
      after: 960,
    }),
    paragraph(valueOr(frontMatter.author), { align: 'right', after: 60 }),
    paragraph(`NIM ${valueOr(frontMatter.nim)}`, { align: 'right', after: 0 }),
  ].join('');
}

const TABLE_WIDTHS = [2834, 2834, 2836];

function tableRow(
  cells: string[],
  options: { bold?: boolean; height?: number } = {},
): string {
  const rowPr =
    options.height !== undefined
      ? `<w:trPr><w:trHeight w:val="${options.height}" w:hRule="atLeast"/></w:trPr>`
      : '';
  const cellsXml = cells
    .map((text, index) => {
      const width = TABLE_WIDTHS[index] ?? 2834;
      return (
        `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/><w:vAlign w:val="center"/></w:tcPr>` +
        `${paragraph(text, { align: 'center', bold: options.bold, size: 24 })}</w:tc>`
      );
    })
    .join('');
  return `<w:tr>${rowPr}${cellsXml}</w:tr>`;
}

function approvalTable(frontMatter: FrontMatter): string {
  const borders = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
    .map((side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="000000"/>`)
    .join('');
  const rows = [
    tableRow(['Pembimbing I', 'Pembimbing II', 'Ketua Program Studi'], { bold: true }),
    tableRow(['', '', ''], { height: 1600 }),
    tableRow(
      [
        valueOr(frontMatter.supervisor1),
        valueOr(frontMatter.supervisor2),
        PLACEHOLDER,
      ],
      { height: 360 },
    ),
    tableRow(['NIP. ……………', 'NIP. ……………', 'NIP. ……………'], { height: 360 }),
  ].join('');
  return (
    '<w:tbl><w:tblPr><w:tblW w:w="8504" w:type="dxa"/><w:jc w:val="center"/>' +
    `<w:tblBorders>${borders}</w:tblBorders><w:tblLayout w:type="fixed"/>` +
    '<w:tblCellMar><w:top w:w="40" w:type="dxa"/><w:left w:w="108" w:type="dxa"/>' +
    '<w:bottom w:w="40" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar>' +
    '</w:tblPr><w:tblGrid><w:gridCol w:w="2834"/><w:gridCol w:w="2834"/>' +
    `<w:gridCol w:w="2836"/></w:tblGrid>${rows}</w:tbl>`
  );
}

function approvalXml(frontMatter: FrontMatter): string {
  const title = valueOr(frontMatter.title, '…………………………');
  const author = valueOr(frontMatter.author);
  const nim = valueOr(frontMatter.nim);
  return [
    pageTitle('HALAMAN PENGESAHAN'),
    paragraph(
      `Skripsi berjudul "${title}" yang disusun oleh ${author} (NIM ${nim}) telah diperiksa dan disetujui untuk diujikan.`,
      { align: 'left', after: 360 },
    ),
    approvalTable(frontMatter),
  ].join('');
}

const TOC_FIELD =
  '<w:p><w:r><w:fldChar w:fldCharType="begin" w:dirty="true"/></w:r>' +
  '<w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" \\h \\z \\u </w:instrText></w:r>' +
  '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
  '<w:r><w:t>Daftar isi akan terisi otomatis saat dokumen dibuka di Microsoft Word.</w:t></w:r>' +
  '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>';

function listParagraphs(entries: CaptionEntry[], emptyText: string): string {
  if (entries.length === 0) {
    return paragraph(emptyText, { align: 'left', after: 60 });
  }
  return entries
    .map((entry) => paragraph(captionLabel(entry), { align: 'left', after: 60 }))
    .join('');
}

function bodyMarkerXml(): string {
  return `<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/></w:pPr>` +
    `<w:r><w:t>${DOCX_BODY_MARKER}</w:t></w:r></w:p>`;
}

export type DocxChapterInput = { path: string; markdown: string };

export type DocxBuildInput = {
  frontMatter: FrontMatter;
  abstract: { heading: string; body: string } | null;
  chapters: DocxChapterInput[];
  tables: CaptionEntry[];
  figures: CaptionEntry[];
};

/**
 * Markdown gabungan untuk DOCX:
 * - halaman depan memakai raw openxml (cover, pernyataan, pengesahan, daftar)
 * - TOC berupa field asli, diisi Word saat dokumen dibuka
 * - penanda `DOCX_BODY_MARKER` diproses jadi section break oleh applyThesisLayout
 */
export function buildDocxMarkdown(input: DocxBuildInput): string {
  const chunks: string[] = [];
  const front = [
    coverXml(input.frontMatter),
    PAGE_BREAK,
    statementXml(input.frontMatter),
    PAGE_BREAK,
    approvalXml(input.frontMatter),
    PAGE_BREAK,
  ].join('');
  chunks.push(openxmlBlock(front));

  const tocAndLists = [
    pageTitle('DAFTAR ISI'),
    TOC_FIELD,
    PAGE_BREAK,
    pageTitle('DAFTAR TABEL'),
    listParagraphs(input.tables, 'Belum ada tabel.'),
    PAGE_BREAK,
    pageTitle('DAFTAR GAMBAR'),
    listParagraphs(input.figures, 'Belum ada gambar.'),
    bodyMarkerXml(),
  ].join('');

  if (input.abstract) {
    chunks.push(openxmlBlock(pageTitle(input.abstract.heading)));
    if (input.abstract.body.trim().length > 0) chunks.push(input.abstract.body.trim());
    chunks.push(openxmlBlock([PAGE_BREAK, tocAndLists].join('')));
  } else {
    chunks.push(openxmlBlock(tocAndLists));
  }

  input.chapters.forEach((chapter, index) => {
    if (index > 0) chunks.push(openxmlBlock(PAGE_BREAK));
    chunks.push(chapter.markdown.trimEnd());
  });

  return `${chunks.join('\n\n')}\n`;
}

const SECTPR_ORDER = [
  'headerReference',
  'footerReference',
  'footnotePr',
  'endnotePr',
  'type',
  'pgSz',
  'pgMar',
  'paperSrc',
  'pgBorders',
  'lnNumType',
  'pgNumType',
  'cols',
  'formProt',
  'vAlign',
  'noEndnote',
  'titlePg',
  'textDirection',
  'bidi',
  'rtlGutter',
  'docGrid',
  'printerSettings',
  'sectPrChange',
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function upsertSectPrChild(sectPr: string, name: string, child: string): string {
  const existing = new RegExp(`<w:${name}\\b[^>]*/>`);
  if (existing.test(sectPr)) return sectPr.replace(existing, child);

  const order = SECTPR_ORDER.indexOf(name);
  for (let index = order + 1; index < SECTPR_ORDER.length; index += 1) {
    const next = new RegExp(`<w:${SECTPR_ORDER[index]}\\b`);
    const match = next.exec(sectPr);
    if (match) return sectPr.slice(0, match.index) + child + sectPr.slice(match.index);
  }
  const close = sectPr.lastIndexOf('</w:sectPr>');
  return sectPr.slice(0, close) + child + sectPr.slice(close);
}

function extractBodySectPr(xml: string): { start: number; end: number; xml: string } | null {
  const start = xml.lastIndexOf('<w:sectPr');
  if (start < 0) return null;
  const close = xml.indexOf('</w:sectPr>', start);
  if (close < 0) return null;
  const end = close + '</w:sectPr>'.length;
  return { start, end, xml: xml.slice(start, end) };
}

function nextFooterName(zip: JSZip): string {
  for (let index = 1; index <= 64; index += 1) {
    if (!zip.file(`word/footer${index}.xml`)) return `footer${index}.xml`;
  }
  throw new Error('Tidak ada slot footer kosong');
}

function footerXml(): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<w:p><w:pPr><w:spacing w:before="0" w:after="0"/><w:jc w:val="center"/></w:pPr>' +
    '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
    '<w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>' +
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
    '<w:r><w:t>1</w:t></w:r>' +
    '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:ftr>'
  );
}

function addFooterRelationship(rels: string, footerName: string, relId: string): string {
  const relationship =
    `<Relationship Id="${relId}" ` +
    'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" ' +
    `Target="${footerName}"/>`;
  if (rels.includes('</Relationships>')) {
    return rels.replace('</Relationships>', `${relationship}</Relationships>`);
  }
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    `${relationship}</Relationships>`
  );
}

function addFooterContentType(types: string, footerName: string): string {
  const partName = `/word/${footerName}`;
  if (types.includes(`PartName="${partName}"`)) return types;
  const override =
    `<Override PartName="${partName}" ` +
    'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>';
  if (types.includes('</Types>')) return types.replace('</Types>', `${override}</Types>`);
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    `${override}</Types>`
  );
}

function enableUpdateFields(settings: string): string {
  if (settings.includes('w:updateFields')) return settings;
  const element = '<w:updateFields w:val="true"/>';
  for (const anchor of ['savePreviewPicture', 'characterSpacingControl']) {
    const match = new RegExp(`<w:${anchor}\\b[^>]*/>`).exec(settings);
    if (match) {
      const at = match.index + match[0].length;
      return settings.slice(0, at) + element + settings.slice(at);
    }
  }
  return settings.replace('</w:settings>', `${element}</w:settings>`);
}

export type DocxLayoutResult = {
  bytes: Buffer;
  markerFound: boolean;
};

/**
 * Dua section + nomor halaman:
 * - section depan: `w:pgNumType w:fmt="lowerRoman"`
 * - section isi: `w:pgNumType w:fmt="decimal" w:start="1"`
 * - footer berisi field PAGE dipakai kedua section.
 */
export type CoverLogoInput = { buffer: Buffer; ext: 'png' | 'jpg' };

export async function applyThesisLayout(
  docx: Buffer,
  marker = DOCX_BODY_MARKER,
  logo?: CoverLogoInput | null,
): Promise<DocxLayoutResult> {
  const zip = await JSZip.loadAsync(docx);
  const documentFile = zip.file('word/document.xml');
  if (!documentFile) throw new Error('DOCX tidak punya word/document.xml');
  let xml = await documentFile.async('string');

  const bodySect = extractBodySectPr(xml);
  if (!bodySect) throw new Error('DOCX tidak punya sectPr');


  const relsFile = zip.file('word/_rels/document.xml.rels');
  const rels = relsFile ? await relsFile.async('string') : '';

  let relId = 'rIdFooter1';
  for (let index = 1; index <= 999; index += 1) {
    relId = `rIdFooter${index}`;
    if (!rels.includes(`Id="${relId}"`)) break;
  }

  const footerName = nextFooterName(zip);
  const footerReference = `<w:footerReference w:type="default" r:id="${relId}"/>`;
  const frontSect = upsertSectPrChild(
    upsertSectPrChild(
      upsertSectPrChild(bodySect.xml, 'footerReference', footerReference),
      'type',
      '<w:type w:val="nextPage"/>',
    ),
    'pgNumType',
    '<w:pgNumType w:fmt="lowerRoman"/>',
  );
  const bodySectPatched = upsertSectPrChild(
    upsertSectPrChild(bodySect.xml, 'footerReference', footerReference),
    'pgNumType',
    '<w:pgNumType w:fmt="decimal" w:start="1"/>',
  );

  xml =
    xml.slice(0, bodySect.start) +
    bodySectPatched +
    xml.slice(bodySect.end);

  const markerPattern = new RegExp(
    `<w:p\\b[^>]*>(?:(?!</w:p>)[\\s\\S])*?${escapeRegExp(marker)}(?:(?!</w:p>)[\\s\\S])*?</w:p>`,
  );
  const markerFound = markerPattern.test(xml);
  if (markerFound) {
    xml = xml.replace(markerPattern, `<w:p><w:pPr>${frontSect}</w:pPr></w:p>`);
  }

  // Logo disisipkan PALING AKHIR: pergeseran indeks dari penyisipan di awal
  // pernah membuat blok sectPr masuk ke tengah teks dan merusak XML.
  if (logo) {
    xml = await insertCoverLogo(zip, xml, logo);
  }

  zip.file('word/document.xml', xml);
  zip.file(`word/${footerName}`, footerXml());
  zip.file('word/_rels/document.xml.rels', addFooterRelationship(rels, footerName, relId));

  const typesFile = zip.file('[Content_Types].xml');
  if (typesFile) {
    zip.file('[Content_Types].xml', addFooterContentType(await typesFile.async('string'), footerName));
  }
  const settingsFile = zip.file('word/settings.xml');
  if (settingsFile) {
    zip.file('word/settings.xml', enableUpdateFields(await settingsFile.async('string')));
  }

  const bytes = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
  return { bytes, markerFound };
}

const EMU_PER_CM = 360_000;
const LOGO_HEIGHT_EMU = Math.round(2.5 * EMU_PER_CM);
const LOGO_MAX_WIDTH_EMU = Math.round(8 * EMU_PER_CM);

/**
 * Sisipkan logo di paling atas sampul DOCX.
 *
 * Word tidak bisa menampilkan gambar tanpa entri media + relasi, jadi ketiganya
 * ditulis sekaligus: berkas di `word/media`, relasi di `document.xml.rels`, dan
 * elemen drawing di awal `<w:body>`.
 */
async function insertCoverLogo(
  zip: JSZip,
  xml: string,
  logo: CoverLogoInput,
): Promise<string> {
  const size = imageSize(logo.buffer) ?? { width: 600, height: 600 };
  const ratio = size.width > 0 && size.height > 0 ? size.width / size.height : 1;
  const cy = LOGO_HEIGHT_EMU;
  const cx = Math.min(LOGO_MAX_WIDTH_EMU, Math.round(cy * ratio));

  const mediaName = `cover-logo.${logo.ext === 'jpg' ? 'jpeg' : 'png'}`;
  zip.file(`word/media/${mediaName}`, logo.buffer);

  const relsPath = 'word/_rels/document.xml.rels';
  const relsFile = zip.file(relsPath);
  const rels = relsFile ? await relsFile.async('string') : '';
  let relId = 'rIdCoverLogo1';
  for (let index = 1; index <= 999; index += 1) {
    relId = `rIdCoverLogo${index}`;
    if (!rels.includes(`Id="${relId}"`)) break;
  }
  const rel = `<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${mediaName}"/>`;
  const relsNext = rels.includes('</Relationships>')
    ? rels.replace('</Relationships>', `${rel}</Relationships>`)
    : `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rel}</Relationships>`;
  zip.file(relsPath, relsNext);

  const contentType = logo.ext === 'jpg' ? 'image/jpeg' : 'image/png';
  const ctFile = zip.file('[Content_Types].xml');
  if (ctFile) {
    const ct = await ctFile.async('string');
    const ext = logo.ext === 'jpg' ? 'jpg' : 'png';
    if (!ct.includes(`Extension="${ext}"`)) {
      zip.file(
        '[Content_Types].xml',
        ct.replace('</Types>', `<Default Extension="${ext}" ContentType="${contentType}"/></Types>`),
      );
    }
  }

  const drawing =
    '<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="0" w:after="0"/></w:pPr><w:r><w:drawing>' +
    '<wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"' +
    ` distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/>` +
    `<wp:docPr id="900" name="Logo Sampul"/><wp:cNvGraphicFramePr/>` +
    '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
    '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    `<pic:nvPicPr><pic:cNvPr id="900" name="${mediaName}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic>' +
    '</wp:inline></w:drawing></w:r></w:p>';

  // Setelah <w:body>, sebelum paragraf pertama (sampul).
  return xml.replace(/(<w:body>)/, `$1${drawing}`);
}
