# ServicePRO mk2 — Target-State Architecture (Phase 3)

- **Status:** Proposed — synthesis of [ADR-0001](adr/ADR-0001-ci-source-split-and-observability.md)…[ADR-0009](adr/ADR-0009-dev-loop-ergonomics.md).
- **Date:** 2026-06-27

## The one-sentence verdict

**The stack is right; the packaging is wrong.** Relitigating every load-bearing decision *confirmed* the core choices (Postgres, Express, React, Vite, stateless JWT, the QB derive-from-work-records seam) and localized the "lumbering" to three fixable things: an un-split 2.5 MB client bundle, a handful of god-files, and missing safety nets (no tests, no CI). **mk2 is a refactor-and-harden program executed strangler-fig — not a rewrite.** A rewrite would be more expensive end-to-end and would throw away correct, working code; I can't make the rewrite case and won't manufacture one.

## What carries over unchanged (load-bearing-and-correct — confirmed, stop touching)

| Decision | Why it's correct | ADR |
|---|---|---|
| **Postgres 16 + Prisma 7** | 45 JSONB fields, pg_trgm, generated columns, CHECK, 75 enums — deeply and correctly Postgres-locked; MariaDB would be all cost, no benefit | [0002](adr/ADR-0002-data-layer-postgres.md) |
| **Express 4** | Not the bottleneck; LAN-scale workload; swapping = 40k-LOC rewrite for perf nobody will feel | [0003](adr/ADR-0003-api-framework-express.md) |
| **Vite 7** | `vite build` is 11.4 s — fast; the problem is unconfigured splitting, not the tool | [0004](adr/ADR-0004-frontend-build-vite.md) |
| **React 19 + Router + Dexie + the offline sync engine** | Offline-first is the product's spine and it works; do **not** rewrite the sync engine | [0005](adr/ADR-0005-frontend-architecture.md) |
| **Stateless JWT (+ PIN, Google SSO, kiosk)** | Exactly right for offline-first *and* the coming multi-instance split — no shared session store needed | [0007](adr/ADR-0007-auth-session-model.md) |
| **QB derive-from-work-records seam + Postgres queue + QBWC poll** | Clean, restart-safe, on-prem-pure; honors QB-as-ledger | [0008](adr/ADR-0008-quickbooks-boundary.md) |
| **Caddy + Redis containers** | Caddy is the future on-VM load-balancer; Redis is about to graduate from future-proofing to load-bearing | [0006](adr/ADR-0006-container-topology.md) |
| **Native dev inner loop (tsx watch + Vite HMR)** | HMR isn't the slow part; keep it | [0009](adr/ADR-0009-dev-loop-ergonomics.md) |

## What gets replaced / changed (all in-place, no tool swaps)

| Change | Nature | ADR |
|---|---|---|
| **Client packaging** — surface-based `React.lazy` + `manualChunks` for heavy libs (tesseract/recharts/qrcode/dnd-kit/stripe) | Config + light refactor | [0005](adr/ADR-0005-frontend-architecture.md), [0004](adr/ADR-0004-frontend-build-vite.md) |
| **Surface-scoped data stacks** — Dexie + sync engine for **field/shop only**; **Billing/AR, Ops, Admin online-only** (no Dexie), React Query as the online server-state layer | Refactor as surfaces are carved | [0005](adr/ADR-0005-frontend-architecture.md) |
| **God-component decomposition** — `TicketWizard.tsx` (5,511 lines) split per work-type; biggest route files (`invoices`/`locations`/`sync`) → service layer | Strangler-fig, behind tests | [0005](adr/ADR-0005-frontend-architecture.md), [0003](adr/ADR-0003-api-framework-express.md) |
| **Type-check off the deploy path** — esbuild/vite transpile to emit, `tsc --noEmit` in CI; fix the OOM-ing server `build` script | Config | [0009](adr/ADR-0009-dev-loop-ergonomics.md) |
| **Shared in-memory state → Redis** — event bus, QBWC session map, rate-limiter, RBAC matrix invalidation | Prerequisite for the split | [0006](adr/ADR-0006-container-topology.md), [0008](adr/ADR-0008-quickbooks-boundary.md) |
| **Auth hardening** — hash kiosk tokens, lock CORS, rate-limit `/api/auth/*` | Low-effort security | [0007](adr/ADR-0007-auth-session-model.md) |
| **Express 4 → 5** (drop `express-async-errors`) | Opportunistic | [0003](adr/ADR-0003-api-framework-express.md) |
| **Delete dead weight** — `bullmq`, `@tanstack/react-query`, `cva`, the :3443 HTTPS server, the duplicate Express static path | Trivial cleanup | [0003](adr/ADR-0003-api-framework-express.md), [0005](adr/ADR-0005-frontend-architecture.md), [0006](adr/ADR-0006-container-topology.md) |

