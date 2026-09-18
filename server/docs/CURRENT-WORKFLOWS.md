# Current ServicePRO workflows

Reviewed **2026-09-17**, committed baseline **45b3d44**, including late-August
and September changes. This describes repository behavior; check the deployed
tag for production release status. The final section records uncommitted work
present in this checkout today, separately from the committed baseline.

## Tickets and locations

Start at `/tickets/start` for division-first entry. The shell hands work types
to `/tickets/new`; that direct route and ticket editing still exist. D3 Air has
a subtype picker; new installs can record multiple air systems. Shop and direct
sales hand off to dedicated screens.

Locations can be pads **or standalone wells**. A well does not need an invented
pad for selection, route stops, or coverage. DMR activation resolves the operator;
API-number identity supports authoritative well naming and import deduplication.
Rejected requests stay rejected; matched requests retain their resolved well.
Tier 1 evaluation includes well-only locations.

Abandoned local wizard drafts are pruned; empty abandoned drafts are not durable
job records. Technician ownership is retained when saving tickets. Inventory
mutations must use supported actions rather than arbitrary record writes.

## Shop boards and QA

Customer work is at `/shop-board`; Basin equipment is at `/shop-board/inhouse`.
Site routes also support `/boards/:siteSlug` and its `/inhouse` variant. Wall
columns are **Incoming, In Service, On Hold, Ready for Pickup, Departing**.
Intake, inspection, repair, and re-test are grouped in In Service. `qc_testing`
remains an item status, not a separate wall column. On Hold cards show a reason.
Wall displays omit aging/countdown noise; supervisors have dashboard widgets.

Required QA checkpoints must pass before a gated unit becomes `shop_complete`.
Individual inspections or batch QA can satisfy the gate. Offline replay with
incomplete QA preserves the submitted work but diverts the unit to `qc_testing`,
with a reason in its status log. Condemnation requires evidence.

Reaching `shop_complete`, `returned`, or `condemned` starts a **48 wall-clock hour
correction window**. During it, the closing tech or a supervisor can correct the
unit under the edit rules. It is not yet billable or eligible for its final
Vault push. `hardClosesAt` determines finality; database guards enforce it.
Reopening requires the authorized path and a reason.

The hard-close worker materializes batch QA and queues eligible inspections and
evidence. Billing reads the deadline directly, independently of the worker.
A locked shop inspection alone does not bypass that window or prove delivery.

## Vendor returns, evidence, and charges

Receive Back records one of `warranty`, `pass_thru_repair`, `no_charge`, or
`internal`. Only `pass_thru_repair` bills the customer. Attach a durable vendor
invoice; warranty returns may instead use a packing slip. Wait for upload
acknowledgement before receiving the unit.

Billable vendor work offers **pass-through** (the keyed invoice total) or
**catalog service** (active service, quantity, rate). Catalog service replaces
the vendor pass-through charge rather than duplicating it. Vendor cost remains
recorded; billing notes are context and never parsed into amounts. Ticket/vendor
paperwork is separate from serial-level equipment evidence sent to VaultPRO.

Review unit and order charges together before closing. Catalog services selected
in QA link service actions and billing charges. Parts use catalog selling prices;
labor, services, vendor charges, mileage, and misc remain distinct. Preview and
invoice generation share pricing logic, but preview can include unfinished work.

Customer shop orders invoice **directly from the closed work order** via
`POST /api/invoices/generate/from-shop-wo`, without an intermediate repair ticket.
Check unit hard-close deadlines as well as WO status. Warranty and nonbillable
vendor dispositions are excluded; internal orders do not generate customer
invoices. Condemnation can still carry inspection charges.

## Rentals and billing

Selecting a dispatched rental carries its customer and site into the deployment
ticket. Record actual equipment and partial returns: billing uses the dates
equipment was out rather than charging every unit for the whole agreement period.
Walk-in pickup does not acquire a delivery charge merely because dispatch rentals have one.

