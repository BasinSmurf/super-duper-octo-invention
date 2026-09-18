# ADR-0006 — Container topology (Caddy, Redis, client-build, the coming split)

- **Status:** Proposed
- **Date:** 2026-06-27
- **Principle flags:** ⚠️ The instance-split note touches **bad-divorce** (in-memory shared state) — see below.

## Current state (file evidence)
Five services (`docker-compose.prod.yml`):
- **postgres** (16-alpine), volume `external: true` (deliberate `down -v` guard).
- **redis** (7-alpine) — **only consumer is the job-lock** (`services/jobLocks.ts` via `services/redis.ts`); falls back to in-memory `Set` if absent. `bullmq` is a **dead dep**.
- **api** — Express + **8 in-process `setInterval` workers** (`index.ts:254-275`); publishes `3001` directly for QBWC.
- **client-build** — build-only, copies Vite output into the `client-dist` volume and exits.
- **caddy** (2-alpine) — **plain HTTP :80**, no `tls` block; serves static PWA from the volume + SPA fallback + cache headers + `reverse_proxy /api/* → api:3001`. **External TLS is terminated upstream by an NPM VM**, not here.
- Residual in code: HTTPS server on :3443 (`index.ts:237-252`), disabled (no certs); and Express *also* serves the SPA when `NODE_ENV=production` (`index.ts:206-221`) — a second static path not on the live route.

## Why each was likely chosen
- **Caddy:** originally terminated TLS (the repo *used* to describe :443 + `tls`); TLS was later stripped and moved upstream to NPM, leaving Caddy doing static+proxy.
- **Redis:** added for job-locking as future-proofing for multiple API instances; `bullmq` was speculative (leftover from a dropped e-sign integration — confirmed).
- **client-build:** keeps the Caddy image clean (static files via a shared volume rather than baking them in).

## Does each still earn its place?
- **Caddy — KEEP, and it earns *more* of its place post-split.** It is *not* residual: it does real static-serving, gzip/zstd, cache-control, and the API proxy. The brief's suspicion ("is Caddy residual now TLS is gone?") is reasonable but the answer is no — and once the API is split into multiple instances, Caddy becomes the **on-VM load-balancer / router** in front of them. The redundant Express static path and the dead :3443 HTTPS server should be deleted to make the one-proxy story unambiguous.
- **Redis — KEEP.** Currently load-bearing for exactly one thing (the lock) and degradable. But the planned split makes it **genuinely load-bearing**: with >1 API instance, the in-memory lock fallback stops being safe, and the lock is what prevents two instances double-submitting to Enverus/BlueLion/QB. Remove the dead `bullmq` dependency.
- **client-build — KEEP** (minor). It's a cheap pattern. Could be folded into a multi-stage build later; not worth touching now.

## ⚠️ The split surfaces real bad-divorce / correctness hazards (the actual work)
Today these are single-process and *silently* correct; with a second API instance they break **without erroring**:
- **In-process event bus** (`services/eventBus.ts`, explicitly "no Redis pub/sub yet") — listeners fire only on the instance that handled the request.
- **In-memory QBWC session map** (`routes/qbwc.ts`) — a QBWC poll cycle must be pinned to one instance or moved to Postgres/Redis.
- **In-memory Enverus master-data cache** and the **v1 rate-limiter bucket** — per-instance, so caches diverge and limits multiply by instance count.
- **The RBAC matrix cache** (`loadMatrix()`) — invalidated in-process on PUT; a second instance keeps a stale matrix.

## ⚠️ Hardware reality (owner input 2026-06-27): prod is a **2-core / 8 GB Linux box** (host has ~32 cores / ~60 GB free)

**Right-size, don't max ("no beefy pikachu").** The constraints are RAM and build-burst headroom, not request-serving CPU:
- **RAM is the real lever** — Postgres on a shared 8 GB box is starved and can't cache the working set (hurts the known 50k-location query hotspot); the 4 GB-heap `tsc` then swaps on top. Bumping to **~16–24 GB** lets Postgres actually use `shared_buffers`/page cache *and* removes build swap. Cheap, high-value.
- **Cores are marginal for throughput** — this is a few-dozen-user LAN app, not high-RPS; it is **not CPU-bound on requests**. A modest bump (**4–8 cores**) covers parallel builds + running web/worker/Postgres without contention. 32 cores buys nothing for this workload.
- **Crucial:** more horsepower does **not** make horizontal API replication a *gain* — you weren't CPU-bound to begin with. So the verdict below (role-based split, not replication) stands regardless of the bump.

