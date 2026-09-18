-- Shop intake contact persons.
--
-- Two contacts captured at intake:
--   1. drop_off_contact_*  — person physically dropping equipment off
--   2. pickup_contact_*    — "who do we call when it's ready"
--
-- preferred = 'call' | 'text' | 'email'. Stored as plain text (no enum)
-- to keep parity with the rental contact fields and to stay easy to extend.
--
-- All columns nullable so the migration is non-breaking; the API + UI
-- enforce required-on-create going forward.

ALTER TABLE "shop_work_orders"
    ADD COLUMN IF NOT EXISTS "drop_off_contact_name"      TEXT,
    ADD COLUMN IF NOT EXISTS "drop_off_contact_phone"     TEXT,
    ADD COLUMN IF NOT EXISTS "drop_off_contact_email"     TEXT,
    ADD COLUMN IF NOT EXISTS "drop_off_contact_preferred" TEXT,
    ADD COLUMN IF NOT EXISTS "pickup_contact_name"        TEXT,
    ADD COLUMN IF NOT EXISTS "pickup_contact_phone"       TEXT,
    ADD COLUMN IF NOT EXISTS "pickup_contact_email"       TEXT,
    ADD COLUMN IF NOT EXISTS "pickup_contact_preferred"   TEXT;
