-- ============================================================
-- SUNDOG EQUIPMENT RESET — Air Trailers & Bottles
-- Generated: 2026-03-31
-- Sources:
--   Williston: Copy of Trailer Cylinders.docx
--   Dickinson: TRAILER CYLINDERS FOR DICKINSON AIR TRAILERS.docx
--   KPA export: equipment-1774982660841.csv
--
-- Trailer serials:   TRL-01 … TRL-31, TRL-1000, TRL-1001  (Williston)
--                    TRL-05-DK, TRL-07-DK, TRL-10-DK, TRL-15-DK,
--                    TRL-16-DK, TRL-17-DK, TRL-21-DK, TRL-30-DK  (Dickinson)
--   (TRL-32 skipped — no bottle serials recorded)
--
-- ⚠️  KNOWN SERIAL CONFLICTS (ON CONFLICT DO NOTHING — first insert wins)
--   TRL-07-DK   : all 6 cylinders identical to TRL-07 WIL → TRL-07-DK gets none
--   TRL-10-DK   : 7 of 8 cylinders identical to TRL-10 WIL → only JP5195155 lands
--   TRL-15-DK   : all 4 cylinders identical to TRL-15 WIL → TRL-15-DK gets none
--   TRL-16-DK   : JP13S432117 conflicts with TRL-19 WIL → 3 of 4 land
--   TRL-21-DK   : MB-1130 conflicts with TRL-21 WIL → 3 of 4 land
--   TRL-30-DK   : 3665923Y, 4344021Y, 53935X conflict with TRL-30 WIL → 7 of 10 land
--   TRL-23      : 4 cylinders also in TRL-17 WIL → TRL-23 gets 6 of 10
--   TRL-25      : V758053, V758085, V758123 also in TRL-09 → TRL-25 gets 5 of 8
-- Field sup needs to verify and reassign affected bottles.
--
-- ⚠️  All bottles use product 'AIR-TANK-30' (only serialized air-supply
--     product in catalog). 2400 PSI vs 4500 PSI captured in custom_data.psi.
--
-- ⚠️  DESTRUCTIVE — take a pg_dump backup before running.
-- ⚠️  Runs inside a transaction — inspect row counts before COMMIT.
-- ============================================================

BEGIN;

-- ============================================================
-- STEP 0: GUARD — abort if rental line items or repair orders exist
--   (they hold NOT NULL FKs to serialized_equipment).
--   Remove these checks if you want to wipe those records too.
-- ============================================================
DO $$
DECLARE
  rai_count  INTEGER;
  ro_count   INTEGER;
BEGIN
  SELECT COUNT(*) INTO rai_count FROM rental_agreement_items;
  SELECT COUNT(*) INTO ro_count  FROM repair_orders;
  IF rai_count > 0 THEN
    RAISE EXCEPTION 'rental_agreement_items has % row(s). Resolve FK conflict before running.', rai_count;
  END IF;
  IF ro_count > 0 THEN
    RAISE EXCEPTION 'repair_orders has % row(s). Resolve FK conflict before running.', ro_count;
  END IF;
END $$;

-- ============================================================
-- STEP 0b: NULL out nullable FKs in dependent tables
-- ============================================================
UPDATE ticket_line_item
   SET equipment_id_installed = NULL
 WHERE equipment_id_installed IS NOT NULL;

UPDATE ticket_line_item
   SET equipment_id_removed = NULL
 WHERE equipment_id_removed IS NOT NULL;

UPDATE shop_work_order_items
   SET serialized_equipment_id = NULL
 WHERE serialized_equipment_id IS NOT NULL;

-- ============================================================
-- STEP 0c: Break self-referential parent link, then delete all
-- ============================================================
UPDATE serialized_equipment SET parent_equipment_id = NULL;
DELETE FROM serialized_equipment;

-- ============================================================
-- STEP 1: TRAILERS (parent records — no parent_equipment_id)
-- ============================================================
INSERT INTO serialized_equipment
  (id, product_id, serial_number, ownership, status, custom_data, created_at, updated_at)
SELECT
  gen_random_uuid(),
  prod.id,
  t.serial,
  'basin_safety'::"EquipmentOwnership",
  'available'::"EquipmentStatus",
  t.cdata::jsonb,
  NOW(), NOW()
