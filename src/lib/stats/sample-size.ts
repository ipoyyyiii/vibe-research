/**
 * Kalkulator ukuran sampel untuk Bab 3 (Metodologi Penelitian).
 *
 * Tiga rumus yang paling sering diminta pembimbing: Slovin, Cochran (dengan
 * koreksi populasi terbatas), dan Isaac & Michael. Semua fungsi murni angka →
 * angka tanpa I/O, supaya bisa dites langsung dari node.
 *
 * Konvensi pembulatan: SELALU ke atas. Ukuran sampel pecahan (mis. 79,51)
 * tidak boleh dibulatkan ke bawah karena jumlah responden jadi lebih kecil
 * dari yang dijanjikan margin error. Toleransi 1e-9 hanya untuk membuang galat
 * float (80.00000000000001 tetap 80) dan tidak menelan kasus 80.0000001 → 81.
 */

export type SampleMethod = 'slovin' | 'cochran' | 'isaac-michael';

export type SampleOptions = {
  z?: number;
  p?: number;
  marginOfError?: number;
};

export type SampleSizeRow = {
  method: SampleMethod;
  n: number;
  formula: string;
  assumption: string;
  whenToUse: string;
};

export type SampleSizeInput = {
  population: number;
  marginOfError: number;
  z?: number;
  p?: number;
  /** Judul tabel; default dibuat otomatis dari N, e, z, dan p. */
  title?: string;
};

const DEFAULT_Z = 1.96;
const DEFAULT_P = 0.5;
const DEFAULT_E = 0.05;
/** Selisih aman pembulatan: cukup kecil agar 80.0000001 → 81 tetap terdeteksi. */
const EPSILON = 1e-9;

const METHOD_LABEL: Record<SampleMethod, string> = {
  slovin: 'Slovin',
  cochran: 'Cochran',
  'isaac-michael': 'Isaac–Michael',
};

function assertPopulation(population: number): void {
  if (typeof population !== 'number' || !Number.isFinite(population) || population <= 0) {
    throw new Error(
      `Populasi (N) harus berupa angka lebih besar dari 0, diterima: ${String(population)}.`,
    );
  }
}

function assertMarginOfError(marginOfError: number): void {
  if (!Number.isFinite(marginOfError) || marginOfError <= 0 || marginOfError >= 1) {
    throw new Error(
      `Margin of error (e) harus lebih besar dari 0 dan lebih kecil dari 1, diterima: ${String(marginOfError)}.`,
    );
  }
}

function assertProportion(p: number): void {
  if (!Number.isFinite(p) || p <= 0 || p >= 1) {
    throw new Error(
      `Proporsi populasi (p) harus lebih besar dari 0 dan lebih kecil dari 1, diterima: ${String(p)}.`,
    );
  }
}

function assertZ(z: number): void {
  if (!Number.isFinite(z) || z <= 0) {
    throw new Error(`Nilai z harus berupa angka lebih besar dari 0, diterima: ${String(z)}.`);
  }
}

/** Pembulatan ke atas + jaga hasil tetap bilangan hingga dan minimal 1 responden. */
function ceilUp(value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error('Perhitungan ukuran sampel menghasilkan nilai tak hingga; periksa input.');
  }
  return Math.max(1, Math.ceil(value - EPSILON));
}

/** Angka gaya Indonesia untuk tabel/paragraf ("0,05" bukan "0.05"). */
function formatNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toFixed(4))).replace('.', ',');
}

/** Sebut tingkat kepercayaan hanya kalau z-nya memang nilai baku yang dikenal. */
function confidencePhrase(z: number): string {
  const standard: Array<[number, string]> = [
    [1.28, '80%'],
    [1.645, '90%'],
    [1.96, '95%'],
    [2.576, '99%'],
    [2.58, '99%'],
  ];
  const match = standard.find(([value]) => Math.abs(z - value) < 0.005);
  return match
    ? `tingkat kepercayaan ${match[1]} (z = ${formatNumber(z)})`
    : `nilai z = ${formatNumber(z)} yang ditetapkan peneliti`;
}

/** p = 0,5 adalah pilihan konservatif; nilai lain dianggap estimasi peneliti. */
function proportionPhrase(p: number): string {
  return p === 0.5
    ? 'proporsi populasi p = 0,5 (paling konservatif karena memberi varians maksimum)'
    : `proporsi populasi p = ${formatNumber(p)} hasil estimasi peneliti`;
}

/** n = N / (1 + N·e²) — Slovin. */
export function slovin(population: number, marginOfError: number): number {
  assertPopulation(population);
  assertMarginOfError(marginOfError);
  return ceilUp(population / (1 + population * marginOfError * marginOfError));
}

/**
 * n0 = z²·p(1-p)/e² → n = n0 / (1 + (n0-1)/N).
 * Tanpa `population` (null) hasilnya n0 murni untuk populasi tak terbatas.
 */
export function cochran(
  population: number | null = null,
  options: SampleOptions = {},
): number {
  const z = options.z ?? DEFAULT_Z;
  const p = options.p ?? DEFAULT_P;
  const marginOfError = options.marginOfError ?? DEFAULT_E;

  assertZ(z);
  assertProportion(p);
  assertMarginOfError(marginOfError);
  if (population !== null) assertPopulation(population);

  const n0 = (z * z * p * (1 - p)) / (marginOfError * marginOfError);
  if (population === null) return ceilUp(n0);
  return ceilUp(n0 / (1 + (n0 - 1) / population));
}

