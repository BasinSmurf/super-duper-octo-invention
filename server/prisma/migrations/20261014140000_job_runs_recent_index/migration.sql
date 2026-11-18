-- Ops recent-hour counts filter by time across all jobs.
CREATE INDEX IF NOT EXISTS "job_runs_started_idx" ON "job_runs" ("started_at");
