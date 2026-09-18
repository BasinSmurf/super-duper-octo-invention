-- ============================================================
-- SUNDOG EQUIPMENT RESET — SCBAs + Monitors
-- Generated: 2026-03-31
-- Source: KPA/Flex exports
--   SCBAs:    equipment-1774982660841.csv  (Type = SCBA)
--   Monitors: equipment-1774982531323.csv  (Type = Area Monitors | BZ1 Tower)
--
-- Products created/upserted:
--   SCBA-30MIN   — 30-Min SCBA Pack         (new, no QB link)
--   MON-AREA-BW  — BW RigRat Area Monitor   (upserted, QB link cleared)
--   MON-BZ1      — Industrial Scientific BZ1 Tower (new, no QB link)
--
-- Status mapping (KPA → Sundog):
--   uptodate / Y     → available
--   expired  / Y     → available  (calibration data records overdue state)
--   out of service/N → repair
--   Lost f/Location  → SKIPPED (230631S-009, 230631T-009)
--
-- Hydro dates stored as:
--   last_calibration_date = Hydro Last Inspection Date
--   calibration_due_date  = Hydro Expires On
--   (NULL when blank in source)
--
-- SCBA parent_equipment_id intentionally left NULL —
-- wire up to trailers after trailer data is verified.
--
-- ⚠️  DESTRUCTIVE — pg_dump first.
-- ⚠️  Runs in a transaction — review row counts before COMMIT.
-- ============================================================

BEGIN;

-- ============================================================
-- STEP 1: UPSERT PRODUCTS
-- ============================================================

-- 30-Min SCBA Pack (new — no QB link intentional)
INSERT INTO products
  (id, part_number, name, description, category, product_type,
   unit_of_measure, is_serialized, is_taxable, is_active,
   created_at, updated_at)
VALUES
  (gen_random_uuid(), 'SCBA-30MIN', '30-Min SCBA Pack',
   'Self-Contained Breathing Apparatus, 30-minute rated',
   'supplied_air_component'::"ProductCategory",
   'rental'::"ProductType",
   'EA', true, false, true, NOW(), NOW())
ON CONFLICT (part_number) DO UPDATE
  SET name        = EXCLUDED.name,
      description = EXCLUDED.description,
      updated_at  = NOW();

-- BW RigRat Area Monitor (clear QB link — these are rental units not sell-through)
INSERT INTO products
  (id, part_number, name, description, category, product_type,
   unit_of_measure, is_serialized, is_taxable, is_active,
   created_at, updated_at)
VALUES
  (gen_random_uuid(), 'MON-AREA-BW', 'BW RigRat Area Monitor',
   'BW Technologies RigRat multi-gas area monitor',
   'monitor_area'::"ProductCategory",
   'rental'::"ProductType",
   'EA', true, false, true, NOW(), NOW())
ON CONFLICT (part_number) DO UPDATE
  SET name              = EXCLUDED.name,
      description       = EXCLUDED.description,
      qb_item_list_id   = NULL,
      qb_item_full_name = NULL,
      qb_item_type      = NULL,
      updated_at        = NOW();

-- Industrial Scientific BZ1 Tower (new — no QB link intentional)
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
ON CONFLICT (part_number) DO UPDATE
  SET name        = EXCLUDED.name,
      description = EXCLUDED.description,
      updated_at  = NOW();

-- ============================================================
-- STEP 2: NULL OUT NULLABLE FKs, THEN DELETE EXISTING UNITS
-- ============================================================

UPDATE ticket_line_items SET equipment_id_installed = NULL
 WHERE equipment_id_installed IN (
   SELECT se.id FROM serialized_equipment se
   JOIN products p ON p.id = se.product_id
   WHERE p.part_number IN ('SCBA-30MIN','MON-AREA-BW','MON-BZ1',
                           'AIR-PACK-30ESC')   -- catch old part number too
 );

UPDATE ticket_line_items SET equipment_id_removed = NULL
 WHERE equipment_id_removed IN (
   SELECT se.id FROM serialized_equipment se
   JOIN products p ON p.id = se.product_id
   WHERE p.part_number IN ('SCBA-30MIN','MON-AREA-BW','MON-BZ1','AIR-PACK-30ESC')
 );

UPDATE shop_work_order_items SET serialized_equipment_id = NULL
 WHERE serialized_equipment_id IN (
   SELECT se.id FROM serialized_equipment se
   JOIN products p ON p.id = se.product_id
   WHERE p.part_number IN ('SCBA-30MIN','MON-AREA-BW','MON-BZ1','AIR-PACK-30ESC')
 );

DELETE FROM serialized_equipment
 WHERE product_id IN (
   SELECT id FROM products
   WHERE part_number IN ('SCBA-30MIN','MON-AREA-BW','MON-BZ1','AIR-PACK-30ESC')
 );

-- ============================================================
-- STEP 3: INSERT SCBAs
-- Columns: serial, kpa_status, is_in_svc, hydro_last (MM/DD/YY), hydro_exp (MM/DD/YY)
-- NULL dates where source was blank.
-- ============================================================

INSERT INTO serialized_equipment
  (id, product_id, serial_number, ownership, status,
   last_calibration_date, calibration_due_date,
   custom_data, created_at, updated_at)
