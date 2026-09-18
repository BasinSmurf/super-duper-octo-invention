-- Confirmed via prod discovery query: the real "rig/truck duplicated per
-- operator" mess lives on WELLS (created via AddWellModal's Manual Entry
-- tab, which has zero dedup), not Pads — the pads table is currently
-- empty. Same fix as Pad.assetCategory, reusing the same enum, applied to
-- the model where the actual duplication happens.

-- AlterTable
ALTER TABLE "wells" ADD COLUMN "asset_category" "PadAssetCategory" NOT NULL DEFAULT 'site';
