-- Parts numbering by division: derived catalog facets on products.
-- New-scheme part numbers are 7-digit zero-padded strings encoding
-- DIVISION(2, 00-09) FAMILY(1) SUBGROUP(1) PART(3). A conforming number
-- therefore always starts with '0', which also separates it from legacy
-- numbers ("406", "11009"). Facets scope the catalog picker only; revenue
-- attribution (QB Class) stays on the ticket's division.
ALTER TABLE "products" ADD COLUMN "division" INTEGER;
ALTER TABLE "products" ADD COLUMN "part_family" INTEGER;
ALTER TABLE "products" ADD COLUMN "part_subgroup" INTEGER;

CREATE INDEX "products_division_idx" ON "products"("division");

-- Backfill any part numbers already in the new format.
UPDATE "products" SET
  "division"      = substring("part_number" from 1 for 2)::int,
  "part_family"   = substring("part_number" from 3 for 1)::int,
  "part_subgroup" = substring("part_number" from 4 for 1)::int
WHERE "part_number" ~ '^0[0-9]{6}$';
