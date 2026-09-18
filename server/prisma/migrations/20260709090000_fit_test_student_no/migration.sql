-- Fit-test student number: TRT<year>-<seq>, the card's printed verify_id /
-- lookup ref back into Sundog. Minted from this sequence on first BlueLion
-- push and persisted, so re-pushes and card reprints keep the same number.

CREATE SEQUENCE IF NOT EXISTS "fit_test_student_no_seq" START 1;

ALTER TABLE "fit_test_records"
  ADD COLUMN "student_no" TEXT;

CREATE UNIQUE INDEX "fit_test_records_student_no_key" ON "fit_test_records"("student_no");
