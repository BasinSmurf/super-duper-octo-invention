-- Google SSO group → role mappings for the new ClassPRO roles.
-- Group emails per owner spec (sundog-trainer / sundog-trainadmin); editable
-- afterwards in Admin → SSO role mappings. Priorities slot between the
-- existing ladder (admin 100 / super 80 / billing 60 / dispatch 40 / tech 20):
-- trainadmin (50) beats dispatch+tech for dual members; trainer (30) beats
-- tech only.

INSERT INTO "google_role_mappings" ("id", "google_group_email", "sundog_role", "priority", "updated_at")
VALUES
  (gen_random_uuid(), 'sundog-trainadmin@basinsafetyus.com', 'train_admin', 50, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'sundog-trainer@basinsafetyus.com',    'trainer',     30, CURRENT_TIMESTAMP)
ON CONFLICT ("google_group_email") DO NOTHING;
