ALTER TYPE "EnverusQueueStatus" ADD VALUE IF NOT EXISTS 'superseded';
ALTER TABLE "enverus_sync_queue"
  ADD COLUMN "superseded_at" TIMESTAMP(3),
  ADD COLUMN "superseded_by_id" TEXT;
