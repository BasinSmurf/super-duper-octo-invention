-- ClassPRO wave 4: pre-registration roster + "make the class" ticket push
-- + employer-name aliases for silent roster matching.
--
-- cp_session_registrations: pre-registered students on a scheduled session,
-- copied onto the draft training ticket as training_roster_records at push.
-- training_employer_aliases: normalized employer text -> Company, written by
-- the trainer-admin reconcile pane, read by the auto-matcher on QR sign-in
-- and registration entry (core table — serves core roster records too).

ALTER TYPE "TicketSourceType" ADD VALUE IF NOT EXISTS 'classpro_session';

-- Booking customer for the push (the ticket needs exactly one).
ALTER TABLE "cp_scheduled_sessions" ADD COLUMN "company_id" TEXT;
ALTER TABLE "cp_scheduled_sessions" ADD CONSTRAINT "cp_scheduled_sessions_company_id_fkey"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "cp_session_registrations" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "student_name" TEXT NOT NULL,
    "employer_name" TEXT,
    "employer_company_id" TEXT,
    "contact_phone" TEXT,
    "contact_email" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cp_session_registrations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "cp_session_registrations_session_id_idx" ON "cp_session_registrations"("session_id");

ALTER TABLE "cp_session_registrations" ADD CONSTRAINT "cp_session_registrations_session_id_fkey"
    FOREIGN KEY ("session_id") REFERENCES "cp_scheduled_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "cp_session_registrations" ADD CONSTRAINT "cp_session_registrations_employer_company_id_fkey"
    FOREIGN KEY ("employer_company_id") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "training_employer_aliases" (
    "id" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "training_employer_aliases_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "training_employer_aliases_alias_key" ON "training_employer_aliases"("alias");

ALTER TABLE "training_employer_aliases" ADD CONSTRAINT "training_employer_aliases_company_id_fkey"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
