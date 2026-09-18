-- Thin, standalone, operator-agnostic named assets (rigs, air trailers) —
-- deliberately NOT a Well/Pad. `rig` backs the "Rig present" toggle on
-- field service tickets. `air_trailer` is the re-homed identity for a
-- customer's numbered breathing-air trailer, so WorkPoint-based cylinder/
-- hydro-test tracking has somewhere to live without pretending to be a
-- wellsite.
-- CreateEnum
CREATE TYPE "MobileAssetKind" AS ENUM ('rig', 'air_trailer');

-- CreateTable
CREATE TABLE "mobile_assets" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "MobileAssetKind" NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mobile_assets_pkey" PRIMARY KEY ("id")
);

-- AlterTable: WorkPoint gains a 4th polymorphic parent
ALTER TABLE "work_points" ADD COLUMN "mobile_asset_id" TEXT;
ALTER TABLE "work_points" ADD CONSTRAINT "work_points_mobile_asset_id_fkey" FOREIGN KEY ("mobile_asset_id") REFERENCES "mobile_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable: ServiceTicket "rig present" toggle — independent of the
-- main location, just noted context for the visit.
ALTER TABLE "service_tickets" ADD COLUMN "rig_present" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "service_tickets" ADD COLUMN "present_rig_id" TEXT;
ALTER TABLE "service_tickets" ADD CONSTRAINT "service_tickets_present_rig_id_fkey" FOREIGN KEY ("present_rig_id") REFERENCES "mobile_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- =========================================================================
-- Data migration: retire rig/truck as Well/Pad asset categories.
--
-- Rigs (asset_category = 'rig') move to the new thin MobileAsset model.
-- "Truck" wells were never real wellbores — they were free-text truck/
-- trailer identities from the old bulk LGC-#### import, given a Well row
-- only because that was the only mechanism available at the time to make
-- something selectable in the ticket wizard. A subset of those (air
-- trailers, identified by name — 'trailer' / 'B&G') have REAL, active
-- WorkPoint-based cylinder/hydro-test inspection tracking still in daily
-- use, so those get re-homed onto the new MobileAsset instead of being
-- discarded. Confirmed via a full FK sweep (route_stops,
-- rental_agreements, operator_history, fit_test_records,
-- ticket_line_items.well_id_override, serialized_equipment.current_well_id,
-- dmr_reference_wells.matched_well_id) that nothing else references these
-- wells, so deleting them once re-pointed is safe.
-- =========================================================================

-- Seed one MobileAsset per distinct legacy rig well name.
INSERT INTO "mobile_assets" ("id", "name", "kind", "created_at", "updated_at")
SELECT gen_random_uuid(), dn."well_name", 'rig', now(), now()
FROM (
  SELECT DISTINCT "well_name" FROM "wells"
  WHERE "asset_category" = 'rig' AND "well_name" IS NOT NULL
) dn;

-- Seed one MobileAsset per distinct legacy air-trailer/truck well name.
-- Scoped to api_number IS NULL as a defensive guard — a real DMR-matched
-- wellbore should never match this name pattern, but never say never.
INSERT INTO "mobile_assets" ("id", "name", "kind", "created_at", "updated_at")
SELECT gen_random_uuid(), dn."well_name", 'air_trailer', now(), now()
FROM (
  SELECT DISTINCT "well_name" FROM "wells"
  WHERE "well_name" ~* 'trailer|b&g' AND "api_number" IS NULL AND "well_name" IS NOT NULL
) dn;

-- Re-home WorkPoints (cylinder/hydro-test records) from the well onto the
-- new MobileAsset with the same name — every record carries over untouched.
UPDATE "work_points" wp
SET "mobile_asset_id" = ma."id", "well_id" = NULL
FROM "wells" w
JOIN "mobile_assets" ma ON ma."name" = w."well_name"
WHERE wp."well_id" = w."id"
  AND (w."asset_category" = 'rig' OR (w."well_name" ~* 'trailer|b&g' AND w."api_number" IS NULL));

-- Fix up every ticket that referenced one of these wells: preserve the
-- identity as free text (matching the new Air Fill / rig-present
-- convention) instead of a Well FK, backfilling location_display where
-- it was blank so historical tickets still display something sensible.
UPDATE "service_tickets" st
SET
  "custom_data" = COALESCE(st."custom_data", '{}'::jsonb) || jsonb_build_object('truckUnit', w."well_name"),
  "location_display" = COALESCE(NULLIF(st."location_display", ''), w."well_name"),
  "well_id" = NULL
FROM "wells" w
WHERE st."well_id" = w."id"
  AND (w."asset_category" = 'rig' OR (w."well_name" ~* 'trailer|b&g' AND w."api_number" IS NULL));

-- Now safe to delete — every reference has been re-pointed or cleared.
DELETE FROM "wells" w
WHERE w."asset_category" = 'rig' OR (w."well_name" ~* 'trailer|b&g' AND w."api_number" IS NULL);

-- Catch-all: any OTHER 'truck'/'rig'-category wells or pads not covered
-- above (e.g. explicitly tagged via the app's own asset-type UI rather
-- than a bare legacy-import stand-in) — recategorize rather than delete,
-- since we don't have the same "confirmed no other references" evidence
-- for this unknown set that we do for the flagged legacy set above.
UPDATE "wells" SET "asset_category" = 'other_mobile' WHERE "asset_category" IN ('rig', 'truck');
UPDATE "pads" SET "asset_category" = 'other_mobile' WHERE "asset_category" IN ('rig', 'truck');

-- =========================================================================
-- Narrow PadAssetCategory: drop 'rig' and 'truck' now that nothing uses them.
-- =========================================================================
CREATE TYPE "PadAssetCategory_new" AS ENUM ('site', 'other_mobile', 'gas_plant', 'tank_battery', 'compressor_station', 'swd_facility', 'office', 'shop');

ALTER TABLE "wells" ALTER COLUMN "asset_category" DROP DEFAULT;
ALTER TABLE "wells" ALTER COLUMN "asset_category" TYPE "PadAssetCategory_new" USING ("asset_category"::text::"PadAssetCategory_new");
ALTER TABLE "wells" ALTER COLUMN "asset_category" SET DEFAULT 'site';

ALTER TABLE "pads" ALTER COLUMN "asset_category" DROP DEFAULT;
ALTER TABLE "pads" ALTER COLUMN "asset_category" TYPE "PadAssetCategory_new" USING ("asset_category"::text::"PadAssetCategory_new");
ALTER TABLE "pads" ALTER COLUMN "asset_category" SET DEFAULT 'site';

ALTER TYPE "PadAssetCategory" RENAME TO "PadAssetCategory_old";
ALTER TYPE "PadAssetCategory_new" RENAME TO "PadAssetCategory";
DROP TYPE "PadAssetCategory_old";