Daily logs stay attached to the rental. Explicit manual daily rates, including
zero, are honored; blank and zero differ. Check period, deploy/return dates, rate
source, and daily logs when totals look wrong. Rental invoices retain source
`rental_agreement`; linked tickets supply QuickBooks header context where
available. Review PO/AFE/location and other required fields before queueing.

Rental kiosks support dispatch and walk-in views per site. Roles
`RENTALS_DISPATCH` and `RENTALS_WALKIN` determine filters on the server.

QuickBooks sync and Enverus submission are separate stages. Enverus status
polling runs within queue processing; successful upload does not prove buyer
acceptance. Billing Attention and Billing Lineage help trace missing charges.

## Customer portal

Customers use normal login and land at `/portal`. Admins assign the `customer`
role and company; access is read-only and company-scoped.

| Route | View |
|---|---|
| `/portal` | Summary and recent activity |
| `/portal/service` | Service/testing history and CSV export |
| `/portal/h2s` | H₂S history, trends, and location comparison |
| `/portal/shop` | Shop progress |
| `/portal/rentals` | Rental agreements |
| `/portal/account` | Account/company information |
| `/portal/tickets/:id` | An allowed ticket's detail |

The API re-resolves the active user/company on requests. `platform_admin` can
preview a selected company using `previewCompanyId` or
`x-portal-preview-company-id`; ordinary staff are redirected to the dashboard.
Customers cannot use that selector to cross company boundaries.

## Source references

- [App.tsx](../../client/src/App.tsx), [portal.ts](../src/routes/portal.ts).
- [shopQaGate.ts](../src/services/shopQaGate.ts), [shopSoftClose.ts](../src/services/shopSoftClose.ts), [shopHardCloseSweep.ts](../src/services/shopHardCloseSweep.ts).
- [shopVendorReceive.ts](../src/services/shopVendorReceive.ts), [shopVendorReceiveBilling.ts](../src/services/shopVendorReceiveBilling.ts).
- [shopChargePreview.ts](../src/services/shopChargePreview.ts), [shopBillingLines.ts](../src/services/shopBillingLines.ts).
- [mk2](../../mk2/) contains decisions and proposals; historical inventories and target-state documents are not current runbooks.

## Local work present on September 17 (uncommitted)

These changes are implemented in the working tree but were not committed or
verified as deployed during this documentation pass.

- **Close shop WOs without billing:** Billing has a review/selection dialog,
  requires a reason, and uses `shop_orders:waive_billing` (default: platform admin).
  The transaction retains work history, marks the waiver, voids eligible local
  invoices, skips unsent QB jobs, cancels pending signatures, and closes related
  legacy tickets as not billable. Payments, external billing history, mixed
  invoices, or unfinished shop work block the operation. It does not reverse QB
  transactions. Waivers are respected by ready lists, invoice generation, sync,
  and QB sending; they are stored in existing JSON/audit structures, with no new migration.
- **Internal Shop — Retail Value:** a dashboard report for completed/closed
  internal work, gated by `reports:financial`. Default Boss/Admin layouts include
  it; customized layouts require adding it. Boss, Billing AR and Platform Admin
  can select the widget. Values are current retail estimates, not revenue or
  actual internal cost. It creates no invoices, payments or sync jobs.
- **Overnight on-site logs:** entries carry dates as well as times; the wizard
  derives the window from full timestamps and rental log display sorts them.
  Legacy entries use the service/log date. This avoids ordering after-midnight
  entries before the prior evening.
- **Field inspection entry:** the fixed inspection service is derived for new
  entries, restored drafts and edits. Who/Where validation reports the missing
  customer, location, charge path or service choice.
- **V2 surface mockup:** `client/src/pages/V2SurfaceMockupPage.tsx` exists locally
  but is not registered in `App.tsx`; it is not an available application route.

The local ADR-0016 and September 9 rollout plan already supersede the old
clean-DB/IP handoff and record an owner update that production uses the current
V2 surface. Do not revive that cutover plan. Their September 10 pricebook target
is a historical target, not evidence of enablement; current rollout acceptance
still requires actual environment checks.
