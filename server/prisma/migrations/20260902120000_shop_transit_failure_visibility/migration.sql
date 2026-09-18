-- A requested auto-transit that could not be honored stops being silent.
--
-- THE BUG: a field-inspection spawn names its destination shop by short code
-- (the tech's "return to shop" pick, sent as `transitToShortCode`). The intake
-- helper looked that code up and, if it resolved to nothing or to a
-- deactivated Site, created the work order and simply skipped the
-- ShopTransferEvent. No event means no open transfer, and the shop wall
-- board's Incoming column is driven ENTIRELY by open transfers -- so the gear
-- the tech handed off never appeared as inbound anywhere, no error was raised,
-- and nobody found out until somebody went looking for it.
--
-- WHY COLUMNS AND NOT A NOTE: the question worth asking is "is anything
-- stranded right now", and that is a question ACROSS work orders. Appended to
-- intake_notes it would be unqueryable prose; these columns let the Ops
-- Dashboard count the miss. transit_failed_reason is an enum rather than free
-- text so the count can be grouped by cause -- a bad short code on a device is
-- a client bug, a deactivated Site is an admin action, and they get fixed by
-- different people.
--
-- WHY NOT HARD-FAIL INSTEAD: the only producer of transitToShortCode is the
-- ticket wizard, which queues the work order as an offline mutation and
-- replays it through /sync/push whether or not the device is online. A 400
-- there dead-letters the mutation, stranding the entire work order and every
-- item on it because of a TRANSIT problem. Warn-and-create loses nothing.

CREATE TYPE "ShopTransitFailureReason" AS ENUM ('unknown_short_code', 'site_inactive');

ALTER TABLE "shop_work_orders"
  ADD COLUMN "transit_failed_short_code" TEXT,
  ADD COLUMN "transit_failed_reason"     "ShopTransitFailureReason",
  ADD COLUMN "transit_failed_at"         TIMESTAMP(3);

-- The Ops Dashboard's actionable set is "failed AND still never transited",
-- which filters on this column first.
CREATE INDEX "shop_work_orders_transit_failed_reason_idx"
  ON "shop_work_orders"("transit_failed_reason");

-- All three are one fact recorded in three places, so the database keeps them
-- coherent rather than trusting every future writer to set the full set. A row
-- carrying a reason with no short code could not tell an admin WHAT the tech
-- picked, which is the only part of the record that leads to a fix.
ALTER TABLE "shop_work_orders"
  ADD CONSTRAINT "shop_wo_transit_failure_is_whole"
  CHECK (
    ("transit_failed_reason" IS NULL
      AND "transit_failed_short_code" IS NULL
      AND "transit_failed_at" IS NULL)
    OR ("transit_failed_reason" IS NOT NULL
      AND "transit_failed_short_code" IS NOT NULL
      AND length(btrim("transit_failed_short_code")) > 0
      AND "transit_failed_at" IS NOT NULL)
  );
