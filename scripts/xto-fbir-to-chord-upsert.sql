-- ============================================================
-- FBIR WELLS → CHORD ENERGY + TIER 1
--
-- Source: DrillingEdge export drillingedge_export_20260908_084204.csv —
-- 110 wells named "FBIR *" (Fort Berthold Indian Reservation), HEART BUTTE
-- field, Dunn County, filed to XTO ENERGY INC. Chord Energy took these over.
--
-- Three things happen here:
--   1. Every FBIR well goes to Chord Energy — the 110 in the export, plus the
--      11 FBIR wells we carry that the export does not list (it only shows
--      wells still filed to XTO). 25 wells in the export exist only as DMR
--      reference rows and get activated. 9 dead permits (7 PNC / 1 DRY /
--      1 PA) are deliberately NOT activated.
--   2. Every FBIR well gets tier_1 = true, regardless of operator. Requires
--      migration 20260908120000_well_tier1 (wells.tier_1) to be deployed —
--      STEP 1 hard-fails if it isn't.
--   3. "FBIR Iron Woman 21X-10" — a hand-entered, API-less well row that was
--      meant to be a PAD — becomes a real pad, and the ten 21X-10 wells get
--      attached to it.
--
-- Matching is on the canonical digits-only API number (see normalizeApi in
-- server/src/services/dmrBulkUpsert.ts), so a dashed or 10-digit stored form
-- still matches. Counts in the comments were measured against the sandbox
-- clone of prod on 2026-09-08.
--
-- Idempotent. Wrapped in a transaction — run it, read the STEP 9 counts,
-- then flip ROLLBACK to COMMIT.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- STEP 0: The 110 FBIR APIs from the export (canonical 14-digit)
-- ------------------------------------------------------------
CREATE TEMP TABLE fbir_api (api text PRIMARY KEY) ON COMMIT DROP;

INSERT INTO fbir_api (api) VALUES
  ('33025011420000'), ('33025011430000'), ('33025011950000'), ('33025011960000'), ('33025011970000'),
  ('33025011980000'), ('33025012190000'), ('33025012200000'), ('33025012450000'), ('33025012480000'),
  ('33025012500000'), ('33025012780000'), ('33025013020000'), ('33025013030000'), ('33025013170000'),
  ('33025013410000'), ('33025013480000'), ('33025014180000'), ('33025018200000'), ('33025018210000'),
  ('33025018220000'), ('33025018500000'), ('33025018510000'), ('33025018520000'), ('33025018530000'),
  ('33025018540000'), ('33025018720000'), ('33025018730000'), ('33025018740000'), ('33025018750000'),
  ('33025018760000'), ('33025018810000'), ('33025018820000'), ('33025018830000'), ('33025018840000'),
  ('33025018850000'), ('33025018860000'), ('33025018870000'), ('33025019020000'), ('33025019030000'),
  ('33025019190000'), ('33025021360000'), ('33025021370000'), ('33025021380000'), ('33025022800000'),
  ('33025022810000'), ('33025023430000'), ('33025023600000'), ('33025028570000'), ('33025028580000'),
  ('33025028590000'), ('33025028600000'), ('33025028610000'), ('33025028620000'), ('33025029400000'),
  ('33025029410000'), ('33025029420000'), ('33025029430000'), ('33025029440000'), ('33025029450000'),
  ('33025029460000'), ('33025030680000'), ('33025030690000'), ('33025030700000'), ('33025030710000'),
  ('33025030720000'), ('33025030730000'), ('33025030740000'), ('33025030760000'), ('33025031070000'),
  ('33025031480000'), ('33025033530000'), ('33025033540000'), ('33025033900000'), ('33025033910000'),
  ('33025033990000'), ('33025034330000'), ('33025034340000'), ('33025034350000'), ('33025034560000'),
  ('33025034570000'), ('33025034580000'), ('33025034590000'), ('33025034930000'), ('33025034940000'),
  ('33025035110000'), ('33025035120000'), ('33025035130000'), ('33025035140000'), ('33025035150000'),
  ('33025036370000'), ('33025036380000'), ('33025036390000'), ('33025036400000'), ('33025036410000'),
  ('33025036420000'), ('33025036430000'), ('33025036440000'), ('33025037390000'), ('33025037400000'),
  ('33025037410000'), ('33025037420000'), ('33025037430000'), ('33025038760000'), ('33025038770000'),
  ('33025038780000'), ('33025038790000'), ('33025038800000'), ('33025038810000'), ('33025038820000');

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM fbir_api;
  IF n <> 110 THEN RAISE EXCEPTION 'Expected 110 FBIR APIs, got %', n; END IF;