FROM (VALUES
  -- Williston — 2400 PSI
  ('TRL-01',    'TRL-2400', '{"psi":2400,"yard":"Williston"}'),
  ('TRL-02',    'TRL-2400', '{"psi":2400,"yard":"Williston"}'),
  ('TRL-03',    'TRL-2400', '{"psi":2400,"yard":"Williston"}'),
  ('TRL-04',    'TRL-2400', '{"psi":2400,"yard":"Williston"}'),
  ('TRL-10',    'TRL-2400', '{"psi":2400,"yard":"Williston"}'),
  ('TRL-11',    'TRL-2400', '{"psi":2400,"yard":"Williston"}'),
  ('TRL-12',    'TRL-2400', '{"psi":2400,"yard":"Williston"}'),
  ('TRL-13',    'TRL-2400', '{"psi":2400,"yard":"Williston"}'),
  ('TRL-14',    'TRL-2400', '{"psi":2400,"yard":"Williston"}'),
  ('TRL-15',    'TRL-2400', '{"psi":2400,"yard":"Williston"}'),
  ('TRL-16',    'TRL-2400', '{"psi":2400,"yard":"Williston"}'),
  ('TRL-17',    'TRL-2400', '{"psi":2400,"yard":"Williston"}'),
  ('TRL-18',    'TRL-2400', '{"psi":2400,"yard":"Williston"}'),
  ('TRL-19',    'TRL-2400', '{"psi":2400,"yard":"Williston"}'),
  ('TRL-20',    'TRL-2400', '{"psi":2400,"yard":"Williston"}'),
  ('TRL-21',    'TRL-2400', '{"psi":2400,"yard":"Williston"}'),
  ('TRL-22',    'TRL-2400', '{"psi":2400,"yard":"Williston"}'),
  ('TRL-23',    'TRL-2400', '{"psi":2400,"yard":"Williston"}'),
  ('TRL-26',    'TRL-2400', '{"psi":2400,"yard":"Williston"}'),
  ('TRL-28',    'TRL-2400', '{"psi":2400,"yard":"Williston"}'),
  ('TRL-29',    'TRL-2400', '{"psi":2400,"yard":"Williston"}'),
  ('TRL-30',    'TRL-2400', '{"psi":2400,"yard":"Williston"}'),
  ('TRL-31',    'TRL-2400', '{"psi":2400,"yard":"Williston"}'),
  -- Williston — 4500 PSI
  ('TRL-05',    'TRL-4500', '{"psi":4500,"yard":"Williston"}'),
  ('TRL-06',    'TRL-4500', '{"psi":4500,"yard":"Williston"}'),
  ('TRL-07',    'TRL-4500', '{"psi":4500,"yard":"Williston"}'),
  ('TRL-08',    'TRL-4500', '{"psi":4500,"yard":"Williston"}'),
  ('TRL-09',    'TRL-4500', '{"psi":4500,"yard":"Williston"}'),
  ('TRL-24',    'TRL-4500', '{"psi":4500,"yard":"Williston"}'),
  ('TRL-25',    'TRL-4500', '{"psi":4500,"yard":"Williston"}'),
  ('TRL-27',    'TRL-4500', '{"psi":4500,"yard":"Williston"}'),
  -- KPA extras — no cylinder data on file
  ('TRL-1000',  'TRL-2400', '{"psi":2400,"yard":"Williston"}'),
  ('TRL-1001',  'TRL-2400', '{"psi":2400,"yard":"Williston","kpa_status":"expired"}'),
  -- Dickinson — separate units (DK doc)
  ('TRL-05-DK', 'TRL-4500', '{"psi":4500,"yard":"Dickinson"}'),
  ('TRL-07-DK', 'TRL-4500', '{"psi":4500,"yard":"Dickinson"}'),
  ('TRL-10-DK', 'TRL-2400', '{"psi":2400,"yard":"Dickinson"}'),
  ('TRL-15-DK', 'TRL-2400', '{"psi":2400,"yard":"Dickinson"}'),
  ('TRL-16-DK', 'TRL-2400', '{"psi":2400,"yard":"Dickinson"}'),
  ('TRL-17-DK', 'TRL-2400', '{"psi":2400,"yard":"Dickinson"}'),
  ('TRL-21-DK', 'TRL-2400', '{"psi":2400,"yard":"Dickinson"}'),
  ('TRL-30-DK', 'TRL-2400', '{"psi":2400,"yard":"Dickinson"}')
) AS t(serial, pn, cdata)
JOIN product prod ON prod.part_number = t.pn;

-- ============================================================
-- STEP 2: AIR BOTTLES (child equipment)
-- ============================================================
-- Format per row: (serial, trailer_serial, hydro_date, custom_data_json)
-- calibration_due_date computed as hydro_date + 5 years
-- ON CONFLICT (serial_number) DO NOTHING — see header for conflict list
-- ============================================================
INSERT INTO serialized_equipment
  (id, product_id, serial_number, ownership, status, custom_data,
   parent_equipment_id, last_calibration_date, calibration_due_date,
   created_at, updated_at)
SELECT
  gen_random_uuid(),
  prod.id,
  c.serial,
  'basin_safety'::"EquipmentOwnership",
  'available'::"EquipmentStatus",
  c.cdata::jsonb,
  parent.id,
  c.hydro::date,
  (c.hydro::date + interval '5 years')::date,
  NOW(), NOW()