This materially changes the split and build story:
- **The "split" should be role-based, not horizontal.** Replicating the API for throughput on 2 cores buys ~nothing (Node is single-threaded per instance; Postgres needs CPU too). The split worth doing here is **web vs. worker**: pull the 8 in-process `setInterval` loops (Enverus/QB/BlueLion/print) into a *worker* process so a heavy integration batch can't starve field-tech requests. That's a blast-radius win, not a scale win — and it still requires the Redis-backed shared state below.
- **Memory budget is tight but workable:** Postgres + Redis + **two** small Node processes + Caddy fits in 8 GB **only if you are not also building on the box** (see next).
- **Stop building images on the prod box.** `tsc` with `--max-old-space-size=4096` (per `server/Dockerfile`) allocating a 4 GB heap on an 8 GB box that's also running Postgres + the live stack means **swapping** — this is the real source of the felt "~12 min" deploy, not the build itself (a dev box builds the API cold in 150 s). Build in CI off-box → push to a **self-hosted registry** (`registry:2` container, or Gitea/GitLab's built-in) → prod does `docker pull && up -d`. Prod never runs `tsc` again.

## Deploy-freshness note ("doesn't uptake without `--no-cache`") — tested
- **Tested and falsified the Docker-cache hypothesis:** changing a client source file correctly re-runs `COPY . .` + `RUN npm run build` (only `npm ci` cache-hits). BuildKit invalidation is sound; the build is *not* shipping stale layers.
- **Most likely real cause: the PWA service worker.** `registerType: 'prompt'` + aggressive Workbox precache → clients keep serving the old bundle until the SW update is accepted. `--no-cache` doesn't actually fix this (correlation with the accompanying hard-refresh). Fix is SW-update strategy, not the build.
- **Building off-box → registry → digest-pinned pull removes all ambiguity** server-side: prod runs exactly the image CI built, no local build cache to second-guess. You'd never need `--no-cache` again.

### The "rebuild all 5 / one-at-a-time gets weird" ritual
Owner currently rebuilds **all five services** every deploy because bringing up only `api` "sometimes makes api + postgres weird." That's a workaround for a symptom, not a law. Most likely causes: the **migrate-on-start** (`docker-entrypoint.sh` runs `prisma migrate deploy` every api boot — overlapping restarts or a mid-flight pool can misbehave) or the health `start_period` race. **Pull-based deploys dissolve the ritual:** with pre-built images, `docker compose up -d` recreates only the changed container and never touches Postgres — so an API ship stops cycling the database. Worth a separate diagnosis from prod logs (`docker logs servicepro-api` on a one-at-a-time attempt) since I have dev-only access.

## Migration cost / risk / effort
- Delete dead :3443 + duplicate Express static + `bullmq`: trivial, do now.
- **Move builds off-box (CI + self-hosted registry):** Medium, **highest operational leverage for this hardware** — eliminates the 12-min deploy, the OOM/swap risk, and the freshness ambiguity in one move.
- Make split-safe (move event bus to Redis pub/sub, QBWC session + rate-limit to Redis, matrix-invalidation to a Redis channel): **Medium**, and **must precede** any web/worker split. Mostly "promote the things already abstracted behind `getRedis()`."

## Verdict: **KEEP** all live containers; **REPLACE-LATER** (delete) the residuals; **move builds off-box**; if splitting, split **web-vs-worker**, gated on Redis-backed shared state.
> Caddy is not residual. Redis graduates to load-bearing. But on a 2-core/8 GB box the priority isn't scaling out — it's getting the *build* off the prod box (CI → registry → pull), which kills the slow-deploy + OOM + staleness trio at once. Any process split should be role-based (web/worker) and must move event-bus / QBWC-session / rate-limit / matrix-cache off in-process memory first, or it's silently wrong.
