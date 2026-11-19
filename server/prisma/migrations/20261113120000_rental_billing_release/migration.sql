-- Rental "send for billing".
--
-- An active rental used to sit in AR's Ready queue from the day it opened.
-- Now a field supervisor sends it, which stamps billing_released_through; the
-- rental is in the queue only while that date is ahead of what has been
-- invoiced. Closed rentals need no stamp (closing is the send).

ALTER TABLE "rental_agreements"
  ADD COLUMN "billing_released_through" DATE,
  ADD COLUMN "billing_released_at" TIMESTAMP(3),
  ADD COLUMN "billing_released_by_id" TEXT,
  ADD COLUMN "billing_release_force_reason" TEXT;

ALTER TABLE "rental_agreements"
  ADD CONSTRAINT "rental_agreements_billing_released_by_id_fkey"
  FOREIGN KEY ("billing_released_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Cutover. Without this, every active rental would vanish from AR's queue the
-- moment this deploys. Stamp what is already due: any active rental with
-- unbilled days on or before the last completed month-end is released through
-- that month-end. Rentals that opened in the current month start unsent.
-- No released_by: nobody clicked, the migration did.
UPDATE "rental_agreements" ra
SET "billing_released_through" = m.eom,
    "billing_released_at" = NOW()
FROM (
  SELECT (date_trunc('month', NOW() AT TIME ZONE 'America/Chicago') - INTERVAL '1 day')::date AS eom
) m
WHERE ra."status" = 'active'
  AND ra."start_date" <= m.eom
  AND NOT EXISTS (
    SELECT 1 FROM "invoices" i
    WHERE i."rental_agreement_id" = ra."id"
      AND i."status" <> 'void'
      AND i."period_end" >= m.eom
  );
