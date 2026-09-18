-- CreateTable
CREATE TABLE "bug_reports" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'bug',
    "title" TEXT NOT NULL,
    "description" TEXT,
    "reporter_id" TEXT,
    "reporter_name" TEXT,
    "reporter_email" TEXT,
    "reporter_role" TEXT,
    "route" TEXT,
    "context" JSONB,
    "logs" JSONB,
    "screenshot_key" TEXT,
    "emailed" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'open',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bug_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "bug_reports_status_created_idx" ON "bug_reports"("status", "created_at" DESC);
