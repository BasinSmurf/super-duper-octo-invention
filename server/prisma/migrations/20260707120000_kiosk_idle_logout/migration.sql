-- CLAIM kiosks: optional idle-logout window (minutes). When set (>0), a signed-in
-- intake session auto-logs-out after this many idle minutes (board stays open).
ALTER TABLE "kiosks" ADD COLUMN "idle_logout_minutes" INTEGER;
