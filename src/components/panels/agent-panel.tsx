'use client';

import { useEffect, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
  Plus,
  SlidersHorizontal,
  Sparkles,
  Stethoscope,
} from 'lucide-react';
import { useT } from '@/lib/preferences';
import ReactMarkdown from 'react-markdown';
import { JournalCard, parseJournalCard } from '@/components/panels/journal-card';
import remarkGfm from 'remark-gfm';
import { Button, Modal, SegmentedGroup, StatusDot } from '@/components/ui';
import {
  AgentComposer,
  formatSessionTime,
  type AgentAttachment,
  type AgentSessionView,
  type ModelEntryView,
  type ModelGroupView,
  type ProviderPickView,
} from '@/components/panels/agent-composer';

// Tipe model picker disimpan di agent-composer (milik komposer ala-Codex),
// diekspor ulang di sini biar import agent-view gak berubah.
export type { ModelEntryView, ModelGroupView, ProviderPickView, AgentSessionView };

/** Hasil diagnosa koneksi AI (cermin src/lib/opencode/doctor.ts). */
type DoctorFinding = {
  providerID: string;
  label: string;
  modelID: string;
  status: 'ok' | 'free-limit' | 'not-supported' | 'no-model' | 'auth' | 'error';
  message: string;
  /** Model lain di provider ini yang ternyata bisa dipakai. */
  workingModel?: string;
};
type DoctorReport = {
  findings: DoctorFinding[];
  checkedAt: string;
  error?: string;
};

// Panel kanan fase 2 (pratinjau UI — belum nyambung API; wiring nyata menyusul).

export type ChatToolEvent = {
  id: string;
  title: string;
  detail?: string;
  status: 'running' | 'done' | 'error';
};

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  /** Konten teks — saat streaming akan di-append terus oleh parent. */
  text: string;
  /** Timeline tool/actions milik pesan assistant ini. */
  toolEvents?: ChatToolEvent[];
};

export type AgentPanelProps = {
  slug: string;
  projectTitle: string;
  /** Sudah ada session agent untuk project ini? */
  sessionReady: boolean;
  /** Buat/mulai session (tombol "Mulai" kalau sessionReady=false). */
  onEnsureSession: () => Promise<void>;
  messages: ChatMessage[];
  sending: boolean;
  onSend: (text: string) => void;
  /** File yang terbuka di editor — disisipkan sebagai konteks. */
  activeFilePath: string | null;
  /** Auth OpenCode (mis. provider ChatGPT) sudah tersambung? */
  connected: boolean;
  onConnect: () => void;
  /** Login ulang / ganti akun ChatGPT (kredensial lama dilepas dulu). */
  onReconnect?: () => void;
  /** Hasil diagnosa: ada model yang bisa dipakai atau tidak. */
  onDoctorResult?: (usable: boolean) => void;
  /** Model diganti dari modal diagnosa. */
  onModelPicked?: (providerID: string, modelID: string) => void;
  /** Agent sedang mengerjakan sesuatu (tampilkan bubble "mengetik…"). */
  busy: boolean;
  /** Tutup panel kanan — dipanggil dari tombol arrow di header panel. */
  onCollapse?: () => void;
  /** Model picker (fase 2): daftar model per provider + pilihan aktif. */
  models: ModelGroupView[];
  currentModel: ModelEntryView | null;
  onSelectModel: (model: ModelEntryView) => void;
  /** Login provider lain pakai API key (fase 2.5-lite). */
  providerPicks: ProviderPickView[];
  onProviderConnect: (integrationID: string, key: string) => Promise<void>;
  onProviderDisconnect: (integrationID: string) => Promise<void>;
  /** Meter token sesi (opsional — nanti di-wire agent-view); undefined → tampil "—". */
  usage?: { input: number; output: number } | null;
  /** Kemampuan AI (fase 2.5): toggle websearch/jurnal; null = belum ke-load. */
  capabilities: { websearch: boolean; literature: boolean } | null;
  onToggleCapability: (key: 'websearch' | 'literature', enabled: boolean) => void;
  /** Multi-sesi (picker Sessions di strip + slash menu composer). */
  sessions: AgentSessionView[];
  activeSessionId: string | null;
  /** Pindah/buat sesi masih jalan → pill & item menu menandai sibuk. */
  switching: boolean;
  /** Buat sesi baru ("Sesi baru"). */
  onCreateSession: () => void;
  /** Pindah ke sesi lain dari picker. */
  onSwitchSession: (sessionId: string) => void;
};

