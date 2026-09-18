-- #13 Training QR self-sign-in: students sign on their phone; signature +
-- timestamp land on their roster row.
ALTER TABLE "training_roster_records" ADD COLUMN IF NOT EXISTS "participant_signature" TEXT;
ALTER TABLE "training_roster_records" ADD COLUMN IF NOT EXISTS "signed_at" TIMESTAMP(3);
