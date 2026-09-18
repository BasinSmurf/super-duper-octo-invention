-- Walk-in vs dispatch rentals.
--
-- Existing rows are dispatch (Basin delivered, services on site, daily logs
-- expected). Walk-ins are counter transactions: customer signs the liability
-- waiver at pickup, equipment goes out immediately, no Pad/Location, no
-- daily-log expectation. Pickup type drives detail-page UI + the new
-- in-progress rentals dashboard slicing.

-- Create enum type idempotently
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'RentalPickupType') THEN
    CREATE TYPE "RentalPickupType" AS ENUM ('dispatch', 'walk_in');
  END IF;
END$$;

ALTER TABLE "rental_agreements"
    ADD COLUMN IF NOT EXISTS "pickup_type" "RentalPickupType" NOT NULL DEFAULT 'dispatch';

CREATE INDEX IF NOT EXISTS "rental_agreements_pickup_type_idx"
    ON "rental_agreements" ("pickup_type");
