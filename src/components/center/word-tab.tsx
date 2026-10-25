'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ExternalLink,
  FileText,
  Loader2,
  PenLine,
  TriangleAlert,
  Upload,
  X,
} from 'lucide-react';
import { useT } from '@/lib/preferences';
import { Button } from '@/components/ui';
import type { BibEntry } from '@/lib/journals/bib';
import { seedWordcraftFonts } from '@/lib/wordcraft/seed-fonts';

type SaveCandidate = { name: string; bytes: ArrayBuffer };

/**
 * Hook yang disuntik KE DALAM iframe WordCraft (same-origin). Dua tugas:
 * (1) ganti showSaveFilePicker dengan picker palsu (handle + writable stream
 *     ajaib) — simpan di Word sukses tanpa dialog, bytes dijemput saat close,
 *     lalu dikirim ke parent (app) via postMessage; (2) jemput anchor-download
 * (ekspor dari dalam Word) TANPA memblokir unduhan aslinya.
 */
const HOOK_SOURCE = `
(() => {
  if (window.__rwHooked) return;
  window.__rwHooked = true;
  // Sinyal "WordCraft siap menerima file": egui baru mendaftarkan handler drop
  // setelah wasm 42MB selesai boot. Selama belum, event drop dilempar sia-sia.
  // Cara cek: kirim dragover sintetis - kalau egui sudah listen, defaultPrevented.
  window.__wcProbeReady = function () {
    try {
      const canvas = document.querySelector('#wordcraft_canvas');
      if (!canvas) return false;
      const ev = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() });
      canvas.dispatchEvent(ev);
      return ev.defaultPrevented;
    } catch (e) { return false; }
  };
  // Lempar file ke canvas WordCraft.
  // WAJIB jalan di realm iframe: DataTransfer/File harus lahir di dokumen yang
  // sama dengan canvas. Dibuat di parent lalu didispatch ke iframe, egui cuma
  // mendaftarkan file-nya (muncul di "Recent") tapi tidak pernah membukanya.
  window.__rwDropFile = function (name, base64) {
    try {
      const raw = atob(base64);
      const u8 = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) u8[i] = raw.charCodeAt(i);
      const dt = new DataTransfer();
      dt.items.add(new File([u8], name, { type: 'text/markdown' }));
      const canvas = document.querySelector('#wordcraft_canvas') || document.body;
      for (const type of ['dragenter', 'dragover', 'drop']) {
        canvas.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
      }
      return true;
    } catch (e) { return false; }
  };
  // Panel Sitasi app: paste sintetis ke canvas (satu-satunya cara yang terbukti
  // masuk ke editor egui; keydown sintetis tidak dibaca).
  window.__rwInsertText = function (text) {
    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', String(text));
      document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      return true;
    } catch (e) { return false; }
  };
  const post = (name, bytes) => {
    try { parent.postMessage({ source: 'wordcraft-bridge', kind: 'save', name: name, bytes: bytes }, '*'); } catch (e) {}
  };
  // Picker palsu: pura-pura sukses simpan, bytes ditangkap lewat writable stream.
  try {
    window.showSaveFilePicker = async function (opts) {
      const name = (opts && opts.suggestedName) || 'dokumen.md';
      return {
        kind: 'file',
        name: name,
        createWritable: async function () {
          const parts = [];
          return {
            write: async function (d) {
              if (d && typeof d === 'object' && 'type' in d) {
                if (d.type === 'truncate') { parts.length = 0; if (d.size > 0) parts.push(new Uint8Array(d.size)); return; }
                if (d.type === 'seek') return;
                if ('data' in d) { d = d.data; } else { return; }
              }
              if (d instanceof Blob) { d = await d.arrayBuffer(); }
              if (d instanceof ArrayBuffer) { parts.push(new Uint8Array(d)); return; }
              if (ArrayBuffer.isView(d)) { parts.push(new Uint8Array(d.buffer, d.byteOffset, d.byteLength)); return; }
              parts.push(new TextEncoder().encode(String(d)));
            },
            truncate: async function (size) { parts.length = 0; if (size > 0) parts.push(new Uint8Array(size)); },
            seek: async function () {},
            close: async function () {
              let total = 0;
              for (const p of parts) { total += p.length; }
              const out = new Uint8Array(total);
              let at = 0;
              for (const p of parts) { out.set(p, at); at += p.length; }
              post(name, out.buffer);
            },
            abort: async function (r) { throw r; },
          };
        },
      };
    };
  } catch (e) {}
  // Unduhan jangkar (mis. ekspor dari dalam Word): jemput juga, TANPA memblokir unduhan aslinya.
  const proto = HTMLAnchorElement.prototype;
  const click = proto.click;
  proto.click = function () {
    try {
      const href = this.getAttribute('href') || '';
      if (href.startsWith('blob:') && this.hasAttribute('download')) {
        const name = this.getAttribute('download') || 'dokumen.md';
        fetch(href).then((r) => r.arrayBuffer()).then((bytes) => post(name, bytes)).catch(() => {});
      }
    } catch (e) {}
    return click.apply(this, arguments);
  };
})();
`;

