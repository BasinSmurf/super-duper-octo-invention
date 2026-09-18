-- Shop billing chunk + category-filtered parts.
-- All additive & nullable — safe to apply over existing data.

-- Free-form catalog grouping populated from the QB price-list work (drives the
-- shop parts-picker category dropdown; distinct from the fixed `category` enum).
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "catalog_category" TEXT;

-- Per-unit structured billing chunk (labor time, misc, outside-vendor + invoice
-- attachment, roll-up flag). Materials stay in the existing `parts_used`.
ALTER TABLE "shop_work_order_items" ADD COLUMN IF NOT EXISTS "billing" JSONB;

-- WO-level billing extras (mileage/trip + order-level misc), billed once.
ALTER TABLE "shop_work_orders" ADD COLUMN IF NOT EXISTS "billing_extras" JSONB;
