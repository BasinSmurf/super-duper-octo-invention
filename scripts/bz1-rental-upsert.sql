-- ============================================================
-- BZ1 RENTAL EQUIPMENT UPSERT
-- "If it exists, reclassify it to BZ1. If not, create it as a BZ1."
--
-- Idempotent: serialized_equipment.serial_number is UNIQUE.
-- ON CONFLICT (serial_number) DO UPDATE re-points any existing unit
-- (e.g. a MON-AREA-BW RigRat) to the MON-BZ1 product. Status, location,
-- calibration, ownership, etc. are left untouched — only the product
-- link changes. Missing serials are inserted as new MON-BZ1 units.
--
-- Safe to re-run. Wrapped in a transaction; review counts before COMMIT.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- STEP 1: Ensure the BZ1 product exists (no-op if already there)
-- ------------------------------------------------------------
INSERT INTO products
  (id, part_number, name, description, category, product_type,
   unit_of_measure, is_serialized, is_taxable, is_active,
   created_at, updated_at)
VALUES
  (gen_random_uuid(), 'MON-BZ1', 'Industrial Scientific BZ1 Tower',
   'Industrial Scientific BZ1 fixed-point gas detection tower',
   'monitor_area'::"ProductCategory",
   'rental'::"ProductType",
   'EA', true, false, true, NOW(), NOW())
ON CONFLICT (part_number) DO NOTHING;

-- ------------------------------------------------------------
-- STEP 2: Reclassify existing units to BZ1, create missing ones
-- ------------------------------------------------------------
INSERT INTO serialized_equipment
  (id, product_id, serial_number, ownership, status, created_at, updated_at)
SELECT
  gen_random_uuid(),
  (SELECT id FROM products WHERE part_number = 'MON-BZ1'),
  s.serial,
  'basin_safety'::"EquipmentOwnership",
  'available'::"EquipmentStatus",
  NOW(), NOW()
FROM (VALUES
  ('16041M4-001'),
  ('16041T8-001'),
  ('16083DE-008'),
  ('16123FX-001'),
  ('17052NE-004'),
  ('17052NF-004'),
  ('17083Z2-001'),
  ('17113RL-009'),
  ('17121XN-018'),
  ('18022Q2-050'),
  ('18023XQ-006'),
  ('180319H-013'),
  ('18042GZ-010'),
  ('180441L-001'),
  ('180441L-002'),
  ('180720K-006'),
  ('19020PJ-016'),
  ('19050XJ-003'),
  ('19052S9-002'),
  ('19072NV-001'),
  ('19081DN-009'),
  ('20021GD-002'),
  ('200413E-002'),
  ('22032ED-048'),
  ('22120ZY-001'),
  ('22120ZY-002'),
  ('22120ZY-003'),
  ('22120ZY-004'),
  ('22120ZY-005'),
  ('230631S-004'),
  ('230631S-005'),
  ('230631S-006'),
  ('230631S-007'),
  ('230631S-009'),
  ('230631S-010')
) AS s(serial)
ON CONFLICT (serial_number) DO UPDATE
  SET product_id = (SELECT id FROM products WHERE part_number = 'MON-BZ1'),
      updated_at = NOW();

-- ------------------------------------------------------------
-- VERIFICATION: how each requested serial resolved
-- ------------------------------------------------------------
SELECT
  s.serial,
  CASE WHEN se.id IS NULL THEN 'MISSING (insert failed?)'
       ELSE p.part_number || '  (' || se.status || ')'
  END AS resolved_to
FROM (VALUES
  ('16041M4-001'),('16041T8-001'),('16083DE-008'),('16123FX-001'),
  ('17052NE-004'),('17052NF-004'),('17083Z2-001'),('17113RL-009'),
  ('17121XN-018'),('18022Q2-050'),('18023XQ-006'),('180319H-013'),
  ('18042GZ-010'),('180441L-001'),('180441L-002'),('180720K-006'),
  ('19020PJ-016'),('19050XJ-003'),('19052S9-002'),('19072NV-001'),
  ('19081DN-009'),('20021GD-002'),('200413E-002'),('22032ED-048'),
  ('22120ZY-001'),('22120ZY-002'),('22120ZY-003'),('22120ZY-004'),
  ('22120ZY-005'),('230631S-004'),('230631S-005'),('230631S-006'),
  ('230631S-007'),('230631S-009'),('230631S-010')
) AS s(serial)
LEFT JOIN serialized_equipment se ON se.serial_number = s.serial
LEFT JOIN products p ON p.id = se.product_id
ORDER BY s.serial;

COMMIT;

-- Or to abort:
-- ROLLBACK;
