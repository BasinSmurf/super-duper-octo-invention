-- ============================================================
-- PROMOTE PAD-SHAPED WELLS TO ACTUAL PADS
--
-- A name like "George Federal 21X-19/Bang Federal 21X-19" names TWO wells, so
-- the row is a PAD that the legacy Azure/DoForms import materialized as a
-- well. (That import made every location a well: 2,815 of 2,845 wells carry an
-- `azureLocationId` and not one pad does — which is why pad-less is the
-- majority case in the first place.)
--
-- THE TEST IS NOT "HAS A SLASH." Five slash-named rows are real single
-- wellbores, and the state says so itself — NDIC names those exact APIs with
-- the slash: DAILEY 4-12/13H, DODGE 4-6/7 HR, GABBERT 3-3/10H, KUMMER 1-6/7H,
-- Ildstad/Berman 2C-4-1. Promoting those would destroy five real wells.
--
-- The test that holds up, and the one used here:
--   1. the row has NO api_number (nothing claims it is a specific wellbore)
--   2. BOTH halves of the name exist in DMR as their own wells, under their
--      own separate APIs
--   3. the state does NOT name any API with that slashed name
--
-- Rows that satisfy 2 but carry an API are deliberately NOT in this list — the
-- API is a competing claim about what the row is, and only a human can say
-- whether the name or the API is the truth. Same for rows whose second half
-- can't be pinned to one lease.
--
-- Tickets move to the pad and lose their well: 369 of them across these rows,
-- and pad-level tickets are entirely normal here (1,470 already exist). The
-- bogus well row is soft-deactivated with a breadcrumb, never deleted —
-- matching mergeWell() in server/src/services/wellDmrMatch.ts.
--
-- Idempotent. Ends in ROLLBACK — read the verify output, then flip to COMMIT.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- STEP 0: The four confirmed pads, by exact name
--
-- Listed explicitly rather than matched by pattern, because the pattern has
-- false positives that cost real wells. Every one of these is API-less, and
-- both of its lease families exist in DMR under their own APIs:
--   LK-ERICKSON/QUILLIAM H2-4    LK-ERICKSON- 147-97-1102H-* (7)  + LK-QUILLIAM- 147-97-1423H-* (12)
--   George Federal .../Bang ...  GEORGE FEDERAL 21X-19* (4)       + BANG FEDERAL 21X-19* (4)
--   LK-BICE0631H3/A QTR CIR      LK-BICE- 147-96-0631H-* (7)      + LK-A QTR CIR- 147-96-* (10)
--   ARLENE FEDERAL/ROUGH ...     ARLENE FEDERAL 44X-23A-H (8)     + ROUGH FEDERAL 44X-23A-H+DXA (9)
-- ------------------------------------------------------------
CREATE TEMP TABLE promote (well_name text PRIMARY KEY) ON COMMIT DROP;
INSERT INTO promote (well_name) VALUES
  ('LK-ERICKSON/QUILLIAM H2-4'),
  ('George Federal 21X-19/Bang Federal 21X-19'),
  ('LK-BICE0631H3/A QTR CIR'),
  ('ARLENE FEDERAL/ROUGH FEDERAL 44X-23F');

-- Member wells to attach, where we actually carry them. Three of the four have
-- no activated members at all — the pad still stands (the tickets are what
-- live there), and wells attach later from the DMR browser.
CREATE TEMP TABLE member (pad_name text, pat text) ON COMMIT DROP;
INSERT INTO member (pad_name, pat) VALUES
  ('George Federal 21X-19/Bang Federal 21X-19', '%GEORGE%FEDERAL%21X-19%'),
  ('George Federal 21X-19/Bang Federal 21X-19', '%BANG%FEDERAL%21X-19%'),
  ('ARLENE FEDERAL/ROUGH FEDERAL 44X-23F',      '%ARLENE%44X-23%'),
  ('ARLENE FEDERAL/ROUGH FEDERAL 44X-23F',      '%ROUGH%44X-23%');

