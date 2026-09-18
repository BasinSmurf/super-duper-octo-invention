-- Wave 4 foundation: per-job run history for the watcher/scheduler layer.
-- Pairs with services/jobLocks.ts (Redis SET NX EX wrapper) and services/jobs.ts
-- (runScheduledJob helper that wraps fn execution + persists outcome here).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'JobRunStatus') THEN
    CREATE TYPE "JobRunStatus" AS ENUM ('running', 'success', 'error', 'skipped');
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS "job_runs" (
    "id"            TEXT NOT NULL,
    "job_name"      TEXT NOT NULL,
    "started_at"    TIMESTAMP(3) NOT NULL,
    "finished_at"   TIMESTAMP(3),
    "status"        "JobRunStatus" NOT NULL,
    "duration_ms"   INTEGER,
    "error_message" TEXT,

    CONSTRAINT "job_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "job_runs_name_started_idx"
    ON "job_runs" ("job_name", "started_at" DESC);
