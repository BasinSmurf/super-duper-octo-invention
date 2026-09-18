-- Shop WO Tier 1 billing flag. Shop work has no pad, so the geographic Pad.tier1
-- flag can't drive the Tier 1 reservation surcharge for it. This WO-level
-- checkbox (set at intake) drives the 5% fee + Pale Horse QB customer override
-- at invoice time. Additive only.
ALTER TABLE "shop_work_orders"
  ADD COLUMN IF NOT EXISTS "tier_1" BOOLEAN NOT NULL DEFAULT false;
