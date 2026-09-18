-- BlueLion Occ Health push (#18). Purely additive:
--   - new BlueLionEntityType values for the two certs a FitTestRecord can yield
--   - person-id tracking columns on fit_test_records (per-cert event seqs stay
--     on the queue rows, since one record can produce FIT-TEST + AUDIO)

-- AlterEnum
ALTER TYPE "BlueLionEntityType" ADD VALUE IF NOT EXISTS 'fit_test';
ALTER TYPE "BlueLionEntityType" ADD VALUE IF NOT EXISTS 'audiometric';

-- AlterTable
ALTER TABLE "fit_test_records"
  ADD COLUMN "bluelion_person_id" TEXT,
  ADD COLUMN "bluelion_synced_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "fit_test_records_employee_name_bluelion_person_id_idx" ON "fit_test_records"("employee_name", "bluelion_person_id");
