-- Wave 4 Slice E — Enverus full-lifecycle status tracking.
--
-- Today the poller only acts on Approved/Disputed terminal states. Adding
-- last_seen_status + last_polled_at lets us:
--   1. Detect intermediate buyer-side transitions ("status_flipped")
--      without re-emitting on every poll cycle
--   2. Recognize Paid as a new terminal-positive state (separate from Approved)
--   3. Tune polling cadence per entry if cost ever matters
--
-- Plus: 'paid' joins EnverusReceiptStatus so a paid receipt exits the poll
-- pool the same way approved/disputed do today.

ALTER TABLE "enverus_sync_queue"
    ADD COLUMN IF NOT EXISTS "last_seen_status" TEXT,
    ADD COLUMN IF NOT EXISTS "last_polled_at"   TIMESTAMP(3);

ALTER TYPE "EnverusReceiptStatus" ADD VALUE IF NOT EXISTS 'paid';
