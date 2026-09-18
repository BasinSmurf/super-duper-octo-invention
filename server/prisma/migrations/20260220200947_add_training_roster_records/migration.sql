-- AlterEnum
ALTER TYPE "ServiceSubtype" ADD VALUE 'safety_training';

-- CreateTable
CREATE TABLE "training_roster_records" (
    "id" TEXT NOT NULL,
    "ticket_id" TEXT NOT NULL,
    "employee_name" TEXT NOT NULL,
    "employee_id" TEXT,
    "employer_name" TEXT,
    "employer_company_id" TEXT,
    "contact_email" TEXT,
    "contact_phone" TEXT,
    "course_name" TEXT NOT NULL,
    "passed" BOOLEAN NOT NULL DEFAULT true,
    "card_issued_on_site" BOOLEAN NOT NULL DEFAULT false,
    "card_issued_official" BOOLEAN NOT NULL DEFAULT false,
    "card_number" TEXT,
    "card_expiry_date" DATE,
    "notes" TEXT,
    "trained_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "training_roster_records_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "training_roster_records" ADD CONSTRAINT "training_roster_records_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "service_tickets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_roster_records" ADD CONSTRAINT "training_roster_records_employer_company_id_fkey" FOREIGN KEY ("employer_company_id") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;
