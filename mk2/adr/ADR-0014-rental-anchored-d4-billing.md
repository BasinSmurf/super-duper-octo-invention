# ADR-0014 — Rental-anchored D4 billing (the rental is the billing spine)

- **Status:** Proposed — cadence model stands; **line composition + pricing now governed by [ADR-0015](ADR-0015-catalog-bom-pricing.md)**, and therefore **BUILD BLOCKED** with it (owner 2026-07-02: "rental billing #s are getting totally reloaded … a blocker for now"). No code beyond the uncommitted manned-air wizard line on `mk2-relitigation`; that line's tech-count→SKU logic is superseded (see below) — do not finish it against combo SKUs.
- **Date:** 2026-06-30
- **Principle flags:** Reinforces **derive-from-work-records / "I'm not billing it because you *said* so"** — every billed day traces to a recorded, signed ticket, never to an asserted date range × headcount. Also [[feedback_freetext_last_resort]] (the daily/cal work is structured line items, not a typed-in total).
- **Related:** [[reference_manned_air_billing]], [ADR-0013](ADR-0013-ticket-wizard-division-first-restructure.md) (D4 wizard surface), [[project_rental_workflow_updates]], [[project_rental_workflow_batch2]], [[project_resolver_at_ticket_time]] (per-customer price levels feed the rates here).

## Context (file evidence + two real tickets)

Two doForms field tickets define the two shapes D4 rentals bill in:

1. **Manned air trailer** — `…Kraken…Apollo-18-7-6-#3H…D4…Rental` (Downloads). One day, one tech: a single line **461 "Daily Air Trailer Rental w/Technician - With Gas Detection" @ $1,050**. A 14-day job = 14 such daily tickets.
2. **Unmanned monthly monitor rental** — `…Petro-Hunt…Little-Knife-Gas-Plant…D4-Dickinson…Rental` (Downloads). doForms crams the whole month onto one sheet: 5× "Area Monitor Daily Rate" + 2× "RGX Gateway Daily Rate", each **30 × $35 = $1,050** (= $7,350), **plus** "Monthly Calibration Flat Rate" $200 → **$7,550**.

