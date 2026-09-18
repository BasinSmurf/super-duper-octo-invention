-- Phase C: rental dispatch becomes a distinct lifecycle phase from "active".
-- A rental is 'scheduled' once dispatch creates the contract; it auto-flips to
-- 'active' on read once start_date <= today (no cron — flipped lazily by the
-- /rentals endpoint).

ALTER TYPE "RentalStatus" ADD VALUE IF NOT EXISTS 'scheduled';

-- Phase C dispatch capture: who called it in + who created the contract.
-- Person Calling = customer-side requester (often the office that called).
-- createdById = our dispatcher (auto from logged-in user on submit).
ALTER TABLE "rental_agreements"
    ADD COLUMN IF NOT EXISTS "person_calling_name"  TEXT,
    ADD COLUMN IF NOT EXISTS "person_calling_phone" TEXT,
    ADD COLUMN IF NOT EXISTS "person_calling_email" TEXT,
    ADD COLUMN IF NOT EXISTS "created_by_id"        TEXT;

-- FK to users(id). Idempotent via constraint check.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'rental_agreements_created_by_id_fkey'
      AND table_name = 'rental_agreements'
  ) THEN
    ALTER TABLE "rental_agreements"
      ADD CONSTRAINT "rental_agreements_created_by_id_fkey"
      FOREIGN KEY ("created_by_id") REFERENCES "users"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END$$;
