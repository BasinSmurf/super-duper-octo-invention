-- Per-buyer relabeled standard line fields on the billing profile.
-- defaultMajor / defaultMinor: auto-fill values for COP's "Activity Code" (major)
-- and "Functional Area" (minor) — standard Enverus line fields, editable per submit.
-- lineFieldLabels: UI-only display labels so the OT submit panel speaks the buyer's
-- vocabulary (afeNumber / costCenter / major / minor → label). Additive, nullable.
ALTER TABLE "customer_billing_profiles" ADD COLUMN IF NOT EXISTS "default_major" TEXT;
ALTER TABLE "customer_billing_profiles" ADD COLUMN IF NOT EXISTS "default_minor" TEXT;
ALTER TABLE "customer_billing_profiles" ADD COLUMN IF NOT EXISTS "line_field_labels" JSONB;