END $$;

-- ------------------------------------------------------------
-- STEP 1: Preflight
--
-- (a) wells.tier_1 must exist. It ships in migration
--     20260908120000_well_tier1, which auto-applies when the API container
--     starts. If this raises, deploy first and re-run.
-- (b) Target operator. There are TWO Chord rows: 'co-chord'
--     (company_type=operator, is_active=f, a seed row) and
--     'qb-chord-energy-llc' (company_type=customer, is_active=t, carries the
--     Chord QB price level). Every XTO well today points at the active QB row
--     ('qb-xto-energy-inc'), so we stay consistent and use the active QB row.
--     Both share the same qb_price_level_id, so billing is unaffected by the
--     choice; is_active is what keeps the well visible in operator pickers.
-- ------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'wells' AND column_name = 'tier_1'
  ) THEN
    RAISE EXCEPTION 'wells.tier_1 is missing — deploy migration 20260908120000_well_tier1 before running this script';
  END IF;
END $$;

CREATE TEMP TABLE chord_target ON COMMIT DROP AS
SELECT id, name FROM companies WHERE id = 'qb-chord-energy-llc';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM chord_target) THEN
    RAISE EXCEPTION 'Chord Energy company row qb-chord-energy-llc not found - resolve the target company before running';
  END IF;
END $$;

-- ------------------------------------------------------------
-- STEP 2: Find-or-create the HEART BUTTE field
-- All 110 DMR rows carry field_name = 'HEART BUTTE'; the wells we already
-- have are mostly parked on 'field-unassigned', which STEP 4 leaves alone.
-- ------------------------------------------------------------
INSERT INTO fields (id, name, county, state, is_active, created_at, updated_at)
SELECT gen_random_uuid(), 'HEART BUTTE', 'Dunn County', 'ND', true, NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM fields WHERE lower(name) = 'heart butte');

-- ------------------------------------------------------------
-- STEP 3: INSERT - activate the FBIR wells we do not have yet (25)
--
-- Mirrors the field mapping in the bulk-activate path
-- (server/src/routes/locations.ts, POST /dmr/bulk-activate): pad stays NULL
-- (pads are manual-only), field from the DMR row, type/status straight
-- across since dmr_reference_wells already stores clean enum codes.
--
-- Only live wells are activated. PNC (permit cancelled), DRY and PA rows are
-- skipped - they are not serviceable locations and activating them just
-- pollutes the well picker. Drop the well_status filter to get all 110.
-- ------------------------------------------------------------
INSERT INTO wells
  (id, pad_id, field_id, current_operator_id,
   dmr_file_number, api_number, api_short, well_name, well_name_base,
   total_depth, spud_date,
   quarter_quarter, section, township, range, feet_ns, ns_line, feet_ew, ew_line,
   latitude, longitude, well_type, well_status, county,
   dmr_reference_id, dmr_import_date, dmr_raw_data,
   tier_1, is_active_for_service, pending_review, created_at, updated_at)
SELECT
  gen_random_uuid(),
  NULL,
  (SELECT id FROM fields WHERE lower(name) = 'heart butte' LIMIT 1),
  (SELECT id FROM chord_target),
  d.dmr_file_number, d.api_number, d.api_short, d.well_name, d.well_name_base,
  d.total_depth, d.spud_date,
  d.quarter_quarter, d.section, d.township, d.range, d.feet_ns, d.ns_line, d.feet_ew, d.ew_line,
  d.latitude, d.longitude,
  COALESCE(d.well_type, 'other')::"WellType",
  COALESCE(d.well_status, 'other')::"WellStatus",
  d.county,
  d.id, CURRENT_DATE, d.raw_data,
  true, true, false, NOW(), NOW()
FROM dmr_reference_wells d
JOIN fbir_api f ON regexp_replace(d.api_number, '[^0-9]', '', 'g') = f.api
WHERE d.well_status IN ('A', 'IA')
  AND NOT EXISTS (
    SELECT 1 FROM wells w
    WHERE regexp_replace(w.api_number, '[^0-9]', '', 'g') = f.api
  );

