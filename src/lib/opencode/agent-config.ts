import fs from 'node:fs';
import path from 'node:path';
import { listTree, type TreeEntry } from '@/lib/workspace/files';

/**

/**
 * Persona + izin agent per project.
 *
 * Server OpenCode (v2) membaca config project dari `<project>/.opencode/opencode.json`
 * saat session dibuat dengan `location.directory` = folder project.
 * File persona instruksi = `<project>/AGENTS.md` (standar OpenCode).
 */

export type { TreeEntry };

/** Toggles kemampuan per project (disimpan di opencode.json, bukan DB — ini config agent). */
export type AgentCapabilities = { websearch: boolean; literature: boolean };

const CAPS_DEFAULT: AgentCapabilities = { websearch: false, literature: false };

/**
 * Key `research-desk` di opencode.json project = NAMA FORMAT LAMA, sengaja
 * dipertahankan. App sekarang bernama "Vibe Research", tapi key ini format
 * data di disk: diganti, seluruh project yang toggle-nya udah tersimpan
 * kehilangan setting-nya. Nama tampilan boleh berubah, key format tidak.
 */
export function readProjectCapabilities(folderPath: string): AgentCapabilities {
  try {
    const file = path.join(folderPath, '.opencode', 'opencode.json');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      agent?: { thesis?: { tools?: Record<string, boolean> } };
      'research-desk'?: { capabilities?: Partial<AgentCapabilities> };
    };
    const caps = parsed['research-desk']?.capabilities ?? {};
    return {
      websearch: caps.websearch ?? parsed.agent?.thesis?.tools?.websearch ?? CAPS_DEFAULT.websearch,
      literature: caps.literature ?? CAPS_DEFAULT.literature,
    };
  } catch {
    return { ...CAPS_DEFAULT };
  }
}

/** Blok kemampuan dikelola app di AGENTS.md (antara marker ini, boleh ditimpa). */
function capabilitiesBlock(caps: AgentCapabilities): string[] {
  const head = '<!-- research-desk:capabilities:start -->';
  const tail = '<!-- research-desk:capabilities:end -->';
  const lines: string[] = [head, '## Kemampuan AI (dikelola Vibe Research)'];
  if (caps.literature) {
    lines.push(
      '- **Pencarian jurnal AKTIF.** Pakai tool shell/execute untuk HTTP GET ke API publik:',
      '  - OpenAlex: `https://api.openalex.org/works?search=<kata-kunci>&per-page=5`',
      '  - Crossref: `https://api.crossref.org/works?query=<kata-kunci>&rows=5`',
      '  - Semantic Scholar: `https://api.semanticscholar.org/graph/v1/paper/search?fields=title,authors,year,externalIds,citationCount,abstract&query=<kata-kunci>`',
      '  - WAJIB sebut: judul, penulis, tahun, DOI, jumlah sitasi. JANGAN mengarang metadata; kalau data gak ada, bilang gak ada.',
      '  - Kalau ada abstrak, BACA dulu baru rekomendasiin (jangan asal judul).',
      '  - Untuk SETIAP paper yang direkomendasikan, sertakan satu blok berpagar supaya UI bisa menampilkan kartu (buka PDF + drag ke file manager):',
      '    ```vibe-journal',
      '    {"doi":"10.xxxx/xxxx","title":"Judul paper","authors":["Nama 1","Nama 2"],"year":2024,"venue":"Nama jurnal","openAccessUrl":"https://...pdf"}',
      '    ```',
      '    Blok ini hanya untuk UI — JANGAN menyalinnya ke file bab.',
    );
  } else {
    lines.push(
      '- **Pencarian jurnal MATI.** Kalau user minta nyari jurnal, bilang bahwa fitur itu belum dinyalakan dan sarankan menyalakannya di panel "Kemampuan AI" (ikon slider di header chat). JANGAN manggil API jurnal.',
    );
  }
  if (caps.websearch) {
    lines.push(
      '- **Web search AKTIF.** Tool `websearch` boleh dipakai buat fakta umum terkini. Sertakan sumber/URL di jawaban.',
    );
  } else {
    lines.push('- **Web search MATI.** Jangan pakai tool `websearch`.');
  }
  lines.push(tail);
  return lines;
}

