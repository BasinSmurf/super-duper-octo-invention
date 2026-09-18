-- Fixed, single-operator, never-a-wellbore places (gas plants, tank
-- batteries, compressor stations, SWD facilities, offices, shops) — same
-- reasoning as project_facility_deferral.md: these are "pad subtypes," not
-- a separate model. Unlike rig/truck, these do NOT get the cross-operator
-- dedup bypass (see FLOATING_ASSET_CATEGORIES in locations.ts) — they
-- belong to one operator, same-operator/same-field matching already works.
-- This just lets the pending-review queue label them instead of leaving
-- them looking permanently unresolved.

-- AlterEnum
ALTER TYPE "PadAssetCategory" ADD VALUE 'gas_plant';
ALTER TYPE "PadAssetCategory" ADD VALUE 'tank_battery';
ALTER TYPE "PadAssetCategory" ADD VALUE 'compressor_station';
ALTER TYPE "PadAssetCategory" ADD VALUE 'swd_facility';
ALTER TYPE "PadAssetCategory" ADD VALUE 'office';
ALTER TYPE "PadAssetCategory" ADD VALUE 'shop';
