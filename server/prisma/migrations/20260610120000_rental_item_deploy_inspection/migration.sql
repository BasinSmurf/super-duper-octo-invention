-- #19/#20 Deploy QA gate: per-unit inspection captured when gear is added to a job
ALTER TABLE "rental_agreement_items" ADD COLUMN IF NOT EXISTS "deploy_inspection" JSONB;
