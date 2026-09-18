-- ShopWork refactor (Wave 3): BlueLion is the inspection ledger. Add the
-- 'equipment_inspection' entity type so locked terminal inspections (field pass,
-- shop pass/visual-only, condemn=DEAD record) can be queued for push to the
-- separate equipment-inspection endpoint. Additive enum value.
ALTER TYPE "BlueLionEntityType" ADD VALUE IF NOT EXISTS 'equipment_inspection';