-- ------------------------------------------------------------
-- STEP 4: The full FBIR target set = export APIs UNION name match
--
-- Name match matters because the export only lists wells still FILED to XTO,
-- so it misses 11 FBIR wells we already carry: four GUYBLACKHAWK 24X-27s,
-- four SMITH 11X-10s, "FBIR Goeseverywhere 31X-11C" (no operator at all),
-- "FBIR Ironwoman 21X-NF" (already on Chord), and the hand-entered
-- "FBIR Iron Woman 21X-10" that STEP 7 turns into a pad.
-- ------------------------------------------------------------
CREATE TEMP TABLE fbir_target ON COMMIT DROP AS
SELECT DISTINCT w.id
FROM wells w
WHERE w.well_name ILIKE 'FBIR%'
   OR EXISTS (
     SELECT 1 FROM fbir_api f
     WHERE regexp_replace(w.api_number, '[^0-9]', '', 'g') = f.api
   );

-- ------------------------------------------------------------
-- STEP 5: Operator - history row first, then the reassignment
--
-- One history row per well that actually changes. Skips wells already on
-- Chord (so a re-run adds nothing) and wells with no current operator
-- (previous_operator_id is NOT NULL, so there is nothing to record).
-- source = 'state_filing' - this is state-filed operator data, not a
-- hand-edit in the app.
--
-- NOTE: 10 of the wells in the export were not on XTO at all (Hess 3,
-- Kraken 3, Continental, Petro-Hunt, Shale Oil Field Services, Hydra MT) —
-- bad DMR matches. The state says XTO/Chord for every one of those APIs, so
-- they get reassigned too; the history rows record what each one was on.
-- ------------------------------------------------------------
INSERT INTO operator_history
  (id, well_id, previous_operator_id, new_operator_id, effective_date, source, notes, created_at)
SELECT
  gen_random_uuid(), w.id, w.current_operator_id, (SELECT id FROM chord_target),
  CURRENT_DATE,
  'state_filing'::"OperatorHistorySource",
  'XTO to Chord Energy: FBIR well set, DrillingEdge export 2026-09-08',
  NOW()
FROM wells w
JOIN fbir_target t ON t.id = w.id
WHERE w.current_operator_id IS NOT NULL
  AND w.current_operator_id <> (SELECT id FROM chord_target);

UPDATE wells w
SET current_operator_id = (SELECT id FROM chord_target),
    updated_at = NOW()
FROM fbir_target t
WHERE t.id = w.id
  AND w.current_operator_id IS DISTINCT FROM (SELECT id FROM chord_target);

-- ------------------------------------------------------------
-- STEP 6: Tier 1 - every FBIR well, regardless of operator
--
-- The migration already backfilled wells.tier_1 for 'FBIR%'. This re-applies
-- it so the wells STEP 3 just activated are covered too, and so the script
-- stays correct if it runs long after the deploy.
-- ------------------------------------------------------------
UPDATE wells w
SET tier_1 = true, updated_at = NOW()
FROM fbir_target t
WHERE t.id = w.id AND NOT w.tier_1;

-- ------------------------------------------------------------
-- STEP 7: "FBIR Iron Woman 21X-10" was meant to be a pad, not a well
--
-- It is a hand-entered row with no API, no coordinates, no legal location
-- and zero tickets — someone added it through the manual-entry path meaning
-- "the pad the 21X-10 wells sit on". Turn it into an actual pad, attach the
-- 21X-10 wells, then drop the bogus well row.
--
-- 7c attaches by name, but only where the state export AGREES the API is a
-- 21X-10. That deliberately excludes "FBIR YELLOW WOLF 21X-10F" (API
-- 33025034580000), which the state calls FBIR YELLOWWOLF 31X-10DXA and whose
-- coordinates put it in the 31X-10 cluster ~300 ft east. It is either
-- misnamed or a duplicate of the real 21X-10F (API 33025018820000) — either
-- way, hanging it off this pad would send a tech to the wrong location. It
-- is listed in the STEP 9 output so it does not get lost.
-- ------------------------------------------------------------

