-- Per-user dashboard widget layout
-- Stores array of widget instances as JSONB; null = use role baseline
ALTER TABLE "users" ADD COLUMN "dashboard_widgets" JSONB;
