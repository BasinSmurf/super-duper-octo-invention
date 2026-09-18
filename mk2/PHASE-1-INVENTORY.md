# ServicePRO mk2 — Phase 1 Discovery Inventory

**Status:** Ground truth only. No recommendations, no verdicts. Phase 2 (relitigation) has not started.
**Branch:** `mk2-relitigation`
**Date:** 2026-06-27
**Method:** Direct reads of config/bootstrap files + four parallel read-only sweeps of the data layer, auth/QB/sync, Redis usage, and the client. Every claim below is cited to a file. Numbers are measured, not estimated, unless flagged "(est.)".

---

## 0. Repo shape at a glance

| Metric | Value | Source |
|---|---|---|
| Monorepo | `server/` (Express+TS+Prisma) + `client/` (React PWA) | root layout |
| Total commits | 339 | `git rev-list` |
| Project age | ~3.5 months (2026-03-11 → 2026-06-26) | `git log` |
| Server source (non-generated) | **40,239 LOC** across **121** `.ts` files | `find server/src` |
| Generated Prisma client | **220,374 LOC** (in `server/src/generated/prisma`) | `find` |
| Client source | **58,761 LOC** across **133** `.ts/.tsx` files | `find client/src` |
| Prisma schema | **3,428 lines, 67 models, 75 enums** | `schema.prisma` |
| Migrations | **97** | `prisma/migrations/` |
| Route files | 40 | `server/src/routes` |
| Service files | 56 | `server/src/services` |
| Built client bundle (main chunk) | **2,472 KB raw / 654 KB gzip**, single chunk | `client/dist/assets/index-*.js` |

Naming note: the product is **ServicePRO** (README title, prod container prefix `servicepro-`); the repo/package name is **`sundog`** and most internal strings say Sundog. Same system.

---

## 1. Languages, frameworks, load-bearing dependencies (with versions)

### Server (`server/package.json`)
- **Runtime:** Node.js 22 (Dockerfile `node:22-alpine`), TypeScript 5.7.3, ESM (`.js` import specifiers, compiled by `tsc`).
- **Dev loop:** `tsx watch src/index.ts`. **Build:** `tsc` → `dist/`.
- **Framework:** **Express 4.21.2** + `express-async-errors` 3.1.1 (monkey-patches Express 4 so async route throws reach the error middleware — `index.ts:2`).
- **ORM:** **Prisma 7.8.0**, pinned to 7.x (memory: "do NOT bump past 7"). Uses the `@prisma/adapter-pg` driver adapter (`db.ts:5-10`), generator `prisma-client` emitting **TypeScript into `src/generated/prisma`** in **cjs** module format (`schema.prisma:1-5`).
- **Queue/cache deps:** `bullmq` ^5.0.0, `ioredis` ^5.4.2. **`bullmq` is never imported anywhere in `server/src`** (dead dependency — see §5). `ioredis` is used only by the lock service.
- **Auth:** `jsonwebtoken` 9, `bcryptjs` 2.4.3, `google-auth-library` 10.5.0, `googleapis` 171.4.0.
- **Integrations/IO:** `stripe` 20.4.1, `nodemailer` 8.0.4, `pdfkit` 0.17.2, `qrcode` 1.5.4, `multer` 1.4.5-lts.1 (note: lts patch of an otherwise-deprecated major), `fuse.js` 7.3.0 (in-app fuzzy match), `swagger-ui-express` 5 (serves the v1 OpenAPI), `helmet` 8, `cors` 2.8.5, `morgan` 1.10, `zod` 3.24.1, `uuid` 11.

