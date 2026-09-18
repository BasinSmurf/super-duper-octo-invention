-- Wave 5 5C — admin-assigned PriceLevel per customer (option B).
--
-- companies.qb_price_level_id  — FK to price_levels.id. Many → one allowed
--                                (a single price level can be shared across
--                                multiple customers). Independent of QB's
--                                CustomerRef PriceLevelRef so admins can
--                                override + so the apply path works without
--                                a customer pull from QB.

ALTER TABLE "companies"
    ADD COLUMN IF NOT EXISTS "qb_price_level_id" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'companies_qb_price_level_id_fkey'
      AND table_name = 'companies'
  ) THEN
    ALTER TABLE "companies"
      ADD CONSTRAINT "companies_qb_price_level_id_fkey"
      FOREIGN KEY ("qb_price_level_id") REFERENCES "price_levels"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS "companies_qb_price_level_idx"
    ON "companies" ("qb_price_level_id");
