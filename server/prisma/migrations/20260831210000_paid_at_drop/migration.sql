-- WI-08: monitor cal gets paid at the counter, and the money reaches QuickBooks
-- without anybody re-keying it.
--
-- Three things here, and the third is a bug fix that predates this batch.
--
-- 1. WHERE THE PAYMENT CAME FROM, on the work order. Deliberately only the ROUTE.
--    How much was collected is NOT stored -- it is summed from the payments
--    table, so a refund, a second payment, or work added after the customer
--    paid cannot leave a stale figure on the order contradicting the money.
--    Exemption from billing is therefore derived, and an order that grows past
--    what was paid becomes billable again on its own, for the delta, with no
--    flag for anyone to remember to clear.
--
-- 2. THE STRIPE EVENT LEDGER. Stripe retries a webhook until it gets a 2xx, so
--    a duplicate delivery is normal traffic rather than an incident. The event
--    id is the PRIMARY KEY: a replay collides at INSERT, which holds even when
--    two deliveries land on two API processes at once. A check-then-act in
--    application code would not.
--
-- 3. ONE SALES RECEIPT PER PAYMENT, enforced. See the partial unique index at
--    the bottom -- and the comment there, because it fixes something live.

CREATE TYPE "PaidAtDropMethod" AS ENUM ('stripe', 'lightspeed');

-- On the WORK ORDER, not the ticket. Monitor calibration is shop work: it
-- arrives as a shop_work_order_item with service_type = 'calibrate'. There is
-- no monitor-cal ticket type, and the counter this feature is about is the shop
-- intake counter.
ALTER TABLE "shop_work_orders"
  ADD COLUMN "paid_at_drop_via"      "PaidAtDropMethod",
  ADD COLUMN "lightspeed_txn_number" TEXT;

CREATE TABLE "stripe_webhook_events" (
  "id"           TEXT NOT NULL,
  "type"         TEXT NOT NULL,
  "received_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processed_at" TIMESTAMP(3),
  "error"        TEXT,
  "payment_id"   TEXT,
  CONSTRAINT "stripe_webhook_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "stripe_webhook_events_processed_at_idx"
  ON "stripe_webhook_events"("processed_at");

-- ── One QB sales receipt per payment ───────────────────────────────────────
--
-- THIS FIXES A LIVE BUG, not just a WI-08 requirement.
--
-- POST /api/payments/:id/confirm and POST /api/payments/cash both create a
-- qb_sync_queue row unconditionally. Nothing stops either being called twice --
-- a double-clicked button, a retried request, a tech tapping again because the
-- spinner looked stuck -- and each call queues another `sales_receipt` for the
-- same payment. Two rows, two receipts, one payment, and the discrepancy shows
-- up in QuickBooks rather than in ServicePRO where somebody might notice.
--
-- WI-08 asks for exactly this guarantee for the Stripe webhook path. Enforcing
-- it at the table gets the pre-existing paths for free, which is the right
-- place for it: the alternative is remembering the check in three call sites
-- and every future one.
--
-- PARTIAL, because it is only true of sales receipts. Invoices and other entity
-- types legitimately queue more than once (an invoice is re-sent after edits),
-- and a blanket unique index would break them.
--
-- Existing duplicates are collapsed first, keeping the earliest row -- it is
-- the one most likely to have already been sent.
DELETE FROM "qb_sync_queue" q
WHERE q."entity_type" = 'sales_receipt'
  AND EXISTS (
    SELECT 1 FROM "qb_sync_queue" keep
    WHERE keep."entity_type" = 'sales_receipt'
      AND keep."entity_id" = q."entity_id"
      AND (keep."created_at" < q."created_at"
           OR (keep."created_at" = q."created_at" AND keep."id" < q."id"))
  );

CREATE UNIQUE INDEX "qb_sync_queue_one_sales_receipt_per_payment"
  ON "qb_sync_queue"("entity_id")
  WHERE "entity_type" = 'sales_receipt';
