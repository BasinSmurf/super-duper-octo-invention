# ADR-0013 — Ticket wizard restructure (division-first) + decomposition plan

- **Status:** Proposed (net-new; executes the `TicketWizard` decomposition from [ADR-0005](ADR-0005-frontend-architecture.md))
- **Date:** 2026-06-27
- **Principle flags:** None new. Reinforces [[feedback_freetext_last_resort]] (catch-all is the bounded exception, not the default) and derive-from-work-records (division set up front sharpens billing/QB-class).

## Context (file evidence)
- `client/src/pages/TicketWizard.tsx` is **5,511 lines / 263 KB** — one component, ~126 hooks, ~13 work-type flows inlined (field_service, ih_testing, cascade_air, gas_detection, on_site_services, rental_deploy, daily_log, inspection, training, occ_health, shop_repair, air_fill, direct_sale).
- Today the wizard is **work-type-first** (Step 0 = pick work type); **division follows** the work type (the V2 mockup says "Division follows the work type").
- Owner: "the team talks in D3 / D4 terms." The current work-type-first step is a "weird hybrid." `ServiceDivision` D3/D4/D6 are real enum values feeding QB class mapping ([[reference_qb_class_mapping]]).

## Decision — division-first top level
Step 0 picks a **division** (how the crew already thinks), each button carrying a subhead "*types of work you find here*" since the codes are opaque to outsiders but native to the team. Choosing the division **sets the ticket's division classification up front** (rather than deriving it) — cleaner for billing/QB-class downstream.

### FIELD surface — 4 default buttons
```
D3 — air / detection / general field service
     ├─ Air System (Cascade Air)
     │    └─ On-site air-system Inspection  ── SEPARATE workflow from D6;
     │         can STACK with repairs / other cascade work in one ticket
     ├─ IH Testing                 (current "IH" ticket folds in)
     ├─ Gas Detection
     └─ Other / General Service    (catch-all — see below)

D4 — rental & on-site   (baseline = On Site Services)
     ├─ On Site Services           (baseline; Manned Trailer lives HERE, unchanged)
     ├─ Rental → Deploy / Daily Ticket / Return   (nomenclature tentative)
     └─ Other / General Service    (catch-all)

D6 Inspection                      (label kept explicit to disambiguate)
     └─ Equipment Inspection       — the "send to D6 / shop" inspection.
        Standalone top-level "Inspection" goes away entirely.

Shop Fill (Air Fill)               — available on BOTH field + shop surfaces;
                                      "whoever happens to be here" task.
```

### The two inspections are NOT the same workflow (important)
- **D3 → Cascade Air → on-site air-system Inspection:** field check of an on-site air system; **stackable** with repairs / cascade work in the same ticket.
- **D6 Inspection:** the standalone "this needs shop work" inspection that feeds the Shop Service surface (ShopWorkOrder).
- They share no flow. Don't collapse them.

### APP SWITCHER (surfaces, not field buttons — per [ADR-0005](ADR-0005-frontend-architecture.md))
```
Shop Service   = today's shop work tab (no top-level field button)
Compliance     = Training + Occ Health (moved OUT of the field wizard entirely)
Direct Sale    = POS-style; "whoever's here", available field + shop (placement tentative)
[+ Billing / Ops / Admin]
```

### Catch-all ("Other / General Service", under D3 and D4)
Deliberately thin: **billable line items + a forced notes box** ("what did you do that was so special?"). It still yields billable lines (so AR can invoice) and a mandatory record — bounded enough not to become "6 sticky notes and a gorilla interpreting sign language," but a real door for the 20% that doesn't fit. It is the exception path, never the default.

## Old → new mapping (this table IS the decomposition plan)
Each **division** becomes a lazy module; each **work-type** a step-module under it. Breaking `TicketWizard.tsx` along these lines *is* the ADR-0005 god-component decomposition — paid once.

| Current work-type | New home |
|---|---|
| `field_service` (general) | D3 → Other/General **and** D4 → Other/General |
| `cascade_air` | D3 → Air System (+ on-site inspection sub-flow) |
| `ih_testing` | D3 → IH Testing |
| `gas_detection` | D3 → Gas Detection |
| `on_site_services` (incl. Manned Trailer) | D4 → On Site Services |
| `rental_deploy` | D4 → Deploy |
| `on_site_services` / manned-trailer daily log | **D4 → Daily Ticket** — a *shortcut* to the existing manned-trailer daily log (NOT net-new; just a faster door than On Site Services → Manned Trailer) |
| *(net-new)* return | **D4 → Return** — return rental gear with **item selection (partial OK** — e.g. just monitors today); distinct from "Return & Close" which ends the rental |
| `inspection` (field) | D6 → Equipment Inspection |
| `air_fill` | Shop Fill (field + shop surfaces) |
| `shop_repair` | Shop Service surface (app switcher) |
| `training` | Compliance surface |
| `occ_health` | Compliance surface |
| `direct_sale` | Direct Sale (app switcher, POS) |

## Migration cost / risk / effort
- **Medium-high, but it's the decomposition you already owe** ([ADR-0005](ADR-0005-frontend-architecture.md)). Sequencing: do it **behind the test net** ([ADR-0001](ADR-0001-ci-source-split-and-observability.md)) — extract one division/step-module at a time from the monolith; the new division-first shell is the new entry point.
- **Risk:** the wizard is the highest-traffic field surface with zero current tests — strangler it work-type by work-type, don't big-bang rewrite the 5,511 lines.

## Open / parked
- **Direct Sale / POS** exact placement (app-switcher item assumed; "whoever's here").
- **Return flow design** (net-new): item-level selection for partial returns, and how it relates to "Return & Close" (close = end the rental; Return-only leaves it open). Daily Ticket resolved — it's a shortcut to the existing manned-trailer daily log, not a new flow.
- **Cascade-fill locked kiosk** (future): pick filling tech + customer + truck # at the cascade — a new kiosk type on the existing kiosk infra (BOARD/STATION/CLAIM → +FILL). Out of scope now.

## Verdict: **BUILD (V2)** — division-first shell + per-work-type step-modules.
> Buttons = divisions (D3/D4/D6 + Shop Fill), because that's how the crew thinks and it sets billing classification at step 0. Two distinct inspections (D3 on-site air-system, stackable; D6 send-to-shop). Training/Occ-Health/Shop/Direct-Sale move to app-switcher surfaces. The old→new map doubles as the plan to dismantle the 5,511-line monolith — strangler it, behind tests, one module at a time.
