-- Backfill QB mapping fields for companies and products that are missing them.
-- Only updates rows where the QB field is NULL (won't overwrite QB-imported data).
-- Run against prod: psql $DATABASE_URL -f server/scripts/backfill-qb-mappings.sql

BEGIN;

-- Companies: set qb_customer_full_name = name where missing
UPDATE companies
SET    qb_customer_full_name = name,
       updated_at = NOW()
WHERE  qb_customer_full_name IS NULL;

-- Products: set qb_item_full_name = name where missing
UPDATE products
SET    qb_item_full_name = name,
       updated_at = NOW()
WHERE  qb_item_full_name IS NULL;

-- Show what was updated
SELECT 'Companies without QB mapping remaining:' AS check,
       COUNT(*) AS count
FROM   companies
WHERE  qb_customer_full_name IS NULL;

SELECT 'Products without QB mapping remaining:' AS check,
       COUNT(*) AS count
FROM   products
WHERE  qb_item_full_name IS NULL;

COMMIT;
