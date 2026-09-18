-- Add buyer-specific additional data fields to billing profiles
-- Used for COP Safety: Facility Property, Cost Object, Activity Code, Functional Area
ALTER TABLE "customer_billing_profiles"
  ADD COLUMN IF NOT EXISTS "default_additional_data_fields" JSONB;
