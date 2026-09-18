-- Mobile/rented equipment (drilling rigs, service trucks) gets billed
-- per-job to whoever contracted it, not the operator of the site it's
-- currently at, so it's never tied to one operator the way a real pad is.
-- Flagging a pad's assetCategory lets the pending-request dedup pool
-- match it across ALL operators/fields instead of only the requested
-- one, so the same rig/truck record gets reused everywhere it works.

-- CreateEnum
CREATE TYPE "PadAssetCategory" AS ENUM ('site', 'rig', 'truck', 'other_mobile');

-- AlterTable
ALTER TABLE "pads" ADD COLUMN "asset_category" "PadAssetCategory" NOT NULL DEFAULT 'site';
