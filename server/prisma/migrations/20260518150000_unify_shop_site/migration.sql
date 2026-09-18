-- Multi-Site Expansion — unify the Wave 2 BasinShop enum onto the Site table.
--
-- Site (the table) becomes the single model for "which Basin shop." The Wave 2
-- BasinShop enum, the shop_work_orders.origin_shop column, and the
-- shop_transfer_events from/to enum columns are all migrated onto Site FKs.

-- Seed the Dickinson satellite (Williston was seeded in 20260518120000).
INSERT INTO "sites" ("id", "name", "short_code", "timezone", "active", "created_at", "updated_at")
VALUES ('51700000-0000-4000-8000-000000000002', 'Dickinson', 'DIC', 'America/Chicago', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

-- Correct intake_site_id for WOs received at Dickinson. 20260518120000
-- backfilled every WO to Williston before origin_shop was reconciled.
UPDATE "shop_work_orders"
   SET "intake_site_id" = '51700000-0000-4000-8000-000000000002'
 WHERE "origin_shop" = 'dickinson';

-- shop_transfer_events: BasinShop enum columns -> Site FK columns.
ALTER TABLE "shop_transfer_events" ADD COLUMN "from_site_id" TEXT;
ALTER TABLE "shop_transfer_events" ADD COLUMN "to_site_id" TEXT;

UPDATE "shop_transfer_events"
   SET "from_site_id" = CASE "from_shop"
         WHEN 'dickinson' THEN '51700000-0000-4000-8000-000000000002'
         ELSE '51700000-0000-4000-8000-000000000001' END,
       "to_site_id" = CASE "to_shop"
         WHEN 'dickinson' THEN '51700000-0000-4000-8000-000000000002'
         ELSE '51700000-0000-4000-8000-000000000001' END;

ALTER TABLE "shop_transfer_events" ALTER COLUMN "from_site_id" SET NOT NULL;
ALTER TABLE "shop_transfer_events" ALTER COLUMN "to_site_id" SET NOT NULL;

ALTER TABLE "shop_transfer_events" ADD CONSTRAINT "shop_transfer_events_from_site_id_fkey"
    FOREIGN KEY ("from_site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shop_transfer_events" ADD CONSTRAINT "shop_transfer_events_to_site_id_fkey"
    FOREIGN KEY ("to_site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "shop_transfer_events" DROP COLUMN "from_shop";
ALTER TABLE "shop_transfer_events" DROP COLUMN "to_shop";

-- Drop the redundant origin_shop column (replaced by intake_site_id).
ALTER TABLE "shop_work_orders" DROP COLUMN "origin_shop";

-- BasinShop enum is no longer referenced by any column.
DROP TYPE "BasinShop";
