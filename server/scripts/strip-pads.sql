-- Strip all Pads — one-time data operation, see scripts/strip-pads.ts for the
-- dry-run reporting tool and full rationale. Run this via:
--   docker exec -i sundog-postgres psql -U sundog -d sundog < scripts/strip-pads.sql
-- Take a DB snapshot first (pg_dump) — this deletes every Pad row.
BEGIN;

-- Phase 1a: single-well pads — unambiguous backfill.
WITH single_well_pads AS (
  SELECT p.id AS pad_id, MIN(w.id) AS well_id FROM pads p JOIN wells w ON w.pad_id = p.id GROUP BY p.id HAVING COUNT(w.id) = 1
)
UPDATE service_tickets t SET well_id = s.well_id FROM single_well_pads s WHERE t.pad_id = s.pad_id AND t.well_id IS NULL;

WITH single_well_pads AS (
  SELECT p.id AS pad_id, MIN(w.id) AS well_id FROM pads p JOIN wells w ON w.pad_id = p.id GROUP BY p.id HAVING COUNT(w.id) = 1
)
UPDATE work_points t SET well_id = s.well_id FROM single_well_pads s WHERE t.pad_id = s.pad_id AND t.well_id IS NULL;

WITH single_well_pads AS (
  SELECT p.id AS pad_id, MIN(w.id) AS well_id FROM pads p JOIN wells w ON w.pad_id = p.id GROUP BY p.id HAVING COUNT(w.id) = 1
)
UPDATE rental_agreements r SET well_id = s.well_id, well_ids = jsonb_build_array(s.well_id)
FROM single_well_pads s
WHERE r.pad_id = s.pad_id AND r.well_id IS NULL AND (r.well_ids IS NULL OR r.well_ids = '[]'::jsonb);

-- Phase 1b: ambiguous (0 or 2+ wells) — breadcrumb, no guess.
WITH ambiguous_pads AS (
  SELECT p.id AS pad_id, p.name AS pad_name,
         COALESCE(array_agg(w.well_name) FILTER (WHERE w.id IS NOT NULL), '{}') AS well_names
  FROM pads p LEFT JOIN wells w ON w.pad_id = p.id GROUP BY p.id, p.name HAVING COUNT(w.id) <> 1
)
UPDATE service_tickets t
SET custom_data = COALESCE(t.custom_data, '{}'::jsonb) || jsonb_build_object(
  'needsWellReview', true,
  'formerPad', jsonb_build_object('name', ap.pad_name, 'wellNames', to_jsonb(ap.well_names))
)
FROM ambiguous_pads ap WHERE t.pad_id = ap.pad_id AND t.well_id IS NULL;

WITH ambiguous_pads AS (
  SELECT p.id AS pad_id, p.name AS pad_name,
         COALESCE(array_agg(w.well_name) FILTER (WHERE w.id IS NOT NULL), '{}') AS well_names
  FROM pads p LEFT JOIN wells w ON w.pad_id = p.id GROUP BY p.id, p.name HAVING COUNT(w.id) <> 1
)
UPDATE work_points t
SET custom_data = COALESCE(t.custom_data, '{}'::jsonb) || jsonb_build_object(
  'needsWellReview', true,
  'formerPad', jsonb_build_object('name', ap.pad_name, 'wellNames', to_jsonb(ap.well_names))
)
FROM ambiguous_pads ap WHERE t.pad_id = ap.pad_id AND t.well_id IS NULL;

WITH ambiguous_pads AS (
  SELECT p.id AS pad_id, p.name AS pad_name
  FROM pads p LEFT JOIN wells w ON w.pad_id = p.id GROUP BY p.id, p.name HAVING COUNT(w.id) <> 1
)
UPDATE rental_agreements r
SET notes = COALESCE(r.notes || E'\n', '') || '[needs well match — was on pad ' || ap.pad_name || ']'
FROM ambiguous_pads ap
WHERE r.pad_id = ap.pad_id AND r.well_id IS NULL AND (r.well_ids IS NULL OR r.well_ids = '[]'::jsonb);

-- Phase 2: null every Pad FK, then delete every Pad row.
UPDATE service_tickets SET pad_id = NULL WHERE pad_id IS NOT NULL;
UPDATE rental_agreements SET pad_id = NULL WHERE pad_id IS NOT NULL;
UPDATE serialized_equipment SET current_pad_id = NULL WHERE current_pad_id IS NOT NULL;
UPDATE route_stops SET pad_id = NULL WHERE pad_id IS NOT NULL;
UPDATE operator_history SET pad_id = NULL WHERE pad_id IS NOT NULL;
UPDATE work_points SET pad_id = NULL WHERE pad_id IS NOT NULL;
UPDATE facilities SET pad_id = NULL WHERE pad_id IS NOT NULL;
UPDATE wells SET pad_id = NULL WHERE pad_id IS NOT NULL;
UPDATE shop_work_orders SET source_location_id = NULL WHERE source_location_id IS NOT NULL;
UPDATE shop_work_orders SET return_location_id = NULL WHERE return_location_id IS NOT NULL;
DELETE FROM pads;

COMMIT;
