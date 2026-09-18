-- Bind rental BOMs to real QB items so customer price levels can reach them.
--
-- The invoice resolver matches price-level rules on qb_item_list_id, which only
-- exists on a Product. Baseline rows were category-only, so a BOM line could
-- never carry an MSA rate. Two nullable bindings fix that without touching any
-- existing row's behaviour:
--   customer_rental_boms.package_product_id  → the item the whole package bills as
--   customer_rental_bom_items.product_id     → the item an OVERAGE of that row bills as
-- Both nullable: unbound BOMs keep behaving exactly as they did (descriptive, $0).

ALTER TABLE "customer_rental_boms"
  ADD COLUMN "package_product_id" TEXT;

ALTER TABLE "customer_rental_bom_items"
  ADD COLUMN "product_id" TEXT;

ALTER TABLE "customer_rental_boms"
  ADD CONSTRAINT "customer_rental_boms_package_product_id_fkey"
  FOREIGN KEY ("package_product_id") REFERENCES "products"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "customer_rental_bom_items"
  ADD CONSTRAINT "customer_rental_bom_items_product_id_fkey"
  FOREIGN KEY ("product_id") REFERENCES "products"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "customer_rental_boms_package_product_id_idx"
  ON "customer_rental_boms"("package_product_id");

CREATE INDEX "customer_rental_bom_items_product_id_idx"
  ON "customer_rental_bom_items"("product_id");
