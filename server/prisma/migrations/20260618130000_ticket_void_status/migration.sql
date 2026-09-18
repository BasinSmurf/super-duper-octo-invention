-- Billing/AR void (nullify) support.
--
-- Adds a terminal `void` status to TicketStatus plus the void audit columns.
-- The new enum value is only WRITTEN at runtime (never referenced inside this
-- migration), so adding it in the same script is safe on Postgres 12+.

-- 1. New enum value (idempotent — re-runs cleanly).
ALTER TYPE "TicketStatus" ADD VALUE IF NOT EXISTS 'void';

-- 2. Void audit columns on the ticket.
ALTER TABLE "service_tickets"
  ADD COLUMN IF NOT EXISTS "voided_at"    TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "voided_by_id" TEXT,
  ADD COLUMN IF NOT EXISTS "void_reason"  TEXT;
