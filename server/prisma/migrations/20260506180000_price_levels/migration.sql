-- Wave 5 Slice 5B — QB Per-Item Price Level pull.

ALTER TYPE "QbSyncEntityType" ADD VALUE IF NOT EXISTS 'price_level';
--
-- price_levels                  — one row per QB Price Level (typically per
--                                 customer in this org's QB setup)
-- price_level_items             — per-item override (custom price OR %
--                                 adjustment). One row per (price level, item).
--
-- Pull is read-only. Apply happens later inside the billing-rules engine.
-- Both tables idempotent so reruns of the migration are safe.

CREATE TABLE IF NOT EXISTS "price_levels" (
    "id"                  TEXT NOT NULL,
    "qb_list_id"          TEXT NOT NULL,
    "name"                TEXT NOT NULL,
    "is_active"           BOOLEAN NOT NULL DEFAULT TRUE,
    "qb_customer_list_id" TEXT,
    "qb_customer_name"    TEXT,
    "qb_time_modified"    TIMESTAMP(3),
    "last_synced_at"      TIMESTAMP(3),
    "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "price_levels_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "price_levels_qb_list_id_key" ON "price_levels"("qb_list_id");
CREATE INDEX IF NOT EXISTS "price_levels_customer_idx" ON "price_levels"("qb_customer_list_id");

CREATE TABLE IF NOT EXISTS "price_level_items" (
    "id"                TEXT NOT NULL,
    "price_level_id"    TEXT NOT NULL,
    "qb_item_list_id"   TEXT NOT NULL,
    "qb_item_full_name" TEXT,
    "custom_price"      DECIMAL(12, 2),
    "adjust_percent"    DECIMAL(6, 2),
    "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "price_level_items_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "price_level_items_unique"
    ON "price_level_items"("price_level_id", "qb_item_list_id");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'price_level_items_price_level_id_fkey'
      AND table_name = 'price_level_items'
  ) THEN
    ALTER TABLE "price_level_items"
      ADD CONSTRAINT "price_level_items_price_level_id_fkey"
      FOREIGN KEY ("price_level_id") REFERENCES "price_levels"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;
