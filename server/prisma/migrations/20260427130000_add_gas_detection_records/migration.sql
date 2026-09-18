-- Phase B2: Gas Detection records.
-- One record per monitor on a Gas Detection ticket; each becomes a single
-- invoice line item at billing time. Per-ticket Fixed/Area selection lives
-- on customData JSONB (no schema change for those flags).

CREATE TYPE "GasDetectionSubtype" AS ENUM ('bump', 'calibration', 'sensor_replacement', 'other_repair');

CREATE TABLE "gas_detection_records" (
    "id" TEXT NOT NULL,
    "ticket_id" TEXT NOT NULL,
    "monitor_make" TEXT,
    "monitor_model" TEXT,
    "monitor_serial" TEXT NOT NULL,
    "subtype" "GasDetectionSubtype" NOT NULL,
    "test_result" "TestResult",
    "sensor_replaced" TEXT,
    "work_performed" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gas_detection_records_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "gas_detection_records_ticket_id_idx" ON "gas_detection_records"("ticket_id");

ALTER TABLE "gas_detection_records"
    ADD CONSTRAINT "gas_detection_records_ticket_id_fkey"
    FOREIGN KEY ("ticket_id") REFERENCES "service_tickets"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
