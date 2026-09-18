-- Internal division classification — drives QuickBooks Class on SalesOrder header
CREATE TYPE "ServiceDivision" AS ENUM ('D3', 'D4');

ALTER TABLE "service_tickets" ADD COLUMN "division" "ServiceDivision";
ALTER TABLE "service_tickets" ADD COLUMN "is_dickinson" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "invoices" ADD COLUMN "division" "ServiceDivision";
ALTER TABLE "invoices" ADD COLUMN "is_dickinson" BOOLEAN NOT NULL DEFAULT false;

-- Line-item notes — previously captured in client UI but never persisted.
-- Needed for 406 labor "reason for work" and general per-line context.
ALTER TABLE "ticket_line_items" ADD COLUMN "notes" TEXT;
