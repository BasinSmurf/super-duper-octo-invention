-- Pull QB Sales Tax Items + Groups so qbTaxItemName can be reconciled against
-- real QB names (fixes recurring 3140 "invalid reference to QuickBooks Item
-- Sales Tax"). Additive only — safe on the drifted dev DB.

-- New entity type for the QBWC sync queue.
ALTER TYPE "QbSyncEntityType" ADD VALUE IF NOT EXISTS 'sales_tax';

-- Authoritative mirror of QB's tax items + groups.
CREATE TABLE IF NOT EXISTS "qb_sales_tax_records" (
    "id"               TEXT NOT NULL,
    "qb_list_id"       TEXT NOT NULL,
    "full_name"        TEXT NOT NULL,
    "record_type"      TEXT NOT NULL,
    "tax_rate_percent" DECIMAL(7,4),
    "is_active"        BOOLEAN NOT NULL DEFAULT true,
    "description"      TEXT,
    "qb_time_modified" TIMESTAMP(3),
    "last_synced_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "qb_sales_tax_records_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "qb_sales_tax_records_qb_list_id_key" ON "qb_sales_tax_records"("qb_list_id");
CREATE INDEX IF NOT EXISTS "qb_sales_tax_records_full_name_idx" ON "qb_sales_tax_records"("full_name");
