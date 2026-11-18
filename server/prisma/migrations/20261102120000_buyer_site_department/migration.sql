-- Any billing profile can require / source the buyer's subcompany (Enverus site) and
-- remit-to department, and require a cost center, the same way as AFE and PO.
ALTER TABLE "customer_billing_profiles"
  ADD COLUMN "requires_cost_center" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "buyer_site_source" "BillingFieldSource" NOT NULL DEFAULT 'fixed',
  ADD COLUMN "requires_buyer_site" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "buyer_department_source" "BillingFieldSource" NOT NULL DEFAULT 'fixed',
  ADD COLUMN "default_buyer_department" TEXT,
  ADD COLUMN "requires_buyer_department" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "wells" ADD COLUMN "buyer_site_uuid" TEXT, ADD COLUMN "buyer_department" TEXT;
ALTER TABLE "pads" ADD COLUMN "buyer_site_uuid" TEXT, ADD COLUMN "buyer_department" TEXT;
ALTER TABLE "invoices" ADD COLUMN "buyer_site_uuid" TEXT, ADD COLUMN "buyer_department" TEXT;
