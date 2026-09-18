# syntax=docker/dockerfile:1.7
# ──────────────────────────────────────────────
# Sundog API — production Docker image
# Multi-stage: build TypeScript → slim Node runtime
#
# IMPORTANT: build and runtime stages MUST use the same base image.
# We copy node_modules (including Prisma's platform-specific query
# engine + any native modules like bcryptjs/pdfkit) between stages,
# so divergent glibc/musl or CPU arches would fail at startup. If
# you change one FROM line, change both.
# ──────────────────────────────────────────────

# ── Stage 1: build ────────────────────────────
FROM node:22-alpine AS build

WORKDIR /app

# Copy package files first for better layer caching
COPY package.json package-lock.json* ./
COPY prisma ./prisma/
COPY prisma.config.ts ./

# Install all deps (including devDeps for tsc).
# Cache mount keeps npm's download cache between builds.
RUN --mount=type=cache,target=/root/.npm \
    npm ci

# Copy source BEFORE generate: the Prisma 7 `prisma-client` generator emits
# TypeScript into src/generated/prisma (see schema output path), so src must
# exist first and the generated client is compiled by our own tsc below.
COPY tsconfig.json ./
COPY src ./src/

# Generate Prisma client into src/generated/prisma.
# `generate` only reads the schema and never connects, but loading
# prisma.config.ts eagerly resolves env('DATABASE_URL') and throws if it's
# unset — which it always is at build time (.env is dockerignored). Feed a
# throwaway URL just for this step; the real one is injected at runtime.
RUN DATABASE_URL="postgresql://build:build@localhost:5432/build" npx prisma generate

# tsc + the large generated Prisma 7 client exceed Node's default ~2 GB heap
# and OOM during compile. Bump the heap just for this build step; the runtime
# stage below is unaffected.
RUN NODE_OPTIONS=--max-old-space-size=4096 npm run build

# Strip devDeps so we can copy node_modules straight into runtime.
RUN npm prune --omit=dev

# ── Stage 2: production runtime ───────────────
FROM node:22-alpine AS runtime

WORKDIR /app

# Add tini for proper signal handling (PID 1 problem)
RUN apk add --no-cache tini

# Bring over manifests, pruned deps, and the generated Prisma client.
# This replaces a second `npm ci --omit=dev` + `prisma generate` cycle.
COPY package.json package-lock.json* ./
COPY prisma ./prisma/
COPY prisma.config.ts ./
COPY --from=build /app/node_modules ./node_modules

# tsx needed for `prisma db seed`; prisma CLI needed for `prisma migrate
# deploy` (now runs at container start via docker-entrypoint.sh, plus still
# usable via `docker exec` for ad-hoc work). The Prisma 7 CLI reads
# prisma.config.ts (copied above) for the datasource URL + migrations/seed
# config. Installed globally so the prune above doesn't nuke them and they
# don't bloat node_modules.
#
# CRITICAL: the global `prisma` CLI version MUST exactly match the bundled
# `@prisma/client`, or Prisma refuses to run. The package.json range is
# unpinned (^7.8.0), so derive the exact resolved version from the client
# instead of hardcoding it — keeps CLI and client locked together.
RUN --mount=type=cache,target=/root/.npm \
    PRISMA_VERSION="$(node -p "require('@prisma/client/package.json').version")" && \
    npm install -g tsx "prisma@${PRISMA_VERSION}"

# Copy compiled JS from build stage
COPY --from=build /app/dist ./dist/

# Entrypoint script: runs `prisma migrate deploy` then exec's the API.
# Idempotent — safe to run on every restart.
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# Create uploads + logs + file-store directories.
# Every path that gets a named volume in compose MUST exist here and be owned by
# node. Docker creates a missing mountpoint as root:root, and the container runs
# as USER node — so an unlisted path means silent EACCES on every write. That is
# what happened to /app/data/storage: the file store (bug-report screenshots,
# equipment documents, ticket PDFs) could not write a single byte in prod.
RUN mkdir -p /app/uploads /app/logs /app/data/storage \
 && chown -R node:node /app/uploads /app/logs /app/data

# Don't run as root
USER node

EXPOSE 3001

# Tini handles SIGTERM → graceful shutdown. Entrypoint script runs migrations
# before exec'ing node so the API never comes up against a stale schema.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/usr/local/bin/docker-entrypoint.sh"]