/** Tulis ulang persona/permissions project (idempotent, dipanggil saat ensure session). */
export function ensureProjectAgentConfig(
  folderPath: string,
  capsInput?: Partial<AgentCapabilities>,
): AgentCapabilities {
  try {
    // Toggles: param (dari UI) > file existing > default. Merge biar gak ada yang balik default diam-diam.
    const existing = readProjectCapabilities(folderPath);
    const caps: AgentCapabilities = {
      websearch: capsInput?.websearch ?? existing.websearch,
      literature: capsInput?.literature ?? existing.literature,
    };

    const dir = path.join(folderPath, '.opencode');
    fs.mkdirSync(dir, { recursive: true });

    // Baca config existing dulu — app CUMA pegang $schema, research-desk, dan
    // agent.thesis. Semua key lain (mcp, skills, plugins, provider, dsb.) yang
    // ditulis manual/user/instaler HARUS kejaga — jangan full-replace.
    const configPath = path.join(dir, 'opencode.json');
    let previous: Record<string, unknown> = {};
    try {
      previous = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    } catch {
      previous = {};
    }

    const config: Record<string, unknown> = { ...previous };
    config['$schema'] = 'https://opencode.ai/config.json';
    config['research-desk'] = {
      ...((previous['research-desk'] as Record<string, unknown> | undefined) ?? {}),
      capabilities: caps,
    };
    config.agent = {
      ...((previous.agent as Record<string, unknown> | undefined) ?? {}),
      thesis: {
          description: 'Asisten penulis skripsi — baca/tulis berkas project, cari jurnal, pasang sitasi',
          prompt:
            'Kamu "Thesis", asisten penulis skripsi di aplikasi research-desk. ' +
            'Bahasa pengguna: Indonesia santai-tapi-rapi. ' +
            'ATURAN: (1) Untuk sitasi, SELALU gunakan kunci bibliografi yang ada di references.bib — jangan pernah mengarang nomor sitasi. ' +
            '(2) Untuk merevisi isi dokumen, edit file markdown di folder dokumen/ secara konservatif (replace terhadap teks yang ada, bukan tulis ulang seluruh bab) dan sebut nama file yang kamu ubah. ' +
            '(3) Sebelum menambah jurnal, tampilkan singkat: judul, penulis, tahun, DOI, jumlah sitasi — jangan asal comot. ' +
            '(4) Kamu boleh membaca/mengubah berkas di dalam folder project ini saja. ' +
            '(5) Jawab singkat dan terstruktur; kalau konteks dari dossier tidak jelas, gunakan tool `question` (pilihan user datang balik sebagai jawaban di chat); kalau pertanyaannya longgar/tidak berpilihan, tanyakan lewat teks biasa juga boleh. ' +
            '(6) GAYA TULIS DALAM FILE WAJIB akademik formal: tanpa kata basa-basi/sampah (yuuhuuuu, wkwk, cok, lol, test, placeholder, emoji), tanpa kalimat gantung ellipsis "…" — kalimat harus selesai dan padat. ' +
            '(7) JANGAN PERNAH menulis daftar pustaka atau sitasi bernomor ([1], [Vaswani 2017]) ke dalam file bab — sitasi cukup ditulis marker [@kunci]; daftar pustaka dibikin otomatis saat ekspor (pandoc citeproc). ' +
            '(8) JANGAN PERNAH menulis catatan metadata (blok kutip "> Catatan sumber:", DOI notes, dsb.) ke dalam file bab — metadata sumber cukup tersimpan di references.bib; penjelasan panjang cukup dikirim ke chat. ' +
            '(9) FORMAT JUDUL BAB: baris pertama `# BAB I` (angka Romawi), baris kedua `# PENDAHULUAN` (huruf besar) — tanpa tanda "·", tanpa kalimat lain nyangkut di heading; tinggalkan baris kosong antar-heading sebelum isi. ' +
            '(10) INSTALL SKILL (kalau user minta): bikin folder `<project>/.opencode/skills/<nama>/SKILL.md` — nama HARUS huruf kecil/angka/tanda hubung (tanpa spasi, maksimal 64 char) dan SAMA dengan nama foldernya; file diawali YAML frontmatter berisi `name:` + `description:` (maks 1024 char, spesifik) lalu isi instruksi. Skill itu muncul di tool `skill` untuk sesi baru; kalau belum muncul, sarankan user mulai sesi baru. ' +
            '(11) ADD MCP SERVER (kalau user minta): edit `.opencode/opencode.json` di project ini — BACA dulu isinya lalu gabungkan key `mcp` baru (JANGAN menimpa key lain; config ini juga menampung pengaturan research-desk). Format lokal: {"type":"local","command":["npx","-y","<paket>"],"enabled":true}; remote: {"type":"remote","url":"https://...","enabled":true}. MCP baru biasanya aktif untuk sesi baru; kalau tool-nya belum terlihat, sarankan user mulai sesi baru atau muat ulang app. ' +
            '(12) ANALISIS DATA & STATISTIK: data mentah di `data/` JANGAN PERNAH diubah/ditimpa — selalu baca saja; skrip reproduksibel ditulis di `scripts/`, hasil ke `hasil/` (baru dibuat kalau perlu). Skrip standar `scripts/uji-statistik.py` membaca xlsx/csv dan mencetak laporan markdown. Kalau dependency Python belum ada, sekali saja: `python3 -m venv .venv && .venv/bin/pip install pandas scipy statsmodels openpyxl`, lalu jalankan `.venv/bin/python scripts/uji-statistik.py --data data/<file>`. Laporkan angka NYATA dari output skrip; jangan mengarang hasil statistik, dan sebut jumlah data yang dibuang karena missing value. ' +
            '(13) GAMBAR & PDF: berkas gambar (gambar/*.png|jpg|jpeg|webp) bisa DILIHAT langsung pakai tool read — lihat dulu isinya sebelum berkomentar. PDF di referensi/ boleh dibaca/diekstrak teksnya. Jangan pernah mengarang isi gambar atau PDF; kalau gagal dibaca, bilang gagal. ' +
            '(14) NASKAH DI TAB WORD: file .md adalah versi kanonik. Perubahan yang belum disimpan di WordCraft belum ada di disk — kalau user bilang baru mengedit di tab Word, sarankan simpan (Save to chapter) dulu sebelum kamu menyunting file yang sama. ' +
            'Kemampuan web/jurnal ikuti blok "Kemampuan AI" di AGENTS.md — kalau dimatikan, jangan coba-coba.',
          // Tool `question` AKTIF (kartu pertanyaan implement, probe Lane C
          // 2026-10-19 di /tmp/opencode/question-probe): agent tool `question`
          // → event `form.created` (metadata.kind=question) → app jawab via
          // session.form.reply/cancel → terbukti agent lanjut turn, tidak hang
          // lagi (kasus 2026-10-18). websearch ngikutin toggle panel Kemampuan
          // AI (explicit true/false).
          tools: { websearch: caps.websearch },
        },
      };

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    // AGENTS.md = instruksi level project. Blok "Kemampuan AI" DITIMPA idempotent
    // (marker start/end), konten lain di luar marker tetap utuh.
    const agentsDoc = path.join(folderPath, 'AGENTS.md');
    const block = capabilitiesBlock(caps).join('\n');
    if (!fs.existsSync(agentsDoc)) {
      fs.writeFileSync(
        agentsDoc,
        [
          '# Project skripsi',
          '',
          'Dokumen skripsi dalam markdown per-bab di `dokumen/`.',
          'Gunakan agent "thesis" untuk konsultasi, revisi isi, dan sitasi.',
          'Jangan mengubah file di luar folder project.',
          'Analisis data: jalankan Python di dalam project (venv `.venv`); data mentah di `data/` jangan diubah, skrip reproducible di `scripts/`, hasil di `hasil/`.',
          '',
          block,
          '',
        ].join('\n'),
        'utf8',
      );
    } else {
      const raw = fs.readFileSync(agentsDoc, 'utf8');
      const start = raw.indexOf('<!-- research-desk:capabilities:start -->');
      const end = raw.indexOf('<!-- research-desk:capabilities:end -->');
      let next: string;
      if (start >= 0 && end > start) {
        next = raw.slice(0, start) + block + raw.slice(end + '<!-- research-desk:capabilities:end -->'.length);
      } else {
        next = raw.trimEnd() + '\n\n' + block + '\n';
      }
      fs.writeFileSync(agentsDoc, next, 'utf8');
    }
    return caps;
  } catch (error) {
    console.error('[agent-config] gagal menulis config:', error);
    // Gagal nulis → balikin state yang paling akurat: file existing atau default.
    return readProjectCapabilities(folderPath);
  }
}

