-- Wave 2 — Shop intake/transfer foundation.
-- See project_inspection_forms_and_transfers.md for full design context.
--
-- This migration adds:
--   1. BasinShop enum — Williston | Dickinson; enum-extensible.
--   2. ShopWorkOrder.origin_shop — which Basin shop received intake.
--      Defaults to 'williston' so existing rows backfill cleanly.
--   3. ShopWorkOrder.source_location_id + return_location_id — optional FK to
--      Pad. Source captures field-tech-picked-up-from-customer-site case;
--      return captures gear-going-back-to-different-pad case.
--   4. shop_transfer_events table — append-only log of shop-to-shop transfers
--      within Basin. The WO's birth state at originShop is NOT a transfer
--      event; transfers only model shop-to-shop hops within Basin.

-- CreateEnum
CREATE TYPE "BasinShop" AS ENUM ('williston', 'dickinson');

-- AlterTable: ShopWorkOrder — add origin shop + location pointers
ALTER TABLE "shop_work_orders"
    ADD COLUMN "origin_shop" "BasinShop" NOT NULL DEFAULT 'williston',
    ADD COLUMN "source_location_id" TEXT,
    ADD COLUMN "return_location_id" TEXT;

-- AddForeignKey
ALTER TABLE "shop_work_orders" ADD CONSTRAINT "shop_work_orders_source_location_id_fkey"
    FOREIGN KEY ("source_location_id") REFERENCES "pads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shop_work_orders" ADD CONSTRAINT "shop_work_orders_return_location_id_fkey"
    FOREIGN KEY ("return_location_id") REFERENCES "pads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable: shop_transfer_events
CREATE TABLE "shop_transfer_events" (
    "id" TEXT NOT NULL,
    "work_order_id" TEXT NOT NULL,
    "from_shop" "BasinShop" NOT NULL,
    "to_shop" "BasinShop" NOT NULL,
    "transferred_by_id" TEXT,
    "transferred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shop_transfer_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "shop_transfer_events_work_order_id_idx" ON "shop_transfer_events"("work_order_id");

-- AddForeignKey
ALTER TABLE "shop_transfer_events" ADD CONSTRAINT "shop_transfer_events_work_order_id_fkey"
    FOREIGN KEY ("work_order_id") REFERENCES "shop_work_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shop_transfer_events" ADD CONSTRAINT "shop_transfer_events_transferred_by_id_fkey"
    FOREIGN KEY ("transferred_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
