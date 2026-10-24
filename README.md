<h1 align="center">Vibe Research</h1>

<p align="center">
  <img alt="Next.js 15.5" src="https://img.shields.io/badge/Next.js-15.5-black?style=flat-square">
  <img alt="React 19.1" src="https://img.shields.io/badge/React-19.1-61dafb?style=flat-square">
  <img alt="TypeScript 5" src="https://img.shields.io/badge/TypeScript-5-3178c6?style=flat-square">
  <img alt="Tailwind CSS 4" src="https://img.shields.io/badge/Tailwind_CSS-4-06b6d4?style=flat-square">
  <img alt="SQLite with Drizzle" src="https://img.shields.io/badge/SQLite-Drizzle-003b57?style=flat-square">
  <img alt="Node.js 24" src="https://img.shields.io/badge/Node.js-24-5fa04e?style=flat-square">
</p>

<p align="center">
  A local-first, single-user workspace for academic writing: chapter editing, literature search<br>
  and citation management, data analysis, and an embedded AI assistant, operating on plain files<br>
  inside a user-selected project directory.
</p>

---

## Table of contents

1. [Overview](#1-overview)
2. [Features](#2-features)
3. [Architecture](#3-architecture)
4. [Technology stack](#4-technology-stack)
5. [Requirements](#5-requirements)
6. [Installation](#6-installation)
7. [Configuration](#7-configuration)
8. [Usage](#8-usage)
9. [Workspace layout](#9-workspace-layout)
10. [Data model](#10-data-model)
11. [AI integration](#11-ai-integration)
12. [Document processing](#12-document-processing)
13. [API surface](#13-api-surface)
14. [Scripts](#14-scripts)
15. [Development](#15-development)
16. [Troubleshooting](#16-troubleshooting)
17. [Limitations](#17-limitations)
18. [License](#18-license)

---

## 1. Overview

Vibe Research is a Next.js application that runs as a single-user service bound to `127.0.0.1`.
It manages one or more *project directories* (thesis workspaces) and edits their contents
directly. The application does not create accounts, does not synchronise data to a remote
service, and does not host user documents.

Design constraints:

- **Files are the source of truth.** Chapters, bibliography, data and analysis output are stored
  as plain files inside the project directory. The application database only holds application
  state.
- **Markdown is the document format.** Each chapter is a separate `.md` file. Rich editing is
  provided through an embedded editor; DOCX/PDF are one-way export targets.
- **The AI assistant operates on the workspace.** The assistant reads and writes files inside the
  project directory through the OpenCode runtime, subject to directory-scoped path guards.
- **Operations are reversible.** Chapter versions are snapshotted to disk before every overwrite,
  and destructive production of content (agent edits, table insertion) is recorded in the version
  history.

## 2. Features

### 2.1 Document editing

| Capability | Detail |
|---|---|
| Chapter editor | TipTap 3 with a Word-style ribbon: paragraph styles, font family/size, line spacing, inline formatting, four-way alignment, ordered/unordered/task lists with indent control, tables, links, images, clear formatting |
| Autosave | 800 ms debounce; manual save with `Ctrl/⌘ + S` |
| Word tab | WordCraft (WebAssembly) in a same-origin iframe; opens a `.md` chapter, edits it, writes the result back to the same file |
| Excel tab | GridCraft (WebAssembly); opens `.xlsx`/`.csv` and writes the binary back to the project |
| Outline | Chapter inventory with word counts and per-chapter word targets |
| Draft quality scan | Detects filler phrases, misplaced quote notes, a bibliography section inside a chapter, headings containing a stray sentence, and hanging ellipses; supports automatic fixes |
| Version history | Content is snapshotted to `.riwayat/` before each overwrite; supports diff, restore and delete, with restore itself being reversible |

### 2.2 Literature and citations

| Capability | Detail |
|---|---|
| Journal search | Parallel queries to OpenAlex, Crossref and Semantic Scholar; merged and de-duplicated by DOI; citation counts and open-access status |
| Library | Saved papers stored per project; open-access PDFs downloaded to `referensi/papers/`; BibTeX entries appended to `references.bib` |
| Literature matrix | Per-paper theme / method / findings / quote columns; markdown table export |
| Annotations | Per-paper notes with optional quotes; a quote can be applied to the paper's matrix row |
| Reference manager integration | Zotero via Better BibTeX auto-export; Mendeley via `.bib`/`.ris` import |
| Citation consistency | Detects cited keys absent from the bibliography and bibliography entries never cited |
| Citation insertion | Citation panel inside the Word tab inserts `[@key]` markers at the caret |

### 2.3 Data analysis

| Capability | Detail |
|---|---|
| Data intake | CSV/XLSX upload into `data/`; the application never modifies these files. A Google Forms importer maps scale questions to `P1..Pn`, converts Likert text answers to numbers, keeps identity and free-text columns, and warns about values it does not recognise |
| Statistics script | `uji-statistik.py`: descriptives, Shapiro-Wilk, Pearson/Spearman correlation, independent and Welch t-test, one-way ANOVA with Tukey HSD, paired t-test, multiple linear regression (VIF, Durbin-Watson, residual diagnostics, Glejser and Breusch-Pagan), Cronbach's alpha, item validity and reliability |
| Run from the UI | Two presets (instrument validity, full regression) run the script from the Data panel with a live log, the exit code and the report path. The server resolves the project virtualenv, refuses paths outside the project and enforces a ten minute timeout |
| Figures | Histograms and Q-Q plots are generated for the dependent variable and the predictors only; `--figures-all` restores every numeric column. Scatter, residual and group box plots are always produced |
| Sample size | Slovin, Cochran with finite population correction, and Isaac & Michael, each with its formula and assumptions, plus a table ready to paste into Chapter 3 |
| Report insertion | Tables and figures from `hasil/*.md` can be inserted at the end of a chosen section with thesis-style numbering (`Tabel 3.1`, `Gambar 4.2`); a version snapshot is taken first |

### 2.4 Revision workflow

| Capability | Detail |
|---|---|
| Comment intake | Supervisor comments pasted as a batch and split into checklist items |
| Status tracking | `todo` / `doing` / `done`, resolution timestamp and note |
| Chapter binding | Each item can be attached to a chapter file |
| Export | Open items exported as markdown for reporting back |

### 2.5 AI assistant

| Capability | Detail |
|---|---|
| Workspace access | Reads and edits project files, searches literature, executes analysis scripts |
| Context injection | Project title, chapter list, bibliography and active file are included per turn |
| Streaming | Token streaming, collapsible tool timeline, token meter, permission prompts |
| Model selection | Free models, ChatGPT subscription sign-in, or API keys for third-party providers |
| Diagnostics | Provider/model probe reporting quota, entitlement, availability and credential failures |
| Turn reconciliation | Typing state is verified against server state, so a dropped event stream cannot leave the chat locked |

### 2.6 Interface

- Indonesian (default) and English localisation, 885 keys maintained in parity.
- Light, dark and system themes; collapsible panels; focus mode; resizable three-panel layout.
- File manager with drag-to-move, file/folder creation, deletion and OS drag-and-drop upload.

### 2.7 Integrity and defense

| Capability | Detail |
|---|---|
| Citation style | Upload a campus `.csl` file; it is stored inside the project and passed to pandoc, so the bibliography follows the campus format instead of APA or IEEE |
| Provenance | Every paragraph is labelled human, agent, or edited after the agent, computed from the version snapshots and their recorded reasons |
| Similarity pre-check | Chapter sentences are compared with the abstracts of saved papers (five-word shingles, Jaccard similarity, 80% threshold). This is a local pre-check, not a plagiarism service |
| Defense slides | A 10–14 slide deck is generated from chapters 1, 4 and 5 with the regression tables and the most relevant figures. Sections that do not exist are skipped and listed, never invented |

## 3. Architecture

```
┌──────────────────────────── Browser (localhost) ────────────────────────────┐
│  Next.js App Router — UI and API routes                                     │
│    src/app            pages, 51 route handlers                              │
│    src/components     workspace shell, panels, editor, tabs                 │
│    src/lib            workspace guards, journals, citations, matrix,        │
│                       versions, revisions, notes, insert, opencode client   │
└───────────────┬───────────────────────────────────────┬─────────────────────┘
                │ HTTP + SSE                             │ filesystem I/O
                ▼                                        ▼
┌───────────────────────────────────┐      ┌─────────────────────────────────┐
│ OpenCode service (background)     │      │ Project directory               │
│  session per project directory    │      │  dokumen/  gambar/  referensi/  │
│  provider credentials, models     │      │  data/  hasil/  scripts/        │
│  tool execution, event stream     │      │  export/  .riwayat/ .opencode/  │
└───────────────────────────────────┘      └─────────────────────────────────┘
                │
                ▼
       data/app.db (SQLite, application state only)
```

The OpenCode service is a separate long-lived process. It is discovered through a runtime
descriptor under `~/.local/state/opencode/`, authenticated with HTTP Basic, and consumed through
`@opencode/client` (REST calls plus a server-sent event stream). Credentials never enter the
application database.

## 4. Technology stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 24, pnpm |
| Framework | Next.js 15.5.28 (App Router), React 19.1, TypeScript 5 (strict) |
| Styling | Tailwind CSS 4, local UI primitives (`src/components/ui.tsx`) |
| Editor | TipTap 3.32, `@tiptap/markdown` |
| Embedded office engines | WordCraft 0.8 (WASM), GridCraft 0.9 (WASM) |
| AI runtime | OpenCode service, `@opencode/client` 2.0.32 |
| Database | SQLite via better-sqlite3 13, Drizzle ORM 0.45, Drizzle Kit 0.31 |
| Validation | Zod 4 |
| Literature sources | OpenAlex, Crossref, Semantic Scholar Graph API |
| Citations | `references.bib`, CSL styles (APA, IEEE, or a project-supplied `.csl`) |
| Export | pandoc `--citeproc`; DOCX reference document; PDF via weasyprint or wkhtmltopdf; PPTX via pptxgenjs 4 |
| DOCX post-processing | JSZip (injects `b:Sources` custom XML) |
| Internationalisation | JSON dictionaries with a React context |

## 5. Requirements

| Dependency | Minimum | Purpose |
|---|---|---|
| Node.js | 24 | Runtime; required by `@opencode/client` |
| pnpm | 9 | Package manager |
| pandoc | 3 | DOCX/PDF export and citation processing |
| weasyprint or wkhtmltopdf | current | PDF export |
| Python | 3.10 | Statistics script |
| Python packages | see `requirements.txt` | pandas, scipy, statsmodels, openpyxl |
| OpenCode CLI | 2.x | AI assistant runtime |
| fontTools, Microsoft core fonts | optional | Extended WordCraft font pack |

System packages on Debian/Ubuntu:

```bash
sudo apt install pandoc python3 python3-venv weasyprint
sudo apt install ttf-mscorefonts-installer   # optional, font pack
python3 -m pip install --user fonttools       # optional, font pack
```

## 6. Installation

```bash
corepack enable
pnpm install
bash scripts/setup-semua.sh     # fetch WordCraft, GridCraft and the font pack
pnpm build
pnpm start
```

The application listens on `http://127.0.0.1:3000`. The SQLite database is created and migrated
automatically on first start; no manual database step is required.

AI provider authentication is performed once, outside the application:

```bash
opencode auth login openai --method chatgpt-headless   # ChatGPT subscription (device code)
```

Alternatively, connect a provider with an API key from **Settings → Providers** in the interface.

## 7. Configuration

| Item | Location |
|---|---|
| Database | `data/app.db` (SQLite, WAL mode) |
| Migrations | `drizzle/` (applied at startup) |
| WordCraft build | `public/wordcraft/` (gitignored, fetched by script) |
| GridCraft build | `public/gridcraft/` (gitignored, fetched by script) |
| WordCraft font pack | `data/wordcraft-fonts/` (gitignored, generated by script) |
| Export reference document | `templates/skripsi-reference.docx` |
| Citation styles | `csl/apa.csl`, `csl/ieee.csl` |
| PDF stylesheet | `assets/pdf.css` |
| Per-project agent configuration | `<project>/.opencode/opencode.json`, `<project>/AGENTS.md` |

All HTTP services bind to loopback. There is no configuration file for the application itself;
preferences are stored in the `settings` table and edited through the interface.

## 8. Usage

1. Open `http://127.0.0.1:3000` and attach a project directory using **Pasang folder project**.
   The path must reside inside the current user's home directory. Missing standard subdirectories
   are created; existing files are not modified.
2. Create a chapter, or place an existing `.md` file in `dokumen/`.
3. Optionally connect the AI assistant.
4. Add references through the journal search panel, or place a `references.bib` in the project
   root.
5. Export a chapter from the editor ribbon. DOCX export uses
   `templates/skripsi-reference.docx`.

## 9. Workspace layout

The project directory is created and managed by the application:

```
<project>/
├─ dokumen/            chapters, one markdown file per chapter
├─ gambar/             images referenced by chapters
├─ referensi/
│  ├─ papers/          source PDFs
│  └─ references.bib   bibliography
├─ data/               raw data (read-only for the application)
├─ hasil/              analysis reports (markdown)
├─ scripts/            reproducible analysis scripts
├─ export/             exported DOCX/PDF and slide decks
├─ .riwayat/           chapter version snapshots
├─ .vibe-research/     project settings (word targets, campus citation style)
└─ .opencode/          per-project agent configuration
```

The application repository contains the following generated directories, excluded from version
control:

```
public/wordcraft/      WordCraft web build
public/gridcraft/      GridCraft web build
data/wordcraft-fonts/  WordCraft font pack
data/app.db            application database
```

## 10. Data model

Application state is stored in SQLite (`data/app.db`), schema defined in
`src/lib/db/schema.ts`. Six tables:

| Table | Columns | Purpose |
|---|---|---|
| `projects` | `id, slug, name, folder_path, created_at, last_opened_at, opencode_session_id` | Registered project directories and the bound AI session |
| `settings` | `id (=1), locale, theme, effort, default_citation_style, last_project_id, agent_model_override` | Single-row application preferences |
| `saved_papers` | `id, slug, paper_id, bib_key, data, created_at` | Library entries; unique on `(slug, paper_id)` |
| `matrix_rows` | `id, slug, paper_id, title, authors, year, tema, metode, temuan, kutipan, position, created_at` | Literature matrix; unique on `(slug, paper_id)` |
| `paper_notes` | `id, slug, paper_id, matrix_row_id, note, quote, source, created_at` | Paper annotations; `matrix_row_id` references `matrix_rows` with `ON DELETE SET NULL` |
| `revision_items` | `id, slug, text, status, chapter_path, note, resolved_at, position, created_at` | Revision checklist |

Migrations are stored in `drizzle/` and applied automatically at startup by
`src/lib/db/index.ts`. The initial migration is idempotent, so an existing database is left
untouched. After modifying the schema:

```bash
pnpm db:generate   # create a migration
pnpm db:push       # or synchronise a development database directly
```

## 11. AI integration

### 11.1 Runtime

The assistant is executed by the OpenCode background service. The application:

1. discovers a live service through `~/.local/state/opencode/service.*.json`;
2. authenticates with HTTP Basic using the service password;
3. creates one session per project directory, bound in `projects.opencode_session_id`;
4. streams responses through a server-sent event proxy at `/api/ai/stream`.

The service is started automatically if no live instance is found.

### 11.2 Model selection

Resolution order: explicit user override, then the first connected non-free provider model, then
the service default. The model catalogue lists more models than a given subscription account can
use; `/api/ai/doctor` probes one model per provider and reports the failure class (quota,
entitlement, availability, credential), together with a model that is known to work.

### 11.3 Permissions and project configuration

The application writes `<project>/.opencode/opencode.json` (persona and tool toggles) and a
managed block in `<project>/AGENTS.md`. Only the application-owned keys and the marker-delimited
block are rewritten; all other content is preserved.

## 12. Document processing

### 12.1 Embedded editors

WordCraft and GridCraft run in same-origin iframes. Two integration points are required:

- **Opening a file** — the content is transferred with a synthetic drag-and-drop dispatched inside
  the iframe's realm, after the embedded application signals that its drop handler is registered.
  Dispatching from the parent realm, or before initialisation completes, only registers the file
  in the embedded application's recent-files list.
- **Saving a file** — `showSaveFilePicker` is intercepted; the produced bytes are posted to the
  parent frame and written back to the project. WordCraft always writes DOCX, so the bytes are
  converted to markdown with pandoc before the chapter is updated. WordCraft's own
  *File → Export → Markdown* produces native markdown and is the higher-fidelity path.

The WordCraft font pack is generated by `scripts/wordcraft-fontpack-v3.py` and seeded into browser
IndexedDB before the embedded application starts.

### 12.2 Export pipeline

```
chapter.md ──► pandoc --citeproc ──► DOCX ──► inject b:Sources ──► export/
            │                        └──► reference-doc: TNR 12 pt, 1.5 spacing, A4, 4/3/3/3 cm
            └──► HTML + assets/pdf.css ──► weasyprint|wkhtmltopdf ──► PDF
```

Citation markers use the `[@key]` syntax and are resolved against `references.bib`. An export
preflight reports keys that have no bibliography entry. Exported files are final artefacts;
subsequent edits in an external word processor are not synchronised back.

Two headings at the top of a chapter (`# BAB I` followed by `# PENDAHULUAN`) are merged before
assembly, so the table of contents lists one entry per chapter instead of two. The DOCX keeps its
table of contents as a field with `updateFields` enabled, and the PDF is rendered with real page
numbers. A slide deck is built from the same chapters, so all three artefacts describe the same
text.

```
dokumen/*.md ──► slide composer ──► export/slide-sidang.pptx (10–14 slides)
             └─ tables from hasil/, figures from gambar/
```

## 13. API surface

64 route handlers, grouped:

| Group | Routes |
|---|---|
| AI runtime | `ai/status`, `ai/doctor`, `ai/connect`, `ai/models`, `ai/providers`, `ai/capabilities`, `ai/session`, `ai/sessions`, `ai/prompt`, `ai/stream`, `ai/messages`, `ai/usage`, `ai/permission`, `ai/question` |
| Projects | `projects`, `projects/[slug]` |
| Project files | `tree`, `file`, `file/move`, `files`, `folders`, `raw`, `upload`, `upload-folder`, `attachments`, `documents`, `spreadsheets` |
| Literature and citations | `journals/search`, `journals/save`, `journals/related`, `journals/pdf`, `bib`, `bib/sources`, `citations/check`, `csl` |
| Research support | `matrix`, `matrix/export`, `notes`, `revisions`, `revisions/import`, `versions`, `versions/restore`, `insert-result`, `stats-template`, `instrument-template`, `targets`, `progress`, `backup` |
| Analysis | `analysis/run`, `analysis/columns` |
| Export | `export`, `export/thesis`, `export/front-matter`, `export/slides`, `word-save` |
| Integrity | `provenance`, `similarity` |
| Integrations | `zotero`, `extensions`, `skills` |
| Application | `settings`, `proxy`, `wordcraft/fonts/pack`, `wordcraft/fonts/file/[name]` |

All project-scoped routes resolve the project by slug, validate input with Zod, and reject paths
outside the project directory.

## 14. Scripts

| Script | Purpose |
|---|---|
| `scripts/setup-semua.sh` | Fetch WordCraft, GridCraft and the font pack |
| `scripts/fetch-wordcraft.sh` | Download the WordCraft web build (`WORDCRAFT_VER` to override) |
| `scripts/fetch-gridcraft.sh` | Download the GridCraft web build (`GRIDCRAFT_VER` to override) |
| `scripts/wordcraft-fontpack-v3.py` | Build the WordCraft font pack |
| `scripts/wordcraft-font-alias.py` | Add metric-compatible font aliases to the pack |
| `scripts/make-reference-docx.mjs` | Regenerate `templates/skripsi-reference.docx` |
| `assets/templates/uji-statistik.py` | Statistics script installed into project directories |

## 15. Development

```bash
pnpm dev       # Turbopack development server on 127.0.0.1:3000
pnpm lint      # ESLint
pnpm build     # production build
```

The production build is recommended for evaluation on low-memory machines; the development server
compiles routes on demand and is noticeably slower.

## 16. Troubleshooting

| Symptom | Cause and resolution |
|---|---|
| `no such table: projects` | Database predates migrations. Run `pnpm db:push`. |
| Word tab displays the start screen instead of the document | The embedded engine had not finished initialising. Use **Open in Word**; initialisation can take several seconds on first load. |
| `not supported when using Codex with a ChatGPT account` | The selected model is not available to the account. Select another model; use **Check AI connection** to identify a working one. |
| `Free usage limit reached` | Free-tier quota exhausted. Connect a subscription or API key in Settings → Providers. |
| PDF export reports a missing tool | Install weasyprint or wkhtmltopdf, or export DOCX. |
| Saving from Word does not update the chapter | Only markdown round-trips automatically. Use WordCraft's *File → Export → Markdown*. |
| First free-model answer takes about a minute | The free provider starts a worker process on first use. |

## 17. Limitations

- Single user, loopback binding only; no authentication, multi-user support, sharing or remote
  synchronisation.
- Markdown is the canonical format. Round-trips through Word or Excel are conversions; complex
  document features such as fields and page numbering are not preserved.
- DOCX/PDF export is one-way.
- The DOCX table of contents is a Word field: Word fills it in when the document is opened
  (choose Yes when prompted, or right-click the table of contents and pick Update Field). The PDF
  is generated with a real table of contents and printed page numbers.
- WordCraft saves DOCX; markdown output requires the embedded export menu.
- The similarity check compares chapter sentences with saved abstracts only, so it cannot catch a
  paraphrase whose source sentence never appears in an abstract.
- Provenance is inferred from version snapshots. Edits made outside the application without a
  snapshot are attributed to the previous state.
- Defense slides are generated from existing text with a fixed layout; there is no visual theme
  editor.
- Google Scholar is not queried, as it provides no official API.

## 18. License

Application code is provided for use by its author. WordCraft and GridCraft are third-party
packages distributed under MIT / Apache-2.0 and are downloaded separately by
`scripts/setup-semua.sh`.
