-- AddFitTestDisclosureFields
-- These fields were added directly to the database; this migration catches up the migration history.

ALTER TABLE "fit_test_records" ADD COLUMN IF NOT EXISTS "job_title" TEXT;
ALTER TABLE "fit_test_records" ADD COLUMN IF NOT EXISTS "disclosure_conditions" JSONB;
ALTER TABLE "fit_test_records" ADD COLUMN IF NOT EXISTS "is_clean_shaven" BOOLEAN;
ALTER TABLE "fit_test_records" ADD COLUMN IF NOT EXISTS "wears_glasses_contacts" BOOLEAN;
ALTER TABLE "fit_test_records" ADD COLUMN IF NOT EXISTS "adverse_reactions" JSONB;
ALTER TABLE "fit_test_records" ADD COLUMN IF NOT EXISTS "criteria_acknowledged" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "fit_test_records" ADD COLUMN IF NOT EXISTS "participant_signature" TEXT;
ALTER TABLE "fit_test_records" ADD COLUMN IF NOT EXISTS "meq_accepted" BOOLEAN NOT NULL DEFAULT false;
