-- Multi-Site Expansion · Phase 5 — two-phase inter-site transfers.
--
-- A transfer is now initiate → in-transit → receive. While transit_to_site_id
-- is set the WO is "leaving but not yet received"; shop_transfer_events rows
-- carry a received_at that is NULL until the destination confirms arrival.

ALTER TABLE "shop_work_orders"
    ADD COLUMN "transit_to_site_id" TEXT,
    ADD COLUMN "transit_initiated_at" TIMESTAMP(3),
    ADD COLUMN "transit_initiated_by_id" TEXT;

ALTER TABLE "shop_transfer_events"
    ADD COLUMN "received_at" TIMESTAMP(3),
    ADD COLUMN "received_by_id" TEXT;

-- Pre-Phase-5 transfer events were instantaneous (the Wave 2 model) — there
-- was no in-transit state. Mark them all as already received so they don't
-- show up as stale open transfers.
UPDATE "shop_transfer_events"
   SET "received_at" = "transferred_at",
       "received_by_id" = "transferred_by_id"
 WHERE "received_at" IS NULL;

CREATE INDEX "shop_work_orders_transit_to_site_id_idx" ON "shop_work_orders"("transit_to_site_id");
CREATE INDEX "shop_transfer_events_received_at_idx" ON "shop_transfer_events"("received_at");

ALTER TABLE "shop_work_orders" ADD CONSTRAINT "shop_work_orders_transit_to_site_id_fkey"
    FOREIGN KEY ("transit_to_site_id") REFERENCES "sites"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "shop_work_orders" ADD CONSTRAINT "shop_work_orders_transit_initiated_by_id_fkey"
    FOREIGN KEY ("transit_initiated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "shop_transfer_events" ADD CONSTRAINT "shop_transfer_events_received_by_id_fkey"
    FOREIGN KEY ("received_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
