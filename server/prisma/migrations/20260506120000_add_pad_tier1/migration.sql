-- Tier 1 flag on Pad: single boolean indicating the pad is on a Native American
-- reservation. Customer-coined term ("Tier 1") — there is no Tier 2/3.
-- Will gate billing rules once the rules engine lands; for now it's just data.

ALTER TABLE "pads"
    ADD COLUMN IF NOT EXISTS "tier_1" BOOLEAN NOT NULL DEFAULT FALSE;