Current system state:
- **Manned-air wizard line is built but uncommitted** on `mk2-relitigation`: `client/src/pages/TicketWizard.tsx` seeds a 461-family line (`MANNED_AIR_LINE_ID`, qty = # techs). Verified at the wizard/draft level. **Not shippable yet** — see the double-bill landmine below.
- **Composition billing** (`server/src/routes/invoices.ts` ~1539–1645) already bills a rental's priced composition per line: `billablePeriods(start,end,rateType)` × rate. It emits a `Trailer (Manned|Unmanned)` line at `invoices.ts:~1620`, plus gas-monitor / other / BOM lines.
- **Consolidated field-ticket invoicing** groups uninvoiced field tickets by customer+field+month ("Invoice All N"); pool comes from `GET /uninvoiced/tickets` (`invoices.ts:~205`).
- **Ticket→rental link already exists**: `ServiceTicket.linkedRentalAgreementId` (`sync.ts:687,723`). The wizard's "Link to Rental" picker sets it — today shown **only** for `onSiteSubtype === 'manned_trailer'`.
- Rental daily-log path exists (manned-trailer tickets mirror entries into the linked rental's log on sync).

## Decision — one principle, one invoice

**The rental agreement is the billing spine. Any field ticket may attach to a rental — attach is ORTHOGONAL to division. The rental's invoice is a single rolled-up document: composition lines + the billable lines of every attached ticket.** (Invoice rollup confirmed by owner: *one* rental invoice, not separate-but-grouped.)

### Attach is decoupled from division (the D3/D4 realization)
The ticket's `division` field = **operational** classification (what kind of work, who's dispatched). Rental-link = **which contract this bills under**, and in AR lingo **Rental IS Division 4** — so the *revenue class* of anything on a rental invoice is D4 (see Mechanism 5). These are independent axes. The canonical case the owner surfaced: an **area monitor on a monthly *unmanned* rental (D4 contract) gets cal'd** — a cal/bump/sensor-replace is *normally D3* gas-detection work. The ticket stays **operationally D3** (work record / dispatch), but **attaches to the D4 rental** and its rolled-up revenue books as **D4**. This is why the old doForms field ticket blurred D3/D4: the work genuinely crosses the operational/billing line on one job. We keep the logical separation (operational division set by work type) and decouple the billing roll-up (rental link → D4 revenue).

So the work types that can attach a rental are **not just D4**:
- **D4** — On Site Services (manned trailer = *required*), rental Deploy/Return, general.
- **D3** — **Gas Detection** (cal / bump / sensor replace), **on-site Air Fill** (cascade-air fill on a rental site).
- Practically: **any field ticket may attach** (optional); the picker is universal, required only for `manned_trailer`.

| Job shape | Composition billing | Attached tickets | Single rental invoice = |
|---|---|---|---|
| **Manned trailer** | trailer line **SUPPRESSED** | one daily ticket per day; **product chosen by tech count** (not qty) | Σ daily tickets, rolled to **days × product** — *14 single-tech days → 461 qty 14* |
| **Unmanned (month+)** | equipment: days-in-month × units × rate(s) | monthly cal/inspection (+ deploy / pickup, T&M) | composition equipment + Σ attached tickets — all **days × items** |

The Petro Hunt sheet, in SP, **splits**: the $7,350 equipment is *derived* from the rental composition (5+2 units × 30 days × $35 — no hand-typed "30 × $35" rows), and the $200 cal is a monthly **ticket** attached to the rental. Both land on the one rental invoice.

### Tech count selects the PRODUCT, days = ticket count (owner, Q1+Q3)
A 2-tech day is **one ticket**, not two. The number of techs picks the daily *product*, it does **not** multiply quantity:
- **1 tech → 461** (Daily Air Trailer Rental w/Tech, With Gas Detection — *includes 1 tech*); no-gas/half-day siblings 460/462/463 as applicable.
- **2 techs → the 2-tech daily product** (*includes 2*). ⚠ **SUPERSEDED by [ADR-0015](ADR-0015-catalog-bom-pricing.md) (owner 2026-07-02).** The hunt for a "451.1" 2-tech combination SKU is retired — combo SKUs are being culled. Correct shape: base `air trailer rental` @ MSA rate, and the **second tech resolved against the customer's BOM** — covered if their Standard BOM includes 2 crew, else an `additional technician` add-on line.
- **3+ techs → base + `additional technician` add-on per over-baseline tech** (ADR-0015 §Billing rule), *not* a combo product + per-tech SKU. (Prior candidate 450 "Air Trailer Technician Labor" $85 is a cull-data question, not a model question.)

Each daily ticket is **one day** (qty 1); the *days* dimension is the count of daily tickets. The invoice rolls those up to **days × product** (Q4) — 14 single-tech days become one `461 qty 14` line, a mixed week splits into one line per product (e.g. `461 qty 10` + `2-tech qty 4`).

### Why tickets, not "days × headcount on the rental"
A synthesized `days × techs × rate` bills off an **assertion** — the rental's open/close dates and a roster number, whether or not a tech stood on that pad on day 17, whether day 9 was a half-day, whether day 3 ran two techs. Billing from tickets means each billed day is a **signed, recorded shift** with its own product/qty. Per-day variance (1 vs 2 techs, half-day 462/463, gate-guard 424, skipped days) is native. This is the project's standing rule, made concrete.

## Mechanisms (the gears)

1. **Suppress the manned-trailer composition line** (`invoices.ts:~1620`): when `composition.trailer.manned === true`, do **not** emit the `Trailer (Manned)` line, and exclude it from the `unpricedCompositionLines` guard (`server/src/services/rentalComposition.ts`) so a manned trailer isn't flagged "unpriced." The 461 daily tickets are the trailer-tech charge. Unmanned trailer line still bills.
2. **Roll attached tickets onto the rental invoice, aggregated to days × items** (Q4): rental invoice generation gathers `ServiceTicket where linkedRentalAgreementId = rental.id AND not-yet-invoiced AND service/log date falls in the billed calendar month`, and rolls their billable lines up **grouped by (product, rate)** so daily charges present as `qty = days × item` — uniform for manned and unmanned. T&M tickets (deploy/pickup/cal) keep their own lines (mileage/labor/flat), not day-multiplied.
3. **Double-invoice guard (load-bearing)**: a ticket with `linkedRentalAgreementId` set must be **excluded from the standalone field-ticket consolidation pool** (`GET /uninvoiced/tickets` / BillingPage grouping). Attached → bills via the rental, never also standalone. This is the single highest-risk correctness point.
4. **Wizard — universal optional attach** (`TicketWizard.tsx`, the part the owner emphasized): the "Link to Rental" picker shows on **any field ticket** — D4 on-site/rental *and* D3 Gas Detection (cal/bump/sensor) and on-site Air Fill. Optional everywhere; **required for `manned_trailer`** (unchanged gate there). The picker filters to the customer's active rentals (a D3 cal ticket for Petro Hunt offers Petro Hunt's open monitor rental). Attaching is the act that makes a ticket roll up. `linkedRentalAgreementId` already persists — this is widening *where the picker renders* + the requiredness rule, not new schema.
5. **Rental revenue books as D4 — the QB class follows the *rental*, not the ticket's operational division** (corrects an earlier draft of this ADR). In AR lingo **Rental IS Division 4**; `qbClass.ts` maps D4 → `"D4 Basin On Site Service"` (Dickinson → `"Dickinson:Dickinson4 On Site Service"`). When a ticket rolls onto a rental invoice, its billable lines take the **rental's** class (D4, base/Dickinson per the rental's location) — *not* the ticket's operational division. So a *D3* gas-detection cal attached to a rental bills as **D4** revenue. The ticket keeps `division = D3` for the **work record / dispatch** (logical separation preserved); the **revenue class** is D4 because it's rental revenue. Net: a rolled-up rental invoice is **uniformly D4** (one Dickinson dimension from the rental), so there is no mixed-class invoice for the rental case — `qbxmlBuilder.ts` per-line `<ClassRef>` (`:147,219,277,354`) just gets fed D4 for every rolled line.

   **Two distinct uses of "division":** (a) *operational* — what kind of work, who's dispatched, the ticket's `division` field (a cal stays D3); (b) *AR revenue class* — which contract books it, D4 for anything on a rental. Attaching a ticket to a rental changes (b), never (a).
6. **Pre-rollup reconciliation gate (manned, soft)** (owner final gotcha): before generating a manned rental's monthly invoice, compare **daily-ticket count vs manned days in the billing month**. Tickets may *exceed* days — two shifts (day + night) = two tickets on one day, expected and fine. But **fewer tickets than days means a shift's ticket is missing** → an "are you sure?" confirm (soft gate, not a hard block — matches the deploy-mismatch confirm pattern [[feedback_shunt_to_correct_path]]). The precise check: every manned calendar day in the period has **≥ 1** linked daily ticket; surface the uncovered dates in the prompt so AR can chase the missing shift before billing.

## Consequences

- **Cleaner, auditable billing**: the rental invoice reads as the customer expects (equipment + the month's service), every line backed by either the composition spec or a signed ticket.
- **Tech stops hand-totaling**: no more typing "30 × $35" rows; equipment is derived, the ticket carries only the cal/inspection performed.
- **The uncommitted manned-air wizard line needs rework**: it currently does `461 × qty(=#techs)`. Per Q1+Q3 the correct shape is **tech-count → product** (1→461, 2→2-tech product, 3+→ +line items), **qty = 1 day per daily ticket**. Salvageable (the picker + sentinel-line plumbing stay), but the qty-multiply logic is replaced by product-selection. Still must not ship until mechanism #1 (comp suppression) lands.
- **Walk-ins / legacy rentals** (no priced composition, no linked tickets) fall through to the existing per-item billing path — untouched.
- **Migration**: no schema change required (linkage + line-item fields already exist). Behavior change is in invoice generation + the uninvoiced pools + wizard rendering.

## Billing period — calendar months (owner, Q5)

**Everything bills on calendar-month boundaries; one invoice per rental per calendar month.** A job that crosses a month boundary is split: each month's invoice carries only that month's daily charges (days counted within the month) plus the T&M tickets that occurred that month. Worked example (owner): a job opening on the **30th of a 30-day month** → *Month-1 invoice* = deploy (T&M) + **1 day** of daily charges (the 30th); *Month-2 invoice* = the days falling in month 2, and the **pickup** (T&M) on the month it happens. Daily-charge proration is therefore just "count the days that land in this calendar month" — no fractional-day math. This refines `billablePeriods` to clamp each invoice to `[max(rentalStart, monthStart), min(rentalEnd/now, monthEnd)]`.

## Resolved (owner, 2026-06-30) — Q1–Q5

1. **2-tech day = ONE ticket** (not two). Tech count selects the product (see "Tech count selects the PRODUCT" above), not a second ticket.
2. **Deploy & pickup roll up, billed T&M** (mileage + labor). Cross-month → deploy on month-1 invoice, pickup on month-2 invoice.
3. **Product by tech count**: 461 includes 1 tech; the 2-tech daily product (owner: "451.1" — verify) includes 2; **3+ → 2-tech product + an additional line item per extra tech.** ⚠ exact 2-tech and per-extra-tech part #s need verification against real QB (dev catalog has 423/424/450).
4. **All rollup, days × items** — uniform manned/unmanned presentation.
5. **Calendar-month billing** — see the section above.

### Still to verify before build
- ~~Exact QB part # for the 2-tech daily product / per-extra-tech add-on~~ — **retired**: [ADR-0015](ADR-0015-catalog-bom-pricing.md) resolves crew via base-item + BOM baseline + `additional technician` add-on, not combo SKUs. The remaining question (does the customer's Standard BOM include 2 crew, and what's the add-on's QB rate) is a cull-data/mapping question owned by ADR-0015, not a blocker unique to this ADR.
- Whether a manned-with-gas job ever *also* carries separately-billed composition monitors (assume not — gas is inside the base BOM per ADR-0015).

## Deploy / Return is the D4 job boundary (owner 2026-07-02)
The D4 flow gets a **Deploy / Return function** (see [ADR-0013](ADR-0013-ticket-wizard-division-first-restructure.md), which owns the wizard surface). **Deploy opens the job; Return closes it** — that pair is the rental's start/end anchor, and **both force inspection docs** (equipment inspection captured at deploy and at return, tying into the inspection-as-spine work). This gives the billing spine hard, signed endpoints: the calendar-month day-count clamps to `[deploy, return]`, and a rental cannot close without its return inspection. It also subsumes the earlier "partial return / Return-only leaves rental open" open item — Return = end the job (see ADR-0013 for the resolved flow).

## Non-goals

- Rental **auto-billing scheduler** (still deferred; manual `GET /uninvoiced/rentals` covers MVP — see memory index).
- Touching D3 / non-rental field-ticket invoicing beyond adding the optional attach control.
- Missing-daily-log detection (lives with the future Notifications layer).

## Implementation surfaces (when greenlit)

- `client/src/pages/TicketWizard.tsx` — (a) widen "Link to Rental" to **any field ticket** (D4 on-site/rental + D3 Gas Detection + on-site Air Fill); keep manned required, all else optional. (b) rework the manned daily line: **tech count → product** (1→461 / 2→2-tech / 3+→ +per-tech line), qty = 1 day, not `461 × #techs`.
- At rollup, **stamp rolled-up line items with the RENTAL's QB class** (`resolveQbClassFullName('D4', rental.isDickinson)`), overriding the ticket's operational division — rental revenue books as D4. (Standalone, non-rental tickets keep deriving class from their own division.)
- `server/src/routes/invoices.ts` — (a) suppress manned trailer comp line; (b) roll attached tickets into rental invoice generation (`POST` rental invoice ~1435–1500, `GET /uninvoiced/rentals` ~1849), aggregating daily lines to **days × product** grouped by (product, rate); (c) exclude linked tickets from `GET /uninvoiced/tickets` (~205); (d) clamp `billablePeriods` to **calendar-month** boundaries so each month cuts its own invoice and deploy/pickup land in their month.
- `server/src/services/rentalComposition.ts` — exclude manned trailer from `unpricedCompositionLines`.
- `client/src/pages/BillingPage.tsx` — exclude linked tickets from the customer+field+month consolidation grouping.
- `client/src/pages/RentalDetailPage.tsx` — show the rolled-up running total (linked tickets + composition) for visibility.
- Rental invoice generation (server) — manned **reconciliation gate**: count linked daily tickets vs manned days in the billing month; return uncovered dates so the client can raise the "are you sure?" confirm before committing the invoice.
