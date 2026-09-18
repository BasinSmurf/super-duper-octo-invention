# ADR-0008 — QuickBooks integration boundary & the derive-from-work-records seam

- **Status:** Proposed
- **Date:** 2026-06-27
- **Principle flags:** ⚠️ This is the **QuickBooks-ledger-of-record** and **derive-from-work-records** principle made concrete. Verdict *confirms* it — no violation.

## Current state (file evidence)
- **QuickBooks Desktop via QBWC SOAP poll.** `routes/qbwc.ts` (1,748 lines — largest route file) + `services/qbxmlBuilder.ts` (931 lines). QBWC calls `authenticate → sendRequestXML → receiveResponseXML → closeConnection` against `http://192.168.0.213:3001/api/qbwc/soap` directly (bypasses Caddy, `PROD-TOPOLOGY.md`).
- **Queue = a Postgres table** (`QbSyncQueue`: entityType invoice/sales_order/sales_receipt/item/price_level, action add/query, status, retryCount≤3, priority-ordered dequeue). QBWC session state is an **in-memory map** keyed by ticket UUID, reaped at 30 min.
- **The seam:** invoices are **derived** from tickets/payments, then *posted* to QB append-only via the queue. Two posting modes per customer: `InvoiceAdd` (default) or opt-in `SalesOrderAdd` + a follow-up `InvoiceQuery` poll to detect SO→Invoice conversion (`Company.qbUsesSalesOrder`). Items + per-item price levels are pulled QB→app hourly (full refresh, no delta).
- Known gap (memory + README): **QB tax-item names** still need reconciling against real QB.

## Why it was likely chosen
QBWC is the *only* sanctioned way to talk to on-prem QuickBooks Desktop without a SaaS bridge — it fits the on-prem principle perfectly. A Postgres-backed queue (rather than BullMQ) keeps the dependency surface small and survives restarts. The derive-then-post design is a deliberate, correct expression of "QB is the ledger; ServicePRO holds the conditional billing logic."

## The case to replace / change
- **The seam itself: nothing to replace — it is clean** (the discovery sweep confirmed: invoices are never authored from QB data; QB is write-target + catalog-source only). This is the architecture working as intended.
- **The implementation has two real issues:**
  1. **`qbwc.ts` at 1,748 lines** concentrates session lifecycle + priority dispatch + multi-path response parsing + retry/recovery in one file — change-risky, untested.
  2. **In-memory QBWC session map is a split hazard** ([ADR-0006](ADR-0006-container-topology.md)): a poll cycle spanning two API instances would corrupt session tracking. QBWC must be pinned to one instance or its session state moved to Postgres/Redis.
- The hourly **full** item/price-level refresh should become a `fromModifiedDate` delta (the code comments already flag this as future work).

## The case to keep
- The Postgres-queue + poll model is robust, restart-safe, and on-prem-pure. Do not move it to a hosted iPaaS or a different queue tech.
- Two posting modes exist because real customers' QB comptrollers work differently — that's domain truth, not accidental complexity.

## Migration cost / risk / effort
- **Seam:** keep as-is. **Verdict-confirming, zero cost.**
- **Refactor `qbwc.ts`** into {session, dispatch, response-handlers, builders}: Medium, after a test harness ([ADR-0001](ADR-0001-ci-source-split-and-observability.md)). The qbXML element-order sensitivity (memory: out-of-order → `0x80040400`) makes this **high-risk without golden-file tests** — write those first.
- **Split-safety** (session state off in-memory): Medium; required before multi-instance.
- **Tax-item-name reconcile + delta item pull:** Low-Medium, independent of mk2.

## Verdict: **KEEP** the boundary (it's correct); **REPLACE-LATER** the internals (decompose `qbwc.ts`, split-safe the session, delta the pulls).
> The derive-from-work-records seam is load-bearing-and-correct — confirmed, leave the design alone. The work is internal: golden-file tests around qbXML ordering first, then decompose the 1,748-line file and move QBWC session state out of process memory before the API splits.
