/** Folder snapshot di dalam project — ikut ke folder thesis, bukan ke DB app. */
export const SNAPSHOT_DIR = '.riwayat';

/**
 * Alasan snapshot — ditentukan pemanggil `saveSnapshot`.
 * - edit     : autosave/simpan manual di editor
 * - agent    : isi bab sebelum direvisi agen
 * - analysis : isi bab sebelum hasil analisis disisipkan
 * - restore  : isi bab sebelum versi lama dipulihkan
 * - reject   : isi bab sebelum revisi agen ditolak
 * - manual   : snapshot manual dari panel Riwayat Versi
 * - word     : isi bab sebelum ditimpa hasil simpan dari tab Word
 */
export type SnapshotReason = 'edit' | 'agent' | 'analysis' | 'restore' | 'reject' | 'manual' | 'word';

export const SNAPSHOT_REASONS: readonly SnapshotReason[] = [
  'edit',
  'agent',
  'analysis',
  'restore',
  'reject',
  'manual',
  'word',
];

/** Metadata satu snapshot — dibaca dari file sidecar `.json` di sebelah snapshot. */
export type SnapshotMeta = {
  /** Path bab relatif ke root project (pemisah '/'). */
  path: string;
  /** Waktu snapshot diambil (ISO-8601). */
  savedAt: string;
  /** Alasan snapshot. */
  reason: SnapshotReason;
  /** Ukuran isi snapshot (byte). */
  bytes: number;
  /** Hash pendek isi snapshot (sha16, 6 hex). */
  hash: string;
  /** Nama file snapshot (di dalam folder bab). */
  file: string;
  /** Folder snapshot bab relatif ke root project, mis. `.riwayat/dokumen__bab1`. */
  dir: string;
};
