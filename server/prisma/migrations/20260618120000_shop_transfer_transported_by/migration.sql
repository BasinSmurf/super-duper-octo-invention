-- Shop transfer "Transported by": who physically moved the units, distinct from
-- the in-app initiator. Any active employee can be selected.
ALTER TABLE "shop_transfer_events" ADD COLUMN "transported_by_id" TEXT;

ALTER TABLE "shop_transfer_events"
  ADD CONSTRAINT "shop_transfer_events_transported_by_id_fkey"
  FOREIGN KEY ("transported_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