-- ------------------------------------------------------------
-- STEP 1: Preflight — refuse to run if reality moved
--
-- (a) all four rows must still exist as wells
-- (b) none may have picked up an api_number since this was written; an API
--     means something now claims the row IS a specific wellbore, and that is
--     a human call, not a script's
-- (c) the state must not name a well with that slashed name (the
--     DAILEY 4-12/13H trap)
-- ------------------------------------------------------------
DO $$
DECLARE n int; bad text;
BEGIN
  SELECT count(*) INTO n FROM wells w JOIN promote p ON p.well_name = w.well_name;
  IF n <> 4 THEN RAISE EXCEPTION 'Expected 4 pad-shaped wells, found % — resolve by hand', n; END IF;

  SELECT string_agg(w.well_name || ' (' || w.api_number || ')', '; ') INTO bad
  FROM wells w JOIN promote p ON p.well_name = w.well_name
  WHERE w.api_number IS NOT NULL;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'These now carry an API and are no longer safe to promote: %', bad;
  END IF;

  SELECT string_agg(w.well_name, '; ') INTO bad
  FROM wells w JOIN promote p ON p.well_name = w.well_name
  WHERE EXISTS (
    SELECT 1 FROM dmr_reference_wells d
    WHERE upper(replace(d.well_name, ' ', '')) = upper(replace(w.well_name, ' ', ''))
  );
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'The state names a well this way, so it is a real wellbore, not a pad: %', bad;
  END IF;
END $$;

-- ------------------------------------------------------------
-- STEP 2: Create the pads
--
-- The name carries over verbatim. Operators name pads across two leases on
-- purpose, so "LK-ERICKSON/QUILLIAM H2-4" is a perfectly good PAD name — and
-- keeping it means every ticket and route still reads the way the crews expect.
-- manually_verified because this is a human-confirmed reclassification, not a
-- guess by the matcher.
-- ------------------------------------------------------------
INSERT INTO pads
  (id, name, field_id, current_operator_id, section, township, range,
   county, latitude, longitude, asset_category,
   auto_generated, manually_verified, pending_review, is_active,
   custom_data, created_at, updated_at)
SELECT
  gen_random_uuid(), w.well_name, w.field_id, w.current_operator_id,
  w.section, w.township, w.range, w.county, w.latitude, w.longitude,
  'site'::"PadAssetCategory",
  false, true, false, true,
  COALESCE(w.custom_data, '{}'::jsonb) || jsonb_build_object(
    'promotedFromWellId', w.id,
    'promotedAt', to_char(NOW(), 'YYYY-MM-DD"T"HH24:MI:SSOF'),
    'promotedReason', 'name identifies two wells that each exist under their own API'
  ),
  NOW(), NOW()
FROM wells w
JOIN promote p ON p.well_name = w.well_name
WHERE NOT EXISTS (SELECT 1 FROM pads x WHERE x.name = w.well_name);

-- ------------------------------------------------------------
-- STEP 3: Move the work off the well and onto the pad
--
-- field_id stays as it is; only the well→pad level changes. All three of these
-- tables have a pad_id, and none of the four rows has any rental, equipment,
-- route-stop, fit-test or line-item-override link (checked: all zero), which
-- matters because fit_test_records and ticket_line_items have NO pad column to
-- move to.
-- ------------------------------------------------------------
UPDATE service_tickets s
SET pad_id = pd.id, well_id = NULL
FROM wells w JOIN promote p ON p.well_name = w.well_name
JOIN pads pd ON pd.name = w.well_name
WHERE s.well_id = w.id;

UPDATE work_points wp
SET pad_id = pd.id, well_id = NULL
FROM wells w JOIN promote p ON p.well_name = w.well_name
JOIN pads pd ON pd.name = w.well_name
WHERE wp.well_id = w.id;

UPDATE operator_history oh
SET pad_id = pd.id, well_id = NULL
FROM wells w JOIN promote p ON p.well_name = w.well_name
JOIN pads pd ON pd.name = w.well_name
WHERE oh.well_id = w.id;

