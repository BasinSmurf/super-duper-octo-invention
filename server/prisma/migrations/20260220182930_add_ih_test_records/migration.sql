-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ServiceSubtype" ADD VALUE 'ih_h2s';
ALTER TYPE "ServiceSubtype" ADD VALUE 'ih_o2_voc';
ALTER TYPE "ServiceSubtype" ADD VALUE 'ih_sampling';
ALTER TYPE "ServiceSubtype" ADD VALUE 'ih_audiometric';

-- CreateTable
CREATE TABLE "ih_test_records" (
    "id" TEXT NOT NULL,
    "ticket_id" TEXT NOT NULL,
    "test_type" TEXT NOT NULL,
    "location_point" TEXT,
    "instrument_model" TEXT,
    "instrument_serial" TEXT,
    "test_data" JSONB NOT NULL,
    "notes" TEXT,
    "tested_at" TIMESTAMP(3) NOT NULL,
    "tested_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ih_test_records_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "ih_test_records" ADD CONSTRAINT "ih_test_records_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "service_tickets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ih_test_records" ADD CONSTRAINT "ih_test_records_tested_by_id_fkey" FOREIGN KEY ("tested_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
