CREATE TABLE "webhook_notifications" (
  "channel" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "url" TEXT,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "webhook_notifications_pkey" PRIMARY KEY ("channel")
);