### Client (`client/package.json`)
- **Framework:** **React 19.2.0** + `react-dom` 19.2.0, **react-router-dom 7.13.0**.
- **Build tool:** **Vite 7.3.1** + `@vitejs/plugin-react` 5.1.1, **Tailwind v4** via `@tailwindcss/vite` 4.1.18 (the Vite-plugin path, no PostCSS config), `vite-plugin-pwa` 1.2.0 (Workbox).
- **TS:** 5.9.3 (note: **client TS 5.9.3 vs server TS 5.7.3** — version skew across the monorepo). Build = `tsc -b && vite build`.
- **Offline:** `dexie` 4.3.0 + `dexie-react-hooks` 4.2.0 (IndexedDB).
- **Server-state libs present:** `@tanstack/react-query` 5.90.21 **is a dependency but the client's actual data access is a hand-rolled `fetch` wrapper (`client/src/lib/api.ts`) + Dexie + Context** — see §6. (Whether React Query is actually wired anywhere is a Phase-2 check; the client sweep found app state on Context+Dexie, not RQ.)
- **UI:** hand-rolled. `lucide-react` 0.563 (icons), `clsx` + `tailwind-merge` (a `cn()` helper). `class-variance-authority` 0.7.1 is a dependency **but the client sweep found zero `cva` usage**. No Radix/shadcn/headless-ui.
- **Heavy feature deps (all bundled, see §7):** `tesseract.js` 7 (OCR), `recharts` 3.8, `html2canvas-pro` 2 (split to its own 225 KB chunk), `html5-qrcode` 2.3.8, `@dnd-kit/*` (kanban drag-drop), `@stripe/react-stripe-js`.
- **Tooling skew:** `@types/node` is **24.10.1 on client vs 22.12.0 on server**; `uuid` is **13 on client vs 11 on server**.
- **No test runner anywhere** — the client sweep found no vitest/jest/playwright config and no `*.test`/`*.spec` files. ESLint 9 (flat config) is the only quality gate.

---

## 2. Container topology (what each container does at runtime)

Source: `docker-compose.prod.yml`, `deploy/PROD-TOPOLOGY.md`, `Caddyfile`. **There are 5 services, not 4** (README/prompt undercount by omitting the build-only client container).

| Container | Image | Runtime role | Published |
|---|---|---|---|
| `servicepro-postgres` | postgres:16-alpine | Primary datastore. Volume `servicepro_postgres-data` is **`external: true`** (declared outside compose — a deliberate guard against `down -v` wiping prod data). | internal 5432 |
| `servicepro-redis` | redis:7-alpine | `--appendonly yes`. **Only consumer is the distributed-lock service** (§5). | internal 6379 |
| `servicepro-api` | built from `server/` | Express API. **Also runs 8 in-process background workers** (§4). Publishes **`3001:3001`** so the QuickBooks Web Connector reaches `/api/qbwc/soap` directly, bypassing Caddy. Health check has a **60s `start_period`** because cold boot does DB connect + `prisma migrate deploy` + spins up the workers before `/api/health` answers. | `0.0.0.0:3001` |
| `servicepro-client-build` | built from `client/` | **Build-only, exits 0.** Wipes and copies the Vite build into the shared `client-dist` volume, then stops. Not a long-running service. | none |
| `servicepro-caddy` | caddy:2-alpine | Reverse proxy + static PWA host. `handle /api/*` → `reverse_proxy api:3001`; everything else served from `/srv/www` (the `client-dist` volume) with SPA fallback + asset cache headers + a few security headers. **Plain HTTP on `:80` only — no `tls` block, 443 not published.** | `0.0.0.0:80:80` |

**TLS / routing reality (`PROD-TOPOLOGY.md`):** External TLS is terminated **upstream by an Nginx Proxy Manager VM** (a third box), which forwards to Caddy:80. So in prod the request path is `Cloudflare → public IP → NPM (Let's Encrypt) → Caddy:80 → {static | api:3001}`. **Caddy currently terminates no TLS and does no certificate work.** Its live responsibilities are: static file serving, SPA fallback, gzip/zstd, asset cache-control headers, and the `/api/*` proxy split.

**Dual server in code:** `index.ts:237-252` also starts an HTTPS server on 3443 from self-signed certs **if certs exist** — disabled in prod (no certs) and not published. Residual.

**Static-serving duplication:** `index.ts:206-221` *also* makes Express serve the client `dist/` with SPA fallback when `NODE_ENV=production` — i.e. the API can serve the SPA itself. In the current prod topology Caddy does this from the volume, so the Express static path is a second, parallel implementation of the same job (only one is on the live path).

---

## 3. Data layer

