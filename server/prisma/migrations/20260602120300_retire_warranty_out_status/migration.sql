-- Retire the 'warranty_out' shop-item status: send-out is now always
-- 'outside_service' with an orthogonal is_warranty flag. Migrate any existing
-- warranty_out rows to outside_service + is_warranty=true. The 'warranty_out'
-- enum value is intentionally LEFT in place (dropping a Postgres enum value
-- requires recreating the type) — it's simply no longer produced.
UPDATE "shop_work_order_items"
   SET "status" = 'outside_service', "is_warranty" = true
 WHERE "status" = 'warranty_out';
