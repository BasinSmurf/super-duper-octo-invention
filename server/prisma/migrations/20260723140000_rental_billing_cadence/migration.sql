-- Billing cadence (how often to invoice) is distinct from billing rate type
-- (the per-period price). Defaults to monthly, the common case.
ALTER TABLE "rental_agreements" ADD COLUMN "billing_cadence" "RentalRateType" NOT NULL DEFAULT 'monthly';
ALTER TABLE "rental_agreements" ADD COLUMN "last_bill_ready_notified_for" DATE;