-- 7a: create the pad (idempotent on name). Coordinates are filled in by 7d
-- from whatever actually ends up attached, so the two can't drift apart.
INSERT INTO pads
  (id, name, field_id, current_operator_id, section, township, range,
   county, tier_1, asset_category,
   auto_generated, manually_verified, pending_review, is_active,
   created_at, updated_at)
SELECT
  gen_random_uuid(), 'FBIR Iron Woman 21X-10',
  (SELECT id FROM fields WHERE lower(name) = 'heart butte' LIMIT 1),
  (SELECT id FROM chord_target),
  10, 148, 92, 'DUNN',
  true, 'site'::"PadAssetCategory",
  false, true, false, true,
  NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM pads WHERE name = 'FBIR Iron Woman 21X-10');

-- 7b: move the hand-entered row's operator history onto the pad, so deleting
-- the well row does not silently SET NULL and orphan it
UPDATE operator_history oh
SET well_id = NULL,
    pad_id = (SELECT id FROM pads WHERE name = 'FBIR Iron Woman 21X-10')
WHERE oh.well_id IN (
  SELECT id FROM wells
  WHERE well_name = 'FBIR Iron Woman 21X-10' AND api_number IS NULL
);

-- 7c: attach the ten 21X-10 wells
UPDATE wells w
SET pad_id = (SELECT id FROM pads WHERE name = 'FBIR Iron Woman 21X-10'),
    field_id = (SELECT id FROM fields WHERE lower(name) = 'heart butte' LIMIT 1),
    updated_at = NOW()
WHERE w.well_name ILIKE 'FBIR%21X-10%'
  AND w.api_number IS NOT NULL
  AND w.pad_id IS DISTINCT FROM (SELECT id FROM pads WHERE name = 'FBIR Iron Woman 21X-10')
  AND EXISTS (
    SELECT 1 FROM dmr_reference_wells d
    WHERE regexp_replace(d.api_number, '[^0-9]', '', 'g')
        = regexp_replace(w.api_number, '[^0-9]', '', 'g')
      AND d.well_name ILIKE '%21X-10%'
  );

-- 7d: pad coordinates = centroid of the wells attached in 7c
UPDATE pads p
SET latitude  = agg.lat,
    longitude = agg.lon,
    updated_at = NOW()
FROM (
  SELECT round(avg(w.latitude), 7)  AS lat,
         round(avg(w.longitude), 7) AS lon
  FROM wells w
  JOIN pads pp ON pp.id = w.pad_id
  WHERE pp.name = 'FBIR Iron Woman 21X-10'
    AND w.latitude IS NOT NULL AND w.longitude IS NOT NULL
) agg
WHERE p.name = 'FBIR Iron Woman 21X-10'
  AND agg.lat IS NOT NULL
  AND (p.latitude IS DISTINCT FROM agg.lat OR p.longitude IS DISTINCT FROM agg.lon);

-- 7e: drop the bogus well row (0 tickets, 0 rentals, 0 equipment, 0 work
-- points, 0 fit tests, 0 route stops; its one history row moved in 7b)
DELETE FROM wells
WHERE well_name = 'FBIR Iron Woman 21X-10'
  AND api_number IS NULL
  AND NOT EXISTS (SELECT 1 FROM service_tickets s WHERE s.well_id = wells.id)
  AND NOT EXISTS (SELECT 1 FROM rental_agreements r WHERE r.well_id = wells.id)
  AND NOT EXISTS (SELECT 1 FROM serialized_equipment e WHERE e.current_well_id = wells.id)
  AND NOT EXISTS (SELECT 1 FROM work_points wp WHERE wp.well_id = wells.id)
  AND NOT EXISTS (SELECT 1 FROM fit_test_records fr WHERE fr.well_id = wells.id)
  AND NOT EXISTS (SELECT 1 FROM route_stops rs WHERE rs.well_id = wells.id)
  AND NOT EXISTS (SELECT 1 FROM ticket_line_items tli WHERE tli.well_id_override = wells.id);

-- ------------------------------------------------------------
-- STEP 8: Re-point the DMR reference rows at the right well + company
--
-- 19 of the export's DMR rows had a stale or missing matched_well_id, which
-- is what lets a later activation run treat them as unmatched. operator_name
-- is deliberately left as "XTO ENERGY INC" — that column mirrors raw state
-- data and a re-import would overwrite it anyway. matched_company_id is what
-- the matcher actually reads.
-- ------------------------------------------------------------
UPDATE dmr_reference_wells d
SET matched_well_id = w.id,
    matched_company_id = (SELECT id FROM chord_target),
    updated_at = NOW()
