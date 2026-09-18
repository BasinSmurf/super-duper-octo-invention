# ADR-0016 - V2 delivery status reset: cutover plan superseded

- **Status:** Superseded by current production reality (owner update 2026-09-09).
- **Original status:** Accepted 2026-07-02 as a strategy decision, never scheduled as written.
- **Current decision:** Do not build or execute the old V1 -> V2 clean-DB/IP handoff. The production-facing app is already the V2 surface. The remaining rollout work is workflow hardening, sandbox QB validation, pricebook enablement, and D6 redesign.
- **Related:** [MK2-TARGET-STATE](../MK2-TARGET-STATE.md), [ADR-0013](ADR-0013-ticket-wizard-division-first-restructure.md), [ADR-0015](ADR-0015-catalog-bom-pricing.md), [ADR-0017](ADR-0017-division-coding-and-qb-class.md), [Service Pro workable rollout plan](../SERVICEPRO-WORKABLE-ROLLOUT-PLAN-2026-09-09.md), [SANDBOX](../../SANDBOX.md).

## Why This ADR Changed

The 2026-07-02 ADR assumed a future delivery event: stand up a clean V2 beside V1, run allowlist migrations, freeze V1, re-key active jobs, spin V1 down, and move V2 onto V1's IP so QuickBooks and NPM did not need reconfiguration.

That is no longer the useful plan. Per owner update on 2026-09-09:

- The team pulled back from the handoff/cutover shape entirely in order to work through the operational rollout issues.
- The production version is already the V2/current surface. There is no remaining one-day IP inheritance handoff to plan around.
- The sandbox at localhost:5174 is wired to a sandbox-flavored QuickBooks company file for full run testing and billing proof.
- Customer pricebooks already exist and are expected to be enabled on 2026-09-10.
- The four board workstream is done.
- D4/D6 tagging is still needed, but it can land after go-live.
- D6 service center workflow is not coherent enough to patch around; it needs a full workflow relitigation.

## Superseded Pieces

The following parts of the original ADR are historical only and should not drive current work:

1. **Parallel V2 standup on a temporary IP.** No longer needed as a rollout gate.
2. **Clean empty Postgres as the go-live event.** Not the active rollout path.
3. **Allowlist migration tooling as the one net-new artifact.** Useful as a future data-cleanup pattern, but no longer the go-live blocker.
4. **Freeze V1 and manually re-key 20-30 open jobs.** No current handoff event requires this.
5. **Move V2 onto V1's old IP.** Superfluous now that V2/current is already production.

Keep the original logic as historical context: it was a sane answer to the earlier "clean restart" question. It is not the plan now.

## Current Rollout Shape

The rollout is now sandbox-verified operational go-live, not infrastructure cutover.

1. **Pricebooks**
   - Existing state: customer pricebooks exist.
   - Next gate: enable them on 2026-09-10.
   - Verification: pull/sync from QuickBooks sandbox, generate representative invoices, confirm the expected customer/item rates land.

2. **Sandbox QB full-run testing**
   - Existing state: sandbox runs at Vite 5174 / API 3002 / Postgres 5435 / Redis 6380.
   - Existing state: sandbox QuickBooks has its own QBWC app identity and should be pulled manually with the sandbox company file open.
   - Gate: every go-live workflow that can create money must be run end-to-end in sandbox through invoice generation and QBWC transmission.

3. **D4**
   - Existing state: the division-first wizard exposes D4 On Site Services, Deploy, Daily Ticket, Return, and Other/General through `/tickets/start`.
   - Existing state: rentals bill as D4 by default in `server/src/services/rentalComposition.ts`.
   - Gate: prove deploy -> daily log -> return/complete -> billing -> QB in sandbox for one manned and one monitor-style case.
   - Post-go-live: add D4 tagging.

4. **D6**
   - Existing state: service center workflow is the risky area.
   - Current decision: do not polish the August 28 action list as-is. Redesign the D6 flow from intake through QA, vendor, pickup, billing, and attachments.
   - Gate decision: D6 should either be explicitly out of go-live scope or go live only after the redesigned workflow passes sandbox proof.

5. **Boards**
   - Existing state: four-board workstream is done.
   - Gate: smoke test only. Boards should not consume remaining rollout oxygen unless a blocking defect appears.

6. **Tagging**
   - Existing state: no first-class D4/D6 tagging fields exist on rental or shop models.
   - Decision: tagging is post-go-live unless a customer/billing requirement turns it into a hard gate.

## Code Reality Checked 2026-09-09

- `client/src/App.tsx` routes new ticket entry through `/tickets/start` and keeps `/tickets/new` as the legacy monolith handoff.
- `client/src/pages/wizard/WizardShell.tsx` stamps `division`, `type`, `service`, and `subtype` into the `/tickets/new` URL.
- `client/src/pages/wizard/divisions.tsx` defines D3, D4, D6 Inspection, and Shop Fill surfaces.
- `client/src/pages/RentalReturnPage.tsx` is wired at `/rentals/return`.
- `SANDBOX.md` documents the sandbox on localhost:5174 and the sandbox QuickBooks Web Connector setup.
- `server/package.json` has Vitest for server tests; the client currently has build/lint scripts but no client test harness.
- `server/prisma/schema.prisma` has JSONB escape hatches for D4/D6 metadata, but no canonical tag model yet.

## Work That Remains

The current plan lives in [Service Pro workable rollout plan](../SERVICEPRO-WORKABLE-ROLLOUT-PLAN-2026-09-09.md). It is deliberately more practical than the August 28 PDF: do this, test this, poke here, add/delete this code.

The headline:

1. Enable pricebooks and prove customer rates in sandbox QuickBooks.
2. Run D4 through real billing flows in sandbox.
3. Relitigate D6 as a workflow design problem before building more D6 patches.
4. Smoke the four boards and freeze them.
5. Keep D4/D6 tagging as a scoped post-go-live code slice.

## Verdict

**Supersede the clean-DB/IP cutover ADR.** V2/current is already the production path. The rollout is now about proving billing in the sandbox and choosing a coherent D6 workflow before the team hardens or expands D6 code.
