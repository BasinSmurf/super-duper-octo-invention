-- Rig number on a ticket becomes free text. The legacy present_rig_id
-- (MobileAsset pick) stays for history but the wizard no longer writes it.
ALTER TABLE "service_tickets" ADD COLUMN "present_rig_number" TEXT;

-- Carry existing picks over so edited tickets keep showing their rig.
UPDATE "service_tickets" st
SET "present_rig_number" = ma."name"
FROM "mobile_assets" ma
WHERE st."present_rig_id" = ma."id";