- **Engine:** Postgres 16. **Provider `postgresql`**, accessed through Prisma 7's `@prisma/adapter-pg` (pg driver) — `db.ts:8`. `prisma.config.ts` carries schema path + migrations/seed config (Prisma 7 style).
- **Schema scale:** 67 models, **75 enums**, 3,428 lines.
- **Postgres-specific features actually in use:**
  - **JSONB — 45 `@db.JsonB` fields.** Pervasive `customData`/catch-all bags on the core models: `ServiceTicket` (`customData`, `reviewSignal`, `billingRefs`), `Invoice`, `Company`, `EquipmentInspection` (`data` is **polymorphic per category** — fire_extinguisher / gas_detection / scba / fall_arrest / ue_cylinder / breathing_air_system / first_aid_kit), `RentalAgreement.wellIds`, `ShopWorkOrder`, `SerializedEquipment`, `TicketLineItem`, `PermissionConfig.matrix`, etc. The sweep found **no evidence of DB-side JSONB operator querying** — JSON appears to be read/parsed in app code, which *lowers* engine lock-in for these fields.
  - **`@db.Decimal`** (40+ fields, money `(12,2)` and lat/lng `(10,7)`), `@db.Date` (30+), `@db.Text` (signatures).
  - **`pg_trgm` extension** — `CREATE EXTENSION IF NOT EXISTS pg_trgm` in `migrations/00000000000000_init_extensions`. Used for fuzzy name matching (DMR wells / operators / companies).
  - **Stored generated columns** — `wells.name_norm` and `dmr_reference_wells.name_norm` `GENERATED ALWAYS AS (UPPER(regexp_replace(TRIM(well_name),'\s+',' ','g'))) STORED` with btree indexes (`migrations/20260603160000_dmr_norm_name_indexes`). Prisma can't model these; they live in raw SQL.
  - **CHECK constraint** — `equipment_inspections_parent_exclusivity` enforces XOR on `(shop_item_id, ticket_id)` (`migrations/20260508190100_equipment_inspection`). Raw SQL.
  - **Enums** are native Postgres `ENUM` types (75 of them).
  - **No PostGIS.** Wells/Pads/Facilities store lat/lng as `Decimal(10,7)`; **all proximity/distance math is in app code** (`services/wellProximity.ts`, `wellDmrMatch.ts`), not `ST_*`.
  - Sweep found **no triggers, no materialized views, no GIN indexes** despite `pg_trgm` being loaded (trigram search likely runs ad-hoc or fuzzy matching is partly in `fuse.js` app-side).
- **Migration tooling:** `prisma migrate deploy` runs on every API container start (`docker-entrypoint.sh`). **Dev DB has drifted from migration history** (memory + README): `migrate dev`/reset is forbidden; additive changes are hand-written SQL + `prisma migrate resolve --applied`.
- **Largest server files are route handlers, not services** — i.e. business logic concentrates in the route layer:
  - `routes/invoices.ts` 97 KB · `routes/locations.ts` 86 KB · `routes/sync.ts` 81 KB · `routes/enverus.ts` 79 KB · `routes/shopOrders.ts` 69 KB · `routes/tickets.ts` 67 KB · `routes/qbwc.ts` 65 KB.

---

## 4. API layer

- **Framework:** Express 4.21.2. **~35 routers** mounted in `index.ts:106-198`, almost all behind a single global `authenticate` middleware; a handful mount pre-auth and run their own per-route auth (qbwc, shop-board, boards, kiosks, claim, train, v1 — each commented with why).
- **Middleware stack** (`index.ts:84-100`): `helmet` with a hand-written CSP (allows Google GSI + Stripe), `cors()` **wide open (no origin allowlist)**, `morgan('dev')`, `express.json({limit:'10mb'})`, plus `express.text` for the qbwc XML body.
- **Logging:** homemade — `console.log/warn/error` are monkey-patched to tee to `logs/server.log` (`index.ts:71-82`). No structured logger (pino/winston).
- **Portal containment:** a bespoke pre-router (`index.ts:142-161`) re-verifies the JWT just to reject `role=customer` tokens from any non-`/portal` path.
- **Complexity location:** in the **route files themselves** (see §3 sizes). Routes carry domain logic inline rather than delegating to a service/use-case layer; the `services/` dir is large (56 files) but the biggest single logic blobs are still routes (`invoices.ts`, `locations.ts`, `sync.ts`).
- **Validation:** `zod` is a dep; depth of use is a Phase-2 check.
- **v1 surface:** `server/src/v1` (index 30 KB + mappers 16 KB) is a separate, curated read API at `/api/v1` with its own API-key/JWT auth and OpenAPI docs (§6 auth).

