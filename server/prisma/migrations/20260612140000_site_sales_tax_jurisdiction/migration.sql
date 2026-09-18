-- Per-shop sales tax jurisdiction. Shop work-order invoices are received at
-- the intake shop, so they default to the shop's own jurisdiction (e.g.
-- Dickinson shop → Stark, Williston shop → Williston) rather than ND state.
ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "sales_tax_jurisdiction_id" TEXT;
