-- Remove Adobe Sign columns (IF EXISTS — columns may never have been created on prod)
ALTER TABLE "invoices" DROP COLUMN IF EXISTS "adobe_sign_agreement_id",
DROP COLUMN IF EXISTS "adobe_sign_completed_at",
DROP COLUMN IF EXISTS "adobe_sign_sent_at",
DROP COLUMN IF EXISTS "adobe_sign_status";

ALTER TABLE "service_tickets" DROP COLUMN IF EXISTS "adobe_sign_agreement_id",
DROP COLUMN IF EXISTS "adobe_sign_completed_at",
DROP COLUMN IF EXISTS "adobe_sign_sent_at",
DROP COLUMN IF EXISTS "adobe_sign_status";
