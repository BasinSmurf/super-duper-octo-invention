-- CreateEnum
CREATE TYPE "SignatureStatus" AS ENUM ('NONE', 'PENDING', 'RECEIVED', 'VOIDED');

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "signature_status" "SignatureStatus" NOT NULL DEFAULT 'NONE';

-- AlterTable
ALTER TABLE "service_tickets" ADD COLUMN     "signature_status" "SignatureStatus" NOT NULL DEFAULT 'NONE';

-- CreateTable
CREATE TABLE "signature_requests" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ticket_id" TEXT,
    "invoice_id" TEXT,
    "status" "SignatureStatus" NOT NULL DEFAULT 'PENDING',
    "sent_to_email" TEXT NOT NULL,
    "sent_to_name" TEXT,
    "first_sent_at" TIMESTAMP(3) NOT NULL,
    "last_sent_at" TIMESTAMP(3) NOT NULL,
    "send_count" INTEGER NOT NULL DEFAULT 1,
    "sent_by_id" TEXT NOT NULL,
    "resolved_at" TIMESTAMP(3),
    "resolved_by_id" TEXT,
    "signed_document_url" TEXT,
    "notes" TEXT,

    CONSTRAINT "signature_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "signature_requests_ticket_id_key" ON "signature_requests"("ticket_id");

-- CreateIndex
CREATE UNIQUE INDEX "signature_requests_invoice_id_key" ON "signature_requests"("invoice_id");

-- AddForeignKey
ALTER TABLE "signature_requests" ADD CONSTRAINT "signature_requests_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "service_tickets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signature_requests" ADD CONSTRAINT "signature_requests_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signature_requests" ADD CONSTRAINT "signature_requests_sent_by_id_fkey" FOREIGN KEY ("sent_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signature_requests" ADD CONSTRAINT "signature_requests_resolved_by_id_fkey" FOREIGN KEY ("resolved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