SELECT
  gen_random_uuid(),
  (SELECT id FROM products WHERE part_number = 'SCBA-30MIN'),
  s.serial,
  'basin_safety'::"EquipmentOwnership",
  CASE WHEN s.in_svc = 'N' THEN 'repair'::"EquipmentStatus"
       ELSE 'available'::"EquipmentStatus"
  END,
  CASE WHEN s.hydro_last IS NOT NULL
       THEN TO_DATE(s.hydro_last, 'MM/DD/YY') END,
  CASE WHEN s.hydro_exp  IS NOT NULL
       THEN TO_DATE(s.hydro_exp,  'MM/DD/YY') END,
  jsonb_build_object(
    'kpa_status',   s.kpa_status,
    'hydro_status', s.hydro_status
  ),
  NOW(), NOW()
FROM (VALUES
--  serial              kpa_status    in_svc  hydro_status  hydro_last   hydro_exp
  ('11551345010631',   'expired',    'Y',    'uptodate',   '04/24/24',  '04/23/29'),
  ('129116',           'expired',    'Y',    'uptodate',   '07/03/24',  '07/02/29'),
  ('648809',           'expired',    'Y',    'expired',    NULL,        '03/14/24'),
  ('A050690',          'expired',    'Y',    'uptodate',   '08/28/24',  '08/27/29'),
  ('A060505',          'expired',    'Y',    'uptodate',   '08/20/24',  '08/19/29'),
  ('A074171',          'expired',    'Y',    'expired',    NULL,        '10/21/25'),
  ('A0745171',         'expired',    'Y',    'expired',    NULL,        '11/29/23'),
  ('A074564',          'expired',    'Y',    'uptodate',   '06/19/24',  '06/18/29'),
  ('A078837',          'expired',    'Y',    'expired',    NULL,        '11/29/23'),
  ('A078887',          'expired',    'Y',    'uptodate',   '07/25/24',  '07/24/29'),
  ('A084259',          'expired',    'Y',    'uptodate',   '08/28/24',  '08/27/29'),
  ('A084269',          'expired',    'Y',    'expired',    NULL,        '03/14/24'),
  ('A084303',          'expired',    'Y',    'expired',    NULL,        '11/29/23'),
  ('A088065',          'expired',    'Y',    'expired',    NULL,        '10/21/25'),
  ('A101054',          'expired',    'Y',    'expired',    NULL,        '03/14/24'),
  ('A101059',          'expired',    'Y',    'uptodate',   '07/25/24',  '07/24/29'),
  ('A106995',          'expired',    'Y',    'uptodate',   '10/07/25',  '10/06/30'),
  ('A10819',           'expired',    'Y',    'uptodate',   '06/06/24',  '06/05/29'),
  ('A10821',           'expired',    'Y',    'uptodate',   '06/06/24',  '06/05/29'),
  ('A10824',           'expired',    'Y',    'uptodate',   '06/06/24',  '06/05/29'),
  ('A10825',           'expired',    'Y',    'uptodate',   '06/06/24',  '06/05/29'),
  ('A10827',           'expired',    'Y',    'uptodate',   '06/06/24',  '06/05/29'),
  ('A10843',           'expired',    'Y',    'uptodate',   '07/31/23',  '07/29/28'),
  ('A10873',           'expired',    'Y',    'uptodate',   '06/06/24',  '06/05/29'),
  ('A10886',           'expired',    'Y',    'uptodate',   '06/06/24',  '06/05/29'),
  ('A10893',           'expired',    'Y',    'uptodate',   '06/06/24',  '06/05/29'),
  ('A10898',           'expired',    'Y',    'uptodate',   '06/06/24',  '06/05/29'),
  ('A10907',           'expired',    'Y',    'uptodate',   '06/06/24',  '06/05/29'),
  ('A10918',           'expired',    'Y',    'uptodate',   '06/06/24',  '06/05/29'),
  ('A10926',           'expired',    'Y',    'uptodate',   '06/06/24',  '06/05/29'),
  ('A109923',          'expired',    'Y',    'uptodate',   '07/25/24',  '07/24/29'),
  ('A11005',           'expired',    'Y',    'uptodate',   '06/06/24',  '06/05/29'),
  ('A11019',           'expired',    'Y',    'uptodate',   '06/06/24',  '06/05/29'),
  ('A111675',          'expired',    'Y',    'uptodate',   '07/25/24',  '07/24/29'),
  ('A113057',          'expired',    'Y',    'uptodate',   '08/01/24',  '07/31/29'),
  ('A113546',          'expired',    'Y',    'uptodate',   '07/25/24',  '07/24/29'),
  ('A116251',          'expired',    'Y',    'uptodate',   '06/06/24',  '06/05/29'),
  ('A117755',          'expired',    'Y',    'expired',    NULL,        '10/21/25'),
  ('A117976',          'expired',    'Y',    'uptodate',   '07/31/24',  '07/30/29'),
  ('A118198',          'expired',    'Y',    'expired',    NULL,        '03/14/24'),
  ('A118650',          'expired',    'Y',    'expired',    NULL,        '11/29/23'),
  ('A118740',          'expired',    'Y',    'expired',    NULL,        '03/14/24'),
  ('A11913',           'expired',    'Y',    'uptodate',   '06/06/24',  '06/05/29'),
  ('A119135',          'expired',    'Y',    'uptodate',   '06/06/24',  '06/05/29'),
  ('A119932',          'expired',    'Y',    'expired',    NULL,        '03/14/24'),
  ('A120162',          'expired',    'Y',    'expired',    NULL,        '11/29/23'),
  ('A12055',           'expired',    'Y',    'expired',    NULL,        '03/14/24'),
  ('A120553',          'expired',    'Y',    'uptodate',   '08/01/24',  '07/31/29'),
  ('A120575',          'expired',    'Y',    'uptodate',   '06/06/24',  '06/05/29'),
  ('A12076',           'expired',    'Y',    'uptodate',   '06/06/24',  '06/05/29'),
  ('A12089',           'out of service','N', 'expired',    NULL,        '03/26/24'),
  ('A12216',           'expired',    'Y',    'expired',    NULL,        '03/14/24'),
  ('A12350',           'expired',    'Y',    'uptodate',   '06/06/24',  '06/05/29'),
  ('A12357',           'expired',    'Y',    'uptodate',   '06/06/24',  '06/05/29'),
  ('A12395',           'expired',    'Y',    'uptodate',   '06/06/24',  '06/05/29'),
  ('A12410',           'expired',    'Y',    'uptodate',   '06/06/24',  '06/05/29'),
  ('A12418',           'expired',    'Y',    'uptodate',   '06/06/24',  '06/05/29'),
  ('A125463',          'expired',    'Y',    'uptodate',   '06/06/24',  '06/05/29'),
  ('A125789',          'expired',    'Y',    'expired',    NULL,        '11/29/23'),
  ('A125875',          'expired',    'Y',    'expired',    NULL,        '07/25/24'),
  ('A126544',          'expired',    'Y',    'uptodate',   '06/06/24',  '06/05/29'),
  ('A127873',          'expired',    'Y',    'uptodate',   '06/06/24',  '06/05/29'),
  ('A129116',          'expired',    'Y',    'uptodate',   '06/06/24',  '06/05/29'),
  ('A129476',          'expired',    'Y',    'expired',    NULL,        '03/14/24'),
  ('A129623',          'expired',    'Y',    'expired',    NULL,        '11/29/23'),
  ('A129642',          'expired',    'Y',    'expired',    NULL,        '11/29/23'),
  ('A129668',          'expired',    'Y',    'uptodate',   '07/25/24',  '07/24/29'),
  ('A130012',          'expired',    'Y',    'uptodate',   '06/06/24',  '06/05/29'),
  ('A130016',          'expired',    'Y',    'uptodate',   '07/25/24',  '07/24/29'),
  ('A130061',          'expired',    'Y',    'uptodate',   '06/06/24',  '06/05/29'),
  ('A130065',          'expired',    'Y',    'uptodate',   '06/06/24',  '06/05/29'),
  ('A130066',          'expired',    'Y',    'expired',    NULL,        '03/14/24'),
  ('A130300',          'expired',    'Y',    'uptodate',   '06/06/24',  '06/05/29'),
  ('A130312',          'out of service','N', 'expired',    NULL,        '04/29/24'),
  ('A130569',          'expired',    'Y',    'uptodate',   '06/06/24',  '06/05/29'),
  ('A130585',          'out of service','N', 'expired',    NULL,        '04/29/24'),
  ('A130601',          'expired',    'Y',    'uptodate',   '06/19/24',  '06/18/29'),
  ('A130621',          'expired',    'Y',    'expired',    NULL,        '03/14/24'),
  ('A130900',          'expired',    'Y',    'uptodate',   '07/25/24',  '07/24/29'),
  ('A131152',          'expired',    'Y',    'expired',    NULL,        '11/29/23'),
  ('A131164',          'out of service','N', 'expired',    NULL,        '04/29/24'),
  ('A131182',          'expired',    'Y',    'uptodate',   '07/25/24',  '07/24/29'),
  ('A131190',          'out of service','N', 'expired',    NULL,        '04/29/24'),
  ('A131617',          'expired',    'Y',    'uptodate',   '06/06/24',  '06/05/29'),
  ('A133570',          'expired',    'Y',    'expired',    NULL,        '11/29/23'),
  ('A133587',          'expired',    'Y',    'uptodate',   '07/25/24',  '07/24/29'),
  ('A133736',          'expired',    'Y',    'uptodate',   '07/25/24',  '07/24/29'),
  ('A134711',          'expired',    'Y',    'expired',    NULL,        '10/21/25'),
  ('A134993',          'expired',    'Y',    'uptodate',   '06/06/24',  '06/05/29'),
  ('A135104',          'expired',    'Y',    'uptodate',   '06/06/24',  '06/05/29'),
  ('A135837',          'expired',    'Y',    'uptodate',   '07/31/24',  '07/30/29'),
  ('A138885',          'expired',    'Y',    'uptodate',   '07/25/24',  '07/24/29'),
  ('A14042',           'expired',    'Y',    'expired',    NULL,        '10/21/25'),
  ('A140426',          'expired',    'Y',    'expired',    NULL,        '11/29/23'),
  ('A141608',          'expired',    'Y',    'uptodate',   '09/17/24',  '09/16/29'),
  ('A141919',          'expired',    'Y',    'uptodate',   '07/25/24',  '07/24/29'),
  ('A142679',          'expired',    'Y',    'uptodate',   '07/25/24',  '07/24/29'),
  ('A142911',          'expired',    'Y',    'uptodate',   '06/06/24',  '06/05/29'),
  ('A143215',          'expired',    'Y',    'expired',    NULL,        '03/14/24'),
  ('A144496',          'expired',    'Y',    'uptodate',   '07/25/24',  '07/24/29'),
  ('A144700',          'expired',    'Y',    'uptodate',   '06/06/24',  '06/05/29'),
  ('A145124',          'expired',    'Y',    'uptodate',   '06/06/24',  '06/05/29'),
  ('A146592',          'expired',    'Y',    'expired',    NULL,        '03/14/24'),
  ('A14911',           'expired',    'Y',    'expired',    NULL,        '03/14/24'),
  ('A14977',           'expired',    'Y',    'expired',    NULL,        '03/14/24'),
  ('A150209',          'expired',    'Y',    'uptodate',   '06/06/24',  '06/05/29'),
  ('A150912',          'expired',    'Y',    'expired',    NULL,        '10/21/25'),
  ('A150942',          'expired',    'Y',    'uptodate',   '07/25/24',  '07/24/29'),
  ('A152669',          'expired',    'Y',    'expired',    NULL,        '03/14/24'),
  ('A15285',           'expired',    'Y',    'uptodate',   '06/06/24',  '06/05/29'),
  ('A153798',          'expired',    'Y',    'uptodate',   '03/01/24',  '02/28/29'),
  ('A155278',          'expired',    'Y',    'expired',    NULL,        '11/29/23'),
  ('A155509',          'out of service','N', 'expired',    NULL,        '03/14/24'),
  ('A156151',          'expired',    'Y',    'uptodate',   '08/20/24',  '08/19/29'),
  ('A156161',          'expired',    'Y',    'expired',    NULL,        '03/14/24'),
  ('A156767',          'expired',    'Y',    'uptodate',   '06/06/24',  '06/05/29'),
  ('A156864',          'expired',    'Y',    'uptodate',   '06/06/24',  '06/05/29'),
  ('A159087',          'expired',    'Y',    'uptodate',   '07/31/23',  '07/29/28'),
  ('A159143',          'expired',    'Y',    'uptodate',   '06/06/24',  '06/05/29'),
  ('A16146',           'expired',    'Y',    'uptodate',   '07/25/24',  '07/24/29'),
  ('A163239',          'expired',    'Y',    'uptodate',   '07/25/24',  '07/24/29'),
  ('A164508',          'expired',    'Y',    'uptodate',   '08/05/24',  '08/04/29'),
  ('A164598',          'expired',    'Y',    'uptodate',   '06/06/24',  '06/05/29'),
  ('A16549',           'expired',    'Y',    'uptodate',   '08/01/24',  '07/31/29'),
  ('A16690',           'expired',    'Y',    'uptodate',   '06/06/24',  '06/05/29'),
  ('A16906',           'expired',    'Y',    'expired',    NULL,        '03/14/24'),
  ('A18676',           'expired',    'Y',    'uptodate',   '10/07/25',  '10/06/30'),
  ('A18678',           'expired',    'Y',    'uptodate',   '06/06/24',  '06/05/29'),
  ('A1877',            'expired',    'Y',    'uptodate',   '06/06/24',  '06/05/29'),
  ('A19584',           'expired',    'Y',    'uptodate',   '06/06/24',  '06/05/29'),
  ('A19703',           'expired',    'Y',    'uptodate',   '06/06/24',  '06/05/29'),
  ('A2047',            'expired',    'Y',    'uptodate',   '08/01/24',  '07/31/29'),
  ('A28523',           'expired',    'Y',    'expired',    NULL,        '03/14/24'),
  ('A29013',           'expired',    'Y',    'uptodate',   '06/06/24',  '06/05/29'),
  ('A29018',           'expired',    'Y',    'expired',    NULL,        '10/21/25'),
  ('A29809',           'expired',    'Y',    'uptodate',   '07/25/24',  '07/24/29'),
  ('A30632',           'expired',    'Y',    'uptodate',   '07/25/24',  '07/24/29'),
  ('A30642',           'expired',    'Y',    'uptodate',   '08/20/24',  '08/19/29'),
  ('A30951',           'expired',    'Y',    'expired',    NULL,        '10/21/25'),
  ('A3136',            'expired',    'Y',    'uptodate',   '06/06/24',  '06/05/29'),
  ('A31546',           'expired',    'Y',    'expired',    NULL,        '03/14/24'),
  ('A31904',           'expired',    'Y',    'expired',    NULL,        '11/29/23'),
  ('A3332',            'expired',    'Y',    'uptodate',   '07/25/24',  '07/24/29'),
  ('A34133',           'expired',    'Y',    'uptodate',   '07/15/25',  '07/14/30'),
  ('A34484',           'expired',    'Y',    'uptodate',   '06/06/24',  '06/05/29'),
  ('A36442',           'expired',    'Y',    'uptodate',   '06/06/24',  '06/05/29'),
  ('A4018',            'expired',    'Y',    'expired',    NULL,        '11/29/23'),
  ('A4020',            'expired',    'Y',    'uptodate',   '07/25/24',  '07/24/29'),
  ('A41982',           'expired',    'Y',    'expired',    NULL,        '03/14/24'),
  ('A43372',           'expired',    'Y',    'uptodate',   '06/06/24',  '06/05/29'),
  ('A46685',           'expired',    'Y',    'uptodate',   '08/20/24',  '08/19/29'),
  ('A50125',           'expired',    'Y',    'expired',    NULL,        '11/29/23'),
  ('A50442',           'expired',    'Y',    'uptodate',   '06/19/24',  '06/18/29'),
  ('A54661',           'expired',    'Y',    'uptodate',   '08/20/24',  '08/19/29'),
  ('A5630',            'expired',    'Y',    'expired',    NULL,        '10/21/25'),
  ('A80951',           'expired',    'Y',    'uptodate',   '07/25/24',  '07/24/29'),
  ('A99519',           'expired',    'Y',    'uptodate',   '07/25/24',  '07/24/29'),
  ('AL2216',           'expired',    'Y',    'expired',    NULL,        '03/14/24'),
  ('CJ0002888',        'expired',    'Y',    'uptodate',   '06/19/24',  '06/18/29'),
  ('CJ0003346',        'expired',    'Y',    'uptodate',   '06/06/24',  '06/05/29'),
  ('CJ003346',         'expired',    'Y',    'expired',    NULL,        '10/22/25'),
  ('CJ003646',         'expired',    'Y',    'uptodate',   '07/03/24',  '07/02/29'),
  ('DG05339',          'expired',    'Y',    'expired',    NULL,        '03/14/24'),
  ('DG107810',         'expired',    'Y',    'uptodate',   '06/19/24',  '06/18/29'),
  ('DG113778',         'expired',    'Y',    'uptodate',   '08/26/24',  '08/25/29'),
  ('DG120533',         'expired',    'Y',    'uptodate',   '06/19/24',  '06/18/29'),
  ('DG124272',         'expired',    'Y',    'uptodate',   '04/24/24',  '04/23/29'),
  ('DG130922',         'expired',    'Y',    'uptodate',   '06/06/24',  '06/05/29'),
  ('DG134641',         'expired',    'Y',    'expired',    NULL,        '12/08/23'),
  ('DG140856',         'expired',    'Y',    'uptodate',   '07/03/24',  '07/02/29'),
  ('DG1416',           'expired',    'Y',    'uptodate',   '07/03/24',  '07/02/29'),
  ('DG147007',         'expired',    'Y',    'uptodate',   '06/19/24',  '06/18/29'),
  ('DG173333',         'expired',    'Y',    'expired',    NULL,        '03/14/24'),
  ('DG173335',         'expired',    'Y',    'expired',    NULL,        '03/14/24'),
  ('DG175387',         'expired',    'Y',    'expired',    NULL,        '07/03/24'),
  ('DG178074',         'uptodate',   'Y',    'uptodate',   '07/26/24',  '07/25/29'),
  ('DG178087',         'expired',    'Y',    'expired',    NULL,        '10/22/25'),
  ('DG179833',         'expired',    'Y',    'uptodate',   '07/03/24',  '07/02/29'),
  ('DG225401',         'expired',    'Y',    'uptodate',   '06/06/24',  '06/05/29'),
  ('DG260001',         'expired',    'Y',    'uptodate',   '06/06/24',  '06/05/29'),
  ('DG260031',         'expired',    'Y',    'uptodate',   '06/06/24',  '06/05/29'),
  ('DG263305',         'expired',    'Y',    'uptodate',   '07/03/24',  '07/02/29'),
  ('DG276484',         'expired',    'Y',    'expired',    NULL,        '10/22/25'),
  ('DG277807',         'expired',    'Y',    'uptodate',   '06/06/24',  '06/05/29'),
  ('DG279138',         'expired',    'Y',    'expired',    NULL,        '03/14/24'),
  ('DG283445',         'expired',    'Y',    'expired',    NULL,        '10/22/25'),
  ('DG297255',         'expired',    'Y',    'uptodate',   '07/03/24',  '07/02/29'),
  ('DG306339',         'expired',    'Y',    'uptodate',   '07/03/24',  '07/02/29'),
  ('DG313182',         'expired',    'Y',    'expired',    NULL,        '10/22/25'),
  ('DG330123',         'expired',    'Y',    'uptodate',   '06/06/24',  '06/05/29'),
  ('DG36738',          'expired',    'Y',    'expired',    NULL,        '10/22/25'),
  ('DG375025',         'expired',    'Y',    'uptodate',   '06/06/24',  '06/05/29'),
  ('DG384247',         'expired',    'Y',    'uptodate',   '06/06/24',  '06/05/29'),
  ('DG395657',         'expired',    'Y',    'expired',    NULL,        '03/14/24'),
  ('DG396659',         'expired',    'Y',    'uptodate',   '06/06/24',  '06/05/29'),
  ('DG404151',         'expired',    'Y',    'uptodate',   '06/06/24',  '06/05/29'),
  ('DG40455',          'expired',    'Y',    'uptodate',   '06/06/24',  '06/05/29'),
  ('DG405569',         'expired',    'Y',    'expired',    NULL,        '11/29/23'),
  ('DG412286',         'expired',    'Y',    'uptodate',   '06/06/24',  '06/05/29'),
  ('DG418323',         'expired',    'Y',    'uptodate',   '07/03/24',  '07/02/29'),
  ('DG435835',         'expired',    'Y',    'uptodate',   '06/06/24',  '06/05/29'),
  ('DG440455',         'expired',    'Y',    'expired',    NULL,        '10/22/25'),
  ('DG455830',         'expired',    'Y',    'uptodate',   '06/06/24',  '06/05/29'),
  ('DG45830',          'expired',    'Y',    'expired',    NULL,        '07/30/24'),
  ('DG459124',         'expired',    'Y',    'uptodate',   '07/03/24',  '07/02/29'),
  ('DG471155',         'expired',    'Y',    'uptodate',   '06/06/24',  '06/05/29'),
  ('DG471156',         'expired',    'Y',    'uptodate',   '07/03/24',  '07/02/29'),
  ('DG471173',         'expired',    'Y',    'expired',    NULL,        '03/14/24'),
  ('DG471195',         'expired',    'Y',    'uptodate',   '06/06/24',  '06/05/29'),
  ('DG475029',         'expired',    'Y',    'expired',    NULL,        '03/14/24'),
  ('DG489261',         'expired',    'Y',    'uptodate',   '06/19/24',  '06/18/29'),
  ('DG61895',          'expired',    'Y',    'uptodate',   '06/19/24',  '06/18/29'),
  ('DG61916',          'expired',    'Y',    'uptodate',   '07/03/24',  '07/02/29'),
  ('DG68299',          'expired',    'Y',    'uptodate',   '06/06/24',  '06/05/29'),
  ('DG76284',          'uptodate',   'Y',    'uptodate',   '01/02/26',  '01/01/31'),
  ('DG76384',          'uptodate',   'Y',    'uptodate',   '08/21/24',  '08/20/29'),
  ('DG770',            'expired',    'Y',    'uptodate',   '06/19/24',  '06/18/29'),
  ('DG78656',          'uptodate',   'Y',    'uptodate',   '07/26/24',  '07/25/29'),
  ('DG85129',          'expired',    'Y',    'expired',    NULL,        '03/14/24'),
  ('J047183',          'expired',    'Y',    'uptodate',   '06/06/24',  '06/05/29'),
  ('J98251',           'expired',    'Y',    'uptodate',   '07/25/24',  '07/24/29'),
  ('JD47183',          'expired',    'Y',    'uptodate',   '07/25/24',  '07/24/29'),
  ('T1279128',         'expired',    'Y',    'expired',    NULL,        '10/22/25'),
  ('T13752',           'expired',    'Y',    'uptodate',   '06/06/24',  '06/05/29'),
  ('T16193',           'expired',    'Y',    'uptodate',   '06/06/24',  '06/05/29'),
  ('T164675',          'expired',    'Y',    'uptodate',   '07/03/24',  '07/02/29'),
  ('T20423',           'expired',    'Y',    'uptodate',   '07/03/24',  '07/02/29'),
  ('T211532',          'expired',    'Y',    'uptodate',   '06/06/24',  '06/05/29'),
  ('T211727',          'expired',    'Y',    'expired',    NULL,        '03/14/24'),
  ('T21798',           'expired',    'Y',    'uptodate',   '06/06/24',  '06/05/29'),
  ('T224612',          'expired',    'Y',    'uptodate',   '07/03/24',  '07/02/29'),
  ('T227400',          'expired',    'Y',    'uptodate',   '07/03/24',  '07/02/29'),
  ('T240883',          'expired',    'Y',    'uptodate',   '07/03/24',  '07/02/29'),
  ('T249846',          'expired',    'Y',    'expired',    NULL,        '03/14/24'),
  ('T255549',          'expired',    'Y',    'expired',    NULL,        '03/14/24'),
  ('T260737',          'expired',    'Y',    'uptodate',   '07/03/24',  '07/02/29'),
  ('T269185',          'expired',    'Y',    'expired',    NULL,        '03/14/24'),
  ('T269272',          'uptodate',   'Y',    'uptodate',   '08/21/24',  '08/20/29'),
  ('T276279',          'expired',    'Y',    'expired',    NULL,        '03/14/24'),
  ('T279120',          'expired',    'Y',    'uptodate',   '06/19/24',  '06/18/29'),
  ('T279128',          'expired',    'Y',    'uptodate',   '07/03/24',  '07/02/29'),
  ('T280420',          'expired',    'Y',    'uptodate',   '06/06/24',  '06/05/29'),
  ('T38565',           'expired',    'Y',    'expired',    NULL,        '03/14/24'),
  ('T81425',           'expired',    'Y',    'uptodate',   '06/06/24',  '06/05/29'),
  ('T84425',           'expired',    'Y',    'expired',    NULL,        '03/14/24'),
  ('T91425',           'expired',    'Y',    'uptodate',   '07/03/24',  '07/02/29'),
  ('T95368',           'expired',    'Y',    'uptodate',   '06/19/24',  '06/18/29'),
  ('T95568',           'expired',    'Y',    'uptodate',   '06/19/24',  '06/18/29')
) AS s(serial, kpa_status, in_svc, hydro_status, hydro_last, hydro_exp);

