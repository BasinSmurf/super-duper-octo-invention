# ADR-0015 — Catalog / BOM / Pricing (flat-rate-plus; kill combination SKUs)

- **Status:** Accepted (model, owner 2026-07-02) — **BUILD BLOCKED** on two data prerequisites: (a) 18–24 mo QB sales-by-item cull data, (b) the SP↔QB stable-key mapping table. Do not delete prose SKUs or write billing off this until both exist.
- **Date:** 2026-07-02
- **Source of record:** `catalog-bom-pricing-handoff.md` (owner handoff; this ADR is its in-repo capture).
- **Principle flags:** Makes the **QuickBooks-ledger-of-record / QB-holds-pricing-authority** and **derive-from-work-records** principles concrete (no violation — SP never sets a price). ⚠️ **Bad-divorce corollary:** the per-customer BOM must be a first-class, authoritative, *versioned* SP object — if it ships as an untracked config blob, shop-floor tribal knowledge is merely relocated, not fixed.
- **Related:** [ADR-0014](ADR-0014-rental-anchored-d4-billing.md) (rental billing *cadence*; this ADR supplies its line *composition* + pricing), [ADR-0008](ADR-0008-quickbooks-boundary.md) (QB boundary), [[project_rental_bom_flat_rate_plus]], [[project_invoice_sales_tax]], [[reference_manned_air_billing]], [[project_resolver_at_ticket_time]] (price levels).

## Problem — the QB item list encodes *combinations*, not *things*

