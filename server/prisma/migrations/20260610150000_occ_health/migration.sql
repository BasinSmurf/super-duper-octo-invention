-- #10/#11 Occ Health: one roster where each person can have Fit Test, Audiometric, or both.
-- Audiometric result is baseline|retest. Attachments link per-person via fit_test_record_id
-- (loose TEXT link, no FK — records and attachments sync as independent mutations).
ALTER TABLE "fit_test_records" ADD COLUMN IF NOT EXISTS "includes_fit_test" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "fit_test_records" ADD COLUMN IF NOT EXISTS "includes_audiometric" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "fit_test_records" ADD COLUMN IF NOT EXISTS "audiometric_result" TEXT;
ALTER TABLE "ticket_attachments" ADD COLUMN IF NOT EXISTS "fit_test_record_id" TEXT;
