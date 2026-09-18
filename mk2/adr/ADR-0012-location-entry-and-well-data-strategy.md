# ADR-0012 — Location entry model + well data strategy

- **Status:** Proposed (net-new; extends [ADR-0005](ADR-0005-frontend-architecture.md), supersedes the V1 well-hydration approach)
- **Date:** 2026-06-27
- **Principle flags:** ⚠️ **Bad-divorce** (offline-first must survive a no-signal wellsite — clean-fail below). ⚠️ **Zero field prep** (owner constraint: field rejects any "do X before you go"). Burn-the-cruft is an explicit data decision, flagged for sign-off.

## Context (file evidence)
- Hierarchy: **`Field → Pad → Well`**. `Well.padId` (nullable FK), `Well.fieldId` (required). `DmrReferenceWell` is the read-only ~43k DMR import universe, linked to activated wells via `matchedWellId` (`schema.prisma`).
- **Server-side well search already exists and is the right home:** `GET /locations/wells?search=`, the DMR reference search (`locations.ts:858`), a Fuse pass (`locations.ts:1318`), plus the DB has `pg_trgm` + stored `name_norm` generated columns built for fuzzy name matching (`migrations/00000000000000_init_extensions`, `…_dmr_norm_name_indexes`).
- **Where the cruft came from:** V1 hydrates the whole well universe into every iPad's Dexie (~43k rows) — giant sync payload, the "blank until hard refresh" re-optimize pain, and a second copy of the universe on every device that the pad-defragmentation / dedupe / backfill saga then had to reconcile *against*. Drift, dupes, churn.

## Decision
1. **Two entry lenses as surface capabilities** (per [ADR-0005](ADR-0005-frontend-architecture.md)):
   - **Field = well-first:** search the well → read `well.padId` → ticket auto-fills the pad **and** the selected well. Pad is *derived* from the well via the existing FK.
   - **Billing = pad-first:** pad → `pad.wells[]`. Online surface; no offline concern.
2. **Search is server-authoritative.** The ~43k universe lives **only** on the server (Postgres `pg_trgm`/`name_norm`). It is **never shipped to a device again.**
3. **No universe hydration. The client holds a small, 100%-passive working set** (Dexie), defined without magic as the union of:
   - **Seed (cold-start):** top-N clients' materialized wells, server-computed **per site**, ranked by recent ticket volume (last ~90 days). `N` configurable, start at **5**. Recomputed nightly.
   - **Observed (warms up, takes over):** wells off the tech's *own* recent tickets + assigned routes/cycles + active rentals.
   - **No manual pin / pre-load.** ⚠️ Owner constraint ([[feedback_zero_field_prep]]): field rejects pre-trip prep, so the working set demands **zero tech action**. The earlier "pin your day" idea is explicitly dropped.
4. **Burn the cruft — build only on current, real data.** ⚠️ *Sign-off flag.*
   - Do **not** migrate the V1 pre-built/pre-fragmented `Pad`/`Well` data as a baseline.
   - **DMR import is the only clean reference.** Canonical `Pad`/`Well` rows **materialize from real current work**, matched against DMR — they are not bulk-manufactured. The location graph *accretes* from actual tickets.
   - **Consequence (by design, not bug):** early V2 has a near-empty canonical well store; most entry routes through DMR search + clean-fail capture until real wells accrete over the first weeks. Self-bootstrapping.
5. **Clean-fail capture + additive resync (the rule that prevents repeating the cruft):**
   - **The client captures *intent*; the server owns *truth*; reconciliation is additive and idempotent — never destructive.**
   - Offline + well not in the working set → tech types the well name (+ pad/field hint if known). Ticket stores a **pending well reference** (`wellNameText` + hints). **The client never fabricates or mutates a canonical `Well`/`Pad` row** — that is what burned V1 down (client-hydrated copies reconciled against canon).
   - On sync, the server matcher (`pg_trgm`/`name_norm` vs well + DMR universe) resolves: **confident match** → link `ticket.wellId` silently; **ambiguous** → queue for review; **no match** → keep captured text, flag for Location Builder.
   - Reuses machinery that already exists for the edge case — the `location.resolved → rescore blocked tickets` listener (`startLocationRescoreListener`), the approval-on-unresolved-location flow, and Location Builder — and **promotes it to the primary field path.** Idempotent on the offline ticket id, so retries never dupe. A no-signal tech at an unknown well types a name and keeps working — zero blocking.

## Migration cost / risk / effort
- **Targeted rebuild of the *client* data strategy; keep the server.** This is the one subsystem where a clean rebuild beats strangler-fig — but only client-side. Server search + matcher stay.
- **Effort:** Medium. Delete client well-hydration; add the working-set sync (seed + observed) and the well-first picker; add the pending-well-reference field + wire the existing matcher/rescore path as the primary resolver.
- **Risk:** Low-to-medium, and *lower* than V1 — the client can no longer corrupt canon, which removes the entire class of reconciliation-drift bugs.

## Open / parked items
- **Historical-ticket location reconciliation: PARKED.** Existing tickets reference the old ugly locations; back-matching thousands of legacy refs to the clean graph is its own messy effort. Out of scope here — one thing at a time. Not hand-waved as easy.
- Exact `pending well reference` shape (`wellNameText` + which hints: field, operator, lat/lng, county).
- Seed ranking edge cases (new client with no ticket history; multi-site techs).

## Verdict: **BUILD (net-new, V2), targeted client-side rebuild.**
> Search server-side (already built for it), hold a passive seed+observed working set on the client (zero tech prep), never ship the universe, and let unknown wells fail clean as pending references the server resolves additively. Burn the V1 location cruft instead of migrating it; canon accretes from real work matched against DMR. Keep the server; rebuild only the client data path.
