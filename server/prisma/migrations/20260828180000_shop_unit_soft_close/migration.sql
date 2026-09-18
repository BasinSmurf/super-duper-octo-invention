-- WI-05: closing a unit should not instantly petrify it.
--
-- PER-UNIT, not per-work-order. This repo already bills per unit -- a unit
-- settles when IT reaches a terminal-billable state, not when the parent WO
-- closes -- so a WO-level close would have meant reversing the per-unit billing
-- ledger the ShopWork refactor was built on.
--
-- soft_closed_at is stamped on the FIRST transition into shop_complete /
-- returned / condemned (exactly BILLABLE_STATES, so "settled" and "closed"
-- cannot drift apart). hard_closes_at is that + 48 WALL-CLOCK hours: a Friday
-- 16:00 close is hard before Monday, on purpose.
--
-- Until hard close, the unit is invisible to billing and its VaultPRO push has
-- not fired. Both are consequences of the same timestamp rather than separate
-- flags that could disagree.
ALTER TABLE "shop_work_order_items" ADD COLUMN "soft_closed_at" TIMESTAMP(3);
ALTER TABLE "shop_work_order_items" ADD COLUMN "hard_closes_at" TIMESTAMP(3);
ALTER TABLE "shop_work_order_items" ADD COLUMN "closed_by_id" TEXT;

-- Platform-admin unlock: a fresh 48h, reason required, counted rather than
-- flagged so a unit re-opened four times says so.
ALTER TABLE "shop_work_order_items" ADD COLUMN "unlocked_at" TIMESTAMP(3);
ALTER TABLE "shop_work_order_items" ADD COLUMN "unlocked_by_id" TEXT;
ALTER TABLE "shop_work_order_items" ADD COLUMN "unlock_reason" TEXT;
ALTER TABLE "shop_work_order_items" ADD COLUMN "unlock_count" INTEGER NOT NULL DEFAULT 0;

-- "Fires exactly once" is an acceptance criterion, so it needs somewhere to be
-- recorded. The VaultPRO push is idempotent on its own (the queue's external_id
-- is unique), but a marker turns "probably once" into something checkable, and
-- keeps the sweep from re-walking every hard-closed unit on every tick.
ALTER TABLE "shop_work_order_items" ADD COLUMN "vault_pushed_at" TIMESTAMP(3);

-- Identity resolution, run at close rather than at intake.
ALTER TABLE "shop_work_order_items" ADD COLUMN "identity_resolution" TEXT;
ALTER TABLE "shop_work_order_items" ADD COLUMN "identity_resolved_at" TIMESTAMP(3);
ALTER TABLE "shop_work_order_items" ADD COLUMN "identity_resolved_by_id" TEXT;

-- The hard-close sweep's work queue: units past their deadline that have not
-- yet been handed to billing / VaultPRO.
CREATE INDEX "shop_work_order_items_hard_closes_at_idx"
  ON "shop_work_order_items"("hard_closes_at");

-- BACKFILL. Units already sitting in a terminal state pre-date this feature and
-- have in most cases already been invoiced. Giving them a fresh 48-hour window
-- would yank every historically-billable unit OUT of billing until the sweep
-- caught up. So they are stamped as ALREADY hard-closed, using the timestamp
-- the unit actually settled at where we have one.
UPDATE "shop_work_order_items"
SET "soft_closed_at" = COALESCE("returned_at", "work_completed_at", "updated_at"),
    "hard_closes_at" = COALESCE("returned_at", "work_completed_at", "updated_at"),
    -- Marked as already pushed: these units went to VaultPRO through the old
    -- at-shop_complete path. Leaving it null would make the first sweep after
    -- deploy re-push every historical unit in one go.
    "vault_pushed_at" = COALESCE("returned_at", "work_completed_at", "updated_at")
WHERE "status" IN ('shop_complete', 'returned', 'condemned');

-- ── The stamp is enforced in the DATABASE, not in the routes ────────────────
--
-- WI-04 taught this lesson the expensive way: `condemned` turned out to be
-- reachable from four places, not the one the UI implies. A unit reaches a
-- closing state from at least seven — the item-status route, bulk-clear,
-- bulk-return, release, force-close, the inspection cascade, and the offline
-- sync replay — and billing correctness now depends on the stamp existing on
-- EVERY one of them. A helper each route remembers to call is a helper a
-- future route forgets, and the failure is silent: the unit just bills early.
--
-- So the timestamps are a trigger. Nothing can write a closing status without
-- them, including raw SQL and anything added later.
--
-- The trigger deliberately does NOT touch closed_by_id: the database has no
-- idea who is acting. Routes set it where they know, and canEditUnit degrades
-- to supervisor-only when it is null — restrictive, not permissive.
--
-- Only the FIRST close stamps. shop_complete -> returned is a handover, not a
-- second close, and restarting the clock would let a unit be held out of
-- billing forever by bouncing its status.
CREATE FUNCTION shop_item_stamp_soft_close() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status IN ('shop_complete', 'returned', 'condemned')
       AND NEW.soft_closed_at IS NULL
    THEN
        NEW.soft_closed_at := NOW();
        NEW.hard_closes_at := NOW() + INTERVAL '48 hours';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER shop_item_soft_close
    BEFORE INSERT OR UPDATE ON "shop_work_order_items"
    FOR EACH ROW
    EXECUTE FUNCTION shop_item_stamp_soft_close();