### Background workers — all in-process (`index.ts:254-275`)
The API process starts **8 background loops** at boot: `startEnverusQueueProcessor`, `startBlueLionQueueProcessor`, `startBlueLionTrainingListener`, `startAutoApprovalProcessor`, `startQbInvoiceDiffWatcher`, `startLocationRescoreListener`, `startPrintQueueProcessor`, `startPrinterHealthCheck`. **None use BullMQ.** They are `setInterval` pollers over Postgres queue tables (e.g. `enverusSyncQueue`, `blueLionSyncQueue`, `qbSyncQueue`, `printJob`), several explicitly commented "simple setInterval, not BullMQ" / "Postgres-backed rather than BullMQ — keeps the dependency surface small." The two "listeners" subscribe to an **in-process event bus** (`services/eventBus.ts`, explicitly "no Redis pub/sub yet").

---

## 5. Redis — what it is actually load-bearing for

- **`bullmq` is imported nowhere.** Dead dependency (`server/package.json` only).
- **Single consumer:** `services/redis.ts` (lazy `ioredis` client) → `services/jobLocks.ts` `withLock()` (SET NX EX + Lua release at `jobLocks.ts:44,63`) → `services/jobs.ts` `runScheduledJob()`. Six of the background loops wrap their tick in `withLock()` to prevent duplicate execution if more than one API instance runs.
- **Graceful degradation built in:** if `REDIS_URL` is absent/down, `jobLocks.ts:68-83` falls back to an **in-memory `Set`** lock. So a single-instance deployment is fully functional with Redis off.
- **No caching, no sessions, no rate-limit backend, no pub/sub in Redis.** The Enverus master-data cache and the event bus are explicitly in-memory `Map`s. The v1 rate limiter is an in-memory fixed-window bucket (non-distributed).
- **Net:** Redis is load-bearing **only as a cross-instance job lock**, and only if/when a second API instance exists. Prod currently runs one API container.

---

## 6. Auth / session model

- **Stateless JWT**, Bearer header only, no cookies, **no refresh tokens** (`middleware/auth.ts:19-40`). `JWT_SECRET`, 24h expiry. No server-side session store anywhere.
- **Three human login paths** (`routes/auth.ts`): password (bcrypt `passwordHash`), **PIN** for field devices (bcrypt `pinHash`), and **Google Workspace SSO** (`google-auth-library verifyIdToken`, domain-locked to `GOOGLE_ALLOWED_DOMAIN`, with auto-provision + role-sync from Google Groups when configured).
- **Roles:** `field_tech | dispatch | field_super | billing_ar | boss | platform_admin`, plus external `customer` (portal) and kiosk device roles `BOARD | STATION | CLAIM`.
- **Kiosk/device auth** (`middleware/kioskAuth.ts`): `X-Kiosk-Token` header → direct DB lookup of `Kiosk.apiToken` (**stored plaintext, not hashed**). `authenticateUserOrKiosk()` accepts either a user JWT or a kiosk token.
- **v1 API auth** (`v1/auth.ts`, `v1/apiKeyStore.ts`): `sp_*` API keys (sha256-hashed, loaded from `V1_API_KEYS` env JSON) **or** a staff JWT; explicit scopes per key (`tickets:read`…), users default to `['*']`; optional per-key IP allowlist; `timingSafeEqual` comparisons; customer-role JWTs hard-rejected.
- **RBAC matrix** (`services/permissions.ts`, `routes/permissions.ts`): code `CAPABILITY_CATALOG` (40+ caps) = default, overlaid by a **single DB `PermissionConfig` row** (sparse JSON matrix), merged and **cached in memory** (`loadMatrix()` at boot, invalidated on PUT). `platform_admin` is hard-wired all-powerful; certain admin caps can't be stripped.

---

## 7. Frontend — build, state, PWA, and where the weight is

