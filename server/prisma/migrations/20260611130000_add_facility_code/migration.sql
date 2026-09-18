-- Facility code by-well and by-pad (all Enverus customers).
-- Per-location FC facility code that auto-flows onto the Enverus receipt's
-- buyer "Facility Property" additional-data field. facility_code_adf_key on the
-- billing profile names which ADF entry receives it.
ALTER TABLE "pads"  ADD COLUMN IF NOT EXISTS "facility_code" TEXT;
ALTER TABLE "wells" ADD COLUMN IF NOT EXISTS "facility_code" TEXT;
ALTER TABLE "customer_billing_profiles" ADD COLUMN IF NOT EXISTS "facility_code_adf_key" TEXT;
