-- Per-location buyer cost code (COP "Cost Object"), mirrors facility_code.
ALTER TABLE "pads" ADD COLUMN "cost_center" TEXT;
ALTER TABLE "wells" ADD COLUMN "cost_center" TEXT;

-- Billing profiles choose per field whether AFE / cost center are fixed or come from the well/pad.
CREATE TYPE "BillingFieldSource" AS ENUM ('fixed', 'location');
ALTER TABLE "customer_billing_profiles"
  ADD COLUMN "afe_number_source" "BillingFieldSource" NOT NULL DEFAULT 'fixed',
  ADD COLUMN "cost_center_source" "BillingFieldSource" NOT NULL DEFAULT 'fixed';
