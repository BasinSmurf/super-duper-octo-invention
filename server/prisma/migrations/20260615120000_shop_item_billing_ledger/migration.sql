-- ShopWork refactor (Wave 2): per-unit billing ledger.
-- Billing decouples from WO close — a unit bills when IT settles. billed_at marks
-- a unit as swept onto a billing ticket (the idempotent bill-ready sweep skips
-- units that already have it); billed_ticket_id is an audit pointer to that
-- ServiceTicket (plain id, not an FK). Additive only.
ALTER TABLE "shop_work_order_items"
  ADD COLUMN IF NOT EXISTS "billed_at"        TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "billed_ticket_id" TEXT;
