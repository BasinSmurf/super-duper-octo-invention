-- Release tickets stranded at status 'invoiced' by a rejected/voided invoice.
--
-- Background: generating an invoice moves its source tickets to 'invoiced'.
-- Before the reject handler was fixed (invoices.ts PATCH /:id/reject), rejecting
-- an invoice flipped it back to draft but left the tickets stuck at 'invoiced',
-- so they vanished from both the Ready queue (billing_queue) and the Approvals
-- queue (supervisor_review), surviving only in All Tickets labeled "Invoiced".
--
-- A ticket is "stranded" when it sits at 'invoiced' but NO live invoice still
-- holds it. A live invoice = status <> 'void' AND not rejected (rejected_at IS
-- NULL). Stranded tickets are released back to 'billing_queue' so they reappear
-- in the Ready queue.
--
-- Run inside the postgres container, reading this file from the host:
--   PROD: docker compose exec -T postgres psql -U servicepro -d servicepro < server/scripts/release-stranded-invoiced-tickets.sql
--   DEV:  docker compose exec -T postgres psql -U sundog     -d sundog     < server/scripts/release-stranded-invoiced-tickets.sql
--
-- PREVIEW FIRST: comment out the UPDATE below and run just the SELECT, or run
-- this same predicate as a SELECT to eyeball the list before applying.

-- Preview: which tickets would move
SELECT id, ticket_number
FROM service_tickets
WHERE status = 'invoiced'
  AND id NOT IN (
    SELECT li.source_ticket_id
    FROM invoice_line_items li
    JOIN invoices inv ON inv.id = li.invoice_id
    WHERE li.source_ticket_id IS NOT NULL
      AND inv.status <> 'void'
      AND inv.rejected_at IS NULL
  );

-- Apply: release them back into the Ready queue. RETURNING prints what changed.
UPDATE service_tickets
SET status = 'billing_queue'
WHERE status = 'invoiced'
  AND id NOT IN (
    SELECT li.source_ticket_id
    FROM invoice_line_items li
    JOIN invoices inv ON inv.id = li.invoice_id
    WHERE li.source_ticket_id IS NOT NULL
      AND inv.status <> 'void'
      AND inv.rejected_at IS NULL
  )
RETURNING id, ticket_number;
