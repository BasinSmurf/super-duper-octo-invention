# Service Pro workable rollout plan - 2026-09-09

This plan reconciles the August 28 action-items PDF with the repo as it exists today. The PDF is source material, not an executable task list. Current owner input wins where the PDF contradicts itself.

## Current Truth

- Production is already on the V2/current app path. The old V1 -> V2 clean-DB/IP handoff plan is superseded by [ADR-0016](adr/ADR-0016-v2-clean-db-cutover.md).
- Sandbox is the proving ground: localhost:5174, API 3002, sandbox Postgres 5435, sandbox Redis 6380, and sandbox QuickBooks via manual QBWC pulls. See [SANDBOX.md](../SANDBOX.md).
- Customer pricebooks exist and are expected to be enabled on 2026-09-10.
- The four board workstream is done. Treat boards as smoke-test only unless a defect falls out.
- D4/D6 tagging is needed, but can land after go-live.
- D6 service center workflow is the unstable area. It needs to be redesigned, not merely patched from the meeting notes.

## Gate 0 - Freeze The Target

Do this:

- Decide whether D6 is inside or outside the immediate go-live scope.
- Write the go-live definition in one sentence: "D4/D3 billing proven in sandbox; D6 either excluded or redesigned and proven."
- Stop accepting new board-layout asks unless they are bug fixes.
- Keep the August 28 PDF as background only.

Test this:

- Confirm `/tickets/start` is the staff-facing new-ticket door.
- Confirm `/tickets/new` still works for direct legacy links and drafts.
- Confirm sandbox is on the same code revision intended for prod testing.

Poke here:

- `client/src/App.tsx`
- `client/src/pages/wizard/WizardShell.tsx`
- `client/src/pages/wizard/divisions.tsx`
- `SANDBOX.md`

## Gate 1 - Pricebooks And QB Reality

Do this:

- Enable customer pricebooks on 2026-09-10.
- Pull/sync QuickBooks items and price levels in sandbox.
- Assign representative customers to their expected price levels.
- Pick a small billing corpus: one ordinary D3 job, one D4 manned rental, one D4 monitor/rental case, one D6/shop candidate if D6 remains in scope.

Test this:

- Generate each invoice in Service Pro.
- Use sandbox QBWC manual pull with the sandbox company file open.
- Verify line items, QB item refs, class refs, sales tax item, customer refs, and prices in QuickBooks.
- Verify failures show in `/admin/ops` and can be retried or pulled back without guessing.

Poke here:

- `server/src/routes/admin.ts` - QB item, price-level, and sales-tax sync endpoints.
- `server/src/routes/qbwc.ts` - QBWC queue handling and price-level pull.
- `server/src/services/qbxmlBuilder.ts` - qbXML payload shape.
- `server/src/services/qbItemMapping.ts` - QB item to Product mapping.
- `server/src/services/billingRules.ts` - price/profile resolution.
- `server/src/services/__tests__/qbxmlBuilder.golden.test.ts` - payload invariants.

Need to add/delete:

- Add sandbox test cases to the skipped QB failure corpus when real QB rejects a payload.
- Add a short pricebook verification checklist to `SANDBOX.md` after the first successful pull.
- Do not delete or retire old QB/prose SKUs until the ADR-0015 prerequisites are actually met.

## Gate 2 - D4 Prove-Out

Do this:

- Run D4 from `/tickets/start` through the real user path.
- Prove On Site Services / manned trailer daily ticket.
- Prove Deploy -> Daily Ticket -> Return or Complete.
- Prove rental invoice generation and QB push.
- Confirm D4 class strings and Dickinson variants in sandbox QB.

Test this:

- Manned rental: deploy with trailer and monitors, record a daily ticket, generate billing, push to QB.
- Monitor rental: deploy serialized monitors, return one item partially, complete the rental later, generate billing, push to QB.
- Offline-ish pass: create or edit a D4 ticket with the PWA online, briefly lose connectivity, recover draft/sync.
- Billing edge: verify "walk-in" behavior skips or routes QB/Enverus exactly as intended.

Poke here:

- `client/src/pages/wizard/divisions.tsx`
- `client/src/pages/TicketWizard.tsx`
- `client/src/pages/RentalsPage.tsx`
- `client/src/pages/RentalDetailPage.tsx`
- `client/src/pages/RentalReturnPage.tsx`
- `client/src/components/SiteLogEditor.tsx`
- `server/src/routes/rentals.ts`
- `server/src/routes/invoices.ts`
- `server/src/services/rentalComposition.ts`
- `server/src/services/rentalBilling.ts`
- `server/src/services/rentalBillReadyWatcher.ts`

Need to add/delete:

- Add server tests around rental composition/rental billing if missing for the tested cases.
- Add any missing D4 class/pricebook failure case to qbXML tests.
- Defer D4 tagging until after go-live unless the test corpus proves it is needed for billing correctness.

## Gate 3 - D6 Relitigation

D6 is not a checklist cleanup. Treat it as a workflow design sprint.

Do this:

- Map the actual service-center lifecycle on a whiteboard before code:
  intake -> identify unit -> choose category/service action -> quote/approve if needed -> work/parts/vendor -> QA -> ready for pickup -> release/signature -> billing.
- Split customer drop-off, field-to-shop handoff, internal/Basin work, vendor work, and warranty work. Those are different workflows wearing one coat.
- Define the minimum D6 happy path for go-live, if any.
- Define what must be blocked: untagged drop-off, no serial/category, missing QA, missing vendor invoice, no billable/warranty decision.
- Decide whether D6 uses one work order with per-item status, one work order per job number, or a stricter item-first flow.

Test this:

- Intake an SCBA pack with components.
- Intake a fire extinguisher with FEX-specific fields.
- Intake a gas monitor needing calibration/sensor replacement.
- Send an item to vendor and receive it back.
- Mark warranty vs billable and generate shop billing.
- Confirm QA gate blocks ready-for-pickup until inspection requirements are done.
- Confirm pickup/release is signed and captured.

Poke here:

- `client/src/pages/ShopIntakePage.tsx`
- `client/src/pages/ShopOrderDetailPage.tsx`
- `client/src/pages/ShopOrdersPage.tsx`
- `client/src/components/ShopUnitEntry.tsx`
- `client/src/components/EquipmentInspectionEditor.tsx`
- `server/src/routes/shopOrders.ts`
- `server/src/services/shopStateMachine.ts`
- `server/src/services/shopBoard.ts`
- `server/src/services/shopBillingLines.ts`
- `server/src/services/inspectionChecklist.ts`
- `server/prisma/schema.prisma` models `ShopWorkOrder`, `ShopWorkOrderItem`, `EquipmentInspection`, and `EquipmentInspectionAttachment`.

Need to add/delete:

- Add D6 workflow tests at the service/state-machine level before broad UI edits.
- Add a first-class "D6 job type / tag / reason" model only after the redesigned workflow names the vocabulary.
- Add vendor attachment requirements if vendor billing is in scope for go-live.
- Delete or hide D6 UI paths that invite invalid work before the new flow exists.
- Do not build more one-off D6 toggles until the workflow is agreed.

## Gate 4 - Boards Smoke

Do this:

- Smoke all four boards in sandbox and production-like data.
- Verify site filters, station filters, incoming/departing, ready pickup, and rentals board.
- Confirm board URLs are the intended ones for wall/kiosk devices.

Test this:

- Move a shop item through intake -> work -> QA -> ready pickup.
- Move a transfer between Williston and Dickinson.
- Create and display an active rental.
- Verify no role/auth/kiosk-token regression.

Poke here:

- `client/src/pages/ShopBoardPage.tsx`
- `client/src/pages/RentalsBoardPage.tsx`
- `server/src/routes/boards.ts`
- `server/src/routes/shopBoardPublic.ts`
- `server/src/routes/rentalsBoardPublic.ts`
- `server/src/services/shopBoard.ts`
- `server/src/services/rentalsBoard.ts`

Need to add/delete:

- Add only bug fixes before go-live.
- Delete no columns or statuses unless the board smoke exposes stale dead UI.

## Gate 5 - Post-Go-Live Tagging

Do this:

- Define tags as workflow facts, not decoration.
- Decide whether tags apply to the rental agreement, rental item, shop work order, shop item, or inspection. It is probably more than one level.
- Use a controlled vocabulary for D4/D6 tags and keep free text as notes.

Likely code shape:

- Add `TagDefinition` / `EntityTag` tables, or add narrowly scoped JSONB only if the vocabulary is deliberately temporary.
- Add API endpoints to attach/remove tags with audit logs.
- Add chips/filters in D4 rental views and D6 shop views.
- Add board filters only if staff actually need them on the wall boards.

Poke here:

- `server/prisma/schema.prisma`
- `server/src/routes/rentals.ts`
- `server/src/routes/shopOrders.ts`
- `client/src/pages/RentalsPage.tsx`
- `client/src/pages/RentalDetailPage.tsx`
- `client/src/pages/ShopOrdersPage.tsx`
- `client/src/pages/ShopOrderDetailPage.tsx`

## Suggested Immediate Order

1. Update docs and ADRs to stop planning the obsolete cutover.
2. Pricebooks on, QB sandbox pull, verify representative customer rates.
3. D4 sandbox proof through QB.
4. D6 relitigation session with code owner plus Mike T/service center.
5. D6 minimum viable go-live decision.
6. Board smoke only.
7. Post-go-live D4/D6 tagging slice.

## Go / No-Go

Go when:

- Pricebooks are enabled and verified in sandbox.
- D4 creates real invoices and QB accepts them in sandbox.
- Boards smoke clean.
- D6 is either explicitly excluded from the first go-live or its redesigned minimum path passes sandbox testing.
- Ops knows how to inspect QB failures, pull back invoices, and retry.

No-go when:

- Sandbox QB has not accepted the representative invoice corpus.
- D6 is still relying on the August 28 action list as its workflow design.
- Any money-creating path depends on a pricebook, item, customer, class, or tax mapping that has not been pulled from sandbox QB.
- A board bug hides work in progress from the shop.
