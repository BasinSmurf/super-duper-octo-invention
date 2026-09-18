-- Catchup migration. Fields below were added to schema.prisma in commit
-- 6f36200 (supervisor review dashboard) and the defaultLineItems client
-- code has always emitted lineType='travel' — but no migration was ever
-- generated for either, so prod DBs diverged from schema.
--
-- All operations are idempotent (IF NOT EXISTS / constraint check via
-- information_schema) so this is safe regardless of whether any columns
-- were hand-patched on specific deployments.

-- LineItemType: add 'travel' (client has been sending this since monitor
-- default line items were introduced; server rejected every sync).
ALTER TYPE "LineItemType" ADD VALUE IF NOT EXISTS 'travel';

-- Per-customer kill switch for auto-approval of routine tickets.
ALTER TABLE "customer_billing_profiles"
  ADD COLUMN IF NOT EXISTS "auto_approval_enabled" BOOLEAN NOT NULL DEFAULT true;

-- Supervisor-review fields on ServiceTicket.
ALTER TABLE "service_tickets" ADD COLUMN IF NOT EXISTS "review_signal" JSONB;
ALTER TABLE "service_tickets" ADD COLUMN IF NOT EXISTS "review_signal_ran_at" TIMESTAMP(3);
ALTER TABLE "service_tickets" ADD COLUMN IF NOT EXISTS "reviewed_by_id" TEXT;
ALTER TABLE "service_tickets" ADD COLUMN IF NOT EXISTS "reviewed_at" TIMESTAMP(3);
ALTER TABLE "service_tickets"
  ADD COLUMN IF NOT EXISTS "auto_approved" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "service_tickets" ADD COLUMN IF NOT EXISTS "rejection_reason" TEXT;

-- FK for reviewed_by_id → users(id). Use a DO block so re-runs are safe.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'service_tickets_reviewed_by_id_fkey'
      AND table_name = 'service_tickets'
  ) THEN
    ALTER TABLE "service_tickets"
      ADD CONSTRAINT "service_tickets_reviewed_by_id_fkey"
      FOREIGN KEY ("reviewed_by_id") REFERENCES "users"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END$$;
