# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Vibe Research — image lokal untuk satu pengguna.
#
# Dua tahap: build (Node + pnpm) lalu runtime (tanpa toolchain build). Yang
# ikut ke runtime hanya artefak Next, node_modules, aset wasm WordCraft/
# GridCraft, dan tool yang dipanggil saat ekspor: pandoc (DOCX) dan weasyprint
# (PDF). Python dari virtualenv dipakai skrip analisis statistik.
# ---------------------------------------------------------------------------

FROM node:24-bookworm-slim AS build
WORKDIR /app

RUN npm i -g pnpm@10

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

# ---------------------------------------------------------------------------
FROM node:24-bookworm-slim AS runtime
WORKDIR /app

# lib/analysis/runner.ts memanggil `python3` polos saat project tidak punya
# .venv; karena itu paket dipasang ke Python sistem, bukan venv terpisah.
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      pandoc \
      weasyprint \
      python3 \
      python3-pip \
      ca-certificates \
      curl \
      fonts-dejavu-core \
      fonts-liberation \
 && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
# --break-system-packages: Debian 12 menandai Python sistem sebagai externally
# managed. Di dalam image sekali pakai ini justru yang diinginkan, supaya
# `python3` warisan proses Node langsung menemukan pandas/scipy.
RUN python3 -m pip install --no-cache-dir --break-system-packages --upgrade pip \
 && python3 -m pip install --no-cache-dir --break-system-packages -r requirements.txt

COPY --from=build /app/.next ./.next
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/public ./public
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/next.config.ts ./next.config.ts
COPY --from=build /app/tsconfig.json ./tsconfig.json

# Dibaca saat runtime oleh route stats-template, export, dan csl.
COPY assets ./assets
COPY csl ./csl
COPY templates ./templates
COPY scripts ./scripts
COPY drizzle ./drizzle
COPY drizzle.config.ts ./

# Cache build tidak perlu ikut; SQLite butuh folder data yang bisa ditulis.
RUN rm -rf .next/cache && mkdir -p data

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD curl -fsS http://127.0.0.1:3000/ >/dev/null || exit 1

# Bind ke 0.0.0.0 HANYA di dalam container; compose memetakannya ke loopback.
CMD ["node", "node_modules/next/dist/bin/next", "start", "-H", "0.0.0.0", "-p", "3000"]
