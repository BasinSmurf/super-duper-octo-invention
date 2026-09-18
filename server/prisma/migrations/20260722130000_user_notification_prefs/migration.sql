-- Self-service notification preferences on the user's own Account page.
-- JSON, same pattern as users.dashboard_widgets. Additive only — safe on the
-- drifted dev DB.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "notification_prefs" JSONB;
