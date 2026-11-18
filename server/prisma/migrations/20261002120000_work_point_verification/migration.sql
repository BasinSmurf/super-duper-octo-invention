ALTER TABLE "work_points"
  ADD COLUMN "verified" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "date_verified" TIMESTAMP(3),
  ADD COLUMN "verification_changed_at" TIMESTAMP(3);
ALTER TABLE "air_system_inspections"
  ADD COLUMN "verified" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "date_verified" TIMESTAMP(3);
CREATE TABLE "work_point_verification_config" (
  "id" TEXT NOT NULL DEFAULT 'default',
  "expiry_days" INTEGER NOT NULL DEFAULT 0 CHECK ("expiry_days" >= 0),
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "work_point_verification_config_pkey" PRIMARY KEY ("id")
);
