-- Stored, indexed normalized well name for the DMR backfill/dedupe matcher.
--
-- The matcher joins wells <-> dmr_reference_wells on the normalized name
-- UPPER(regexp_replace(TRIM(well_name), '\s+', ' ', 'g')). Joining on the bare
-- expression made Postgres nested-loop two computed values (tens of millions of
-- regexp calls -> minutes, HTTP timeout) because an aggregated CTE's output can't
-- use an expression index. A STORED generated column gives a plain, indexable
-- column the planner hash-joins on. regexp_replace/UPPER/TRIM are IMMUTABLE, so
-- the generated expression is allowed.

ALTER TABLE wells ADD COLUMN IF NOT EXISTS name_norm text
  GENERATED ALWAYS AS (UPPER(regexp_replace(TRIM(well_name), '\s+', ' ', 'g'))) STORED;

ALTER TABLE dmr_reference_wells ADD COLUMN IF NOT EXISTS name_norm text
  GENERATED ALWAYS AS (UPPER(regexp_replace(TRIM(well_name), '\s+', ' ', 'g'))) STORED;

CREATE INDEX IF NOT EXISTS idx_wells_name_norm ON wells (name_norm);
CREATE INDEX IF NOT EXISTS idx_dmr_ref_name_norm ON dmr_reference_wells (name_norm);