const TOOL_DOT_TONE: Record<ChatToolEvent['status'], 'green' | 'amber' | 'red'> = {
  running: 'amber',
  done: 'green',
  error: 'red',
};

/** Chip saran (fase 3.5): prompt cepat di atas input — key i18n `chat.suggest*`.
 * Dikirim ke composer sebagai kalimat translate; masa tayang dikelola composer
 * (localStorage "chat-suggestions-seen" → cuma tampil sekali). */
const SUGGESTION_KEYS = ['chat.suggestProgress', 'chat.suggestJournals', 'chat.suggestReview'] as const;

/** ID lampiran: cukup unik per panel — bila unggah dua kali banyak file berturut. */
let attachmentSeq = 0;
function attachmentId(): string {
  attachmentSeq += 1;
  return `lamp-${Date.now().toString(36)}-${attachmentSeq}`;
}

type ActivityFilter = 'all' | 'read-edit' | 'run';

const ACTIVITY_FILTERS: Array<{ value: ActivityFilter; key: string }> = [
  { value: 'all', key: 'ai.activityAll' },
  { value: 'read-edit', key: 'ai.activityReadEdit' },
  { value: 'run', key: 'ai.activityRun' },
];

/** Format token pendek: 842 → "842", 12.300 → "12.3k", 123.456 → "123k". */
function formatTokenCompact(value: number): string {
  if (value < 1000) return String(value);
  if (value < 10000) return `${(value / 1000).toFixed(1)}k`;
  return `${Math.round(value / 1000)}k`;
}

/** Filter chip → cocokkan kata kunci judul (API belum kasih field kind). */
function matchActivityFilter(event: ChatToolEvent, filter: ActivityFilter): boolean {
  if (filter === 'all') return true;
  const title = event.title.toLowerCase();
  return filter === 'read-edit'
    ? title.includes('baca') || title.includes('ubah')
    : title.includes('jalankan');
}

/** Detail tool kadang membawa konfirmasi kunci BibTeX "✓ <bibKey>" — itu ditampilkan
 * sebagai chip mono amber (aksen) biar gampang dilirik; teks lain tetap polos. */
function DetailText({ detail }: { detail: string }) {
  const index = detail.indexOf('✓');
  if (index === -1) return <>{detail}</>;
  return (
    <>
      {detail.slice(0, index)}
      <span className="font-mono text-accent">{detail.slice(index)}</span>
    </>
  );
}

/** Kartu timeline collapsible: header 1 baris, detail terbuka pas diklik. */
function ActivityCard({ event }: { event: ChatToolEvent }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="overflow-hidden rounded-md border border-border bg-muted/60">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left transition-colors hover:bg-muted"
      >
        <StatusDot tone={TOOL_DOT_TONE[event.status]} title={event.status} />
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-foreground">
          {event.title}
        </span>
        {event.detail && (
          <span className="min-w-0 max-w-[45%] shrink-0 truncate text-[10px] text-muted-foreground">
            <DetailText detail={event.detail} />
          </span>
        )}
        <ChevronDown size={11} className={`shrink-0 text-muted-foreground transition-transform ${open ? '' : '-rotate-90'}`} />
      </button>
      {open && event.detail && (
        <div className="border-t border-border px-2 py-1.5">
          <p className="whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed text-muted-foreground">
            <DetailText detail={event.detail} />
          </p>
        </div>
      )}
    </li>
  );
}

