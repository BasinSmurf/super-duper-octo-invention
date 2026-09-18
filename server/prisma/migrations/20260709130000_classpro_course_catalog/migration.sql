-- ClassPRO course catalog (cp_ namespace — bounded module, ADR-0002).
-- Replaces the hardcoded client COURSE_TYPES array as the source of truth
-- for course definitions. Seeded below from the legacy static maps:
--   * slug/label/cardsOnSite  ← client COURSE_TYPES
--   * qb_part_number          ← server courseProductMap COURSE_TO_PART
--   * vaultpro_class_code     ← server blueLionClassMap (only the three
--     codes already confirmed against the governed catalog; everything
--     else stays NULL and parks on push — do not guess codes)
-- The legacy 'other' entry is intentionally not seeded: "Other" is a
-- wizard affordance (free-text course name), not a catalog row.

CREATE TABLE "cp_courses" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "duration_hours" DOUBLE PRECISION,
    "validity_months" INTEGER,
    "passing_score" INTEGER,
    "vaultpro_class_code" TEXT,
    "cards_on_site" BOOLEAN NOT NULL DEFAULT false,
    "qb_part_number" TEXT,
    "book_version" TEXT,
    "test_version" TEXT,
    "standard" TEXT,
    "description" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cp_courses_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "cp_courses_code_key" ON "cp_courses"("code");

-- Seed. Durations only where the label states them (plus H2S CLEAR = 4 hr
-- awareness per the ClassPRO handoff); validity only for the H2S courses
-- (12 months per the handoff). Everything unknown stays NULL for the admin
-- to fill in — no guessing.
INSERT INTO "cp_courses"
  ("id", "code", "name", "duration_hours", "validity_months", "vaultpro_class_code", "cards_on_site", "qb_part_number", "sort_order", "updated_at")
VALUES
  (gen_random_uuid(), 'h2s_clear',                'H2S CLEAR',                             4,    12,   'H2S',      true,  '11003', 10,  CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'pec_safeland',             'PEC SafeLand',                          NULL, NULL, 'SAFELAND', false, '11005', 20,  CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'first_aid_cpr',            'First Aid/CPR',                         NULL, NULL, 'CPR-FA',   false, '11011', 30,  CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'safety_meeting',           'Safety Meeting',                        NULL, NULL, NULL,       true,  '10012', 40,  CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'man_down_rescue',          'Man Down Rescue',                       NULL, NULL, NULL,       true,  '11059', 50,  CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'fex_safety_1hr',           'FEX Safety (1 hr)',                     1,    NULL, NULL,       true,  '11016', 60,  CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'h2s_pec_combo',            'H2S Awareness + PEC Basic (1hr + 8hr)', 9,    NULL, NULL,       false, '11007', 70,  CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'h2s_awareness_1hr',        'H2S Awareness (1 hr)',                  1,    12,   'H2S',      true,  '11001', 80,  CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'confined_space_4hr',       'Confined Space (4 hr)',                 4,    NULL, NULL,       true,  '11013', 90,  CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'defensive_driving_4hr',    'Defensive Driving (4 hr)',              4,    NULL, NULL,       true,  '11015', 100, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'bloodborne_pathogens_1hr', 'Bloodborne Pathogens (1 hr)',           1,    NULL, NULL,       true,  'Misc',  110, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;
