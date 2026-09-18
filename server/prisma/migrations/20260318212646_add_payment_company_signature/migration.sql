-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "company_id" TEXT,
ADD COLUMN     "customer_signature" TEXT;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;
