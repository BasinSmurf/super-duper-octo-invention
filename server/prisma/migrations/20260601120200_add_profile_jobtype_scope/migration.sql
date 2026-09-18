-- #4 Job-type scoping for customer billing profiles.
-- Additive, nullable JSONB string-arrays. NULL/empty = unscoped company-wide
-- default → existing rows behave exactly as today until admins scope them.
ALTER TABLE "customer_billing_profiles"
  ADD COLUMN "applies_to_ticket_types" JSONB,
  ADD COLUMN "applies_to_divisions"    JSONB;
