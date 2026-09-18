-- Add enverus_customer_uuid and buyer_field_rules to customer_billing_profiles
ALTER TABLE "customer_billing_profiles" ADD COLUMN "enverus_customer_uuid" TEXT;
ALTER TABLE "customer_billing_profiles" ADD COLUMN "buyer_field_rules" JSONB;
