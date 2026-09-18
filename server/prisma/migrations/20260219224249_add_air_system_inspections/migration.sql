-- CreateEnum
CREATE TYPE "InspectionResult" AS ENUM ('pass', 'fail', 'needs_service');

-- CreateEnum
CREATE TYPE "ComponentCheckResult" AS ENUM ('pass', 'fail', 'na');

-- CreateTable
CREATE TABLE "air_system_inspections" (
    "id" TEXT NOT NULL,
    "ticket_id" TEXT NOT NULL,
    "work_point_id" TEXT,
    "work_point_name" TEXT NOT NULL,
    "air_system_type" TEXT,
    "reel_serial_number" TEXT,
    "stand_serial_number" TEXT,
    "overall_result" "InspectionResult" NOT NULL,
    "reel_condition" "ComponentCheckResult" NOT NULL DEFAULT 'na',
    "stand_condition" "ComponentCheckResult" NOT NULL DEFAULT 'na',
    "hose_condition" "ComponentCheckResult" NOT NULL DEFAULT 'na',
    "mask_condition" "ComponentCheckResult" NOT NULL DEFAULT 'na',
    "regulator_condition" "ComponentCheckResult" NOT NULL DEFAULT 'na',
    "gauge_condition" "ComponentCheckResult" NOT NULL DEFAULT 'na',
    "alarm_condition" "ComponentCheckResult" NOT NULL DEFAULT 'na',
    "cylinder_condition" "ComponentCheckResult" NOT NULL DEFAULT 'na',
    "cylinder_psi" INTEGER,
    "cascade_psi" INTEGER,
    "flow_rate" DECIMAL(6,1),
    "cylinder_serial_number" TEXT,
    "cylinder_hydro_date" DATE,
    "cylinder_expiry_date" DATE,
    "service_actions" JSONB,
    "parts_replaced" TEXT,
    "notes" TEXT,
    "inspected_at" TIMESTAMP(3) NOT NULL,
    "inspected_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "air_system_inspections_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "air_system_inspections" ADD CONSTRAINT "air_system_inspections_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "service_tickets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "air_system_inspections" ADD CONSTRAINT "air_system_inspections_work_point_id_fkey" FOREIGN KEY ("work_point_id") REFERENCES "work_points"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "air_system_inspections" ADD CONSTRAINT "air_system_inspections_inspected_by_id_fkey" FOREIGN KEY ("inspected_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