## What's net-new

| New thing | Why | ADR |
|---|---|---|
| **CI pipeline** (self-hosted runner: tsc + eslint + `migrate deploy` vs ephemeral PG) | Zero tests + 40k LOC + by-hand deploys = unguarded; CI is the net under all other mk2 work | [0001](adr/ADR-0001-ci-source-split-and-observability.md) |
| **A test harness** (esp. golden-file tests for qbXML element-ordering) | Precondition for safely decomposing god-files; qbXML ordering bugs are silent + costly | [0001](adr/ADR-0001-ci-source-split-and-observability.md), [0008](adr/ADR-0008-quickbooks-boundary.md) |
| **Structured logging (pino) + `/metrics` polled by Zabbix** | Single-instance "watch the logs" stops working at the split; keep it lean, gate nothing | [0001](adr/ADR-0001-ci-source-split-and-observability.md) |
| **Failure observability + notification layer** | Durable-first; Zabbix = "really broken", in-app+email = "go do stuff"; reference-only messages, default-on-but-tiered, self-reporting channels | [0010](adr/ADR-0010-failure-observability-and-notifications.md) |
| **Self-service credentials (SSO failover)** | Bad-divorce hole in login: tech self-set PIN (5-try/30-min lock), office/admin password, **mandatory break-glass admin** | [0011](adr/ADR-0011-self-service-credentials-sso-failover.md) |
| **Location entry + well data strategy** | Burn the well-hydration cruft: server-authoritative search, passive seed+observed working set (zero field prep), well-first/pad-first lenses, clean-fail capture; canon accretes from real work vs DMR | [0012](adr/ADR-0012-location-entry-and-well-data-strategy.md) |
| **Ticket wizard restructure (division-first)** | Step 0 = division (D3/D4/D6 + Shop Fill); work-type within. Two distinct inspections (D3 on-site air vs D6 send-to-shop); Training/OccHealth/Shop/DirectSale → app-switcher surfaces. Old→new map doubles as the `TicketWizard.tsx` decomposition plan | [0013](adr/ADR-0013-ticket-wizard-division-first-restructure.md) |

## Sequencing — strangler-fig, in dependency order

Nothing here needs a clean rebuild. The ordering is driven by *what unblocks what*:

1. **Quick wins (hours, no risk):** fix server `build` heap flag; delete dead deps + residual containers/code. Removes footguns immediately.
2. **Client splitting (days):** surface-based `React.lazy` + `manualChunks`. **Biggest felt win, lowest risk** — additive, no behavior change. *(See leverage ranking.)*
3. **Safety net (≈1 week):** CI + first tests, golden-file qbXML tests first. **Unblocks everything below it.**
4. **Move typecheck to CI / transpile-only deploy:** cuts the deploy build once CI owns type-checking.
5. **Decompose behind the net:** `TicketWizard` per work-type; extract service layer from the fat routes; refactor `qbwc.ts`. Incremental, one unit at a time.
6. **Split-enablement (gate before any multi-instance deploy):** Redis-back the event bus / QBWC session / rate-limiter / matrix cache; auth hardening. **Do not deploy a second API instance until this lands** — the split is silently wrong otherwise.
7. **Then, and only then:** the instance/surface split itself.

## ⚠️ Hardware constraint (owner input 2026-06-27): prod = **2-core / 8 GB** (host has ~32 cores / ~60 GB free)
- **Right-size, don't max ("no beefy pikachu").** **RAM is the lever, not cores.** Bump to ~16–24 GB so Postgres can cache the working set (helps the 50k-location query hotspot) and the 4 GB-heap build stops swapping; add 4–8 cores of headroom. This is a few-dozen-user LAN app — **not CPU-bound on requests** — so more cores don't speed requests and **horsepower does not make horizontal replication a gain**. Verdict unchanged: role-based split, not replication.
- **The deploy build should still move OFF the prod box** regardless of the bump — don't size a runtime box for an occasional build burst. `docker compose up --build` runs `tsc` at a 4 GB heap contending with the live stack. Fix: CI builds images → self-hosted registry → prod `docker pull && up -d`. ([ADR-0009](adr/ADR-0009-dev-loop-ergonomics.md), [ADR-0006](adr/ADR-0006-container-topology.md), [ADR-0001](adr/ADR-0001-ci-source-split-and-observability.md))
- **The "split" is role-based (web vs. worker), not horizontal.** Move the 8 `setInterval` loops out of the request process for blast-radius isolation; gated on Redis-backed shared state.
- **"Rebuild all 5 / one-at-a-time gets weird"** is a workaround (likely migrate-on-start or healthcheck race). Pull-based deploys recreate only the changed container and never cycle Postgres — dissolving the ritual. Needs prod-log diagnosis (dev-only access here).
- **The "needs `--no-cache`" freshness bug was tested** — BuildKit invalidates correctly; *not* a build-cache bug. Likeliest cause is the PWA service worker (`registerType:'prompt'`) stranding clients on the old bundle.
- **Offline is a role-mobility capability, not a surface.** `field_tech`/`field_super`/`dispatch` (+`boss` if mobile) load the offline ticket-wizard + Dexie + sync module; `billing_ar`/`platform_admin` never do. Surfaces = bundles; offline = a lazy capability gated by role. ([ADR-0005](adr/ADR-0005-frontend-architecture.md))

