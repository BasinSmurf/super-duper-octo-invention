-- Wave 2 — Rental BOM: per-customer Bill of Materials (Standard / Drilling)
-- defining the baseline gear a customer's flat rig-up + daily rate covers.
-- Audited entity (change history via audit_log, owner via created_by_id),
-- keyed on equipment TYPE (catalog_category) — never serials. Anything a job
-- deploys above this baseline bills as generic add-on lines; the BOM contents
-- themselves never itemize. Additive + idempotent so reruns are safe.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'RentalBomType') THEN
    CREATE TYPE "RentalBomType" AS ENUM ('standard', 'drilling');
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS "customer_rental_boms" (
    "id"             TEXT NOT NULL,
    "company_id"     TEXT NOT NULL,
    "bom_type"       "RentalBomType" NOT NULL DEFAULT 'standard',
    "manned"         BOOLEAN NOT NULL DEFAULT TRUE,
    "included_techs" INTEGER NOT NULL DEFAULT 0,
    "notes"          TEXT,
    "is_active"      BOOLEAN NOT NULL DEFAULT TRUE,
    "created_by_id"  TEXT,
    "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_rental_boms_pkey" PRIMARY KEY ("id")
);

-- One BOM per (customer, type) — Standard + Drilling max.
CREATE UNIQUE INDEX IF NOT EXISTS "customer_rental_boms_company_type_unique"
    ON "customer_rental_boms"("company_id", "bom_type");

CREATE TABLE IF NOT EXISTS "customer_rental_bom_items" (
    "id"                 TEXT NOT NULL,
    "bom_id"             TEXT NOT NULL,
    "equipment_category" TEXT NOT NULL,
    "label"              TEXT,
    "qty"                INTEGER NOT NULL DEFAULT 1,
    "sort_order"         INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "customer_rental_bom_items_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                 WHERE constraint_name = 'customer_rental_boms_company_id_fkey') THEN
    ALTER TABLE "customer_rental_boms"
      ADD CONSTRAINT "customer_rental_boms_company_id_fkey"
      FOREIGN KEY ("company_id") REFERENCES "companies"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                 WHERE constraint_name = 'customer_rental_boms_created_by_id_fkey') THEN
    ALTER TABLE "customer_rental_boms"
      ADD CONSTRAINT "customer_rental_boms_created_by_id_fkey"
      FOREIGN KEY ("created_by_id") REFERENCES "users"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                 WHERE constraint_name = 'customer_rental_bom_items_bom_id_fkey') THEN
    ALTER TABLE "customer_rental_bom_items"
      ADD CONSTRAINT "customer_rental_bom_items_bom_id_fkey"
      FOREIGN KEY ("bom_id") REFERENCES "customer_rental_boms"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;
