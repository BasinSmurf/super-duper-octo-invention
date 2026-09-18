-- CreateEnum
CREATE TYPE "RouteCycleStatus" AS ENUM ('active', 'completed', 'cancelled');

-- AlterTable
ALTER TABLE "companies" ADD COLUMN     "afe_label" TEXT,
ADD COLUMN     "attach_field_ticket" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "attach_invoice" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "cost_center_label" TEXT,
ADD COLUMN     "due_date_offset" INTEGER,
ADD COLUMN     "invoice_template_id" TEXT,
ADD COLUMN     "is_tier1" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "payment_terms" TEXT,
ADD COLUMN     "po_label" TEXT,
ADD COLUMN     "price_book_number" TEXT,
ADD COLUMN     "wo_label" TEXT;

-- AlterTable
ALTER TABLE "work_points" ADD COLUMN     "air_system_type" TEXT,
ADD COLUMN     "custom_data" JSONB,
ADD COLUMN     "legacy_air_system_id" TEXT,
ADD COLUMN     "reel_serial_number" TEXT,
ADD COLUMN     "stand_serial_number" TEXT;

-- CreateTable
CREATE TABLE "service_routes" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "route_number" TEXT,
    "company_id" TEXT NOT NULL,
    "area" TEXT,
    "description" TEXT,
    "estimated_miles" DECIMAL(8,1),
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "legacy_route_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "service_routes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "route_stops" (
    "id" TEXT NOT NULL,
    "route_id" TEXT NOT NULL,
    "pad_id" TEXT,
    "well_id" TEXT,
    "facility_id" TEXT,
    "stop_index" INTEGER NOT NULL,
    "route_mileage" DECIMAL(8,1),
    "notes" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "work_order_number" TEXT,
    "afe_number" TEXT,
    "cost_center" TEXT,
    "sales_tax_id" TEXT,
    "client_name" TEXT,
    "legacy_location_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "route_stops_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "route_cycles" (
    "id" TEXT NOT NULL,
    "route_id" TEXT NOT NULL,
    "cycle_name" TEXT,
    "start_date" DATE NOT NULL,
    "end_date" DATE,
    "status" "RouteCycleStatus" NOT NULL DEFAULT 'active',
    "total_stops" INTEGER NOT NULL DEFAULT 0,
    "completed_stops" INTEGER NOT NULL DEFAULT 0,
    "assigned_tech_id" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "route_cycles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "route_cycle_visits" (
    "id" TEXT NOT NULL,
    "cycle_id" TEXT NOT NULL,
    "stop_id" TEXT NOT NULL,
    "ticket_id" TEXT,
    "visited_at" TIMESTAMP(3),
    "visited_by_id" TEXT,
    "skipped" BOOLEAN NOT NULL DEFAULT false,
    "skip_reason" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "route_cycle_visits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "service_routes_company_id_route_number_key" ON "service_routes"("company_id", "route_number");

-- CreateIndex
CREATE UNIQUE INDEX "route_stops_route_id_stop_index_key" ON "route_stops"("route_id", "stop_index");

-- CreateIndex
CREATE UNIQUE INDEX "route_cycle_visits_cycle_id_stop_id_key" ON "route_cycle_visits"("cycle_id", "stop_id");

-- AddForeignKey
ALTER TABLE "service_routes" ADD CONSTRAINT "service_routes_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_stops" ADD CONSTRAINT "route_stops_route_id_fkey" FOREIGN KEY ("route_id") REFERENCES "service_routes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_stops" ADD CONSTRAINT "route_stops_pad_id_fkey" FOREIGN KEY ("pad_id") REFERENCES "pads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_stops" ADD CONSTRAINT "route_stops_well_id_fkey" FOREIGN KEY ("well_id") REFERENCES "wells"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_stops" ADD CONSTRAINT "route_stops_facility_id_fkey" FOREIGN KEY ("facility_id") REFERENCES "facilities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_cycles" ADD CONSTRAINT "route_cycles_route_id_fkey" FOREIGN KEY ("route_id") REFERENCES "service_routes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_cycles" ADD CONSTRAINT "route_cycles_assigned_tech_id_fkey" FOREIGN KEY ("assigned_tech_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_cycle_visits" ADD CONSTRAINT "route_cycle_visits_cycle_id_fkey" FOREIGN KEY ("cycle_id") REFERENCES "route_cycles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_cycle_visits" ADD CONSTRAINT "route_cycle_visits_stop_id_fkey" FOREIGN KEY ("stop_id") REFERENCES "route_stops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_cycle_visits" ADD CONSTRAINT "route_cycle_visits_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "service_tickets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_cycle_visits" ADD CONSTRAINT "route_cycle_visits_visited_by_id_fkey" FOREIGN KEY ("visited_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
