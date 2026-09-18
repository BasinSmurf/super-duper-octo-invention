-- ClassPRO wave 3: scheduled sessions (the calendar unit).
-- Tier-A sessions reference cp_locations; Tier-B (ad-hoc) locations are
-- carried as session metadata (address + one-time geocode), deliberately not
-- location rows. ticket_id is display/idempotency metadata for the wave-4
-- "make the class" push — intentionally NOT a foreign key (Sundog owns the
-- ticket; ClassPRO never joins into ticket internals).

CREATE TABLE "cp_scheduled_sessions" (
    "id" TEXT NOT NULL,
    "course_id" TEXT NOT NULL,
    "trainer_id" TEXT,
    "location_id" TEXT,
    "ad_hoc_address" TEXT,
    "ad_hoc_lat" DOUBLE PRECISION,
    "ad_hoc_lng" DOUBLE PRECISION,
    "date" DATE NOT NULL,
    "start_time" TEXT NOT NULL,
    "end_time" TEXT NOT NULL,
    "delivery_mode" TEXT NOT NULL DEFAULT 'in_house',
    "capacity" INTEGER,
    "travel_before_min" INTEGER NOT NULL DEFAULT 0,
    "travel_after_min" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "ticket_id" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cp_scheduled_sessions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "cp_scheduled_sessions_date_idx" ON "cp_scheduled_sessions"("date");
CREATE INDEX "cp_scheduled_sessions_trainer_id_date_idx" ON "cp_scheduled_sessions"("trainer_id", "date");

ALTER TABLE "cp_scheduled_sessions" ADD CONSTRAINT "cp_scheduled_sessions_course_id_fkey"
    FOREIGN KEY ("course_id") REFERENCES "cp_courses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cp_scheduled_sessions" ADD CONSTRAINT "cp_scheduled_sessions_trainer_id_fkey"
    FOREIGN KEY ("trainer_id") REFERENCES "cp_trainers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "cp_scheduled_sessions" ADD CONSTRAINT "cp_scheduled_sessions_location_id_fkey"
    FOREIGN KEY ("location_id") REFERENCES "cp_locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
