-- #C Rental composition: dispatch-time spec/BOM for the redesigned Create
-- Rental flow (stackable Trailer / Gas Monitor / Other + Drilling Rig BOM).
-- Additive, nullable JSONB. The flat isManned/isRigJob/monitorsIncluded columns
-- stay populated (derived from composition) so existing display + the v1 API
-- are untouched. Existing rows read null and fall back to the booleans.
ALTER TABLE "rental_agreements"
  ADD COLUMN "composition" JSONB;
