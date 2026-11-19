-- Pull the QuickBooks customer list (paged CustomerQueryRq) so a customer
-- created in QB shows up in Sundog without someone building a price level for
-- it first. Additive only — safe on the drifted dev DB.

-- New entity type for the QBWC sync queue. `customer` stays the per-company
-- add/lookup job; `customer_list` is the bulk pull.
ALTER TYPE "QbSyncEntityType" ADD VALUE IF NOT EXISTS 'customer_list';

-- Mirror of QB's customer list. The link to a Sundog company lives on
-- companies.qb_customer_list_id; a row here with no company holding its ListID
-- is "in QuickBooks, not in Sundog" and waits for review.
CREATE TABLE IF NOT EXISTS "qb_customers" (
    "id"                TEXT NOT NULL,
    "qb_list_id"        TEXT NOT NULL,
    "full_name"         TEXT NOT NULL,
    "name"              TEXT NOT NULL,
    "sublevel"          INTEGER NOT NULL DEFAULT 0,
    "parent_qb_list_id" TEXT,
    "is_active"         BOOLEAN NOT NULL DEFAULT true,
    "company_name"      TEXT,
    "phone"             TEXT,
    "email"             TEXT,
    "address"           TEXT,
    "city"              TEXT,
    "state"             TEXT,
    "zip"               TEXT,
    "ignored"           BOOLEAN NOT NULL DEFAULT false,
    "qb_time_modified"  TIMESTAMP(3),
    "last_synced_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "qb_customers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "qb_customers_qb_list_id_key" ON "qb_customers"("qb_list_id");
CREATE INDEX IF NOT EXISTS "qb_customers_full_name_idx" ON "qb_customers"("full_name");