- **Routing:** `client/src/App.tsx` mounts **~38 routes, all eagerly imported. Zero `React.lazy`/dynamic import.** Consequence below.
- **Bundle (measured from `client/dist`):** total dist 5.3 MB. **Main JS chunk = 2,472 KB raw / 654 KB gzip, single file.** Only `html2canvas-pro` (225 KB) is split out (it dynamic-imports itself internally). Everything else — every page, `tesseract.js`, `recharts`, `html5-qrcode`, `@dnd-kit`, Stripe — is in the one chunk. **This is the single biggest measured "lumbering" number on the client.**
- **State management:** **no Redux/Zustand**; app state is **React Context (`AuthContext`, `PermissionsContext`, `SyncContext`) + Dexie**. Server reads go through a hand-rolled `fetch` wrapper (`lib/api.ts`: get/post/put/patch/delete/upload, Bearer header, 401→logout). `@tanstack/react-query` is installed but the sweep did not find it driving data access — Phase-2 confirm.
- **Offline/PWA:**
  - Dexie DB (`lib/db.ts` + `lib/db-types.ts`, ~925 lines of types) — ~25 tables across 5 schema versions: read-only reference tables (companies/fields/pads/wells/products/equipment), bidirectional writable tables (tickets, line items, rentals, shop orders, inspections, transfers), and local-only `mutationQueue` (outbox), `drafts`, `syncMeta` (watermarks).
  - Sync engine (`lib/syncEngine.ts`, ~669 lines): hydrate → delta-pull (server-driven `serverNow` watermark) → push (drain outbox with retry + server-assigned ID remap). Driven by `SyncContext`: 60s periodic + foreground/online events (5s throttle). **No Background Sync API** (iOS Safari lacks it) — foreground triggers only, by design.
  - Workbox (`vite.config.ts:30-52`): precache `**/*.{js,css,html,ico,svg,woff2}` (≤5 MB each), one runtime rule — `NetworkFirst` on `/api/` (3s timeout, 200 entries, 30-day TTL). `registerType:'prompt'` (deferred SW update UI exists).
- **The monolith pages** (single giant components, inline state, no extraction):
  - **`TicketWizard.tsx` — 5,511 lines / 263 KB.** ~126 hook calls; **one form-field-per-`useState`** (the sweep counted 20+ state vars for the rental step alone, 9 for cascade-air, etc.); all work-type flows (field service / fit test / training / rental / IH / gas detection / inspection / air fill / direct sale) inlined into one function; ~484 inline `className` strings; `buildTicketPayload`/`getWizardData`/`canAdvance`/`submitTicket` defined inline as closures, not extracted.
  - `ShopOrderDetailPage.tsx` 2,830 lines · `BillingPage.tsx` 2,525 · `CompanyDetailPage.tsx` 2,326 · then TicketDetail / Dashboard / RentalDetail / InvoiceDetail / EquipmentInspectionEditor all 50–69 KB.
- **No client tests.**

---

## 8. QuickBooks integration boundary + sync mechanism

- **Transport:** QuickBooks **Desktop** via the **QBWC SOAP poll model** (`routes/qbwc.ts`, 1,748 lines — largest route file). QBWC (on the Windows/QB VM) calls `authenticate → sendRequestXML → receiveResponseXML → closeConnection` against `http://192.168.0.213:3001/api/qbwc/soap` directly (plain HTTP, bypassing Caddy). qbXML is built/sanitized in `services/qbxmlBuilder.ts` (931 lines: smart-quote/superscript→ASCII, 11-char RefNumber truncation, element-order-sensitive assembly).
- **Queue:** a Postgres `QbSyncQueue` table (`entityType` invoice/sales_order/sales_receipt/item/price_level, `action` add/query, status pending/sent/success/error, retryCount max 3, priority-ordered dequeue). QBWC session state is an **in-memory map** keyed by ticket UUID, reaped after 30 min.
- **Derive-from-work-records seam:** the sweep reports it **clean** — invoices are never authored from QB data; they are derived from tickets/payments, then *posted* to QB append-only via the queue. Two posting modes per customer: default **`InvoiceAdd`** (real QB invoice) or opt-in **`SalesOrderAdd`** + a follow-up `InvoiceQuery` poll to detect when the comptroller converts SO→Invoice (`Company.qbUsesSalesOrder`). Items and per-item price levels are pulled QB→app on an hourly auto-queued query (full refresh; no delta date yet). The one known reconciliation gap (memory + README): **QB tax-item names** still need matching against real QB.
- **Other integrations:** **Enverus/OpenInvoice** (mTLS receipt+invoice submit, `routes/enverus.ts` 79 KB + `enverusPayloadBuilder` 33 KB + `enverusClient` 31 KB + queue processor), **BlueLion** (training certs / occ-health / inspection outcomes push, queue processor + REST), **Stripe** (card payments), **email-based signatures** (nodemailer — note memory: prod SMTP is currently unconfigured, so outbound mail silently no-ops).

