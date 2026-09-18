-- Rentals board kiosks, per site and per pickup type.
--
-- Two new kiosk roles. The rentals kanban splits the way the shop board does
-- (BOARD/INHOUSE): by what the device is FOR, not by what it can render. A
-- dispatcher's wall wants the jobs Basin delivers; the counter wants the gear
-- customers carry out themselves. The split axis already exists on the
-- agreement as pickup_type, so no new classification is invented here.
ALTER TYPE "KioskRole" ADD VALUE IF NOT EXISTS 'RENTALS_DISPATCH';
ALTER TYPE "KioskRole" ADD VALUE IF NOT EXISTS 'RENTALS_WALKIN';

-- A rental needs a shop before a per-site board can mean anything: the site is
-- where the gear leaves from and comes back to. Nullable, because agreements
-- written before this column have no honest answer.
ALTER TABLE "rental_agreements" ADD COLUMN IF NOT EXISTS "site_id" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'rental_agreements_site_id_fkey'
  ) THEN
    ALTER TABLE "rental_agreements"
      ADD CONSTRAINT "rental_agreements_site_id_fkey"
      FOREIGN KEY ("site_id") REFERENCES "sites"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "rental_agreements_site_id_pickup_type_idx"
  ON "rental_agreements" ("site_id", "pickup_type");

-- Backfill: the creating dispatcher's home site is the only evidence on record
-- of which shop ran a given rental. Agreements with no creator, or a creator
-- with no home site, are deliberately left NULL rather than defaulted to a
-- site they may have nothing to do with -- those surface under "Unassigned" on
-- the in-app board, where a human can place them.
UPDATE "rental_agreements" ra
   SET "site_id" = u."home_site_id"
  FROM "users" u
 WHERE ra."created_by_id" = u."id"
   AND ra."site_id" IS NULL
   AND u."home_site_id" IS NOT NULL;
