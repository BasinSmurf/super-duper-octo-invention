-- Wave 1 — Equipment Inspection Form (unified shop + field).
-- See project_inspection_forms_and_transfers.md for full design context.
--
-- This migration adds:
--   1. EquipmentStatus.{out_of_service, condemned} — outcome flow-back targets
--      from EquipmentInspection.outcome (cannot_service / condemn).
--   2. EquipmentInspectionCategory enum — superset of EquipmentCategoryShop;
--      adds field-only categories breathing_air_system, first_aid_kit.
--   3. InspectionOutcome enum — drives SerializedEquipment.status flow-back
--      via services/equipmentLifecycle.ts.
--   4. equipment_inspections table — polymorphic on shop_item_id | ticket_id.
--   5. CHECK constraint enforcing parent exclusivity (XOR).
--
-- Coexistence: air_system_inspections / gas_detection_records / ih_test_records
-- remain in service. New shop-side inspections write to equipment_inspections;
-- legacy field-side records are migrated in a later wave.

-- AlterEnum
ALTER TYPE "EquipmentStatus" ADD VALUE 'out_of_service';
ALTER TYPE "EquipmentStatus" ADD VALUE 'condemned';

-- CreateEnum
CREATE TYPE "EquipmentInspectionCategory" AS ENUM (
    'fire_extinguisher',
    'gas_detection',
    'scba',
    'fall_arrest',
    'ue_cylinder',
    'breathing_air_system',
    'first_aid_kit',
    'other'
);

-- CreateEnum
CREATE TYPE "InspectionOutcome" AS ENUM (
    'pass',
    'fail',
    'condemn',
    'cannot_service',
    'requires_parts'
);

-- CreateTable
CREATE TABLE "equipment_inspections" (
    "id" TEXT NOT NULL,
    "shop_item_id" TEXT,
    "ticket_id" TEXT,
    "serialized_equipment_id" TEXT,
    "serial_number" TEXT NOT NULL,
    "category" "EquipmentInspectionCategory" NOT NULL,
    "outcome" "InspectionOutcome" NOT NULL,
    "service_actions" JSONB NOT NULL DEFAULT '[]',
    "data" JSONB NOT NULL DEFAULT '{}',
    "parts_replaced" TEXT,
    "notes" TEXT,
    "inspected_by_id" TEXT,
    "inspected_at" TIMESTAMP(3) NOT NULL,
    "customer_approved_name" TEXT,
    "customer_approved_signature" TEXT,
    "customer_approved_at" TIMESTAMP(3),
    "locked_at" TIMESTAMP(3),
    "corrects_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "equipment_inspections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "equipment_inspections_shop_item_id_idx" ON "equipment_inspections"("shop_item_id");
CREATE INDEX "equipment_inspections_ticket_id_idx" ON "equipment_inspections"("ticket_id");
CREATE INDEX "equipment_inspections_serialized_equipment_id_idx" ON "equipment_inspections"("serialized_equipment_id");
CREATE INDEX "equipment_inspections_serial_number_idx" ON "equipment_inspections"("serial_number");

-- AddForeignKey
ALTER TABLE "equipment_inspections" ADD CONSTRAINT "equipment_inspections_shop_item_id_fkey"
    FOREIGN KEY ("shop_item_id") REFERENCES "shop_work_order_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "equipment_inspections" ADD CONSTRAINT "equipment_inspections_ticket_id_fkey"
    FOREIGN KEY ("ticket_id") REFERENCES "service_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "equipment_inspections" ADD CONSTRAINT "equipment_inspections_serialized_equipment_id_fkey"
    FOREIGN KEY ("serialized_equipment_id") REFERENCES "serialized_equipment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "equipment_inspections" ADD CONSTRAINT "equipment_inspections_inspected_by_id_fkey"
    FOREIGN KEY ("inspected_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "equipment_inspections" ADD CONSTRAINT "equipment_inspections_corrects_id_fkey"
    FOREIGN KEY ("corrects_id") REFERENCES "equipment_inspections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Parent exclusivity — exactly one of shop_item_id or ticket_id must be populated.
-- Prisma can't express CHECK constraints in schema, so it lives here.
ALTER TABLE "equipment_inspections"
    ADD CONSTRAINT "equipment_inspections_parent_exclusivity"
    CHECK (
        (shop_item_id IS NOT NULL AND ticket_id IS NULL) OR
        (shop_item_id IS NULL AND ticket_id IS NOT NULL)
    );
