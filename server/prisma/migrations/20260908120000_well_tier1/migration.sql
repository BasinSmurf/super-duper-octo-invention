-- Well-level Tier 1 (Native American reservation) flag.
--
-- Tier 1 has existed only on pads (pads.tier_1), and billingRules rule 5A —
-- the 5% reservation fee plus the QB customer flip to Pale Horse — fires off
-- ticket.pad.tier1. But a pad-less well is the majority case, not an edge:
-- 2877 of 2886 wells in prod have no pad, and zero of the 50 pads carry the
-- flag. So the fee could never fire on reservation work done at a well,
-- which is nearly all of it.
--
-- This adds the same flag at well level. Rule 5A now fires on pad OR well.
ALTER TABLE "wells" ADD COLUMN "tier_1" BOOLEAN NOT NULL DEFAULT false;

-- Reservation wells are named "FBIR *" (Fort Berthold Indian Reservation) in
-- both the DMR data and our hand-entered rows, so the name is the reliable
-- signal — operator is not (these change hands, and 10 of them were sitting
-- on wrong operators entirely from bad DMR matches). Flag them regardless of
-- who currently operates them.
UPDATE "wells" SET "tier_1" = true WHERE "well_name" ILIKE 'FBIR%';