/** n = (z²·N·p(1-p)) / (e²·(N-1) + z²·p(1-p)) — Isaac & Michael. */
export function isaacMichael(population: number, options: SampleOptions = {}): number {
  const z = options.z ?? DEFAULT_Z;
  const p = options.p ?? DEFAULT_P;
  const marginOfError = options.marginOfError ?? DEFAULT_E;

  assertPopulation(population);
  assertZ(z);
  assertProportion(p);
  assertMarginOfError(marginOfError);

  const numerator = z * z * population * p * (1 - p);
  const denominator =
    marginOfError * marginOfError * (population - 1) + z * z * p * (1 - p);
  return ceilUp(numerator / denominator);
}

/** Tiga baris siap ditampilkan di panel atau diekspor ke tabel markdown. */
export function sampleSizeTable(
  population: number,
  marginOfError: number,
  options: { z?: number; p?: number } = {},
): SampleSizeRow[] {
  const z = options.z ?? DEFAULT_Z;
  const p = options.p ?? DEFAULT_P;

  assertPopulation(population);
  assertMarginOfError(marginOfError);
  assertZ(z);
  assertProportion(p);

  const errorPhrase = `margin error e = ${formatNumber(marginOfError)}`;

  return [
    {
      method: 'slovin',
      n: slovin(population, marginOfError),
      formula: 'n = N / (1 + N·e²)',
      assumption: `Populasi terbatas dengan kerangka populasi jelas; tidak mensyaratkan distribusi normal maupun asumsi proporsi; ${errorPhrase}.`,
      whenToUse:
        'Survei dengan daftar populasi jelas (siswa, mahasiswa, pegawai) dan peneliti menetapkan margin error sendiri; paling lazim dipakai di skripsi Indonesia.',
    },
    {
      method: 'cochran',
      n: cochran(population, { z, p, marginOfError }),
      formula: 'n0 = z²·p(1-p)/e²; n = n0 / (1 + (n0-1)/N)',
      assumption: `Populasi terbatas; ${proportionPhrase(p)}; ${confidencePhrase(z)}; ${errorPhrase}; koreksi populasi terbatas dipakai karena N diketahui.`,
      whenToUse:
        'Populasi besar atau kerangkanya belum pasti; dipakai saat peneliti ingin dasar statistik proporsi yang eksplisit, bukan sekadar konvensi.',
    },
    {
      method: 'isaac-michael',
      n: isaacMichael(population, { z, p, marginOfError }),
      formula: 'n = (z²·N·p(1-p)) / (e²·(N-1) + z²·p(1-p))',
      assumption: `Populasi terbatas; ${proportionPhrase(p)}; ${confidencePhrase(z)}; ${errorPhrase}; setara Cochran + koreksi populasi terbatas.`,
      whenToUse:
        'Sama seperti Cochran, tetapi rumusnya langsung memuat N sehingga tidak perlu menghitung dua tahap dan lebih ringkas dikutip di Bab 3.',
    },
  ];
}

/** Sel tabel markdown: pipa dan newline akan merusak kolom. */
function markdownCell(value: string): string {
  return value.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
}

/**
 * Tabel markdown 4 kolom + satu paragraf catatan pemilihan metode, siap
 * ditempel ke Bab 3. Angka pada paragraf diambil dari perhitungan yang sama
 * dengan tabel supaya narasi dan tabel tidak pernah bertentangan.
 */
export function sampleSizeMarkdown(input: SampleSizeInput): string {
  const { population, marginOfError } = input;
  const z = input.z ?? DEFAULT_Z;
  const p = input.p ?? DEFAULT_P;

  const rows = sampleSizeTable(population, marginOfError, { z, p });
  const byMethod = new Map(rows.map((row) => [row.method, row.n]));
  const recommended = Math.max(...rows.map((row) => row.n));
  const errorPhrase = `margin error e = ${formatNumber(marginOfError)}`;

  const title =
    input.title ??
    `**Tabel 3.1** Perbandingan Perhitungan Ukuran Sampel (N = ${formatNumber(population)}; e = ${formatNumber(marginOfError)}; z = ${formatNumber(z)}; p = ${formatNumber(p)})`;

  const lines = [
    title,
    '',
    '| Metode | Rumus | Asumsi | n |',
    '| --- | --- | --- | --- |',
    ...rows.map(
      (row) =>
        `| ${markdownCell(METHOD_LABEL[row.method])} | ${markdownCell(row.formula)} | ${markdownCell(row.assumption)} | ${row.n} |`,
    ),
    '',
    [
      `Catatan pemilihan metode. Ketiga pendekatan dihitung pada ${errorPhrase} yang sama; untuk Cochran dan Isaac–Michael dipakai ${proportionPhrase(p)} serta ${confidencePhrase(z)}, sehingga Slovin menghasilkan n = ${byMethod.get('slovin') ?? recommended}, sedangkan Cochran dan Isaac–Michael yang secara matematis setara menghasilkan n = ${byMethod.get('cochran') ?? recommended} setelah koreksi populasi terbatas untuk N = ${formatNumber(population)}.`,
      `Slovin dipilih apabila peneliti mengikuti konvensi penulisan skripsi di Indonesia dan hanya membutuhkan angka populasi serta margin error, sementara Cochran atau Isaac–Michael lebih mudah dipertanggungjawabkan secara statistik karena asumsi proporsi dan koreksi populasi terbatas dinyatakan eksplisit.`,
      `Untuk penelitian ini digunakan ukuran sampel minimal n = ${recommended} responden, yaitu nilai terbesar dari ketiga perhitungan yang telah dibulatkan ke atas sehingga jumlah responden tetap memenuhi margin error yang ditetapkan.`,
    ].join(' '),
  ];

  return lines.join('\n');
}