---

## 9. CI / observability — ground truth vs. the brief

- **No CI config in the repo.** No `.github/workflows`, no `.gitlab-ci.yml`, no `.gitlab/`. The prompt references "**GitHub source + GitLab CI split per ADR-0001**" and "Zabbix" — **there is no ADR-0001 file and no ADR directory in the repo** (`grep ADR-0001` → nothing; the only "adr" hit is `node_modules`). **No Zabbix config/agent files in the repo either.** If these exist they live outside this checkout (on the VMs / in a separate ops repo) — to be confirmed with the user in Phase 2. *Flagging this because the brief treats ADR-0001 as a real artifact and it isn't in this tree.*
- **Deploy is shell scripts, not a pipeline:** `deploy/prod-deploy.sh`, `deploy.sh`, `server-setup.sh`, `restore-env.sh`, plus `deploy/nginx-servicepro.conf` and a legacy `deploy/servicepro.service` systemd unit (the one that can steal :3001 after reboot — memory). Migrations apply on container start.
- **Observability in-repo:** homemade file logging (`logs/server.log`) + `morgan('dev')` + an Ops dashboard route (`routes/dashboard.ts`, `/admin/ops`). No metrics/tracing/error-tracking library in either `package.json`.

---

## 10. Where the "lumbering" actually lives (measured, not yet judged)

Distinguishing measured drag from things merely *assumed* slow. **No verdicts here** — these are the quantified candidates Phase 2 will relitigate.

**Real, measured drag:**
1. **Client bundle is one 2.4 MB (654 KB gzip) chunk with zero route-level code splitting** (`App.tsx`, `dist/`). Every device download pulls OCR (`tesseract.js`), charts, QR, drag-drop, and all 38 pages up front. Most directly felt on field iPads / first load.
2. **`TicketWizard.tsx` at 5,511 lines / 263 KB** is the dominant edit-and-reason hotspot — one component, ~126 hooks, one-`useState`-per-field, all work types inlined. Any change here touches everything.
3. **Server build heap pressure:** `tsc` + the **220 K-line generated Prisma client** OOMs Node's default ~2 GB heap; the Dockerfile must set `--max-old-space-size=4096` to compile (`server/Dockerfile`). The generated client also dominates type-check time.
4. **Logic-in-routes concentration:** 7 route files are 65–97 KB each; `invoices.ts`/`locations.ts`/`sync.ts` carry domain logic inline, making them change-risky and hard to test (and there are no tests).
5. **API cold start ~60s** (`start_period: 60s`): DB connect + `migrate deploy` + 8 worker spin-ups before health.

**Perceived / low-real-cost (so Phase 2 doesn't over-weight them):**
- Redis container: present and healthy but only a degradable job-lock; not on any request hot path.
- Caddy: doing real work (static + proxy + headers) but no longer doing the TLS work its presence implies.
- Dev inner loop is **native, not Docker** — `tsx watch` (server) + Vite HMR (client); Docker holds only Postgres+Redis. The dev loop is not Docker-bound; build/bundle pain is at *build/deploy* time, not in HMR.

**Known data/quality risks affecting any mk2 work:**
- Dev DB **schema drift** (no clean `migrate dev`).
- **Zero automated tests** in either package — every refactor is unguarded.
- Monorepo **dependency skew** (TS 5.7 vs 5.9, @types/node 22 vs 24, uuid 11 vs 13).
- Two **dead/residual** items already visible: `bullmq` dependency (unused) and the in-code HTTPS:3443 server (disabled).

---

## Open questions to confirm before Phase 2 (ground-truth gaps)

1. **ADR-0001, the GitHub↔GitLab CI split, and Zabbix** are referenced by the brief but **absent from this checkout**. Where do they live — separate ops repo? VM-only? Or aspirational? This changes the §8 (CI/observability) relitigation entirely.
2. **Is `@tanstack/react-query` actually used** anywhere, or is it a stray dependency like `bullmq`/`cva`? (Affects the frontend-state relitigation.)
3. **Is prod truly single-API-instance?** (Determines whether the Redis lock is live-load-bearing or purely future-proofing.)
4. **Bundle/build timing numbers** beyond the static 2.4 MB chunk (cold `vite build` wall-time, `tsc` wall-time) — worth measuring in Phase 2 to rank the dev-loop item, or are the static sizes sufficient?