FROM (VALUES

  -- ==========================================================
  -- WILLISTON TRAILERS
  -- ==========================================================

  -- TRL-01 (2400 PSI, Williston)
  ('JD D3339062',  'TRL-01', '2018-10-01', '{"psi":2400}'),
  ('JD D3339019',  'TRL-01', '2018-10-01', '{"psi":2400}'),
  ('JD D3340007',  'TRL-01', '2018-10-01', '{"psi":2400}'),
  ('JD D3358199',  'TRL-01', '2018-11-01', '{"psi":2400}'),
  ('JD D3358191',  'TRL-01', '2018-11-01', '{"psi":2400}'),
  ('JD D3339004',  'TRL-01', '2018-10-01', '{"psi":2400}'),
  ('JD D5355039',  'TRL-01', '2023-06-01', '{"psi":2400}'),
  ('JD D5351007',  'TRL-01', '2023-06-01', '{"psi":2400}'),
  ('JD D5316043',  'TRL-01', '2023-06-01', '{"psi":2400}'),
  ('JD D5314029',  'TRL-01', '2023-06-01', '{"psi":2400}'),

  -- TRL-03 (2400 PSI, Williston)
  ('4502356Y',     'TRL-03', '2023-10-01', '{"psi":2400}'),
  ('JD D2815119',  'TRL-03', '2016-12-01', '{"psi":2400}'),
  ('4872210Y',     'TRL-03', '2023-10-01', '{"psi":2400}'),
  ('4557331Y',     'TRL-03', '2023-01-01', '{"psi":2400,"flags":"+*"}'),
  ('JD D5157059',  'TRL-03', '2023-02-01', '{"psi":2400}'),
  ('JD D5246044',  'TRL-03', '2023-04-01', '{"psi":2400}'),
  ('JD D5237189',  'TRL-03', '2023-04-01', '{"psi":2400}'),
  ('JD D5218058',  'TRL-03', '2023-03-01', '{"psi":2400}'),

  -- TRL-05 (4500 PSI, Williston) — note: JP155406140 may be JP15S406140; verify with DK doc
  ('JP155406140',    'TRL-05', '2015-08-01', '{"psi":4500}'),
  ('TWSSP08630403',  'TRL-05', '2022-06-01', '{"psi":4500}'),
  ('TWSSP08633015',  'TRL-05', '2022-06-01', '{"psi":4500}'),
  ('TWSSP08630495',  'TRL-05', '2022-06-01', '{"psi":4500}'),
  ('TWSSP08631484',  'TRL-05', '2022-06-01', '{"psi":4500}'),
  ('TWSSP08631500',  'TRL-05', '2022-06-01', '{"psi":4500}'),
  ('TWSSP08631423',  'TRL-05', '2022-06-01', '{"psi":4500}'),
  ('TWSSP08631748',  'TRL-05', '2022-06-01', '{"psi":4500}'),

  -- TRL-06 (4500 PSI, Williston)
  ('JD V758145',   'TRL-06', '2021-05-01', '{"psi":4500}'),
  ('JD V758069',   'TRL-06', '2021-05-01', '{"psi":4500}'),
  ('JD V758114',   'TRL-06', '2021-05-01', '{"psi":4500}'),
  ('JD V758074',   'TRL-06', '2021-05-01', '{"psi":4500}'),
  ('JD V758099',   'TRL-06', '2021-05-01', '{"psi":4500}'),
  ('JD V758083',   'TRL-06', '2021-05-01', '{"psi":4500}'),
  ('JD V758090',   'TRL-06', '2021-05-01', '{"psi":4500}'),
  ('JD V758075',   'TRL-06', '2021-05-01', '{"psi":4500}'),

  -- TRL-07 (4500 PSI, Williston) — ⚠️ same serials as TRL-07-DK; WIL wins here
  ('4735593Y',     'TRL-07', '2023-08-01', '{"psi":4500}'),
  ('4735627Y',     'TRL-07', '2023-08-01', '{"psi":4500}'),
  ('4735609Y',     'TRL-07', '2023-08-01', '{"psi":4500}'),
  ('4735618Y',     'TRL-07', '2023-08-01', '{"psi":4500}'),
  ('4735608Y',     'TRL-07', '2023-08-01', '{"psi":4500}'),
  ('4735602Y',     'TRL-07', '2023-08-01', '{"psi":4500}'),

  -- TRL-08 (4500 PSI, Williston)
  ('V950185',      'TRL-08', '2023-04-01', '{"psi":4500}'),
  ('155406011',    'TRL-08', '2015-08-01', '{"psi":4500}'),
  ('V950104',      'TRL-08', '2023-04-01', '{"psi":4500}'),
  ('V758094',      'TRL-08', '2021-05-01', '{"psi":4500}'),
  ('4735606Y',     'TRL-08', '2023-08-01', '{"psi":4500}'),
  ('4735623Y',     'TRL-08', '2023-08-01', '{"psi":4500}'),

  -- TRL-09 (4500 PSI, Williston) — ⚠️ V758053/V758085/V758123 also appear in TRL-25; TRL-09 wins
  ('V758088',      'TRL-09', '2021-05-01', '{"psi":4500}'),
  ('V758136',      'TRL-09', '2021-05-01', '{"psi":4500}'),
  ('V758053',      'TRL-09', '2021-05-01', '{"psi":4500}'),
  ('V758085',      'TRL-09', '2021-05-01', '{"psi":4500}'),
  ('V758123',      'TRL-09', '2021-05-01', '{"psi":4500}'),

  -- TRL-10 (2400 PSI, Williston) — ⚠️ same serials as TRL-10-DK; WIL wins here
  ('JD D5157088',  'TRL-10', '2023-02-01', '{"psi":2400}'),
  ('JD D3708073',  'TRL-10', '2019-10-01', '{"psi":2400}'),
  ('JD D3639026',  'TRL-10', '2019-09-01', '{"psi":2400}'),
  ('JD D3708062',  'TRL-10', '2019-10-01', '{"psi":2400}'),
  ('JP519S155146', 'TRL-10', '2019-08-01', '{"psi":2400}'),
  ('JD D3570100',  'TRL-10', '2019-09-01', '{"psi":2400}'),
  ('JD D3708048',  'TRL-10', '2019-10-01', '{"psi":2400}'),
  ('JD D5237181',  'TRL-10', '2023-04-01', '{"psi":2400}'),

  -- TRL-11 (2400 PSI, Williston)
  ('13B012005',    'TRL-11', '2018-10-01', '{"psi":2400}'),
  ('18J148170',    'TRL-11', '2018-05-01', '{"psi":2400}'),
  ('JDD3708068',   'TRL-11', '2019-10-01', '{"psi":2400}'),
  ('JDD3708069',   'TRL-11', '2019-10-01', '{"psi":2400}'),
  ('JDD3708060',   'TRL-11', '2019-10-01', '{"psi":2400}'),
  ('JDD3708051',   'TRL-11', '2019-10-01', '{"psi":2400}'),
  ('5550538Y',     'TRL-11', '2015-12-01', '{"psi":2400,"flags":"+*"}'),
  ('12B617019',    'TRL-11', '2023-03-01', '{"psi":2400}'),

  -- TRL-12 (2400 PSI, Williston)
  ('JD D5312042',  'TRL-12', '2023-06-01', '{"psi":2400}'),
  ('JD D3708039',  'TRL-12', '2019-10-01', '{"psi":2400}'),
  ('JD D3708038',  'TRL-12', '2019-10-01', '{"psi":2400}'),
  ('JD D2924136',  'TRL-12', '2017-06-01', '{"psi":2400}'),
  ('JD D2925035',  'TRL-12', '2017-06-01', '{"psi":2400}'),

  -- TRL-14 (2400 PSI, Williston)
  ('15S4061156',   'TRL-14', '2015-08-01', '{"psi":2400}'),
  ('15S406010',    'TRL-14', '2015-08-01', '{"psi":2400}'),
  ('15S406124',    'TRL-14', '2015-08-01', '{"psi":2400}'),
  ('15S406169',    'TRL-14', '2015-08-01', '{"psi":2400}'),
  ('53732X',       'TRL-14', '2022-01-01', '{"psi":2400,"flags":"+*"}'),

  -- TRL-15 (2400 PSI, Williston) — ⚠️ same serials as TRL-15-DK; dates differ (WIL older); WIL wins
  ('HP548012',     'TRL-15', '2017-04-01', '{"psi":2400}'),
  ('HP603408',     'TRL-15', '2018-12-01', '{"psi":2400}'),
  ('JP14B280031',  'TRL-15', '2014-09-01', '{"psi":2400}'),
  ('JP14B041176',  'TRL-15', '2014-04-01', '{"psi":2400}'),

  -- TRL-16 (2400 PSI, Williston) — note: may have typos vs DK-16; DK-16 uses different serials
  ('JP14B23981',   'TRL-16', '2018-07-01', '{"psi":2400}'),
  ('JP14B280138',  'TRL-16', '2018-07-01', '{"psi":2400}'),
  ('JP14B091157',  'TRL-16', '2024-06-01', '{"psi":2400}'),
  ('JP14B0370',    'TRL-16', '2024-06-01', '{"psi":2400}'),

  -- TRL-17 (2400 PSI, Williston) — ⚠️ cylinders below also appear in TRL-23 with slight serial diffs
  ('JP14B239174',  'TRL-17', '2021-12-01', '{"psi":2400}'),
  ('13B031173',    'TRL-17', '2021-12-01', '{"psi":2400}'),
  ('5266117',      'TRL-17', '2022-01-01', '{"psi":2400}'),
  ('1584789Y',     'TRL-17', '2021-12-01', '{"psi":2400}'),
  ('JP135432010',  'TRL-17', '2021-12-01', '{"psi":2400}'),
  ('JP18J148117',  'TRL-17', '2021-12-01', '{"psi":2400}'),

  -- TRL-18 (2400 PSI, Williston)
  ('HP548024',     'TRL-18', '2017-04-01', '{"psi":2400}'),
  ('5243249',      'TRL-18', '2022-01-01', '{"psi":2400}'),
  ('JP14B037152',  'TRL-18', '2024-06-01', '{"psi":2400}'),
  ('T474359',      'TRL-18', '2024-06-01', '{"psi":2400}'),

  -- TRL-19 (2400 PSI, Williston) — ⚠️ JP13S432117 also in TRL-16-DK; TRL-19 wins here
  ('JP13S432117',  'TRL-19', '2022-01-01', '{"psi":2400}'),
  ('4502402Y',     'TRL-19', '2022-01-01', '{"psi":2400,"flags":"+*"}'),
  ('10592',        'TRL-19', '2023-04-01', '{"psi":2400}'),
  ('50743',        'TRL-19', '2019-03-01', '{"psi":2400}'),
  ('03686',        'TRL-19', '2019-05-01', '{"psi":2400}'),
  ('JD D2763085',  'TRL-19', '2021-08-01', '{"psi":2400}'),

  -- TRL-20 (2400 PSI, Williston)
  ('JD D3708075',  'TRL-20', '2019-10-01', '{"psi":2400}'),
  ('JD D3708076',  'TRL-20', '2019-10-01', '{"psi":2400}'),
  ('JD D4555144',  'TRL-20', '2022-04-01', '{"psi":2400}'),
  ('5287343',      'TRL-20', '2022-10-01', '{"psi":2400,"flags":"+*"}'),
  ('30524X',       'TRL-20', '2023-10-01', '{"psi":2400}'),
  ('4580805Y',     'TRL-20', '2022-06-01', '{"psi":2400,"flags":"+*"}'),

  -- TRL-21 (2400 PSI, Williston) — ⚠️ MB-1130 also in TRL-21-DK; TRL-21 WIL wins
  ('14515',        'TRL-21', '2022-01-01', '{"psi":2400}'),
  ('MB-1130',      'TRL-21', '2019-03-01', '{"psi":2400}'),
  ('H271813',      'TRL-21', '2019-02-01', '{"psi":2400}'),
  ('18500',        'TRL-21', '2019-02-01', '{"psi":2400}'),

  -- TRL-22 (2400 PSI, Williston)
  ('220864',       'TRL-22', '2022-10-01', '{"psi":2400,"flags":"+*"}'),
  ('5266084',      'TRL-22', '2022-10-01', '{"psi":2400,"flags":"+*"}'),
  ('JD D4579070',  'TRL-22', '2022-05-01', '{"psi":2400}'),
  ('JP14B006105',  'TRL-22', '2014-01-01', '{"psi":2400}'),

  -- TRL-23 (2400 PSI, Williston) — ⚠️ 13B031173, JP14B239174, 5266117, 1584789Y
  --   already assigned to TRL-17; those 4 rows skipped here by ON CONFLICT.
  --   JP13S432010 ≠ JP135432010 (TRL-17), JP18J148177 ≠ JP18J148117 (TRL-17) — treated as distinct
  ('JP13S432010',  'TRL-23', '2021-12-01', '{"psi":2400}'),
  ('JP18J148177',  'TRL-23', '2021-12-01', '{"psi":2400}'),
  ('JD D5351021',  'TRL-23', '2023-06-01', '{"psi":2400}'),
  ('JD D5351040',  'TRL-23', '2023-06-01', '{"psi":2400}'),
  ('JD D5316022',  'TRL-23', '2023-06-01', '{"psi":2400}'),
  ('JD D5316012',  'TRL-23', '2023-06-01', '{"psi":2400}'),
  -- duplicates below — kept for clarity, will silently skip
  ('13B031173',    'TRL-23', '2021-12-01', '{"psi":2400}'),
  ('JP14B239174',  'TRL-23', '2021-12-01', '{"psi":2400}'),
  ('5266117',      'TRL-23', '2022-12-01', '{"psi":2400,"flags":"+*"}'),
  ('1584789Y',     'TRL-23', '2021-12-01', '{"psi":2400,"flags":"+*"}'),

  -- TRL-24 (4500 PSI, Williston)
  ('4735636Y',     'TRL-24', '2023-08-01', '{"psi":4500}'),
  ('4735604Y',     'TRL-24', '2023-08-01', '{"psi":4500}'),
  ('4553996Y',     'TRL-24', '2023-08-01', '{"psi":4500}'),
  ('4735600Y',     'TRL-24', '2023-08-01', '{"psi":4500}'),
  ('4735598Y',     'TRL-24', '2023-08-01', '{"psi":4500}'),
  ('4735607Y',     'TRL-24', '2023-08-01', '{"psi":4500}'),
  ('4735617Y',     'TRL-24', '2023-08-01', '{"psi":4500}'),
  ('4734178',      'TRL-24', '2023-08-01', '{"psi":4500}'),

  -- TRL-25 (4500 PSI, Williston) — ⚠️ V758053/V758085/V758123 skipped (already in TRL-09)
  ('V956066',      'TRL-25', '2023-05-01', '{"psi":4500}'),
  ('V950143',      'TRL-25', '2023-04-01', '{"psi":4500}'),
  ('V950029',      'TRL-25', '2023-04-01', '{"psi":4500}'),
  ('V956139',      'TRL-25', '2023-05-01', '{"psi":4500}'),
  ('V950063',      'TRL-25', '2023-04-01', '{"psi":4500}'),
  -- duplicates below — will silently skip
  ('V758053',      'TRL-25', '2021-05-01', '{"psi":4500}'),
  ('V758123',      'TRL-25', '2021-05-01', '{"psi":4500}'),
  ('V758085',      'TRL-25', '2021-05-01', '{"psi":4500}'),

  -- TRL-26 (2400 PSI, Williston)
  ('JD DK136116',  'TRL-26', '2024-07-01', '{"psi":2400}'),
  ('JD DK136124',  'TRL-26', '2024-07-01', '{"psi":2400}'),
  ('JD DK136094',  'TRL-26', '2024-07-01', '{"psi":2400}'),
  ('JD DK136117',  'TRL-26', '2024-07-01', '{"psi":2400}'),
  ('JD DK136128',  'TRL-26', '2024-07-01', '{"psi":2400}'),
  ('JD DK136137',  'TRL-26', '2024-07-01', '{"psi":2400}'),

  -- TRL-27 (4500 PSI, Williston)
  ('JD V950114',   'TRL-27', '2023-04-01', '{"psi":4500}'),
  ('JD V950148',   'TRL-27', '2023-04-01', '{"psi":4500}'),
  ('JD V950093',   'TRL-27', '2023-04-01', '{"psi":4500}'),
  ('JD V950147',   'TRL-27', '2023-04-01', '{"psi":4500}'),
  ('JD V956023',   'TRL-27', '2023-05-01', '{"psi":4500}'),
  ('JD V956107',   'TRL-27', '2023-05-01', '{"psi":4500}'),
  ('JD V956142',   'TRL-27', '2023-05-01', '{"psi":4500}'),
  ('JD V956144',   'TRL-27', '2023-05-01', '{"psi":4500}'),

  -- TRL-28 (2400 PSI, Williston)
  ('JD D5312023',  'TRL-28', '2023-06-01', '{"psi":2400}'),
  ('JD D5157061',  'TRL-28', '2023-02-01', '{"psi":2400}'),
  ('JD D2618014',  'TRL-28', '2016-03-01', '{"psi":2400}'),
  ('JD D2617113',  'TRL-28', '2016-03-01', '{"psi":2400}'),
  ('JD D2555109',  'TRL-28', '2016-06-01', '{"psi":2400}'),
  ('JD D5355016',  'TRL-28', '2023-06-01', '{"psi":2400}'),
  ('JD D5355030',  'TRL-28', '2023-06-01', '{"psi":2400}'),
  ('JD D2924166',  'TRL-28', '2017-06-01', '{"psi":2400}'),
  ('JD D2617133',  'TRL-28', '2016-03-01', '{"psi":2400}'),
  ('JD D2675186',  'TRL-28', '2016-05-01', '{"psi":2400}'),

  -- TRL-29 (2400 PSI, Williston)
  ('4932035Y',     'TRL-29', '2023-10-01', '{"psi":2400}'),
  ('4802119Y',     'TRL-29', '2023-10-01', '{"psi":2400}'),
  ('JP14B280106',  'TRL-29', '2023-02-01', '{"psi":2400}'),
  ('4872211Y',     'TRL-29', '2023-10-01', '{"psi":2400}'),
  ('4780427Y',     'TRL-29', '2023-10-01', '{"psi":2400}'),
  ('4884996Y',     'TRL-29', '2023-10-01', '{"psi":2400}'),
  ('4802177Y',     'TRL-29', '2023-10-01', '{"psi":2400}'),
  ('JD D5355034',  'TRL-29', '2023-06-01', '{"psi":2400}'),
  ('JD D5316046',  'TRL-29', '2023-06-01', '{"psi":2400}'),
  ('JD D5316050',  'TRL-29', '2023-06-01', '{"psi":2400}'),

  -- TRL-30 (2400 PSI, Williston) — ⚠️ 3665923Y, 4344021Y, 53935X also in TRL-30-DK; WIL wins
  --   space-formatted serials (JD D...) differ from DK no-space format (JDD...) — treated as distinct
  ('JD D5314101',  'TRL-30', '2023-06-01', '{"psi":2400}'),
  ('JD D5312046',  'TRL-30', '2023-06-01', '{"psi":2400}'),
  ('JD D5312059',  'TRL-30', '2023-06-01', '{"psi":2400}'),
  ('JD D5312068',  'TRL-30', '2023-06-01', '{"psi":2400}'),
  ('JD D5315176',  'TRL-30', '2023-06-01', '{"psi":2400}'),
  ('JD D5312078',  'TRL-30', '2023-06-01', '{"psi":2400}'),
  ('53935X',       'TRL-30', '2023-12-01', '{"psi":2400}'),
  ('3665923Y',     'TRL-30', '2023-12-01', '{"psi":2400}'),
  ('4344021Y',     'TRL-30', '2023-12-01', '{"psi":2400,"flags":"+UE"}'),

  -- TRL-31 (2400 PSI, Williston)
  ('JD DK102138',  'TRL-31', '2024-06-01', '{"psi":2400}'),
  ('JD DK102074',  'TRL-31', '2024-06-01', '{"psi":2400}'),
  ('JD DK102170',  'TRL-31', '2024-06-01', '{"psi":2400}'),
  ('JD DK081184',  'TRL-31', '2024-05-01', '{"psi":2400}'),
  ('JD DK102096',  'TRL-31', '2024-06-01', '{"psi":2400}'),
  ('JD DK081149',  'TRL-31', '2024-05-01', '{"psi":2400}'),
  ('JD DK081011',  'TRL-31', '2024-05-01', '{"psi":2400}'),
  ('JD DK102106',  'TRL-31', '2024-06-01', '{"psi":2400}'),
  ('JD DK081158',  'TRL-31', '2024-05-01', '{"psi":2400}'),
  ('JD DK5312009', 'TRL-31', '2023-06-01', '{"psi":2400}'),

  -- ==========================================================
  -- DICKINSON TRAILERS
  -- ==========================================================

  -- TRL-05-DK (4500 PSI, Dickinson) — different serials from TRL-05 WIL, no conflicts
  ('630495',       'TRL-05-DK', '2022-06-01', '{"psi":4500,"bottle_type":"DOT","flags":"UE"}'),
  ('JP15S406140',  'TRL-05-DK', '2018-08-01', '{"psi":4500,"bottle_type":"ISO"}'),
  ('683015',       'TRL-05-DK', '2022-06-01', '{"psi":4500,"bottle_type":"DOT","flags":"UE"}'),
  ('630403',       'TRL-05-DK', '2022-06-01', '{"psi":4500,"bottle_type":"DOT","flags":"UE"}'),
  ('631500',       'TRL-05-DK', '2022-06-01', '{"psi":4500,"bottle_type":"DOT","flags":"UE"}'),
  ('631423',       'TRL-05-DK', '2022-06-01', '{"psi":4500,"bottle_type":"DOT","flags":"UE"}'),
  ('631484',       'TRL-05-DK', '2022-06-01', '{"psi":4500,"bottle_type":"DOT","flags":"UE"}'),
  ('631748',       'TRL-05-DK', '2022-06-01', '{"psi":4500,"bottle_type":"DOT","flags":"UE"}'),

  -- TRL-07-DK (4500 PSI, Dickinson) — ⚠️ ALL serials conflict with TRL-07 WIL → none will insert
  --   Keeping rows here for documentation; all will be silently skipped
  ('4735593Y',     'TRL-07-DK', '2023-08-01', '{"psi":4500,"bottle_type":"ISO"}'),
  ('4735627Y',     'TRL-07-DK', '2023-08-01', '{"psi":4500,"bottle_type":"ISO"}'),
  ('4735609Y',     'TRL-07-DK', '2023-08-01', '{"psi":4500,"bottle_type":"ISO"}'),
  ('4735618Y',     'TRL-07-DK', '2023-08-01', '{"psi":4500,"bottle_type":"ISO"}'),
  ('4735608Y',     'TRL-07-DK', '2023-08-01', '{"psi":4500,"bottle_type":"ISO"}'),
  ('4735602Y',     'TRL-07-DK', '2023-08-01', '{"psi":4500,"bottle_type":"ISO"}'),

  -- TRL-10-DK (2400 PSI, Dickinson) — ⚠️ 7 of 8 serials conflict with TRL-10 WIL
  --   JP5195155 (DK) ≠ JP519S155146 (WIL) — this one lands
  ('JD D5157088',  'TRL-10-DK', '2023-02-01', '{"psi":2400,"bottle_type":"ISO"}'),
  ('JD D3708073',  'TRL-10-DK', '2019-10-01', '{"psi":2400,"bottle_type":"ISO"}'),
  ('JD D3639026',  'TRL-10-DK', '2019-09-01', '{"psi":2400,"bottle_type":"ISO"}'),
  ('JD D3708062',  'TRL-10-DK', '2019-10-01', '{"psi":2400,"bottle_type":"ISO"}'),
  ('JD D5237181',  'TRL-10-DK', '2023-04-01', '{"psi":2400,"bottle_type":"ISO"}'),
  ('JD D3708048',  'TRL-10-DK', '2019-10-01', '{"psi":2400,"bottle_type":"ISO"}'),
  ('JD D3570100',  'TRL-10-DK', '2019-09-01', '{"psi":2400,"bottle_type":"ISO"}'),
  ('JP5195155',    'TRL-10-DK', '2019-08-01', '{"psi":2400,"bottle_type":"ISO"}'),

  -- TRL-15-DK (2400 PSI, Dickinson) — ⚠️ ALL serials conflict with TRL-15 WIL → none will insert
  ('HP548012',     'TRL-15-DK', '2017-04-01', '{"psi":2400,"bottle_type":"DOT","flags":"+*"}'),
  ('HP603408',     'TRL-15-DK', '2018-12-01', '{"psi":2400,"bottle_type":"DOT","flags":"+*"}'),
  ('JP14B280031',  'TRL-15-DK', '2018-09-01', '{"psi":2400,"bottle_type":"ISO"}'),
  ('JP14B041176',  'TRL-15-DK', '2018-07-01', '{"psi":2400,"bottle_type":"ISO"}'),

  -- TRL-16-DK (2400 PSI, Dickinson)
  --   JP14B239181 ≠ JP14B23981 (WIL-16), JP14B037008 ≠ JP14B0370 (WIL-16), JP14B041157 ≠ JP14B091157 (WIL-16)
  --   ⚠️ JP13S432117 conflicts with TRL-19 WIL — will skip
  ('JP14B239181',  'TRL-16-DK', '2018-07-01', '{"psi":2400,"bottle_type":"ISO"}'),
  ('JP13S432117',  'TRL-16-DK', '2018-07-01', '{"psi":2400,"bottle_type":"ISO"}'),
  ('JP14B037008',  'TRL-16-DK', '2024-06-01', '{"psi":2400,"bottle_type":"ISO","flags":"UE"}'),
  ('JP14B041157',  'TRL-16-DK', '2024-06-01', '{"psi":2400,"bottle_type":"ISO","flags":"UE"}'),

  -- TRL-17-DK (2400 PSI, Dickinson) — completely different serials from TRL-17 WIL, no conflicts
  ('H-271816',     'TRL-17-DK', '2019-02-01', '{"psi":2400,"bottle_type":"DOT"}'),
  ('5265342',      'TRL-17-DK', '2022-10-01', '{"psi":2400,"bottle_type":"DOT","flags":"UE +*"}'),
  ('JP14B239048',  'TRL-17-DK', '2018-07-01', '{"psi":2400,"bottle_type":"ISO"}'),
  ('JP14B041167',  'TRL-17-DK', '2018-07-01', '{"psi":2400,"bottle_type":"ISO"}'),
  ('HP603406',     'TRL-17-DK', '2018-12-01', '{"psi":2400,"bottle_type":"ISO","flags":"+*"}'),
  ('HS-218493',    'TRL-17-DK', '2019-02-01', '{"psi":2400,"bottle_type":"DOT"}'),

  -- TRL-21-DK (2400 PSI, Dickinson)
  --   271813 (DK) ≠ H271813 (WIL-21) — treated as distinct
  --   ⚠️ MB-1130 conflicts with TRL-21 WIL — will skip
  ('271813',       'TRL-21-DK', '2019-02-01', '{"psi":2400,"bottle_type":"DOT"}'),
  ('785090',       'TRL-21-DK', '2019-02-01', '{"psi":2400,"bottle_type":"DOT"}'),
  ('MB-1130',      'TRL-21-DK', '2021-03-01', '{"psi":2400,"bottle_type":"DOT"}'),
  ('K145575',      'TRL-21-DK', '2022-01-01', '{"psi":2400,"bottle_type":"DOT","flags":"+UE"}'),

  -- TRL-30-DK (2400 PSI, Dickinson)
  --   No-space serials (JDD...) differ from WIL space-formatted (JD D...) — both insert
  --   ⚠️ 3665923Y, 4344021Y, 53935X conflict with TRL-30 WIL — will skip
  ('JDD5314100',   'TRL-30-DK', '2023-06-01', '{"psi":2400,"bottle_type":"ISO"}'),
  ('JDD5314101',   'TRL-30-DK', '2023-06-01', '{"psi":2400,"bottle_type":"ISO"}'),
  ('3665923Y',     'TRL-30-DK', '2023-10-01', '{"psi":2400,"bottle_type":"DOT","flags":"+*"}'),
  ('4344021Y',     'TRL-30-DK', '2023-12-01', '{"psi":2400,"bottle_type":"DOT","flags":"+UE"}'),
  ('53935X',       'TRL-30-DK', '2023-12-01', '{"psi":2400,"bottle_type":"DOT","flags":"+UE"}'),
  ('JDD5312059',   'TRL-30-DK', '2023-06-01', '{"psi":2400,"bottle_type":"ISO"}'),
  ('JDD5315058',   'TRL-30-DK', '2023-06-01', '{"psi":2400,"bottle_type":"ISO"}'),
  ('JDD5315176',   'TRL-30-DK', '2023-06-01', '{"psi":2400,"bottle_type":"ISO"}'),
  ('JDD5312078',   'TRL-30-DK', '2023-06-01', '{"psi":2400,"bottle_type":"ISO"}'),
  ('JDD5312046',   'TRL-30-DK', '2023-06-01', '{"psi":2400,"bottle_type":"ISO"}')

) AS c(serial, trailer_serial, hydro, cdata)
JOIN serialized_equipment parent ON parent.serial_number = c.trailer_serial
CROSS JOIN (SELECT id FROM product WHERE part_number = 'AIR-TANK-30') prod
ON CONFLICT (serial_number) DO NOTHING;

-- ============================================================
-- VERIFICATION QUERIES — run these before COMMIT
-- ============================================================
SELECT 'Trailers' AS type, COUNT(*) AS count FROM serialized_equipment WHERE parent_equipment_id IS NULL;
SELECT 'Bottles'  AS type, COUNT(*) AS count FROM serialized_equipment WHERE parent_equipment_id IS NOT NULL;

-- Per-trailer bottle count (trailers with 0 bottles are noted in header)
SELECT
  parent.serial_number AS trailer,
  parent.custom_data->>'yard' AS yard,
  parent.custom_data->>'psi'  AS psi,
  COUNT(child.id)             AS bottles
FROM serialized_equipment parent
LEFT JOIN serialized_equipment child ON child.parent_equipment_id = parent.id
WHERE parent.parent_equipment_id IS NULL
GROUP BY parent.serial_number, parent.custom_data
ORDER BY parent.custom_data->>'yard' DESC, parent.serial_number;

-- Uncomment to finalize:
-- COMMIT;

-- Or to abort:
-- ROLLBACK;
