-- BlueLion training-cert push integration.
-- Purely additive: new enums, the sync queue table, and three tracking columns
-- on training_roster_records.

-- CreateEnum
CREATE TYPE "BlueLionEntityType" AS ENUM ('training');

-- CreateEnum
CREATE TYPE "BlueLionSyncAction" AS ENUM ('push');

-- CreateEnum
CREATE TYPE "BlueLionQueueStatus" AS ENUM ('pending', 'synced', 'needs_attention', 'retrying', 'error');

-- AlterTable
ALTER TABLE "training_roster_records"
  ADD COLUMN "bluelion_person_id" TEXT,
  ADD COLUMN "bluelion_training_seq" INTEGER,
  ADD COLUMN "bluelion_synced_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "bluelion_sync_queue" (
    "id" TEXT NOT NULL,
    "entity_type" "BlueLionEntityType" NOT NULL DEFAULT 'training',
    "entity_id" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "action" "BlueLionSyncAction" NOT NULL DEFAULT 'push',
    "request_payload" TEXT,
    "response_payload" TEXT,
    "response_status_code" INTEGER,
    "status" "BlueLionQueueStatus" NOT NULL DEFAULT 'pending',
    "result_status" TEXT,
    "bluelion_person_id" TEXT,
    "training_seq" INTEGER,
    "candidates" JSONB,
    "error_message" TEXT,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submitted_at" TIMESTAMP(3),
    "responded_at" TIMESTAMP(3),

    CONSTRAINT "bluelion_sync_queue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "bluelion_sync_queue_external_id_key" ON "bluelion_sync_queue"("external_id");

-- CreateIndex
CREATE INDEX "bluelion_sync_queue_status_idx" ON "bluelion_sync_queue"("status");

-- CreateIndex
CREATE INDEX "training_roster_records_employee_name_bluelion_person_id_idx" ON "training_roster_records"("employee_name", "bluelion_person_id");
