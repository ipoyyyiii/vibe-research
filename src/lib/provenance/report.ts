/**
 * Asal-usul tiap paragraf: ditulis manusia, oleh agen AI, atau awalnya AI lalu
 * diedit manusia.
 *
 * Snapshot di `.riwayat/` menyimpan isi bab SEBELUM sebuah perubahan, beserta
 * alasannya (`agent`, `edit`, `analysis`, …). Jadi perubahan yang menghasilkan
 * keadaan ke-i berasal dari snapshot ke-i: bandingkan isinya dengan keadaan
 * berikutnya, dan paragraf yang baru/muncul berubah dianggap hasil perubahan itu.
 */

export type ProvenanceKind = 'human' | 'agent' | 'edited' | 'unknown';

export type ProvenanceBlock = {
  /** Nomor baris awal paragraf di file sekarang (1-based). */
  line: number;
  text: string;
  kind: ProvenanceKind;
  /** Waktu perubahan terakhir, ISO-8601; null kalau sudah ada sebelum riwayat. */
  at: string | null;
};

export type ProvenanceSummary = {
  total: number;
  human: number;
  agent: number;
  edited: number;
  unknown: number;
};

export type ProvenanceInput = {
  /** Isi snapshot, urut LAMA → BARU. */
  history: Array<{ content: string; reason: string; savedAt: string }>;
  current: string;
};

type Block = { text: string; line: number; key: string };

/** Paragraf = blok dipisah baris kosong; heading ikut dihitung. */
export function paragraphs(markdown: string): Block[] {
  const lines = markdown.split('\n');
  const blocks: Block[] = [];
  let buffer: string[] = [];
  let startLine = 1;

  const flush = () => {
    if (buffer.length === 0) return;
    const text = buffer.join('\n').trim();
    if (text) {
      blocks.push({ text, line: startLine, key: normalize(text) });
    }
    buffer = [];
  };

  lines.forEach((line, index) => {
    if (line.trim() === '') {
      flush();
      return;
    }
    if (buffer.length === 0) startLine = index + 1;
    buffer.push(line);
  });
  flush();
  return blocks;
}

/** Kunci pembanding: tanpa spasi ganda, tanpa penanda format, huruf kecil. */
function normalize(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/[*_`#>|-]/g, '')
    .trim()
    .toLowerCase();
}

/**
 * Pasangkan blok lama & baru (LCS). Dipakai untuk mewariskan asal-usul: paragraf
 * yang ditulis agen lalu dirapikan manusia tetap tercatat berasal dari agen.
 */
function alignBlocks(before: string[], after: string[]): {
  matched: Array<[number, number]>;
  added: number[];
  removed: number[];
} {
  const n = before.length;
  const m = after.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = before[i] === after[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const matched: Array<[number, number]> = [];
  const added: number[] = [];
  const removed: number[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      matched.push([i, j]);
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      removed.push(i);
      i += 1;
    } else {
      added.push(j);
      j += 1;
    }
  }
  while (i < n) removed.push(i++);
  while (j < m) added.push(j++);
  return { matched, added, removed };
}

export function buildProvenance({ history, current }: ProvenanceInput): {
  blocks: ProvenanceBlock[];
  summary: ProvenanceSummary;
} {
  const states = [...history.map((item) => item.content), current];
  /** Asal-usul per indeks blok pada keadaan saat ini (undefined = sebelum riwayat). */
  let origins: Array<string | undefined> = paragraphs(states[0] ?? '').map(() => undefined);
  /** Perubahan terakhir per teks blok. */
  const lastChange = new Map<string, { reason: string; at: string }>();

  for (let index = 0; index < history.length; index += 1) {
    const before = paragraphs(states[index]).map((block) => block.key);
    const afterBlocks = paragraphs(states[index + 1]);
    const after = afterBlocks.map((block) => block.key);
    const { matched, added, removed } = alignBlocks(before, after);

    const next: Array<string | undefined> = new Array(after.length).fill(undefined);
    for (const [beforeIndex, afterIndex] of matched) next[afterIndex] = origins[beforeIndex];

    const replaced = removed.map((item) => origins[item]);
    added.forEach((afterIndex, order) => {
      // Blok pengganti mewarisi asal-usul blok yang digantikannya.
      next[afterIndex] = replaced[order] ?? history[index].reason;
      lastChange.set(after[afterIndex], {
        reason: history[index].reason,
        at: history[index].savedAt,
      });
    });
    origins = next;
  }

  const kindOf = (origin: string | undefined, last: string | undefined): ProvenanceKind => {
    if (!last) return 'unknown';
    if (last === 'agent') return 'agent';
    return origin === 'agent' ? 'edited' : 'human';
  };

  const blocks: ProvenanceBlock[] = [];
  const summary: ProvenanceSummary = { total: 0, human: 0, agent: 0, edited: 0, unknown: 0 };

  paragraphs(current).forEach((block, index) => {
    const change = lastChange.get(block.key);
    const kind = kindOf(origins[index], change?.reason);
    blocks.push({ line: block.line, text: block.text, kind, at: change?.at ?? null });
    summary.total += 1;
    summary[kind] += 1;
  });

  return { blocks, summary };
}
