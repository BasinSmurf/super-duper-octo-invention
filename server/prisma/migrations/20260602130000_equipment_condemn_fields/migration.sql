-- Decommission record fields on serialized_equipment.
-- Stamped when a locked EquipmentInspection has outcome = 'condemn'
-- (status flips to 'condemned'; these capture when + why). Lightweight by design.
ALTER TABLE "serialized_equipment" ADD COLUMN "condemned_at" TIMESTAMP(3);
ALTER TABLE "serialized_equipment" ADD COLUMN "condemn_reason" TEXT;