FROM fbir_api f, wells w
WHERE regexp_replace(w.api_number, '[^0-9]', '', 'g') = f.api
  AND regexp_replace(d.api_number, '[^0-9]', '', 'g') = f.api
  AND (d.matched_well_id IS DISTINCT FROM w.id
       OR d.matched_company_id IS DISTINCT FROM (SELECT id FROM chord_target));

-- ------------------------------------------------------------
-- STEP 9: Verify - read these before you COMMIT
-- ------------------------------------------------------------
-- Counted over fbir_target, not the name pattern: one row in the export
-- ("Baker 34X-25C", API 33025037420000) is missing its FBIR prefix in our
-- data, so a name-only count would under-report it by one. It is in the
-- human-review list at the bottom.
SELECT 'target wells on Chord' AS check, count(*)::text AS value
FROM wells w JOIN fbir_target t ON t.id = w.id
WHERE w.current_operator_id = (SELECT id FROM chord_target)
UNION ALL
SELECT 'target wells NOT on Chord', count(*)::text
FROM wells w JOIN fbir_target t ON t.id = w.id
WHERE w.current_operator_id IS DISTINCT FROM (SELECT id FROM chord_target)
UNION ALL
SELECT 'target wells with tier_1', count(*)::text
FROM wells w JOIN fbir_target t ON t.id = w.id WHERE w.tier_1
UNION ALL
SELECT 'target wells WITHOUT tier_1', count(*)::text
FROM wells w JOIN fbir_target t ON t.id = w.id WHERE NOT w.tier_1
UNION ALL
SELECT 'wells named FBIR% still not on Chord', count(*)::text
FROM wells WHERE well_name ILIKE 'FBIR%'
  AND current_operator_id IS DISTINCT FROM (SELECT id FROM chord_target)
UNION ALL
SELECT 'export APIs with no well (dead permits)', count(*)::text
FROM fbir_api f
WHERE NOT EXISTS (SELECT 1 FROM wells w WHERE regexp_replace(w.api_number,'[^0-9]','','g') = f.api)
UNION ALL
SELECT 'operator_history rows written now', count(*)::text
FROM operator_history
WHERE notes = 'XTO to Chord Energy: FBIR well set, DrillingEdge export 2026-09-08'
UNION ALL
SELECT 'wells on the new 21X-10 pad', count(*)::text
FROM wells w JOIN pads p ON p.id = w.pad_id WHERE p.name = 'FBIR Iron Woman 21X-10'
UNION ALL
SELECT 'pads flagged tier_1', count(*)::text FROM pads WHERE tier_1;

-- What each reassigned well was on before:
SELECT c.name AS previous_operator, count(*) AS wells
FROM operator_history oh
JOIN companies c ON c.id = oh.previous_operator_id
WHERE oh.notes = 'XTO to Chord Energy: FBIR well set, DrillingEdge export 2026-09-08'
GROUP BY 1 ORDER BY 2 DESC;

-- Left for a human: target wells whose name disagrees with the state's name
-- for their API, plus API-less rows. These are rename/dedupe decisions, not
-- something this script should guess at. Reassignment and Tier 1 are already
-- correct for all of them — only the NAME is in question.
SELECT w.well_name AS our_name,
       COALESCE(w.api_number, '(no API)') AS api,
       COALESCE(d.well_name, '(no DMR row)') AS state_name,
       CASE WHEN w.pad_id IS NULL THEN 'no pad' ELSE 'on a pad' END AS pad
FROM wells w
JOIN fbir_target t ON t.id = w.id
LEFT JOIN dmr_reference_wells d
  ON regexp_replace(d.api_number,'[^0-9]','','g') = regexp_replace(w.api_number,'[^0-9]','','g')
WHERE w.api_number IS NULL OR d.well_name IS NULL
   OR upper(replace(d.well_name, ' ', '')) <> upper(replace(w.well_name, ' ', ''))
ORDER BY 1;

-- Flip these two when the counts look right:
-- COMMIT;
ROLLBACK;
