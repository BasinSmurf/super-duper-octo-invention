-- Customer portal — external read-only accounts scoped to one Company.
--
-- UserRole gains a `customer` value, and users.company_id links a portal
-- account to the single Company whose service history it may view. Null for
-- all internal staff accounts. Every /api/portal query filters by this column.

ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'customer';

ALTER TABLE "users"
    ADD COLUMN IF NOT EXISTS "company_id" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'users_company_id_fkey'
      AND table_name = 'users'
  ) THEN
    ALTER TABLE "users"
      ADD CONSTRAINT "users_company_id_fkey"
      FOREIGN KEY ("company_id") REFERENCES "companies"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS "users_company_id_idx"
    ON "users" ("company_id");
