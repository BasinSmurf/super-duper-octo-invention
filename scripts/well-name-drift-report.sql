-- ============================================================
-- WELL NAME DRIFT REPORT  (read-only, safe to run anywhere)
--
-- A well record must name a REAL well. This lists every well whose name
-- disagrees with what NDIC calls the API on that same row, split by how bad
-- the disagreement is — because the two halves need completely different
-- treatment:
--
--   COSMETIC  — same designation, different caps/spacing. Safe to bulk-adopt
--               the state's name. Migration 20260908150000 did exactly this
--               for the FBIR set, and normalizeWellName() in
--               wellDmrMatch.ts now applies it on every match/activation.
--
--   LETTERING — the name claims a DIFFERENT well than the API does. Two very
--               different causes hide in here and only a human can tell them
--               apart:
--                 (a) name drift — the API is right, the name is a typo
--                     ("FBIR WALKER 31X36DX2" for 31X-36DXA). Fix the name.
--                 (b) a BAD API MATCH — the name is right and the API was
--                     attached to the wrong well ("Hellickson Paluck 44X-24"
--                     carrying the API for "Hellickson Paluck 2-25H"). Fix
--                     the match; renaming would relabel a real well and bury
--                     the error.
--               Do NOT bulk-adopt this half.
-- ============================================================

\echo '== how much drift, by kind =='
WITH j AS (
  SELECT w.well_name AS ours,
         regexp_replace(btrim(d.well_name), '\s+', ' ', 'g') AS state_name
  FROM wells w
  JOIN dmr_reference_wells d
    ON regexp_replace(d.api_number, '[^0-9]', '', 'g')
     = regexp_replace(w.api_number, '[^0-9]', '', 'g')
  WHERE w.well_name IS NOT NULL AND d.well_name IS NOT NULL
)
SELECT count(*)                                                      AS matched_to_dmr,
       count(*) FILTER (WHERE ours = state_name)                     AS clean,
       count(*) FILTER (WHERE ours <> state_name
                          AND upper(replace(ours, ' ', ''))
                            = upper(replace(state_name, ' ', '')))   AS cosmetic_only,
       count(*) FILTER (WHERE upper(replace(ours, ' ', ''))
                          <> upper(replace(state_name, ' ', '')))    AS lettering_differs
FROM j;

\echo ''
\echo '== LETTERING differences — review these by hand, worst-used first =='
SELECT w.well_name                                                   AS ours,
       regexp_replace(btrim(d.well_name), '\s+', ' ', 'g')            AS state_name,
       w.api_number,
       COALESCE(c.name, '(no operator)')                              AS operator,
       (SELECT count(*) FROM service_tickets s WHERE s.well_id = w.id) AS tickets
FROM wells w
JOIN dmr_reference_wells d
  ON regexp_replace(d.api_number, '[^0-9]', '', 'g')
   = regexp_replace(w.api_number, '[^0-9]', '', 'g')
LEFT JOIN companies c ON c.id = w.current_operator_id
WHERE w.well_name IS NOT NULL AND d.well_name IS NOT NULL
  AND upper(replace(w.well_name, ' ', ''))
   <> upper(replace(regexp_replace(btrim(d.well_name), '\s+', ' ', 'g'), ' ', ''))
ORDER BY tickets DESC, 1;

\echo ''
\echo '== wells with NO api_number at all — not identifiable as a real well =='
-- Hand-entered rows that were never matched to a wellbore. Some are genuinely
-- unmatched wells; some are pads or batteries someone typed into the well
-- form (see "FBIR Iron Woman 21X-10", which became a real pad in
-- scripts/xto-fbir-to-chord-upsert.sql).
SELECT w.well_name,
       COALESCE(c.name, '(no operator)')                              AS operator,
       CASE WHEN w.pad_id IS NULL THEN 'no pad' ELSE 'on a pad' END    AS pad,
       (SELECT count(*) FROM service_tickets s WHERE s.well_id = w.id) AS tickets
FROM wells w
LEFT JOIN companies c ON c.id = w.current_operator_id
WHERE w.api_number IS NULL
  AND w.asset_category = 'site'
ORDER BY tickets DESC, 1;

\echo ''
\echo '== PAD-SHAPED wells — a name that identifies TWO wells, not one =='
-- The legacy Azure/DoForms import made every location a well: 2,815 of 2,845
-- wells carry an azureLocationId and not one pad does. So some "wells" are
-- really pads, and a name naming two wells is the tell.
--
-- Read the last column FIRST. When the state names an API with that exact
-- slashed name, the row is a REAL single wellbore and must be left alone —
-- DAILEY 4-12/13H, DODGE 4-6/7 HR, GABBERT 3-3/10H, KUMMER 1-6/7H and
-- Ildstad/Berman 2C-4-1 are all genuine wells whose designation spans two
-- sections. Promoting those would destroy five real wells.
--
-- A row is safe to promote only when ALL of:
--   * api_number IS NULL          (nothing claims it is a specific wellbore)
--   * state_names_a_well_this_way = false
--   * both halves of the name exist in DMR under their own separate APIs
--     (check by hand — the halves can't be split reliably in SQL)
-- Rows that meet the last test but DO carry an API need a human: the API is a
-- competing claim about what the row is. See
-- scripts/promote-pad-shaped-wells.sql for the four already confirmed.
SELECT w.well_name,
       COALESCE(w.api_number, '(no API)')                              AS api,
       COALESCE(c.name, '(no operator)')                               AS operator,
       (SELECT count(*) FROM service_tickets s WHERE s.well_id = w.id) AS tickets,
       EXISTS (
         SELECT 1 FROM dmr_reference_wells d
         WHERE upper(replace(d.well_name, ' ', '')) = upper(replace(w.well_name, ' ', ''))
       )                                                               AS state_names_a_well_this_way
FROM wells w
LEFT JOIN companies c ON c.id = w.current_operator_id
WHERE w.well_name LIKE '%/%'
  AND w.is_active_for_service
  AND w.asset_category = 'site'
ORDER BY 5, 4 DESC, 1;
