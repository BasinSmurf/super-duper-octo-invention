-- Wave 4 Slice F — QB invoice diff watcher fields.
--
-- The watcher periodically queries QB for the actual invoice and compares
-- against Sundog's record. Sundog is canonical; divergence flags here.
--
--   qb_diff_detected_at — last time we found a mismatch (NULL = in sync OR
--                         never checked). Cleared when a subsequent check
--                         shows agreement.
--   qb_diff_notes       — JSONB shape: { ourTotal, theirTotal, ourLineCount,
--                         theirLineCount, checkedAt }. Useful for human
--                         review until auto-correct lands in a follow-up.
--   qb_last_checked_at  — when the watcher last queried QB for this invoice.
--                         Drives the cooling-off window (skip if checked
--                         in the last N hours) so we don't spam QBWC.

ALTER TABLE "invoices"
    ADD COLUMN IF NOT EXISTS "qb_diff_detected_at" TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "qb_diff_notes"       JSONB,
    ADD COLUMN IF NOT EXISTS "qb_last_checked_at"  TIMESTAMP(3);
