-- Google Calendar sync handle for scheduled sessions. One gcal event per
-- session on the shared Training calendar (trainer invited as attendee);
-- the stored id makes create/update/cancel idempotent.

ALTER TABLE "cp_scheduled_sessions" ADD COLUMN "gcal_event_id" TEXT;
