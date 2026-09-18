# syntax=docker/dockerfile:1.7
# ──────────────────────────────────────────────
# Sundog PWA — production static build
# Multi-stage: Node build → copy dist to Caddy
# ──────────────────────────────────────────────

FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json* ./

# Cache mount persists the npm download cache between builds so only
# newly-changed deps actually re-download.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --legacy-peer-deps

COPY . .
RUN npm run build

# ── Output stage: just the static files ───────
# We don't serve from here — Caddy does.
# This stage exists so docker compose can COPY --from=client-build
FROM alpine:3.21 AS static

COPY --from=build /app/dist /srv/www
