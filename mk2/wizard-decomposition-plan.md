# TicketWizard decomposition plan (ADR-0013 execution)

Grounded in the actual `client/src/pages/TicketWizard.tsx` (5,511 lines), not just the ADR's conceptual map.

## Current anatomy (what we're cutting)
- **Flat `WORK_TYPES` config** (lines 114–220): 9 work types, each with a `steps: string[]` sequence. Two redirect out (`repair`→`/shop/intake`, `direct_sale`→`/pos`).
- **One component, one giant state blob** (lines 287+): ~80+ `useState`, edit-mode original-id Sets, draft persistence, shared customer/location/billing state, plus per-work-type state (fit test, air system, IH, gas, training, rental…).
- **Step orchestration by key**: `activeConfig.steps[step-1]` → a big inline switch renders each step.
- **Build/submit closures** (getWizardData, canAdvance, buildTicketPayload, buildTicketRecord, submitTicket, startJob) — close over the whole state blob; **not pure, not exported, not testable as-is**.
- **Leaf editors are ALREADY components** (FitTestEditor, GasDetectionEditor, IhTestingEditor, AirSystemInspectionEditor, FieldInspectionCapture, LineItemEditor, …). The monolith is the **state + orchestration + build/submit**, not the UI leaves. Good news: most of the hard UI is already extracted.
- **Entry preselect:** the wizard reads `?type=<WorkType>` (line 676). This is the strangler hand-off seam.

## Target tree (`client/src/pages/wizard/`)
```
pages/wizard/
  divisions.tsx     # division-first config: D3/D4/D6 + Shop Fill, each w/ subhead
                    # + the work-types within (→ existing WorkType key / redirect)
  WizardShell.tsx   # division-first top level (4 buttons). The NEW entry point.
  state/            # (later) shared WizardState context — extracted from the blob
  steps/            # (later) one module per work-type flow, owning its own state
```

## Strangler sequence (each slice is independently shippable)
1. **Slice 1 (this commit):** `WizardShell` + `divisions` config, additive. The shell delegates every work-type to the existing `/tickets/new?type=…` (and redirects shop/pos). Parallel to the monolith — nothing removed.
2. **Slice 0.5 — client test net (GATE before any logic migration):** the client has **zero tests**. Stand up client `vitest`; as each build/submit function is extracted to a pure module, ship a **characterization test** that pins its current output. Decomposing the highest-traffic untested surface without this is reckless (ADR-0005/0013).
3. **Per-work-type extraction, lowest-risk first:**
   - `air_fill` (Shop Fill) — small, self-contained 3-step flow → proof of the pattern.
   - `field_inspection` (D6) — self-contained, spawns Shop WO.
   - `ih_testing` (D3) — own records + line items.
   - `field_service` family (D3: cascade air / gas detection / general; D4: on-site) — the big shared core; extract the shared `WizardState` context here.
   - `rental` Deploy (D4); add the **new** Daily Ticket + Return flows (not in today's wizard).
   Each: move flow + its slice of state into `steps/<x>`, write its characterization test, repoint the shell hand-off from `/tickets/new?type=x` to the new module.
4. **Migrate-out (not into the field wizard):** `repair`→Shop Service surface, `training`/`fit_test`→Compliance surface, `direct_sale`→POS — per [ADR-0013](adr/ADR-0013-ticket-wizard-division-first-restructure.md) these leave the field wizard entirely.
5. **Finish:** when every field work-type is extracted, repoint `/tickets/new` → `WizardShell` and delete `TicketWizard.tsx`.

## Notes / constraints
- **Routing is deferred:** wiring `WizardShell` to a route is a one-line App.tsx add, held until the concurrent App.tsx work settles (can't cleanly partial-stage a shared file). Slice 1 ships the components unrouted; the dev wires `<Route path="/tickets/start" element={<WizardShell/>}/>` then later repoints `/tickets/new`.
- **field_service sub-type:** the `?type=` seam preselects the work *type*; the field_service *serviceType* (cascade/gas/on-site/general) is still picked in the existing flow until that family is extracted. (Could add a `?service=` param to the monolith, but that's monolith surgery we're avoiding for now.)
- **Daily Ticket + Return (D4)** are net-new flows — they don't exist in today's wizard; build them during the rental slice.
