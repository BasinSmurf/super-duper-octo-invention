-- Rental package variants: a customer may hold several packages of one type.
--
-- The customer price sheet prices the same trailer more than one way —
-- "with monitors" vs "without", 10 PPM vs 100 PPM — and those prices aren't
-- additive (Continental unmanned: $300 incl. 2 monitors vs $200 bare + $75
-- add-on), so they can't be modelled as one package plus monitor overages.
-- Each variant is its own package bound to its own QB item, priced per
-- customer in QuickBooks. That needs the one-per-(company, type) unique gone.
--
--   name        → tells variants apart on the dispatch picker
--   is_default  → which variant dispatch preselects for its type

DROP INDEX IF EXISTS "customer_rental_boms_company_type_unique";

ALTER TABLE "customer_rental_boms"
  ADD COLUMN "name" TEXT,
  ADD COLUMN "is_default" BOOLEAN NOT NULL DEFAULT false;

-- Every existing package was the only one of its type, so it is the default.
UPDATE "customer_rental_boms" SET "is_default" = true;

CREATE INDEX "customer_rental_boms_company_id_bom_type_idx"
  ON "customer_rental_boms"("company_id", "bom_type");
