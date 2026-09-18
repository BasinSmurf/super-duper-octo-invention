-- Catchup migration #2. Commit 4e686d67 (email signature workflow, 2026-03-26)
-- added 'awaiting_signature' to both TicketStatus and InvoiceStatus in
-- schema.prisma, but the bundled migration only created the SignatureRequest
-- table — it never ran ALTER TYPE for the enum values. Result: any count /
-- groupBy that filters on status='awaiting_signature' throws 22P02 at runtime
-- (which is what was taking down /admin/ops/summary).
--
-- Idempotent via IF NOT EXISTS.

ALTER TYPE "TicketStatus" ADD VALUE IF NOT EXISTS 'awaiting_signature';
ALTER TYPE "InvoiceStatus" ADD VALUE IF NOT EXISTS 'awaiting_signature';
