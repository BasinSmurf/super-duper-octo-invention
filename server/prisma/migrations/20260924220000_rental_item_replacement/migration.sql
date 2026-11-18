ALTER TABLE "rental_agreement_items" ADD COLUMN "replaces_item_id" TEXT;
CREATE UNIQUE INDEX "rental_agreement_items_replaces_item_id_key"
ON "rental_agreement_items"("replaces_item_id");