/**
 * Panel Sitasi DI DALAM iframe WordCraft.
 *
 * Kenapa tidak di parent app? Klik UI parent membuat window iframe kehilangan
 * fokus (document.hasFocus() === false) dan WordCraft membuang selection.
 * Akibatnya paste sintetis tidak punya caret. Semua kontrol di sini hidup di
 * dokumen iframe yang sama, jadi selection tetap hidup.
 *
 * Tidak ada <input> pencarian: fokus ke input juga membuang selection (sudah
 * diuji). Filter diketik lewat capture keydown di window iframe; WordCraft
 * tidak pernah menerima huruf-huruf itu.
 */
const CITE_UI_SOURCE = `
(() => {
  if (window.__rwCiteUi) return;
  window.__rwCiteUi = true;

  const DEFAULTS = {
    title: 'Sitasi',
    search: 'Ketik untuk mencari…',
    typeHint: 'Ketik untuk filter. Enter pilih teratas, Esc tutup.',
    hint: 'Pilih referensi untuk sisip di kursor, lalu Save di WordCraft.',
    noBib: 'Belum ada references.bib.',
    noMatch: 'Gak ada yang cocok.',
    error: 'Gagal ambil daftar pustaka.',
    close: 'Tutup',
    loading: 'Memuat…',
    query: 'Cari: {q}',
    count: '{n} entri',
  };
  let strings = Object.assign({}, DEFAULTS);
  let entries = [];
  let hasBib = true;
  let errorText = null;
  let loading = false;
  let query = '';
  let panel = null;
  let listEl = null;
  let queryEl = null;
  let countEl = null;
  let keyHandler = null;

  const setText = (el, text) => { if (el) el.textContent = text; };

  // Tombol mengambang di dalam iframe — klik di sini tidak pernah blur window.
  const btn = document.createElement('button');
  btn.id = 'rw-cite-btn';
  btn.type = 'button';
  btn.style.cssText = 'position:fixed;right:18px;bottom:42px;z-index:2147483646;display:none;align-items:center;gap:6px;height:30px;padding:0 10px;border:0;border-radius:4px;background:#171717;color:#fff;font:600 11px/1 ui-sans-serif,system-ui,-apple-system,sans-serif;letter-spacing:.02em;box-shadow:0 2px 8px rgba(0,0,0,.18);cursor:pointer;';
  btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg><span></span>';
  const btnLabel = btn.querySelector('span');
  setText(btnLabel, strings.title);
  btn.title = strings.title;
  btn.setAttribute('aria-label', strings.title);
  btn.addEventListener('mousedown', (event) => event.preventDefault());
  btn.addEventListener('click', (event) => {
    event.preventDefault();
    if (panel) { closePanel(); return; }
    openPanel();
  });
  document.body.appendChild(btn);

  // Klik di luar panel = tutup (tanpa mengganggu klik tombol Cite).
  document.addEventListener('mousedown', (event) => {
    if (!panel) return;
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (panel.contains(target) || btn.contains(target)) return;
    closePanel();
  }, true);

  window.__rwSetCiteVisible = (visible) => { btn.style.display = visible ? 'inline-flex' : 'none'; };
  window.__rwSetCiteLabel = (label) => {
    if (!label) return;
    setText(btnLabel, label);
    btn.title = label;
    btn.setAttribute('aria-label', label);
  };
  window.__rwSetCiteStrings = (next) => {
    if (next) strings = Object.assign({}, DEFAULTS, next);
    setText(btnLabel, strings.title);
    btn.title = strings.title;
    btn.setAttribute('aria-label', strings.title);
    if (panel) {
      setText(panel.querySelector('[data-rw-title]'), strings.title);
      setText(panel.querySelector('[data-rw-hint]'), strings.hint);
      setText(panel.querySelector('[data-rw-typehint]'), strings.typeHint);
      renderList();
    }
  };

  function filteredEntries() {
    const q = query.trim().toLowerCase();
    return entries.filter((entry) => {
      if (!q) return true;
      const authors = Array.isArray(entry.authors) ? entry.authors.join(' ') : '';
      const hay = (entry.key + ' ' + (entry.title || '') + ' ' + authors + ' ' + (entry.year || '')).toLowerCase();
      return hay.indexOf(q) !== -1;
    });
  }

  function closePanel() {
    if (keyHandler) {
      window.removeEventListener('keydown', keyHandler, true);
      keyHandler = null;
    }
    if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
    panel = null;
    listEl = null;
    queryEl = null;
    countEl = null;
    query = '';
    window.setTimeout(() => {
      const canvas = document.querySelector('canvas');
      try { if (canvas) canvas.focus(); } catch (e) {}
    }, 0);
  }

  function insertEntry(entry) {
    if (!entry || typeof entry.key !== 'string') return;
    const ok = window.__rwInsertText ? window.__rwInsertText('[@' + entry.key + ']') : false;
    if (!ok) return;
    closePanel();
    try { parent.postMessage({ source: 'wordcraft-bridge', kind: 'cite-inserted', key: entry.key }, '*'); } catch (e) {}
  }

  function renderList() {
    if (!listEl) return;
    listEl.replaceChildren();
    if (loading) {
      setText(queryEl, strings.search);
      setText(countEl, '');
      const p = document.createElement('p');
      p.textContent = strings.loading;
      p.style.cssText = 'margin:0;padding:12px 10px;font:11px/1.5 ui-sans-serif,system-ui,sans-serif;color:#737373;';
      listEl.appendChild(p);
      return;
    }
    setText(queryEl, query.trim() ? strings.query.replace('{q}', query) : strings.search);
    if (errorText) {
      setText(countEl, '');
      const p = document.createElement('p');
      p.textContent = errorText;
      p.style.cssText = 'margin:0;padding:12px 10px;font:11px/1.5 ui-sans-serif,system-ui,sans-serif;color:#b91c1c;';
      listEl.appendChild(p);
      return;
    }
    const filtered = filteredEntries();
    setText(countEl, strings.count.replace('{n}', String(filtered.length)));
    if (filtered.length === 0) {
      const p = document.createElement('p');
      p.textContent = hasBib ? strings.noMatch : strings.noBib;
      p.style.cssText = 'margin:0;padding:12px 10px;font:11px/1.5 ui-sans-serif,system-ui,sans-serif;color:#737373;';
      listEl.appendChild(p);
      return;
    }
    for (const entry of filtered.slice(0, 200)) {
      const item = document.createElement('button');
      item.type = 'button';
      item.title = (entry.title || '') + (entry.year ? ' (' + entry.year + ')' : '');
      item.style.cssText = 'display:block;width:100%;border:0;background:transparent;text-align:left;padding:5px 6px;border-radius:4px;cursor:pointer;font:11px/1.35 ui-sans-serif,system-ui,sans-serif;color:#404040;';
      item.addEventListener('mouseenter', () => { item.style.background = '#f5f5f5'; });
      item.addEventListener('mouseleave', () => { item.style.background = 'transparent'; });
      item.addEventListener('mousedown', (event) => event.preventDefault());
      item.addEventListener('click', (event) => { event.preventDefault(); insertEntry(entry); });
      const keyEl = document.createElement('span');
      keyEl.textContent = '[@' + entry.key + ']';
      keyEl.style.cssText = 'font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;color:#1d4ed8;';
      const titleEl = document.createElement('span');
      titleEl.textContent = (entry.title || '—') + (entry.year ? ' (' + entry.year + ')' : '');
      titleEl.style.cssText = 'margin-left:5px;color:#737373;';
      item.appendChild(keyEl);
      item.appendChild(titleEl);
      listEl.appendChild(item);
    }
  }

  function buildPanel() {
    const wrap = document.createElement('div');
    wrap.id = 'rw-cite-panel';
    wrap.style.cssText = 'position:fixed;right:18px;bottom:80px;z-index:2147483647;width:340px;max-width:calc(100vw - 36px);max-height:60vh;display:flex;flex-direction:column;background:#fff;color:#171717;border:1px solid #d4d4d4;border-radius:6px;box-shadow:0 8px 30px rgba(0,0,0,.16);font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;overflow:hidden;';

    const head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid #e5e5e5;';
    const title = document.createElement('span');
    title.setAttribute('data-rw-title', '');
    title.textContent = strings.title;
    title.style.cssText = 'flex:1;font-size:12px;font-weight:600;letter-spacing:.02em;';
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = '×';
    close.setAttribute('aria-label', strings.close);
    close.style.cssText = 'width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:4px;background:transparent;color:#737373;font:16px/1 ui-sans-serif,system-ui,sans-serif;cursor:pointer;';
    close.addEventListener('mousedown', (event) => event.preventDefault());
    close.addEventListener('click', (event) => { event.preventDefault(); closePanel(); });
    head.appendChild(title);
    head.appendChild(close);

    const meta = document.createElement('div');
    meta.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 10px 0;';
    queryEl = document.createElement('span');
    queryEl.style.cssText = 'flex:1;font-size:11px;color:#404040;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
    countEl = document.createElement('span');
    countEl.style.cssText = 'font-size:10px;color:#737373;white-space:nowrap;';
    meta.appendChild(queryEl);
    meta.appendChild(countEl);

    listEl = document.createElement('div');
    listEl.style.cssText = 'flex:1;min-height:0;overflow-y:auto;padding:4px;';

    const foot = document.createElement('div');
    foot.style.cssText = 'padding:6px 10px;border-top:1px solid #e5e5e5;font-size:10px;line-height:1.4;color:#737373;';
    const hint = document.createElement('div');
    hint.setAttribute('data-rw-hint', '');
    hint.textContent = strings.hint;
    const typeHint = document.createElement('div');
    typeHint.setAttribute('data-rw-typehint', '');
    typeHint.textContent = strings.typeHint;
    typeHint.style.cssText = 'margin-top:2px;color:#a3a3a3;';
    foot.appendChild(hint);
    foot.appendChild(typeHint);

    wrap.appendChild(head);
    wrap.appendChild(meta);
    wrap.appendChild(listEl);
    wrap.appendChild(foot);
    document.body.appendChild(wrap);
    return wrap;
  }

  function openPanel() {
    if (!panel) panel = buildPanel();
    query = '';
    errorText = null;
    loading = true;
    renderList();
    keyHandler = (event) => {
      if (!panel) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        closePanel();
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        event.stopImmediatePropagation();
        const filtered = filteredEntries();
        if (filtered.length > 0) insertEntry(filtered[0]);
        return;
      }
      if (event.key === 'Backspace') {
        event.preventDefault();
        event.stopImmediatePropagation();
        query = query.slice(0, -1);
        renderList();
        return;
      }
      if (event.key === 'Tab') {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        event.stopImmediatePropagation();
        query += event.key;
        renderList();
      }
    };
    window.addEventListener('keydown', keyHandler, true);
    try { parent.postMessage({ source: 'wordcraft-bridge', kind: 'cite-open' }, '*'); } catch (e) {}
  }

  window.__rwShowCitePanel = (nextEntries, nextHasBib, nextError) => {
    if (!panel) return; // user sudah menutup panel sebelum fetch selesai
    entries = Array.isArray(nextEntries)
      ? nextEntries.filter((entry) => entry && typeof entry.key === 'string')
      : [];
    hasBib = Boolean(nextHasBib);
    errorText = nextError || null;
    loading = false;
    renderList();
  };
})();
`;

