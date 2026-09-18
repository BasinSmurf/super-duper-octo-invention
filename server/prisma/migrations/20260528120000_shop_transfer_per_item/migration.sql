-- Per-item shop transfers: link each transfer event to the specific items it moves.
CREATE TABLE "shop_transfer_event_items" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,
    CONSTRAINT "shop_transfer_event_items_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "shop_transfer_event_items_event_id_item_id_key" ON "shop_transfer_event_items"("event_id", "item_id");
CREATE INDEX "shop_transfer_event_items_item_id_idx" ON "shop_transfer_event_items"("item_id");

ALTER TABLE "shop_transfer_event_items" ADD CONSTRAINT "shop_transfer_event_items_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "shop_transfer_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "shop_transfer_event_items" ADD CONSTRAINT "shop_transfer_event_items_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "shop_work_order_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: existing events were whole-WO transfers. Link each to every
-- top-level item of its work order so the new per-item logic treats legacy
-- transfers (and any still-open ones) as "all items".
INSERT INTO "shop_transfer_event_items" ("id", "event_id", "item_id")
SELECT gen_random_uuid()::text, e."id", i."id"
FROM "shop_transfer_events" e
JOIN "shop_work_order_items" i
  ON i."work_order_id" = e."work_order_id"
 AND i."parent_item_id" IS NULL;