## Leverage ranking (reduction-in-lumbering per unit effort)

> Two pains, two leaders: operationally (deploys on the small box) the winner is build-off-box; for runtime UX (field iPads) it's surface-splitting.

1. **★ Move the build off the prod box (CI → self-hosted registry → `docker pull`) — highest *operational* leverage.** Kills the ~12-min deploy, the 4 GB-heap OOM/swap risk on the 8 GB box, **and** the `--no-cache` freshness roulette in one move. Medium effort; pairs with standing up CI anyway.
2. **★ Surface-based lazy code-splitting + `manualChunks` — highest *runtime/UX* leverage.** One 2,532 KB / 656 KB-gzip chunk → small per-surface load; a field tech stops downloading OCR/charts/billing/admin to open a ticket. Low effort, no framework change, additive, no test dependency.
3. **Fix the server `build` script (1 line)** — trivial; removes a reproducible OOM footgun.
4. **CI + test harness** — medium effort; the multiplier that makes decomposition affordable instead of scary (and the host for #1).
5. **Typecheck → CI, transpile-only image build** — low effort; trims the build further.
6. **Redis-back shared state** — medium effort; hard *prerequisite* for any web/worker split, not optional.
7. **God-component / fat-route decomposition** — highest effort, high value, only after #4.

## Principle flags requiring your sign-off

- **[ADR-0001]** CI runners should be **self-hosted on a VM** to honor on-prem; using hosted GitHub Actions would put deploys behind a SaaS (flagged, your call). Observability must remain observation-only and gate nothing (bad-divorce).
- **[ADR-0006]** The instance split must not ship until shared in-memory state is Redis-backed; otherwise it's a bad-divorce violation (optional component / second instance silently changing behavior).
- **[ADR-0002 / 0008]** Verdicts *confirm* the Postgres-ledger and derive-from-work-records principles — no changes proposed to either; noted here only because the brief asked every principle-adjacent verdict to be surfaced.
- **[ADR-0010]** Notification layer is bad-divorce-aligned (durable row + dashboard is the floor; push channels best-effort + self-reporting). Owner policy: **reference-only messages** (no business data in any channel; detail behind authenticated click-through), **notify-on by default but severity-tiered** (immediate vs digest) so it doesn't bury.
- **[ADR-0011]** Bad-divorce on the login path: **at least one `platform_admin` must always hold a local password** (break-glass) or a Google-SSO outage locks you out of your own system. Failover credentials are pre-provisioned while SSO works via a **recurring skippable nudge** (never a hard gate — that would trap a tech offline at the site); persists until set once.
- **[ADR-0012]** ⚠️ **Burn-the-cruft** sign-off: V2 does **not** migrate the V1 pre-built well/pad data — canon re-accretes from real work matched against DMR (historical-ticket reconciliation is parked). Bad-divorce: offline field entry must survive no-signal via clean-fail capture (client never writes canon). Zero-field-prep: working set is passive, no pre-trip action.

## Honest gaps / what I did not verify
- **Docker image build now measured** (dev box): API cold 150 s / warm 3 s, client cold 66 s. The prod "~12 min" is the 2-core/8 GB box swapping under a 4 GB-heap `tsc`, not compile cost — inferred, not measured *on prod* (I don't have prod access).
- **Deploy-freshness bug tested:** BuildKit correctly invalidates on source change (my earlier "stale build layer" hypothesis was wrong). Real cause is most likely the PWA service worker; not exhaustively confirmed end-to-end.
- All build numbers are from one dev machine; treat as order-of-magnitude, not benchmarks.
- Depth of `zod` validation usage and whether `@tanstack/react-query` is *truly* zero-use (vs. one stray import) were not exhaustively traced — both are cheap to confirm during the cleanup pass.