Part numbers bake `crew × gas-detection × duration` into the name, so twelve "air trailer" SKUs are one base item with three dials turned differently. Word order also drifts row-to-row ("Air Trailer Daily Rental" vs "Daily Air Trailer Rental w/Technician"), so **the sync key is a prose sentence** — there is no stable key. This is the root cause of the QB sync pain and the SKU explosion (and the exact reason [ADR-0014](ADR-0014-rental-anchored-d4-billing.md) got stuck hunting for a "451.1" 2-tech part # that doesn't cleanly exist).

## Decision — three layers, cleanly separated (one artifact, one job)

### 1. Catalog item = a distinct *thing* we sell
An item exists because it is a distinct thing — never because of who bought it, what they paid, or which combination they took.
- One base item: `air trailer rental`.
- A short, reusable shelf of **generic add-ons**: `daily area monitor`, `additional technician`, `gate guard`, …
- **No combination SKUs.** "Air trailer w/ 2 techs + gate guard" is a base item + a BOM + two add-on lines, not an item.

### 2. Price = QuickBooks (authority, unchanged)
QB stays the system of record for rates; customer rates come from QB **price levels** (per-MSA). SP does not set or override prices — it resolves *which* items apply and assembles the invoice from the work record.
- Base item bills as **one flat line** per standard job — "daily rate per MSA".
- Add-ons carry their own QB rates and bill as their own lines.
- **Duration is a rate tier on the base item, not separate items** — half-day / day / week / month / rig up-down are price-level variants of `air trailer rental`, never distinct SKUs.

### 3. Composition = per-customer BOM, in ServicePRO
A **BOM** is a named, per-customer, **owned + versioned** object defining what a customer's flat rate covers.
- A customer can have multiple named BOMs (`Standard`, `Drilling`). `464 "Drilling Rig Package"` becomes a **BOM template**, not a SKU.
- Standard BOM contents (crew, gas detection, monitors — per agreement) are **covered by the flat rate and not itemized** on the invoice.
- Anything a job runs **above** the customer's standard BOM bills as a generic add-on line (§1) stacked after the flat line.

## Billing rule (flat-rate-plus)

```
invoice for a job =
    1 line:  base item @ customer MSA price level        (covers the standard BOM)
  + N lines: generic add-on items for anything above BOM  (each @ its own QB rate)
```

A standard job is a single clean line; extra lines appear only when the job exceeds the customer's BOM. This keeps invoice line-count sane and the QB item list small.

## The join: SP job number
The SP job number is the key between systems. QB holds the money + the job-number tag on each invoice line; SP holds what was in the job (BOM applied, add-ons, actual serials deployed). "What did this consist of / which serials" is answered by following the job number **into SP**, never by reading the QB item list.

## Serial handling — "Schrödinger's billing line" (intentional)
The same physical monitor is either *covered* (inside the BOM, silent on the invoice) or an *add-on line* (above the BOM), depending on the customer's baseline. Both are correct.
- **Record which serial** went out on every job — asset truth, feeds the equipment ledger (BlueLion) + utilization.
- **Do not attach a billing rate to the serial.** For billing, unit identity is irrelevant; the BOM decides covered-vs-add-on; the rate lives on the generic add-on item in QB.
- **For Code:** serial capture and billing resolution are *separate concerns*. Deploying `AM-0423` records a deployment event; whether it produces a `daily area monitor` line is a function of `(job.items vs customer_bom.baseline)`, decided independently of the serial.

## The cull rule (retiring the QB item list)
Classify each existing SKU:
- **Combination SKU** (crew/gas/duration baked into the name) → **retire**; reconstruct as base + BOM + optional add-ons.
- **Genuinely distinct thing** → keep as a base item or generic add-on.
- **Duration variant** → fold into the base item as a rate tier.
- **Named bundle customers ask for by name** (e.g. Drilling Rig Package) → **BOM template** in SP, not a SKU.

Cull **empirically** against 18–24 mo of sales-by-item data before deleting — retire on evidence, not assumption.

## What Code needs (implementation notes, not final schema)
1. **BOM as a first-class, named, owned, *versioned* object with change history.** Shape `(customer, bom_name) -> composition[]`, each entry `(equipment_type, qty)`. `Standard` is default; a job may select an alternate (`Drilling`). ⚠️ Load-bearing: not an untracked config blob.
2. **Add-on resolution.** Given job composition + selected BOM baseline, compute the delta above baseline; map each over-baseline item to its generic add-on catalog item → those become the extra invoice lines.
3. **Invoice assembly (derive, never author).** Invoice = base line (BOM/MSA) + add-on lines (delta), each tagged with the SP job number.
4. **Catalog mapping table (SP-side).** base item + generic add-ons ↔ their QB items — the stable, non-prose key the current SKUs lack. **Must exist before the cull deletes prose SKUs.**
5. **Duration** flows to the base item's QB price-level / rate tier, not to item selection.

## Out of scope (billing model)
- Serial → billing-rate coupling (serials recorded, never priced).
- Per-customer combination SKUs of any kind.
- SP setting or overriding prices — SP resolves + assembles; QB rates are authority.

## Open items to confirm before / while building
- **BOM ownership + edit workflow** — who edits, review, history retention. Likely its own ADR.
- **Add-on catalog scope** — lock the minimal generic add-on shelf (monitor, tech, gate guard, …) against the cull data.
- **QB item ↔ SP item mapping** — the stable-key table must exist before the cull deletes prose SKUs.
- **464 / Drilling** — confirm it's a BOM template; sweep the list for other "named packages" deserving the same treatment.

## How this reconciles with ADR-0014 (rental billing)
They compose on orthogonal axes and do **not** conflict:
- **ADR-0014 = billing *cadence*** — how many lines and when: one signed, recorded daily ticket per billed day (never a `days × techs × rate` assertion), rolled to `days × product` on a calendar-month rental invoice.
- **ADR-0015 = line *composition* + *pricing*** — *what each line is*: base item @ MSA price level covering the customer's BOM, plus add-on lines for anything above it, no combination SKUs.

**Consequence for ADR-0014:** the hunt for a "451.1" 2-tech combination SKU (and a per-extra-tech combo) is **retired** by this ADR. A 2-tech day is `air trailer rental` (base, @ MSA rate) with the **second tech resolved against the customer's BOM** — covered if their Standard BOM includes 2 crew, else an `additional technician` add-on line. Same for gate guard / monitors. "Tech count selects the product" (ADR-0014) becomes "tech count vs BOM baseline selects the add-on delta." ADR-0014's per-day cadence, calendar-month split, double-invoice guard, and reconciliation gate are unchanged.

## Verdict: **ACCEPT the model; BUILD BLOCKED on data.**
> Three clean layers — catalog = things, QB price levels = money, per-customer versioned BOM = composition — with flat-rate-plus billing derived from the work record and tagged by job number. Kills the combination-SKU explosion at the root and gives QB sync a stable key. Cannot start deleting SKUs or writing billing until the sales-by-item cull data and the SP↔QB mapping table exist. Wave 2 (BOM tables as a versioned, owned entity) can begin as code before Wave 1 (the add-on shelf cull) lands, since the shelf waits on the sales data.