/** Baris kecil satu event tool (dot status + judul + detail). */
function ToolRow({ event }: { event: ChatToolEvent }) {
  return (
    <li className="flex items-start gap-1.5 rounded-md border border-border bg-muted/60 px-2 py-1">
      <span className="mt-1 shrink-0">
        <StatusDot tone={TOOL_DOT_TONE[event.status]} title={event.status} />
      </span>
      <span className="min-w-0 flex-1 text-[11px] leading-snug">
        <span className="font-medium text-foreground">{event.title}</span>
        {event.detail && (
          <span className="text-muted-foreground"> · <DetailText detail={event.detail} /></span>
        )}
      </span>
    </li>
  );
}

/** Respons AI gaya-Claude: full-width, tanpa gelembung, markdown rapi. */
function AssistantText({ text, slug }: { text: string; slug: string }) {
  return (
    <div className="w-full max-w-[92%] text-[13px] leading-relaxed text-card-foreground [&_a]:break-all [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-2 [&_blockquote]:text-muted-foreground [&_code]:rounded [&_code]:border [&_code]:border-border [&_code]:bg-muted [&_code]:px-1 [&_h1]:mt-2 [&_h1]:text-sm [&_h1]:font-semibold [&_h2]:mt-2 [&_h2]:text-[13px] [&_h2]:font-semibold [&_h3]:text-[13px] [&_h3]:font-medium [&_li]:my-0.5 [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-4 [&_p]:my-1 [&_pre]:my-1 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:border-border [&_pre]:bg-muted [&_pre]:p-3 [&_pre_code]:rounded-none [&_pre_code]:border-0 [&_pre_code]:bg-transparent [&_pre_code]:px-0 [&_strong]:font-semibold [&_table]:my-1 [&_table]:text-[11px] [&_td]:border [&_td]:border-border [&_td]:px-1.5 [&_td]:py-0.5 [&_th]:border [&_th]:border-border [&_th]:bg-muted [&_th]:px-1.5 [&_th]:py-0.5 [&_th]:font-medium [&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-4">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Blok ```vibe-journal berisi metadata paper → kartu yang bisa dibuka
          // PDF-nya dan di-drag ke file manager.
          code({ className, children }) {
            if (className === 'language-vibe-journal') {
              const data = parseJournalCard(String(children));
              return data ? <JournalCard slug={slug} data={data} /> : <code>{children}</code>;
            }
            return <code className={className}>{children}</code>;
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

function MessageBubble({ message, slug }: { message: ChatMessage; slug: string }) {
  if (message.role === 'system') {
    return (
      <div className="px-4 text-center text-[11px] text-muted-foreground">{message.text}</div>
    );
  }

  const isUser = message.role === 'user';
  // User = gelembung navy rata kanan. AI = blok teks bersih full-width (tanpa
  // gelembung, markdown di-render) gaya Claude.
  if (isUser) {
    return (
      <div className="flex flex-col items-end">
        <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-[13px] leading-relaxed text-primary-foreground">
          {message.text}
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-start gap-1">
      {message.text ? <AssistantText text={message.text} slug={slug} /> : null}
      {!isUser && (message.toolEvents?.length ?? 0) > 0 && (
        <details className="w-full">
          <summary className="cursor-pointer select-none py-0.5 text-[10px] text-muted-foreground transition-colors hover:text-foreground">
            ⚡ Aktivitas AI ({message.toolEvents?.length ?? 0} langkah)
          </summary>
          <ul className="mt-1 w-full space-y-1">
            {message.toolEvents?.map((event) => <ToolRow key={event.id} event={event} />)}
          </ul>
        </details>
      )}
    </div>
  );
}

export function AgentPanel({
  slug,
  projectTitle,
  sessionReady,
  onEnsureSession,
  messages,
  sending,
  onSend,
  activeFilePath,
  connected,
  onConnect,
  onReconnect,
  onDoctorResult,
  onModelPicked,
  busy,
  onCollapse,
  models,
  currentModel,
  onSelectModel,
  providerPicks,
  onProviderConnect,
  onProviderDisconnect,
  usage,
  capabilities,
  onToggleCapability,
  sessions,
  activeSessionId,
  switching,
  onCreateSession,
  onSwitchSession,
}: AgentPanelProps) {
  const t = useT();
  const [activeTab, setActiveTab] = useState<'chat' | 'activity'>('chat');
  const [draft, setDraft] = useState('');
  /** Lampiran aktif: di-pick di composer → di-upload ke <project>/attachments/ →
   * pas submit dirangkai jadi blok <lampiranPaths> di ekor pesan. */
  const [attachments, setAttachments] = useState<AgentAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  /** Popover Kemampuan AI (fase 2.5). */
  const [capsOpen, setCapsOpen] = useState(false);
  /** Dropdown Sessions pill di strip (multi-sesi). */
  const [sessionsOpen, setSessionsOpen] = useState(false);
  /** Filter chip di tab Aktivitas (dipertahankan saat pindah-pindah tab). */
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>('all');
  /** Diagnosa koneksi AI (probe 1 model per provider). */
  const [doctorBusy, setDoctorBusy] = useState(false);
  const [doctorOpen, setDoctorOpen] = useState(false);
  const [doctor, setDoctor] = useState<DoctorReport | null>(null);
  const capsRef = useRef<HTMLDivElement>(null);
  const sessionsRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const applyModel = async (providerID: string, modelID: string) => {
    try {
      await fetch('/api/ai/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerID, modelID }),
      });
      setDoctorOpen(false);
      onModelPicked?.(providerID, modelID);
    } catch {
      /* diamkan: diagnosa tetap tampil */
    }
  };

  const runDoctor = async () => {
    setDoctorOpen(true);
    setDoctorBusy(true);
    try {
      const res = await fetch('/api/ai/doctor');
      const data = (await res.json().catch(() => null)) as DoctorReport | null;
      if (res.ok && data) {
        setDoctor(data);
        onDoctorResult?.(data.findings.some((finding) => finding.status === 'ok'));
      } else {
        setDoctor({ findings: [], checkedAt: new Date().toISOString(), error: 'Gagal menjalankan diagnosa' });
      }
    } catch {
      setDoctor({ findings: [], checkedAt: new Date().toISOString(), error: 'Gagal menjalankan diagnosa' });
    } finally {
      setDoctorBusy(false);
    }
  };

  // Popover kemampuan ikut ketutup pas klik di luar-nya.
  useEffect(() => {
    if (!capsOpen) return;
    const onDown = (event: MouseEvent) => {
      if (capsRef.current && !capsRef.current.contains(event.target as Node)) setCapsOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [capsOpen]);

  // Dropdown Sessions idem.
  useEffect(() => {
    if (!sessionsOpen) return;
    const onDown = (event: MouseEvent) => {
      if (sessionsRef.current && !sessionsRef.current.contains(event.target as Node)) setSessionsOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [sessionsOpen]);

  // Dropdown model pindah ke composer (ala-Codex) — klik-diluar jadi urusan composer.

  // Ganti project → draft + lampiran dibersihkan (chat/session itu per project).
  useEffect(() => {
    setDraft('');
    setAttachments([]);
    setUploadError(null);
  }, [slug]);

  // Pesan baru / streaming / busy → tetap di ekor daftar.
  useEffect(() => {
    if (activeTab === 'chat' && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages, busy, activeTab]);

  // Timeline dikelompokkan per pesan assistant, pesan terbaru dulu → event baru nongol di atas.
  const activityGroups: Array<{ message: ChatMessage; events: ChatToolEvent[] }> = [];
  for (const message of [...messages].reverse()) {
    const events = message.role === 'assistant' ? message.toolEvents ?? [] : [];
    if (events.length > 0) activityGroups.push({ message, events });
  }
  const visibleGroups = activityGroups
    .map((group) => ({ ...group, events: group.events.filter((event) => matchActivityFilter(event, activityFilter)) }))
    .filter((group) => group.events.length > 0);
  const visibleCount = visibleGroups.reduce((total, group) => total + group.events.length, 0);

  /** Kirim: draft + blok `<lampiranPaths>` (path relatif folder project) — agent
   * baca langsung dari attachments/. Setelah kirim: reset draft + lampiran. */
  const submitDraft = () => {
    const text = draft.trim();
    if ((!text && attachments.length === 0) || sending) return;
    let final = text;
    if (attachments.length > 0) {
      const block = `<lampiranPaths>\n${attachments.map((a) => a.path).join('\n')}\n</lampiranPaths>`;
      final = text ? `${text}\n\n${block}` : block;
    }
    onSend(final);
    setDraft('');
    setAttachments([]);
  };

  /** [+] composer: setiap file di-POST ke /api/projects/{slug}/attachments
   * (simpan di folder project user, gak data/). Gagal → uploadError di baris hint. */
  const handlePickFiles = (files: File[]) => {
    setUploadError(null);
    setUploading(true);
    void (async () => {
      const saved: AgentAttachment[] = [];
      for (const file of files) {
        try {
          const formData = new FormData();
          formData.append('file', file);
          const res = await fetch(`/api/projects/${encodeURIComponent(slug)}/attachments`, {
            method: 'POST',
            body: formData,
          });
          const data = (await res.json()) as { path?: string; name?: string; size?: number; error?: string };
          if (!res.ok || !data.path || !data.name) throw new Error(data.error ?? 'upload gagal');
          saved.push({ id: attachmentId(), name: data.name, path: data.path, size: data.size ?? file.size });
        } catch {
          setUploadError(t('composer.uploadErr'));
        }
      }
      if (saved.length > 0) {
        setUploadError(null);
        setAttachments((prev) => [...prev, ...saved]);
      }
      setUploading(false);
    })();
  };

  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((attachment) => attachment.id !== id));
  };

  // Sesi aktif buat pill strip (title kosong → cuma label "Sesi" di pill).
  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? null;

  return (
    <aside className="flex h-full flex-col border-l border-border bg-background">
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border bg-card px-2">
        <Sparkles size={13} className="shrink-0 text-accent" />
        <SegmentedGroup
          options={[
            { value: 'chat', label: t('ai.chat') },
            { value: 'activity', label: t('ai.activity') },
          ]}
          active={activeTab}
          onSelect={(value) => setActiveTab(value as 'chat' | 'activity')}
        />
        <span
          className="ml-auto min-w-0 max-w-28 truncate font-serif text-sm font-semibold tracking-tight text-foreground"
          title={projectTitle}
        >
          {projectTitle}
        </span>
        <div ref={capsRef} className="relative shrink-0">
          <button
            type="button"
            onClick={() => setCapsOpen((v) => !v)}
            className={`flex items-center gap-0.5 rounded-md border px-1.5 py-0.5 text-[10px] transition-colors ${
              capsOpen
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border bg-muted text-muted-foreground'
            }`}
            title={t('ai.capabilities')}
          >
            <SlidersHorizontal size={11} />
          </button>
          {capsOpen && (
            <div className="absolute right-0 top-8 z-40 w-64 rounded-lg border border-border bg-card p-1 shadow-lg">
              <p className="px-2 py-1 text-[10px] font-medium text-muted-foreground">
                {t('ai.capabilities')}
              </p>
              {(
                [
                  { key: 'websearch', title: t('ai.capWebsearch'), desc: t('ai.capWebsearchDesc') },
                  { key: 'literature', title: t('ai.capLiterature'), desc: t('ai.capLiteratureDesc') },
                ] as const
              ).map((item) => {
                const on = capabilities?.[item.key] ?? false;
                return (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => onToggleCapability(item.key, !on)}
                    className="flex w-full items-start gap-2 rounded px-2 py-1.5 text-left transition-colors hover:bg-muted"
                  >
                    <span
                      className={`mt-0.5 flex h-4 w-7 shrink-0 items-center rounded-full px-0.5 transition-colors ${
                        on ? 'bg-primary justify-end' : 'bg-muted justify-start'
                      }`}
                    >
                      <span className="h-3 w-3 rounded-full bg-card" />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[11px] font-medium text-foreground">
                        {item.title}
                      </span>
                      <span className="block text-[10px] leading-snug text-muted-foreground">{item.desc}</span>
                    </span>
                  </button>
                );
              })}
              <p className="border-t border-border px-2 py-1.5 text-[10px] leading-snug text-muted-foreground">
                {t('ai.capabilitiesNote')}
              </p>
            </div>
          )}
        </div>
        {/* Meter token sesi: total in+out; usage belum ke-wire → "—". */}
        <span
          className="shrink-0 rounded-md border border-border bg-muted/60 px-1.5 py-0.5 text-[10px] text-muted-foreground"
          title={
            usage
              ? `Masuk ${formatTokenCompact(usage.input)} · Keluar ${formatTokenCompact(usage.output)}`
              : t('ai.usageTokens')
          }
        >
          {t('ai.usageTokens')} <span className="font-mono">{usage ? formatTokenCompact(usage.input + usage.output) : '—'}</span>
        </span>
        <StatusDot
          tone={connected ? 'green' : 'amber'}
          title={t(connected ? 'ai.connected' : 'ai.disconnected')}
        />
        {/* Diagnosa koneksi: provider terdaftar ≠ model bisa dipakai. */}
        <button
          type="button"
          onClick={() => void runDoctor()}
          aria-label={t('ai.doctor')}
          title={t('ai.doctor')}
          className="flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          {doctorBusy ? <Loader2 size={12} className="animate-spin" /> : <Stethoscope size={12} />}
        </button>
        {/* Tutup panel kanan — arrow menunjuk keluar (kanan). */}
        {onCollapse && (
          <button
            type="button"
            onClick={onCollapse}
            aria-label={t('layout.rightClose')}
            title={t('layout.rightClose')}
            className="flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <ChevronRight size={12} />
          </button>
        )}
      </div>

      {activeTab === 'chat' ? (
        <>
          {!connected && (
            // Belum login provider Plus → chat tetap jalan (model gratis); CTA ramping di atas.
            <div className="flex shrink-0 items-center gap-2 border-b border-accent/40 bg-accent/10 px-2.5 py-1.5 text-[11px] text-foreground">
              <span className="min-w-0 flex-1 leading-snug">{t('ai.freeBanner')}</span>
              <Button
                variant="outline"
                className="shrink-0 px-2 py-0.5 text-[11px]"
                onClick={onConnect}
              >
                {t('ai.connect')}
              </Button>
            </div>
          )}
          {/* Strip multi-sesi — desain SAMA persis dengan header tab panel tengah:
              chip tab (rounded-t-lg + garis bawah aktif) + tombol + polos kotak. */}
          <div className="flex h-9 shrink-0 items-stretch border-b border-border bg-card">
            <div ref={sessionsRef} className="relative min-w-0 shrink-0">
              <button
                type="button"
                onClick={() => setSessionsOpen((v) => !v)}
                aria-expanded={sessionsOpen}
                title={t('composer.slashHint')}
                className={`flex h-9 min-w-0 max-w-56 shrink-0 cursor-pointer items-center gap-1.5 rounded-t-lg border-b-2 px-3 transition-colors [transition-property:color,background-color] ${
                  sessionsOpen
                    ? 'border-b-primary bg-background text-card-foreground'
                    : 'border-b-transparent text-muted-foreground hover:bg-muted hover:text-foreground'
                }`}
              >
                {switching ? (
                  <>
                    <Loader2 size={11} className="shrink-0 animate-spin" />
                    <span className="min-w-0 flex-1 truncate text-xs">{t('agent.sessionSwitchBusy')}</span>
                  </>
                ) : (
                  <>
                    <StatusDot
                      tone={sessionReady ? 'green' : 'idle'}
                      title={sessionReady ? t('ai.sessionReady') : t('agent.sessionsTitle')}
                    />
                    <span className="max-w-40 truncate text-xs" title={activeSession?.title ?? projectTitle}>
                      {activeSession?.title || t('agent.sessionsTitle')}
                    </span>
                    <ChevronDown size={12} className="shrink-0 text-muted-foreground" />
                  </>
                )}
              </button>
              {sessionsOpen && (
                <div className="absolute left-0 top-full mt-0.5 z-50 w-64 rounded-lg border border-border bg-card p-1 shadow-lg">
                  {/* "Sesi baru" selalu di atas (pola slash-menu). */}
                  <button
                    type="button"
                    onClick={() => {
                      setSessionsOpen(false);
                      onCreateSession();
                    }}
                    className={`flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-[11px] transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                      switching ? 'pointer-events-none text-muted-foreground opacity-50' : 'text-foreground'
                    }`}
                  >
                    <Plus size={12} className="shrink-0 text-accent" />
                    <span className="min-w-0 flex-1 truncate font-medium">{t('agent.sessionNew')}</span>
                  </button>
                  {sessions.length === 0 ? (
                    <p className="px-2 py-1.5 text-[10px] leading-snug text-muted-foreground">
                      {t('agent.sessionsEmpty')}
                    </p>
                  ) : (
                    <div className="border-t border-border pt-0.5">
                      {sessions.map((session) => {
                        const active = session.id === activeSessionId;
                        return (
                          <button
                            key={session.id}
                            type="button"
                            onClick={() => {
                              setSessionsOpen(false);
                              if (!active) onSwitchSession(session.id);
                            }}
                            aria-current={active || undefined}
                            className={`flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                              active ? 'bg-primary/10 text-primary' : 'text-foreground hover:bg-muted'
                            }${switching && !active ? ' pointer-events-none opacity-60' : ''}`}
                          >
                            <span className="min-w-0 flex-1 truncate">
                              {session.title || session.id.slice(0, 10)}
                            </span>
                            <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                              {formatSessionTime(session.timeCreated)}
                            </span>
                            {active && <Check size={11} className="shrink-0 text-primary" />}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
            {/* Tombol + polos kotak — identik tombol + di header tab tengah. */}
            <button
              type="button"
              onClick={onCreateSession}
              disabled={switching}
              aria-label={t('agent.sessionNew')}
              title={t('agent.sessionNew')}
              className={`flex h-9 w-9 shrink-0 items-center justify-center text-muted-foreground transition-colors [transition-property:color,background-color] hover:bg-muted hover:text-foreground ${
                switching ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'
              }`}
            >
              {switching ? <Loader2 size={12} className="animate-spin" /> : <Plus size={14} />}
            </button>
            {!sessionReady && (
              <Button
                variant="outline"
                className="mt-1.5 self-center px-2 py-0.5 text-xs"
                onClick={() => void onEnsureSession()}
              >
                {t('ai.startSession')}
              </Button>
            )}
          </div>

          <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-2.5 py-2.5">
            {messages.length === 0 ? (
              <p className="px-2 py-4 text-center text-xs text-muted-foreground">{t('ai.empty')}</p>
            ) : (
              <div className="space-y-2.5">
                {messages.map((message) => (
                  <MessageBubble key={message.id} message={message} slug={slug} />
                ))}
                {busy && (
                  <div className="flex justify-start" role="status" aria-label={t('ai.typing')}>
                    <div className="flex items-center gap-1.5 rounded-2xl rounded-bl-sm bg-muted px-3 py-2 text-muted-foreground">
                      <span className="typing-dots">
                        <span />
                        <span />
                        <span />
                      </span>
                      <span className="text-[10px]">{t('ai.typing')}</span>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Komposer ala-Codex (ss2): saran chip sekali-tampil + card textarea
              + baris bawah [+] · model ▾ · effort ▾ · ↑. Semua markup di agent-composer. */}
          <div className="shrink-0 px-2.5 pb-2.5">
            <AgentComposer
              draft={draft}
              onDraftChange={setDraft}
              onSubmit={submitDraft}
              sending={sending}
              busy={busy}
              suggestions={SUGGESTION_KEYS.map((key) => t(key))}
              suggestLabel={t('chat.suggestLabel')}
              activeFilePath={activeFilePath}
              attachments={attachments}
              uploading={uploading}
              uploadError={uploadError}
              onPickFiles={handlePickFiles}
              onRemoveAttachment={removeAttachment}
              sessions={sessions}
              activeSessionId={activeSessionId}
              switching={switching}
              onCreateSession={onCreateSession}
              onSwitchSession={onSwitchSession}
              models={models}
              currentModel={currentModel}
              onSelectModel={onSelectModel}
              providerPicks={providerPicks}
              onProviderConnect={onProviderConnect}
              onProviderDisconnect={onProviderDisconnect}
            />
          </div>
        </>
      ) : (
        // Tab Aktivitas: chip filter + timeline collapsible (grup per pesan, terbaru di atas).
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center gap-1 border-b border-border bg-card px-2.5 py-1.5">
            {ACTIVITY_FILTERS.map((item) => (
              <button
                key={item.value}
                type="button"
                onClick={() => setActivityFilter(item.value)}
                className={`rounded-full px-2 py-0.5 text-[10px] transition-colors ${
                  activityFilter === item.value
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                }`}
              >
                {t(item.key)}
              </button>
            ))}
            <span className="ml-auto rounded-full border border-border bg-muted/60 px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
              {t('ai.activitySteps', { n: visibleCount, count: visibleCount })}
            </span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2.5 py-2.5">
            {activityGroups.length === 0 ? (
              <p className="px-2 py-4 text-center text-xs text-muted-foreground">{t('ai.activityEmpty')}</p>
            ) : (
              <div className="space-y-3">
                {visibleGroups.map((group) => (
                  <section key={group.message.id}>
                    <p
                      className="mb-1 truncate px-0.5 text-[9px] uppercase tracking-wide text-muted-foreground"
                      title={group.message.text}
                    >
                      {group.message.text}
                    </p>
                    <ul className="space-y-1.5">
                      {group.events.map((event) => <ActivityCard key={event.id} event={event} />)}
                    </ul>
                  </section>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Diagnosa koneksi AI — provider terdaftar ≠ model bisa dipakai. */}
      <Modal open={doctorOpen} onClose={() => setDoctorOpen(false)} title={t('ai.doctorTitle')}>
        <div className="space-y-3 text-xs">
          {doctorBusy && (
            <p className="flex items-center gap-2 text-muted-foreground">
              <Loader2 size={13} className="animate-spin" />
              {t('ai.doctorRunning')}
            </p>
          )}
          {!doctorBusy && doctor?.error && (
            <p className="text-destructive">{doctor.error}</p>
          )}
          {!doctorBusy && doctor && doctor.findings.length === 0 && !doctor.error && (
            <p className="text-muted-foreground">{t('ai.doctorEmpty')}</p>
          )}
          {!doctorBusy &&
            doctor?.findings.map((finding) => (
              <div key={`${finding.providerID}-${finding.modelID}`} className="rounded-md border border-border p-2">
                <div className="flex items-center gap-2">
                  <StatusDot
                    tone={
                      finding.status === 'ok'
                        ? 'green'
                        : finding.status === 'error' || finding.status === 'auth'
                          ? 'red'
                          : 'amber'
                    }
                    title={finding.status}
                  />
                  <span className="font-medium">{finding.label}</span>
                  <span className="truncate font-mono text-[10px] text-muted-foreground">
                    {finding.modelID}
                  </span>
                </div>
                <p className="mt-1 text-muted-foreground">
                  {t(`ai.doctorStatus.${finding.status}`)}
                </p>
                <p className="mt-1 break-words text-[10px] text-muted-foreground/80">{finding.message}</p>
                {finding.status !== 'ok' && (
                  <p className="mt-1 text-[10px] text-amber-700 dark:text-amber-300">
                    {t(`ai.doctorFix.${finding.status}`)}
                  </p>
                )}
                {finding.workingModel && (
                  <Button
                    variant="outline"
                    className="mt-1.5 h-6 px-2 text-[10px]"
                    onClick={() => void applyModel(finding.providerID, finding.workingModel!)}
                  >
                    {t('ai.doctorUseModel', { model: finding.workingModel })}
                  </Button>
                )}
              </div>
            ))}
          <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
            {doctor?.findings.some(
              (finding) => finding.status === 'not-supported' || finding.status === 'auth',
            ) && (
              <Button
                variant="outline"
                className="h-7 px-2 text-[11px]"
                onClick={() => {
                  setDoctorOpen(false);
                  onReconnect?.();
                }}
              >
                {t('ai.doctorReconnect')}
              </Button>
            )}
            <Button variant="outline" className="h-7 px-2 text-[11px]" onClick={() => setDoctorOpen(false)}>
              {t('common.close')}
            </Button>
          </div>
        </div>
      </Modal>
    </aside>
  );
}
