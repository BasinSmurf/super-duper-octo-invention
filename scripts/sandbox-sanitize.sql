-- sandbox-sanitize.sql — run once, immediately after restoring a prod dump
-- into the sandbox database. Called automatically by sync-prod-to-sandbox.bat.
--
-- A prod dump does not just carry data, it carries QUEUED WORK. The moment the
-- sandbox API boots against it, its background workers start draining that
-- work: QBWC hands pending invoices to QuickBooks, the Enverus processor
-- submits receipts, the print worker writes ZPL to whatever IP a Printer row
-- names. Those queues were populated by production and are meaningless here —
-- prod is the instance that owns them and will push them for real.
--
-- server/.env.sandbox turns the risky workers off by env var. This file is the
-- second layer: even with a worker accidentally enabled, there is nothing
-- queued for it to send. Both layers, because either one alone is one typo
-- away from a sandbox writing to the real world.
--
-- Nothing here touches business records — tickets, invoices, equipment,
-- customers and locations all survive intact. Only in-flight outbound state
-- is cleared.
--
-- An empty qb_sync_queue is not a permanent state: handleAuthenticate re-queues
-- item, sales-tax and invoice lookups on every QBWC poll. Those are all `query`
-- actions — they read from QuickBooks and write nothing. What this file removes
-- is the `add` work, which is the only kind that creates transactions, and
-- which is only ever queued by someone using the app.

BEGIN;

-- ── QuickBooks ───────────────────────────────────────────────────────────
-- Pending rows would be handed to the sandbox company file on the next QBWC
-- poll, burning doc numbers and creating duplicates of transactions prod is
-- also pushing. Invoice.qb* columns are left alone: they are the record of
-- what prod already synced, and clearing them would make the sandbox re-sync
-- everything from scratch.
DELETE FROM qb_sync_queue;

-- ── Enverus OpenInvoice ──────────────────────────────────────────────────
-- Same reasoning. The sandbox tenant is a different tenant, so prod's pending
-- submissions do not translate.
DELETE FROM enverus_sync_queue;

-- ── BlueLion ─────────────────────────────────────────────────────────────
-- Disabled by blank BLUELION_URL, but drop the backlog too.
DELETE FROM bluelion_sync_queue;

-- ── Label printing ───────────────────────────────────────────────────────
-- The restored printers are the real ZD411s in Williston and Dickinson.
-- Queued jobs go first...
DELETE FROM print_jobs WHERE status IN ('QUEUED', 'PRINTING');

-- ...and then the printers are pointed at the loopback address, so a print
-- attempt from the sandbox fails on connect instead of coming out on a shop
-- floor. Rows are kept rather than deleted: the UI expects printers to exist,
-- and the PrintJob -> Printer relation would break without them.
UPDATE printers
   SET ip_address = '127.0.0.1',
       name       = name || ' (SANDBOX - not connected)'
 WHERE ip_address <> '127.0.0.1';

-- ── Outbound email: nothing to do ────────────────────────────────────────
-- Signature requests are sent on demand from the UI, not drained by a worker,
-- so a restored PENDING row sits still. Empty GOOGLE_MAIL_FROM is the whole
-- guard, and leaving the rows alone keeps the sandbox's signature dashboard
-- looking like production.

COMMIT;

-- ── What is left, for the log ────────────────────────────────────────────
SELECT 'qb_sync_queue'       AS queue, count(*) AS rows FROM qb_sync_queue
UNION ALL SELECT 'enverus_sync_queue',  count(*) FROM enverus_sync_queue
UNION ALL SELECT 'bluelion_sync_queue', count(*) FROM bluelion_sync_queue
UNION ALL SELECT 'print_jobs (live)',   count(*) FROM print_jobs WHERE status IN ('QUEUED','PRINTING')
UNION ALL SELECT 'printers off-LAN',    count(*) FROM printers WHERE ip_address <> '127.0.0.1';
