-- FBIR well names adopt the state's designation.
--
-- A well record must name a REAL well. These rows did not: 76 FBIR wells
-- carried a hand-typed or DoForms-imported name that disagrees with what NDIC
-- calls the API sitting on that same row. Most of it is caps and double-space
-- noise, but some of it renamed the well outright:
--
--   FBIR WALKER 31X36DX2          -> FBIR WALKER 31X-36DXA
--   FBIR Lawrence 24X-36B         -> FBIR LAWRENCE 24X-26B     (26, not 36)
--   FBIR YOUNGBEAR  31X-9 Battery -> FBIR YOUNGBEAR 31X-9B     ("B" expanded to "Battery")
--   FBIR YELLOW WOLF 21X-10F      -> FBIR YELLOWWOLF 31X-10DXA (a 31X-10 well filed under a 21X-10 name)
--   Baker 34X-25C                 -> FBIR BAKER 34X-25C        (lost its FBIR prefix)
--
-- The last one mattered twice over: because the name had no FBIR prefix, the
-- Tier 1 backfill in 20260908120000_well_tier1 skipped it, and only the
-- API-keyed pass in scripts/xto-fbir-to-chord-upsert.sql caught it.
--
-- Whitespace is normalized rather than copied — the state is not clean either
-- ("FBIR LAWRENCE  24X-26A" ships with a double space). Lettering is
-- authoritative; spacing is not. Matches normalizeWellName() in
-- server/src/services/wellDmrMatch.ts, which now applies this on every
-- DMR match and activation so the drift cannot come back.
--
-- Scoped to FBIR: 400 wells system-wide disagree with their API's state name,
-- but a chunk of those are bad API matches rather than name drift (e.g.
-- "Hellickson Paluck 44X-24" sitting on the API for "Hellickson Paluck
-- 2-25H"), and renaming those would relabel a real well instead of fixing it.
-- That set needs review, not a blanket UPDATE.
--
-- well_name_base comes along because 85 of the 110 FBIR wells had none at all,
-- and the two link paths were already setting it from the DMR row while
-- keeping the local full name — internally inconsistent.
UPDATE "wells" w
   SET "well_name"      = regexp_replace(btrim(d."well_name"), '\s+', ' ', 'g'),
       "well_name_base" = COALESCE(
                            regexp_replace(btrim(d."well_name_base"), '\s+', ' ', 'g'),
                            w."well_name_base"
                          ),
       "updated_at"     = NOW()
  FROM "dmr_reference_wells" d
 WHERE regexp_replace(d."api_number", '[^0-9]', '', 'g')
     = regexp_replace(w."api_number", '[^0-9]', '', 'g')
   AND d."well_name" IS NOT NULL
   AND (w."well_name" ILIKE 'FBIR%' OR d."well_name" ILIKE 'FBIR%')
   AND (
        w."well_name" IS DISTINCT FROM regexp_replace(btrim(d."well_name"), '\s+', ' ', 'g')
     OR w."well_name_base" IS DISTINCT FROM regexp_replace(btrim(d."well_name_base"), '\s+', ' ', 'g')
   );