-- ------------------------------------------------------------
-- STEP 4: Attach the member wells we carry
--
-- Operators are NOT touched. Several members disagree with their new pad's
-- operator — Arlene/Rough's members sit on Petro-Hunt under a Kraken pad, and
-- George/Bang's six span four companies including "Stallion Oilfield
-- Services", which is a service company, not an operator. That disagreement
-- already exists; attaching makes it visible instead of creating it, and STEP 6
-- prints it. Reassigning operators is a separate decision.
-- ------------------------------------------------------------
UPDATE wells w
SET pad_id = pd.id, updated_at = NOW()
FROM member m
JOIN pads pd ON pd.name = m.pad_name
WHERE w.well_name ILIKE m.pat
  AND w.api_number IS NOT NULL
  AND w.well_name NOT LIKE '%/%'
  AND w.pad_id IS DISTINCT FROM pd.id;

-- ------------------------------------------------------------
-- STEP 5: Retire the bogus well row
--
-- Soft-deactivate with a breadcrumb rather than DELETE — the house pattern
-- from mergeWell(). These rows carried 369 tickets between them; a delete
-- would SET NULL across that history, and there would be nothing left to
-- explain where it went.
-- ------------------------------------------------------------
UPDATE wells w
SET is_active_for_service = false,
    service_notes = COALESCE(w.service_notes || ' | ', '')
                    || 'Reclassified as a pad — this row named two wells, not one. Work moved to the pad of the same name.',
    custom_data = COALESCE(w.custom_data, '{}'::jsonb) || jsonb_build_object(
      'promotedToPadId', (SELECT id FROM pads WHERE name = w.well_name),
      'promotedAt', to_char(NOW(), 'YYYY-MM-DD"T"HH24:MI:SSOF'),
      'promotedVia', 'pad_shaped_well_promotion'
    ),
    updated_at = NOW()
FROM promote p
WHERE p.well_name = w.well_name
  AND w.custom_data ->> 'promotedToPadId' IS NULL;

-- ------------------------------------------------------------
-- STEP 6: Verify — read before COMMIT
-- ------------------------------------------------------------
SELECT p.name AS pad,
       COALESCE(c.name, '(no operator)') AS pad_operator,
       (SELECT count(*) FROM service_tickets s WHERE s.pad_id = p.id) AS tickets_now_on_pad,
       (SELECT count(*) FROM work_points wp WHERE wp.pad_id = p.id)   AS work_points,
       (SELECT count(*) FROM wells w WHERE w.pad_id = p.id)           AS wells_attached
FROM pads p
JOIN promote pr ON pr.well_name = p.name
LEFT JOIN companies c ON c.id = p.current_operator_id
ORDER BY 3 DESC;

SELECT 'tickets still pointing at a retired row' AS check, count(*)::text AS value
FROM service_tickets s JOIN wells w ON w.id = s.well_id
JOIN promote p ON p.well_name = w.well_name
UNION ALL
SELECT 'rows retired', count(*)::text
FROM wells w JOIN promote p ON p.well_name = w.well_name
WHERE NOT w.is_active_for_service AND w.custom_data ->> 'promotedToPadId' IS NOT NULL
UNION ALL
SELECT 'real slash-named wells left untouched', count(*)::text
FROM wells w
WHERE w.well_name LIKE '%/%' AND w.is_active_for_service
  AND EXISTS (SELECT 1 FROM dmr_reference_wells d
              WHERE upper(replace(d.well_name,' ','')) = upper(replace(w.well_name,' ','')));

-- Member wells whose operator disagrees with the pad they just joined.
-- Nothing here is broken by this script — it is pre-existing DMR mismatch that
-- the pad now makes visible. Left for a human.
SELECT p.name AS pad,
       COALESCE(pc.name, '(none)') AS pad_operator,
       w.well_name,
       COALESCE(wc.name, '(none)') AS well_operator
FROM wells w
JOIN pads p ON p.id = w.pad_id
JOIN promote pr ON pr.well_name = p.name
LEFT JOIN companies pc ON pc.id = p.current_operator_id
LEFT JOIN companies wc ON wc.id = w.current_operator_id
WHERE w.current_operator_id IS DISTINCT FROM p.current_operator_id
ORDER BY 1, 3;

-- Flip these two when the counts look right:
-- COMMIT;
ROLLBACK;