/**
 * Dossier ringkas — dikirim bersama tiap prompt supaya agent "paham konteks"
 * yang sedang dikerjakan user tanpa user mengulang.
 */
export async function buildDossier(opts: {
  slug: string;
  title: string;
  folderRealPath: string;
  activeFilePath: string | null;
}): Promise<string> {
  const lines: string[] = [];
  lines.push('[KONTEKS OTOMATIS — dossier project]');
  lines.push(`Judul project: ${opts.title}`);
  lines.push(`Folder: ${opts.folderRealPath}`);
  if (opts.activeFilePath) lines.push(`File aktif di editor: ${opts.activeFilePath}`);

  try {
    const tree = await listTree(opts.folderRealPath);
    // Semua berkas yang bisa dipakai agent — bukan cuma teks. Agent harus tahu
    // isi workspace-nya tanpa perlu nebak atau list folder sendiri.
    const usable = tree.filter(
      (entry) =>
        entry.type === 'file' &&
        /\.(md|bib|ris|txt|csv|tsv|xlsx|xls|json|py|ipynb|pdf|png|jpg|jpeg|webp|gif|docx|tex)$/i.test(
          entry.name,
        ),
    );

    if (usable.length > 0) {
      const groups = new Map<string, Array<{ path: string; name: string; size: number }>>();
      for (const file of usable) {
        const top = file.path.includes('/') ? file.path.split('/')[0] : '(root)';
        const list = groups.get(top) ?? [];
        list.push({ path: file.path, name: file.name, size: file.size });
        groups.set(top, list);
      }
      lines.push('Isi workspace (dikelompokkan per folder):');
      for (const [folder, files] of groups) {
        const shown = files
          .slice(0, 12)
          .map((file) => `${file.name} (${formatSize(file.size)})`)
          .join(', ');
        const more = files.length > 12 ? `, … +${files.length - 12} lagi` : '';
        lines.push(`- ${folder}/ [${files.length}]: ${shown}${more}`);
      }
    } else {
      lines.push('Workspace masih kosong (belum ada berkas).');
    }
    lines.push(
      'Cara mengakses:',
      '- dokumen/*.md = naskah bab: baca & edit langsung, pertahankan struktur heading dan marker [@key].',
      '- data/*.xlsx|*.csv = data mentah: baca lewat Python (pandas/openpyxl), JANGAN diubah/ditimpa.',
      '- gambar/*.png|*.jpg = bisa dilihat langsung (tool read); PDF di referensi/ bisa dibaca/ekstrak teksnya.',
      '- scripts/ = skrip reproducible; hasil/ = laporan analisis; referensi/references.bib = daftar pustaka.',
      '- File .docx di export/ adalah hasil ekspor satu arah — jangan dijadikan sumber edit.',
      'Tiru gaya penulisan yang sudah ada di bab lain (panjang kalimat, istilah, cara mengutip); jangan mengubah gaya penulis.',
    );
  } catch {
    lines.push('(Daftar berkas tidak tersedia)');
  }
  lines.push('[AKHIR KONTEKS]');
  return lines.join('\n');
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
