-- #14/#16/#17 Fit test: Full Face APR/SAR class, MEQ Current date, second mask
ALTER TABLE "fit_test_records" ADD COLUMN IF NOT EXISTS "respirator_class" TEXT;
ALTER TABLE "fit_test_records" ADD COLUMN IF NOT EXISTS "meq_date" DATE;
ALTER TABLE "fit_test_records" ADD COLUMN IF NOT EXISTS "second_mask" JSONB;
