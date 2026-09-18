-- Multi-Site Expansion · Phase 1 — Sites foundation.
--
-- Adds the Site entity and the FK columns that anchor shop work to a
-- physical Basin Safety location. Existing rows predate the multi-site
-- world, so they all backfill to Williston (the only site that existed).
--
-- NOTE FOR PROD DEPLOY: this migration auto-backfills every existing
-- shop work order + item to Williston. That assumption still needs Alex's
-- sign-off (master doc §12 Q1) before this runs against production data.

-- Site: a Basin Safety physical service location.
CREATE TABLE "sites" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "short_code" TEXT NOT NULL,
    "address" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'America/Chicago',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "sites_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "sites_short_code_key" ON "sites"("short_code");

-- Seed the founding site. The satellite shop gets added through
-- Settings -> Sites once its name + short code are confirmed.
INSERT INTO "sites" ("id", "name", "short_code", "timezone", "active", "created_at", "updated_at")
VALUES ('51700000-0000-4000-8000-000000000001', 'Williston', 'WIL', 'America/Chicago', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- New FK columns added nullable so the ALTER survives existing rows.
ALTER TABLE "users" ADD COLUMN "home_site_id" TEXT;
ALTER TABLE "shop_work_orders" ADD COLUMN "intake_site_id" TEXT;
ALTER TABLE "shop_work_order_items" ADD COLUMN "site_id" TEXT;

-- Backfill existing shop data to Williston.
UPDATE "shop_work_orders" SET "intake_site_id" = '51700000-0000-4000-8000-000000000001' WHERE "intake_site_id" IS NULL;
UPDATE "shop_work_order_items" SET "site_id" = '51700000-0000-4000-8000-000000000001' WHERE "site_id" IS NULL;
-- users.home_site_id is intentionally left NULL — home sites are reviewed
-- and assigned per-user in user admin, not blanket-defaulted.

-- Lock the shop-side columns to NOT NULL now that they are backfilled.
ALTER TABLE "shop_work_orders" ALTER COLUMN "intake_site_id" SET NOT NULL;
ALTER TABLE "shop_work_order_items" ALTER COLUMN "site_id" SET NOT NULL;

-- Foreign keys. Sites are soft-deleted, never hard-deleted, so RESTRICT
-- on the shop-side columns is a belt-and-suspenders guard.
ALTER TABLE "users" ADD CONSTRAINT "users_home_site_id_fkey"
    FOREIGN KEY ("home_site_id") REFERENCES "sites"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "shop_work_orders" ADD CONSTRAINT "shop_work_orders_intake_site_id_fkey"
    FOREIGN KEY ("intake_site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shop_work_order_items" ADD CONSTRAINT "shop_work_order_items_site_id_fkey"
    FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