-- ============================================================
-- STEP 4: INSERT MONITORS
-- No calibration dates in KPA export for monitors.
-- BZ1 Tower status was blank in KPA → available.
-- 230631S-009 and 230631T-009 skipped (Lost f/Location).
-- ============================================================

INSERT INTO serialized_equipment
  (id, product_id, serial_number, ownership, status,
   custom_data, created_at, updated_at)
SELECT
  gen_random_uuid(),
  (SELECT id FROM products WHERE part_number = m.pn),
  m.serial,
  'basin_safety'::"EquipmentOwnership",
  'available'::"EquipmentStatus",
  jsonb_build_object('kpa_status', m.kpa_status, 'yard', m.yard),
  NOW(), NOW()
FROM (VALUES
--  serial              part_number     kpa_status   yard
  -- BZ1 Towers
  ('16040D-001',       'MON-BZ1',      '',          'Williston'),
  ('16112P0-005',      'MON-BZ1',      '',          'Williston'),
  ('17012VJ-006',      'MON-BZ1',      '',          'Williston'),
  ('17043S7-002',      'MON-BZ1',      '',          'Dickinson'),
  ('17052N9-015',      'MON-BZ1',      '',          'Williston'),
  ('170610X-016',      'MON-BZ1',      '',          'Williston'),
  ('17090MP-001',      'MON-BZ1',      '',          'Williston'),
  ('17091SN-027',      'MON-BZ1',      '',          'Williston'),
  ('17113HU-038',      'MON-BZ1',      '',          'Williston'),
  ('17113HU-040',      'MON-BZ1',      '',          'Williston'),
  ('17113RM-003',      'MON-BZ1',      '',          'Williston'),
  ('18073HK-003',      'MON-BZ1',      '',          'Williston'),
  ('180924F-003',      'MON-BZ1',      '',          'Dickinson'),
  ('18113VM-001',      'MON-BZ1',      '',          'Williston'),
  ('1901178-002',      'MON-BZ1',      '',          'Williston'),
  ('19080D6-040',      'MON-BZ1',      '',          'Williston'),
  ('190829G-069',      'MON-BZ1',      '',          'Williston'),
  ('19100EM-024',      'MON-BZ1',      '',          'Williston'),
  ('1911180-002',      'MON-BZ1',      '',          'Williston'),
  ('20080HL-005',      'MON-BZ1',      '',          'Williston'),
  ('21071ZL-027',      'MON-BZ1',      '',          'Dickinson'),
  ('22093HR-010',      'MON-BZ1',      '',          'Williston'),
  ('22111ZA-006',      'MON-BZ1',      '',          'Williston'),
  ('22120ZZ-001',      'MON-BZ1',      '',          'Williston'),
  ('22120ZZ-002',      'MON-BZ1',      '',          'Williston'),
  ('22120ZZ-003',      'MON-BZ1',      '',          'Williston'),
  ('22120ZZ-004',      'MON-BZ1',      '',          'Williston'),
  ('22120ZZ-005',      'MON-BZ1',      '',          'Williston'),
  ('23031W6-007',      'MON-BZ1',      '',          'Williston'),
  ('23060WW-001',      'MON-BZ1',      '',          'Williston'),
  ('23060WW-002',      'MON-BZ1',      '',          'Williston'),
  ('230631T-001',      'MON-BZ1',      '',          'Williston'),
  ('230631T-002',      'MON-BZ1',      '',          'Williston'),
  ('230631T-003',      'MON-BZ1',      '',          'Williston'),
  ('230631T-004',      'MON-BZ1',      '',          'Williston'),
  ('230631T-005',      'MON-BZ1',      '',          'Williston'),
  ('230631T-006',      'MON-BZ1',      '',          'Williston'),
  ('230631T-007',      'MON-BZ1',      '',          'Williston'),
  ('230631T-008',      'MON-BZ1',      '',          'Williston'),
  -- 230631T-009 SKIPPED — Lost f/Location
  ('230631T-010',      'MON-BZ1',      '',          'Williston'),
  -- Area Monitors (BW RigRat)
  ('16041M4-001',      'MON-AREA-BW',  'expired',   'Williston'),
  ('16041T8-001',      'MON-AREA-BW',  'expired',   'Williston'),
  ('16083DE-008',      'MON-AREA-BW',  'expired',   'Williston'),
  ('16123FX-001',      'MON-AREA-BW',  'expired',   'Williston'),
  ('17010PY-012',      'MON-AREA-BW',  'expired',   'Williston'),
  ('17052NE-004',      'MON-AREA-BW',  'expired',   'Williston'),
  ('17052NF-004',      'MON-AREA-BW',  'expired',   'Williston'),
  ('17113RL-009',      'MON-AREA-BW',  'expired',   'Williston'),
  ('17121XN-018',      'MON-AREA-BW',  'expired',   'Williston'),
  ('18022Q2-050',      'MON-AREA-BW',  'expired',   'Williston'),
  ('18023XQ-006',      'MON-AREA-BW',  'expired',   'Dickinson'),
  ('180319H-013',      'MON-AREA-BW',  'expired',   'Williston'),
  ('18042GZ-010',      'MON-AREA-BW',  'expired',   'Williston'),
  ('180441L-001',      'MON-AREA-BW',  'expired',   'Dickinson'),
  ('180441L-002',      'MON-AREA-BW',  'expired',   'Williston'),
  ('180720K-006',      'MON-AREA-BW',  'expired',   'Williston'),
  ('19050XJ-003',      'MON-AREA-BW',  'expired',   'Williston'),
  ('19052S9-002',      'MON-AREA-BW',  'expired',   'Williston'),
  ('19062SL-001',      'MON-AREA-BW',  'expired',   'Dickinson'),
  ('19072NV-001',      'MON-AREA-BW',  'expired',   'Williston'),
  ('19081DN-009',      'MON-AREA-BW',  'expired',   'Williston'),
  ('19100EX-002',      'MON-AREA-BW',  'expired',   'Williston'),
  ('19103NG-001',      'MON-AREA-BW',  'expired',   'Williston'),
  ('20021GD-002',      'MON-AREA-BW',  'expired',   'Williston'),
  ('200413E-002',      'MON-AREA-BW',  'expired',   'Williston'),
  ('220413E-002',      'MON-AREA-BW',  'expired',   'Williston'),
  ('220608T-008',      'MON-AREA-BW',  'expired',   'Williston'),
  ('22120ZY-001',      'MON-AREA-BW',  'expired',   'Williston'),
  ('22120ZY-002',      'MON-AREA-BW',  'expired',   'Williston'),
  ('22120ZY-003',      'MON-AREA-BW',  'expired',   'Williston'),
  ('22120ZY-004',      'MON-AREA-BW',  'expired',   'Williston'),
  ('22120ZY-005',      'MON-AREA-BW',  'expired',   'Williston'),
  ('230631S-001',      'MON-AREA-BW',  'expired',   'Williston'),
  ('230631S-002',      'MON-AREA-BW',  'expired',   'Williston'),
  ('230631S-003',      'MON-AREA-BW',  'expired',   'Williston'),
  ('230631S-004',      'MON-AREA-BW',  'expired',   'Williston'),
  ('230631S-005',      'MON-AREA-BW',  'expired',   'Williston'),
  ('230631S-006',      'MON-AREA-BW',  'expired',   'Williston'),
  ('230631S-007',      'MON-AREA-BW',  'expired',   'Williston'),
  ('230631S-008',      'MON-AREA-BW',  'expired',   'Williston'),
  -- 230631S-009 SKIPPED — Lost f/Location
  ('230631S-010',      'MON-AREA-BW',  'expired',   'Williston'),
  ('3589402192',       'MON-AREA-BW',  'expired',   'Williston'),
  ('3589402199',       'MON-AREA-BW',  'expired',   'Williston'),
  ('HRRD000025A7',     'MON-AREA-BW',  'expired',   'Williston'),
  ('HRRD030002B7',     'MON-AREA-BW',  'expired',   'Williston'),
  ('HRRD030003B7',     'MON-AREA-BW',  'expired',   'Williston'),
  ('HRRD532001C4',     'MON-AREA-BW',  'expired',   'Williston'),
  ('HRRD532002B7',     'MON-AREA-BW',  'expired',   'Williston'),
  ('HRRD532002BA',     'MON-AREA-BW',  'expired',   'Williston'),
  ('HRRD532002BB',     'MON-AREA-BW',  'expired',   'Williston'),
  ('HRRD532003BA',     'MON-AREA-BW',  'expired',   'Williston'),
  ('HRRD532003BC',     'MON-AREA-BW',  'expired',   'Williston'),
  ('HRRD532004BB',     'MON-AREA-BW',  'expired',   'Williston'),
  ('HRRD532005BB',     'MON-AREA-BW',  'expired',   'Williston'),
  ('HRRD532005BC',     'MON-AREA-BW',  'expired',   'Williston'),
  ('HRRD532007C1',     'MON-AREA-BW',  'expired',   'Williston'),
  ('HRRD532008BC',     'MON-AREA-BW',  'expired',   'Williston'),
  ('HRRD532012BA',     'MON-AREA-BW',  'expired',   'Williston'),
  ('HRRD532013BA',     'MON-AREA-BW',  'expired',   'Williston'),
  ('HRRD532014BA',     'MON-AREA-BW',  'expired',   'Williston'),
  ('HRRD532016BA',     'MON-AREA-BW',  'expired',   'Williston'),
  ('HRRD532018DB',     'MON-AREA-BW',  'expired',   'Dickinson'),
  ('HRRD532019DB',     'MON-AREA-BW',  'expired',   'Williston'),
  ('HRRD532020DB',     'MON-AREA-BW',  'expired',   'Williston'),
  ('HRRD532021DB',     'MON-AREA-BW',  'expired',   'Williston'),
  ('HRRD532022DB',     'MON-AREA-BW',  'expired',   'Williston'),
  ('HRRD532023DB',     'MON-AREA-BW',  'expired',   'Dickinson'),
  ('HRRD532024DB',     'MON-AREA-BW',  'expired',   'Williston'),
  ('HRRD532025DB',     'MON-AREA-BW',  'expired',   'Williston'),
  ('HRRD532026DB',     'MON-AREA-BW',  'expired',   'Dickinson'),
  ('HRRD532027DB',     'MON-AREA-BW',  'expired',   'Williston')
) AS m(serial, pn, kpa_status, yard);

-- ============================================================
-- VERIFICATION
-- ============================================================
SELECT
  p.part_number,
  p.name,
  COUNT(se.id)                                            AS total,
  COUNT(se.id) FILTER (WHERE se.status = 'available')    AS available,
  COUNT(se.id) FILTER (WHERE se.status = 'repair')       AS repair,
  COUNT(se.id) FILTER (WHERE se.calibration_due_date < CURRENT_DATE
                          AND se.calibration_due_date IS NOT NULL) AS hydro_overdue
FROM products p
JOIN serialized_equipment se ON se.product_id = p.id
WHERE p.part_number IN ('SCBA-30MIN','MON-AREA-BW','MON-BZ1')
GROUP BY p.part_number, p.name
ORDER BY p.part_number;

-- Uncomment to finalize:
-- COMMIT;

-- Or to abort:
-- ROLLBACK;