/**
 * Tab "Word": seluruh WordCraft (engine + UI Word lengkap, wasm 16MB gzip)
 * di iframe same-origin. File bab dilempar ke dalam via drop sintetis; hasil
 * Save diintip dari anchor-download lalu diminta disimpen balik ke file bab.
 */
export function WordTab({
  slug,
  path,
  version,
  onOpenText,
}: {
  slug: string;
  path: string;
  version: number;
  onOpenText: (path: string) => void;
}) {
  const t = useT();
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [booted, setBooted] = useState(false);
  // WordCraft baru bisa menerima file ~6-8 detik setelah iframe muncul (wasm 42MB).
  // Tanpa gerbang ini, event drop dilempar sebelum egui daftar handler -> dokumen
  // tidak pernah tampil di kanvas.
  const [wcReady, setWcReady] = useState(false);
  const [thrown, setThrown] = useState(false);
  const [throwFailed, setThrowFailed] = useState(false);
  const [pending, setPending] = useState<SaveCandidate | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Deteksi file berubah di luar Word (agen nulis): versi terakhir dijembatan vs disk.
  const inWordRef = useRef<string | null>(null);
  const seenRef = useRef<string | null>(null);
  const [stale, setStale] = useState<string | null>(null);

  // Sitasi yang baru masuk (dikirim panel dari dalam iframe) → banner Save.
  const [citeNote, setCiteNote] = useState<string | null>(null);

  const fileName = path.slice(path.lastIndexOf('/') + 1);

  // Gate font: tanam pack font lengkap (metric Word + Google Docs) ke
  // IndexedDB `wordcraft` SEBELUM iframe Word dibuat - WordCraft membaca
  // seluruh store saat boot, jadi langsum masuk ke daftar Font di Word.
  const [fontsReady, setFontsReady] = useState(false);
  const [seedNote, setSeedNote] = useState<string | null>(null);
  const tRef = useRef(t);
  tRef.current = t;
  useEffect(() => {
    let alive = true;
    const deadline = new Promise<void>((resolve) => window.setTimeout(resolve, 15000));
    seedWordcraftFonts()
      .then((res) => {
        if (!alive) return;
        if (res?.fail) setSeedNote(tRef.current('word.fontPackFail'));
        else if (res && (res.added > 0 || res.pruned > 0)) {
          const msg =
            res.pruned > 0
              ? tRef
                  .current('word.fontPackDoneCleaned')
                  .replace('{n}', String(res.added))
                  .replace('{m}', String(res.pruned))
              : tRef.current('word.fontPackDone').replace('{n}', String(res.added));
          setSeedNote(msg);
          window.setTimeout(() => setSeedNote(null), 8000);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (alive) setFontsReady(true);
      });
    // Deadline tetap jalan independen: app buka walau seeding nyangkut.
    void deadline.then(() => alive && setFontsReady(true));
    return () => {
      alive = false;
    };
  }, []);

  // Sinkron: suntik hook begitu document iframe siap penuh.
  useEffect(() => {
    const timer = window.setInterval(() => {
      const frame = frameRef.current;
      const doc = frame?.contentDocument;
      if (!doc || doc.readyState !== 'complete') return;
      const win = frame?.contentWindow as (Window & { __rwHooked?: boolean }) | null | undefined;
      if (win && !win.__rwHooked) {
        const script = doc.createElement('script');
        script.textContent = HOOK_SOURCE + CITE_UI_SOURCE;
        (doc.head ?? doc.documentElement).appendChild(script);
        win.__rwHooked = true;
      }
      if (win?.__rwHooked) {
        window.clearInterval(timer);
        window.setTimeout(() => setBooted(true), 1200); // kasih waktu listener drop dipasang
      }
    }, 250);
    const stop = window.setTimeout(() => window.clearInterval(timer), 90000);
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(stop);
    };
  }, []);

  // Gerbang siap: poll probe drop-handler egui di dalam iframe.
  useEffect(() => {
    let alive = true;
    const probe = () => {
      const win = frameRef.current?.contentWindow as
        | (Window & { __wcProbeReady?: () => boolean })
        | null
        | undefined;
      return win?.__wcProbeReady?.() ?? false;
    };
    const timer = window.setInterval(() => {
      if (!alive) return;
      if (probe()) {
        window.clearInterval(timer);
        setWcReady(true);
      }
    }, 250);
    const stop = window.setTimeout(() => window.clearInterval(timer), 90000);
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.clearTimeout(stop);
    };
  }, []);

  // Pesan dari bridge iframe: simpan file + panel Sitasi.
  useEffect(() => {
    let alive = true;
    const onMsg = async (event: MessageEvent) => {
      const data = event.data as
        | {
            source?: string;
            kind?: string;
            name?: string;
            bytes?: ArrayBuffer;
            key?: string;
          }
        | null;
      if (!data || data.source !== 'wordcraft-bridge') return;

      if (data.kind === 'save' && data.bytes instanceof ArrayBuffer) {
        setPending({ name: data.name ?? 'dokumen.md', bytes: data.bytes });
        setSavedMsg(false);
        setSaveError(null);
        return;
      }

      if (data.kind === 'cite-inserted' && typeof data.key === 'string') {
        const key = data.key;
        setCiteNote(key);
        window.setTimeout(() => setCiteNote((current) => (current === key ? null : current)), 12000);
        return;
      }

      // Panel Sitasi dibuka dari dalam iframe (biar selection WordCraft aman).
      // Parent cuma nyuplai daftar pustaka; render + insert tetap di iframe.
      if (data.kind === 'cite-open') {
        const win = frameRef.current?.contentWindow as
          | (Window & {
              __rwShowCitePanel?: (
                entries: BibEntry[],
                hasBib: boolean,
                error: string | null,
              ) => void;
            })
          | null;
        try {
          const res = await fetch(`/api/projects/${encodeURIComponent(slug)}/bib`);
          const json = await res.json();
          if (!alive || !win) return;
          if (!res.ok) throw new Error('bib');
          win.__rwShowCitePanel?.(
            Array.isArray(json?.entries) ? (json.entries as BibEntry[]) : [],
            Boolean(json?.hasBib),
            null,
          );
        } catch {
          if (!alive || !win) return;
          win.__rwShowCitePanel?.([], false, tRef.current('word.citeError'));
        }
      }
    };
    window.addEventListener('message', onMsg);
    return () => {
      alive = false;
      window.removeEventListener('message', onMsg);
    };
  }, [slug]);

  // Kirim label/string + tampilkan tombol Sitasi setelah WordCraft siap.
  useEffect(() => {
    if (!booted) return;
    const win = frameRef.current?.contentWindow as
      | (Window & {
          __rwSetCiteVisible?: (visible: boolean) => void;
          __rwSetCiteLabel?: (label: string) => void;
          __rwSetCiteStrings?: (strings: Record<string, string>) => void;
        })
      | null;
    if (!win) return;
    win.__rwSetCiteStrings?.({
      title: t('word.cite'),
      search: t('word.citeSearch'),
      typeHint: t('word.citeTypeHint'),
      hint: t('word.citeHint'),
      noBib: t('word.citeNoBib'),
      noMatch: t('word.citeNoMatch'),
      error: t('word.citeError'),
      close: t('word.discard'),
      loading: t('word.loading'),
      query: t('word.citeQuery', { q: '{q}' }),
      count: t('word.citeCount', { n: '{n}' }),
    });
    win.__rwSetCiteLabel?.(t('word.cite'));
    win.__rwSetCiteVisible?.(true);
  }, [booted, t]);

  // Lempar file bab: fetch bytes → File → drop sintetis ke canvas egui.
  const throwFile = useCallback(async () => {
    const frame = frameRef.current;
    const win = frame?.contentWindow;
    const doc = frame?.contentDocument;
    if (!win || !doc || !wcReady) {
      if (wcReady) setThrowFailed(true);
      return;
    }
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(slug)}/raw?path=${encodeURIComponent(path)}`);
      if (!res.ok) throw new Error(`raw ${res.status}`);
      const bytes = await res.arrayBuffer();
      const u8 = new Uint8Array(bytes);
      let bin = '';
      for (let i = 0; i < u8.length; i += 0x8000) {
        bin += String.fromCharCode.apply(null, Array.from(u8.subarray(i, i + 0x8000)));
      }
      const base64 = btoa(bin);
      const drop = (win as Window & { __rwDropFile?: (n: string, b: string) => boolean }).__rwDropFile;
      const ok = drop ? drop(fileName, base64) : false;
      if (!ok) throw new Error('drop gagal');
      // Tandai versi yang saat ini di Word + versi disk yang sudah dikonfirmasi.
      const text = new TextDecoder().decode(bytes);
      inWordRef.current = text;
      seenRef.current = text;
      setStale(null);
      setThrown(true);
      setThrowFailed(false);
    } catch {
      setThrowFailed(true);
    }
  }, [slug, path, fileName, wcReady]);

  // Auto-lempar: tab dibuka / file diklik lagi → begitu Word siap, file langsung dilempar.
  // version naik tiap klik file (shell) → lempar ulang; manual-throw user tetap bisa via tombol.
  const queuedThrow = useRef(true);
  useEffect(() => {
    queuedThrow.current = true;
    if (booted && wcReady) {
      queuedThrow.current = false;
      void throwFile();
    }
  }, [version, booted, wcReady, throwFile]);

  // Kalau lemparan gagal (bukan sekadar diabaikan WordCraft), coba ulang dua
  // kali otomatis sebelum menampilkan tombol manual — race dengan boot wasm
  // adalah penyebab paling sering.
  const retryRef = useRef(0);
  useEffect(() => {
    if (!throwFailed || thrown) {
      retryRef.current = 0;
      return undefined;
    }
    if (retryRef.current >= 2) return undefined;
    const timer = window.setTimeout(() => {
      retryRef.current += 1;
      void throwFile();
    }, 2000);
    return () => window.clearTimeout(timer);
  }, [throwFailed, thrown, throwFile]);

  // Simpan balik bytes hasil Word ke file bab.
  // WordCraft nyimpen .docx (format aslinya) walau file babnya .md → route
  // word-save mengubahnya ke markdown dulu sebelum ditulis balik.
  const keepSave = useCallback(async () => {
    if (!pending || saving) return;
    setSaving(true);
    try {
      const u8 = new Uint8Array(pending.bytes);
      let bin = '';
      for (let i = 0; i < u8.length; i += 0x8000) {
        bin += String.fromCharCode.apply(null, Array.from(u8.subarray(i, i + 0x8000)));
      }
      const base64 = btoa(bin);
      const conv = await fetch(`/api/projects/${encodeURIComponent(slug)}/word-save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: pending.name, base64 }),
      });
      const converted = (await conv.json().catch(() => null)) as
        | { content?: string; error?: string }
        | null;
      if (!conv.ok || typeof converted?.content !== 'string') {
        setSaveError(converted?.error ?? 'Gagal menyimpan hasil Word');
        return;
      }
      const content = converted.content;
      const res = await fetch(`/api/projects/${encodeURIComponent(slug)}/file`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        // reason → isi bab di disk di-snapshot dulu, jadi edit Word bisa dibatalkan.
        body: JSON.stringify({ path, content, reason: 'word' }),
      });
      if (res.ok) {
        inWordRef.current = content;
        seenRef.current = content;
        setStale(null);
        setSavedMsg(true);
        setSaveError(null);
        setPending(null);
      }
    } catch {
      // banner tetep muncul, user bisa coba lagi
    } finally {
      setSaving(false);
    }
  }, [pending, saving, slug, path]);

  // Cocok kalau nama hasil simpan sama dengan file bab, ATAU WordCraft nyimpen
  // .docx sementara file babnya .md (dikonversi ke markdown dulu).
  const nameMatches =
    pending !== null &&
    (pending.name === fileName || (/\.docx$/i.test(pending.name) && /\.md$/i.test(fileName)));

  // Hint sekali-soal "Load system fonts" (font bawaan Windows) — dismissable.
  // 'yes' = browser punya queryLocalFonts (Chrome/Edge), 'no' = tidak punya (Firefox/Safari).
  const [sysHint, setSysHint] = useState<'yes' | 'no' | false>(false);
  useEffect(() => {
    try {
      if (localStorage.getItem('rd.wordcraft.sysHint.ack') === '1') return;
      const supportsLocalFonts = typeof (window as { queryLocalFonts?: unknown }).queryLocalFonts === 'function';
      setSysHint(supportsLocalFonts ? 'yes' : 'no');
    } catch {
      /* storage penuh/tidak tersedia → tampil sekali per visit */
    }
  }, []);
  const dismissHint = useCallback(() => {
    setSysHint(false);
    try {
      localStorage.setItem('rd.wordcraft.sysHint.ack', '1');
    } catch {
      /* abaikan */
    }
  }, []);

  // BabBayangan: cek disk tiap 8 detik — file berubah di luar Word (agen nulis) → chip Tarik.
  useEffect(() => {
    const poll = window.setInterval(async () => {
      if (seenRef.current === null) return; // belum pernah lempar apa-apa ke Word
      try {
        const res = await fetch(`/api/projects/${encodeURIComponent(slug)}/raw?path=${encodeURIComponent(path)}`);
        if (!res.ok) return;
        const text = new TextDecoder().decode(await res.arrayBuffer());
        if (text !== seenRef.current) {
          seenRef.current = text; // kabarin sekali, jangan spam tiap siklus
          if (text !== inWordRef.current) setStale(text);
        }
      } catch {
        // network gagal → siklus berikutnya
      }
    }, 8000);
    return () => window.clearInterval(poll);
  }, [slug, path]);

  const pullLatest = useCallback(async () => {
    await throwFile();
    setStale(null);
  }, [throwFile]);

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col bg-muted/50">
      {/* Bar mini: identitas file + status bridge */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-card px-2">
        <PenLine size={13} className="shrink-0 text-primary" />
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
          {path} · {t('word.title')}
        </span>
        {!booted && (
          <span className="shrink-0 text-[11px] text-muted-foreground">
            <Loader2 size={11} className="mr-1 inline animate-spin" />
            {fontsReady ? t('word.loading') : t('word.fontPack')}
          </span>
        )}
        <a
          href="/wordcraft/index.html"
          target="_blank"
          rel="noopener noreferrer"
          title={t('word.fullPage')}
          className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <ExternalLink size={13} />
        </a>
        <Button
          variant="ghost"
          className="h-7 shrink-0 px-2 text-[11px]"
          title={t('word.textEditor')}
          onClick={() => onOpenText(path)}
        >
          <FileText size={12} className="mr-1" />
          {t('word.textEditor')}
        </Button>
        <Button
          variant="default"
          className="h-7 shrink-0 px-2.5 text-[11px]"
          disabled={!wcReady}
          onClick={() => void throwFile()}
        >
          <Upload size={12} className="mr-1" />
          {t('word.openBtn')}
        </Button>
      </div>

      {/* Status lempar file */}
      {thrown && !pending && (
        <p className="shrink-0 px-2 py-1 text-[11px] text-muted-foreground">{t('word.thrown')}</p>
      )}
      {throwFailed && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-amber-300 bg-amber-50 px-2 py-1 text-[11px] text-amber-900">
          <TriangleAlert size={11} className="shrink-0" />
          <span className="min-w-0 flex-1">{t('word.openFailed')}</span>
          <button
            type="button"
            onClick={() => void throwFile()}
            className="shrink-0 rounded border border-amber-400 px-1.5 py-0.5 font-medium hover:bg-amber-100"
          >
            {t('word.retryOpen')}
          </button>
        </div>
      )}

      {/* Hint sekali: font bawaan Windows via "Load system fonts" */}
      {sysHint && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-muted/40 px-2 py-1">
          <span className="min-w-0 flex-1 text-[11px] text-muted-foreground">
            {t(sysHint === 'yes' ? 'word.sysFontHint' : 'word.sysFontHintNo')}
          </span>
          <button
            type="button"
            aria-label={t('word.discard')}
            onClick={dismissHint}
            className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X size={12} />
          </button>
        </div>
      )}

      {/* Hasil seeding font: ditambah N font / gagal */}
      {seedNote && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-muted/40 px-2 py-1">
          <span className="min-w-0 flex-1 text-[11px] text-muted-foreground">{seedNote}</span>
          <button
            type="button"
            aria-label={t('word.discard')}
            onClick={() => setSeedNote(null)}
            className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X size={12} />
          </button>
        </div>
      )}

      {/* Sitasi baru masuk — ingatkan Save di WordCraft + Simpen ke bab */}
      {citeNote && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-blue-700/30 bg-blue-50 px-2 py-1.5 dark:bg-blue-950/40">
          <span className="min-w-0 flex-1 text-[11px] text-blue-800 dark:text-blue-200">
            {t('word.citeInserted', { key: citeNote })}
          </span>
          <button
            type="button"
            aria-label={t('word.discard')}
            onClick={() => setCiteNote(null)}
            className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X size={12} />
          </button>
        </div>
      )}

      {/* Chip: file berubah di luar Word (agen nulis) → tarik ke Word */}
      {stale !== null && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-blue-700/30 bg-blue-50 px-2 py-1.5 dark:bg-blue-950/40">
          <span className="min-w-0 flex-1 text-[11px] text-blue-800 dark:text-blue-200">
            {t('word.stale')}
          </span>
          <Button variant="default" className="h-6 px-2 text-[11px]" onClick={() => void pullLatest()}>
            {t('word.pull')}
          </Button>
          <button
            type="button"
            aria-label={t('word.discard')}
            onClick={() => setStale(null)}
            className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X size={12} />
          </button>
        </div>
      )}

      {/* Banner simpan dari Word */}
      {pending && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-amber-700/30 bg-amber-50 px-2 py-1.5 dark:bg-amber-950/40">
          <span className="min-w-0 flex-1 text-[11px] text-amber-800 dark:text-amber-200">
            {saveError
              ? saveError
              : nameMatches
                ? /\.docx$/i.test(pending.name)
                  ? t('word.saveConvert').replace('{name}', fileName)
                  : t('word.saveAsk').replace('{name}', pending.name)
                : t('word.saveHint').replace('{name}', pending.name)}
          </span>
          {nameMatches && (
            <>
              <Button variant="default" className="h-6 px-2 text-[11px]" disabled={saving} onClick={() => void keepSave()}>
                {saving ? <Loader2 size={11} className="animate-spin" /> : null}
                {t('word.saveKeep')}
              </Button>
              {savedMsg && <span className="text-[11px] text-green-700">{t('word.saved')}</span>}
            </>
          )}
          <button
            type="button"
            aria-label={t('word.discard')}
            onClick={() => setPending(null)}
            className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X size={12} />
          </button>
        </div>
      )}

      {/* Kanvas WordCraft penuh — baru muncul setelah pack font ditanam */}
      {fontsReady && (
        <iframe
          ref={frameRef}
          src="/wordcraft/index.html"
          title={t('word.title')}
          className="h-full w-full flex-1 border-0 bg-background"
        />
      )}
      {!fontsReady && (
        <div className="flex flex-1 items-center justify-center gap-2 text-[12px] text-muted-foreground">
          <Loader2 size={14} className="animate-spin" />
          {t('word.fontPack')}
        </div>
      )}
    </div>
  );
}
