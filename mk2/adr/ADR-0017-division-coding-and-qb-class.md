# ADR-0017 — Division coding & QB class derivation

- **Status:** Accepted + IMPLEMENTED. Originally built on `feat/adr-0017-division-qb-class` (PR #63, 2026-07-21) — which never landed on master; the work was re-landed 2026-08-25 alongside the server-side derivation that closes the same leak from the other end.
- **Date:** 2026-07-21 (re-landed 2026-08-25)
- **Principle flags:** **QB-ledger** — the QuickBooks Class list is the authority; SP *maps to* it and never invents a class string. **Bad-divorce** — an unmapped/unknown path resolves to `null` (no `<ClassRef>` → "uncategorized" in QB), which is recoverable by re-classing in QB; it must **never** fail the SalesOrder push.
- **Related:** [ADR-0013](ADR-0013-ticket-wizard-division-first-restructure.md) (the division-first wizard this rides on), [MK2-TARGET-STATE](../MK2-TARGET-STATE.md). Supersedes the ad-hoc "tech picks D3/D4" model in `DivisionSelector`.

## Context — division was a data-entry field, and it leaked

Today the **division is something the tech picks** (`DivisionSelector`: D3/D4 buttons + a Dickinson checkbox), and it only renders in the Field Service `who_where` step. Consequences:

- **Every other work type submitted `division = null`** → no `<ClassRef>` on the SalesOrder → **uncategorized revenue in QuickBooks.** IH, Training, Occ Health, Rental, Shop, Direct Sale all leaked.
- The tech had to make a bookkeeping decision (which division?) that they shouldn't own and often got wrong.
- Nothing stopped a **mixed-division ticket/batch** (the QB emit is header-only = one class per SalesOrder; mixed batches only logged a warning).

The division-first wizard ([ADR-0013](ADR-0013-ticket-wizard-division-first-restructure.md)) changes the premise: **the tech already declared the division the instant they tapped a division tile.** Division should be *read from the path*, not re-entered.

## Decision

**Division is a property of the work path, declared once in config; the tech's only locale input is a Dickinson bit that defaults from the active site.**

1. **Division = f(path), declared in config.** Each top-level entry in `client/src/pages/wizard/divisions.tsx` carries its `qbDivision`. Everything under the D3 tile is D3; under D4 is D4; and so on. There is no code path that produces a mis-coded ticket, and **one ticket = exactly one division** falls out for free (kills the mixed-batch landmine).
2. **The tech never picks a division.** `DivisionSelector` stops being an input and degrades to a read-only confirmation chip ("D3 · Williston"). The division comes from the tile.
3. **Locale is the only dial — and it defaults itself.** `isDickinson` **defaults from the active site switcher** already in the header (Dickinson vs Williston), but remains a **per-ticket override toggle** (owner 2026-07-21: there is enough Williston↔Dickinson back-and-forth that the ticket must be able to override the yard you happen to be standing in — the site switcher is convenience, the ticket is truth).
4. **QB Class = `resolveQbClassFullName(division, isDickinson)`** — the existing server helper (`server/src/utils/qbClass.ts`), mechanism unchanged. Client mirrors it for preview.
5. **Not every division has a Dickinson variant.** The QB Class list only defines Dickinson children for divisions **1–6**. **D7 (Sky Shield) and D8 (Occupational Health) are company-wide** — no Dickinson class exists. For those, `isDickinson` is **ignored** and the base class is always used. This is a rule in the resolver (fall back to base when no Dickinson variant), not a special case at the call site.
6. **Unmapped path → `null` → uncategorized, never a failed push** (bad-divorce). A new work type with no division yet posts without a `<ClassRef>` and gets classed in QB by hand — the push still succeeds.

## The QB Class list (authority — mirror exactly, do not reformat)

Full comptroller class list, and how each maps. **Trailing description is part of the class FullName.** Dickinson children are nested under a `Dickinson:` parent.

| Div | Base class (Williston) | Dickinson child | SP picker path |
|---|---|---|---|
| **D1** | `D1 Basin Safety Training` | `Dickinson:Dickinson1 Training` | **Training** |
| D2 | `D2 Basin Consulting` | `Dickinson:Dickinson2 Consulting` | *(no SP path yet)* |
| **D3** | `D3 Basin Safety Service` | `Dickinson:Dickinson3 Safety Service` | **D3** tile + **Shop Fill** |
| **D4** | `D4 Basin On Site Services` | `Dickinson:Dickinson4 On Site Service` | **D4** tile |
| **D5** | `D5 Basin Safety Store` | `Dickinson:Dickinson5 Store` | **Direct Sale** |
| **D6** | `D6 - FEX Services` | `Dickinson:Dickinson6 FEX` | **D6 Inspection** (+ shop work) |
| D7 | `D7 Sky Shield` | *(none — company-wide)* | *(no SP path yet)* |
| **D8** | `D8 Occupational Health` | *(none — company-wide)* | **Occ Health** |

**Tile → division map (encoded in config):**

| Picker tile | `qbDivision` | Note |
|---|---|---|
| D3 (air/gas/IH) | `D3` | |
| D4 (rentals/on-site) | `D4` | |
| D6 Inspection | `D6` | |
| **Shop Fill** | `D3` | in-shop air bills as safety service |
| Shop Service (repair) | `D6` | shop WO invoices stamp D6 + Dickinson from the intake site |
| **Occ Health** | `D8` | no Dickinson variant → always `D8 Occupational Health` |
| **Training** | `D1` | |
| **Direct Sale** | `D5` | Store |

## Consequences — what's built now vs staged

**Encoded now (this ADR):**
- `ServiceDivision` enum extended: `D1`, `D5`, `D8` added (additive migration).
- `QB_CLASS_MAP` in `qbClass.ts` gains D1/D5/D8; resolver falls back to base when a division has no Dickinson variant (D8, and future D7).
- Client `DivisionSelector` preview map mirrors the full table (null-safe for no-Dickinson divisions).
- `divisions.tsx` gains a `qbDivision` field on every top-level division = the single source of the tile→division truth.

**Implemented (Wave 2 — PR #63):**
- `WizardShell` threads `qbDivision` through the hand-off (`?division=`); `TicketWizard` reads it and stamps `division` for **every** work type on mount — closes the null-division leak for Training/Occ/Direct Sale/IH/Rental.
- `isDickinson` defaults from the active site switcher (resolve `getActiveSiteId()` → `/sites`, match name/shortCode `Dickinson`), applied once on a fresh ticket, never clobbering a draft/edit. Remains a per-ticket override.
- `DivisionSelector` collapses to Dickinson-only (`fixedDivision={division}`) wherever a path division is present — the D3/D4 picker is gone; it survives only as the legacy fallback when `/tickets/new` is reached with no `division` param. The Dickinson toggle is surfaced in the who_where, ih_setup, tr_setup, rn_setup, and af_confirm steps; Occ Health (D8) shows no toggle (no Dickinson variant).

## Open items

- ~~Verify the D1 / D5 / D8 exact FullName strings against the live QB Class list~~ — **done 2026-08-25** from a screenshot of QB's own Class list. Two of the *existing* strings were wrong and had to be corrected: **D4** is `D4 Basin On Site Services` (plural) and **D6** is `D6 - FEX Services` (spaces around the dash). The earlier revision of this ADR asserted the coded D3/D4/D6 strings were prod-validated and told the reader not to "fix" them to match a screenshot; that was wrong for D4 and D6. Prod push history shows **only `D3` base has ever gone to QuickBooks** (2 invoices + 1 SO); no D4 or D6 invoice had ever pushed, so neither string had ever been exercised. Both would have hard-rejected (QB 3140) on first use.
- **D2 (Consulting) and D7 (Sky Shield)** have QB classes but no SP work path today. Both are mapped now (enum + class map) so a future path only needs a work-type entry; neither is reachable yet.
- **D0 Basin Integrated** (with its `Camp Road Prop` / `Jon Greiner` sub-classes) is deliberately unmapped — it's the admin/holding class, not service revenue.
- **Nothing validates the class strings against QB automatically.** A transcription error is a hard reject that only shows up on the first push of that division. A `ClassQueryRq` pull (mirroring the existing item / price-level / sales-tax pulls) would turn this class of bug into a startup check; not built.

## Second half — server-side derivation (2026-08-25)

Path-stamping fixes tickets created through the wizard. It does nothing for the invoices already in the queue, for shop-WO and rental invoices (which are built from a work order, not a ticket), or for any future entry point that forgets to pass `?division=`. So the same question is answered independently on the server:

- `defaultDivisionForWork({ ticketType, serviceSubtype })` in `utils/qbClass.ts` is the server's copy of the tile→division table. Applied in `POST /api/tickets` and in the sync-push create path, so a ticket gets a division even if the client sends none.
- Invoice generation freezes it: shop WO → `D6` + Dickinson from the intake site's short code, rental → `D4`, ticket batches → the ticket's division or the work-type default.
- The QBWC push resolves it one last time from the invoice's source work (tickets → shop WO → rental) — which is what lets **already-queued** invoices push with a class instead of needing a data backfill.
- `<Other>` (the template's LOCATION field) is resolved on the same pass.

The client table is a mirror for the UI preview and the offline record; the server is authoritative on write.

## Verdict: **ACCEPT — division is coded by path AND derived server-side, locale defaults from site with a per-ticket override, class strings mirror QB exactly.**
> The tech stops making a bookkeeping decision. Division rides the wizard path (config-declared, one-per-ticket), Dickinson defaults from the yard but the ticket wins, and the resolver falls back to the base class when a division has no Dickinson child (D7/D8). Because the same table also lives on the server, a work type that never touches the wizard — or an invoice built straight off a work order — still lands on a class.
