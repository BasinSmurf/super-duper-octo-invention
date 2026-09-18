# ADR-0005 — Frontend framework & architecture (React + the surface split)

- **Status:** Proposed
- **Date:** 2026-06-27
- **Principle flags:** None (the "surfaces" model *reinforces* derive-from-work-records).

## Current state (file evidence)
- **React 19.2 + react-router-dom 7.13**, hand-rolled UI (`lucide-react` + a `cn()` helper). `class-variance-authority` and `@tanstack/react-query` are installed **but unused** (confirmed stray deps, like `bullmq` server-side).
- State = **React Context (`AuthContext`, `PermissionsContext`, `SyncContext`) + Dexie**; server reads via a hand-rolled `fetch` wrapper (`lib/api.ts`). No Redux/Zustand.
- **One eager SPA: ~38 routes in `App.tsx`, zero `React.lazy`.** → the single 2,532 KB chunk ([ADR-0004](ADR-0004-frontend-build-vite.md)).
- **God-components:** `TicketWizard.tsx` **5,511 lines / 263 KB** (~126 hooks, one `useState` per field, every work type inlined); `ShopOrderDetailPage` 2,830; `BillingPage` 2,525; `CompanyDetailPage` 2,326.
- **The V2 plan** (`client/src/pages/V2SurfaceMockupPage.tsx`): reorganize into six **surfaces** — field / shop / billing / ops / compliance / admin — each audience landing on its own surface. The mockup's thesis line: *"Work capture stays factual. Billing decides what to charge."*

## Why it was likely chosen
React + Router is the safe default; one SPA with eager imports is what you get when you never stop to add `lazy()`. The god-components grew organically as work types were added to a single wizard. Context-over-Redux is a reasonable small-app call.

## The case to replace
- **Framework (React → Svelte/Solid/etc.):** none worth taking seriously. React 19 is current and correct; swapping discards the entire 59k-LOC client for taste. Refuse — novelty-chasing.
- **Architecture:** strong. The eager-SPA + god-component shape is *the* felt client lumbering. The surface model is a real opportunity: surfaces map cleanly onto **lazy-loaded route groups**, and a field tech never needs the billing/admin code.

## The case to keep
- React, Router, Dexie, and the offline sync engine are load-bearing-and-correct — the offline-first design is the product's spine and works (foreground sync, outbox, ID remap). **Do not rewrite the sync engine.**
- Context+Dexie is fine; introducing Redux/Zustand now is unneeded ceremony.

## Per-surface data-access profiles (refinement — owner input 2026-06-27)

Surfaces don't just differ in *when* code loads — they differ in *how they touch data*. The offline/Dexie layer should be **surface-scoped, not global**:

| Surface | Data access | Dexie / sync engine? | Notes |
|---|---|---|---|
| **Field**, **Shop** | Offline-first; local draft → outbox → sync | **Yes — load-bearing, keep** | Techs work without signal; this is the product's spine |
| **Billing / AR**, **Ops**, **Admin**, **Compliance** | **Online-only, direct API reads** | **No** | Office staff on wired connections; the offline outbox/sync is pure overhead and a source of "why didn't it sync" confusion they should never face |

Consequences:
- The AR/Ops/Admin bundle drops Dexie, the sync engine, `tesseract.js`, the barcode/QR libs, etc. — they only load on the field/shop surfaces that use them.
- **This is where `@tanstack/react-query` earns its place** (today it's a stray dep): it's the right server-state layer for the *online* surfaces, replacing ad-hoc `fetch`-into-`useState`. Field/shop stay on Dexie + `useLiveQuery`.
- "Don't force the whole chonk at once, only fire as needed" — surfaces are lazy route-groups *and* divergent data stacks. Dexie still "wins" for field; AR doesn't get it at all.

### Decouple *surface* from *offline capability* (owner input 2026-06-27)
Offline is **not** cleanly "the field surface" — **field-sup and dispatch may go mobile and need the offline ticket wizard; AR and admin never will.** So offline is keyed on **role mobility**, not surface identity. Model it as two orthogonal axes:

- **Surfaces** = UI shells / nav / bundle entry points (field, shop, billing, ops, compliance, admin).
- **Capabilities** = lazy feature modules — the **offline ticket wizard + sync engine**, OCR, barcode/QR — loaded on demand by *role*, not welded to one surface.

| Role | Offline capability (Dexie + sync + wizard)? |
|---|---|
| `field_tech`, `field_super`, `dispatch` (+ `boss` if managers go field) | **Yes** — load the offline capability module |
| `billing_ar`, `platform_admin` | **No** — online-only, physically cannot load it |

So the dispatch/ops surface **conditionally** pulls the offline-wizard capability when the signed-in user is field-mobile; the AR/admin surfaces never include it in their bundle at all. This keeps the offline engine exactly where it's needed and out of every bundle where it isn't.

**Field offline data is a passive working set, not the universe, and demands zero prep** — see [ADR-0012](ADR-0012-location-entry-and-well-data-strategy.md): well-first entry (field) vs pad-first (billing), no well-universe hydration, server-authoritative search, and clean-fail capture for unknown wells. Field UX requires **zero upfront ceremony** ([[feedback_zero_field_prep]]); everything is after-the-fact capture + server-side resolution.

## Migration cost / risk / effort
- **Surface-based lazy code-splitting:** Medium effort, **highest client leverage.** Wrap each surface's routes in `React.lazy` + `Suspense`; add `manualChunks` for the heavy libs. Cuts the field-tech initial download dramatically with no behavior change. Low risk (additive).
- **Scope Dexie to field/shop, React Query to online surfaces:** Medium effort. Reduces the AR/Ops/Admin bundle further and removes offline complexity from users who never needed it. Do it as surfaces are carved out, not as a separate pass.
- **Decompose `TicketWizard.tsx`:** Medium-high effort, high value, **moderate risk with zero tests** — do it *after* [ADR-0001](ADR-0001-ci-source-split-and-observability.md) gives a test harness, and per work-type (each work type → its own lazy step module). This is a strangler-fig, not a rewrite.
- **Drop stray deps** (`@tanstack/react-query`, `cva`): trivial. *Or* actually adopt React Query to replace the hand-rolled fetch+cache — but only if it earns its place; otherwise remove it.
- **Micro-frontends / separate per-surface apps:** **Reject for now.** Overkill for a single team on-prem; the lazy-route-group approach gets 90% of the benefit at 10% of the cost. Keep it as a *later* option if surfaces diverge enough to deploy independently.

## Verdict: **KEEP** React/Router/Dexie; **REPLACE** the architecture (surface-based lazy splitting + god-component decomposition).
> The UI framework is correct; the *packaging* is the problem. Surface-scoped `React.lazy` + `manualChunks` is the single highest-leverage client change and needs no framework change. Decompose `TicketWizard` behind a test net, not before one.
