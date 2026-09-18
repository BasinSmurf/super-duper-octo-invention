-- AlterTable
ALTER TABLE "rental_agreements" ADD COLUMN     "liability_acknowledged" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "liability_signature" TEXT,
ADD COLUMN     "liability_signed_at" TIMESTAMP(3),
ADD COLUMN     "liability_signed_by_name" TEXT,
ADD COLUMN     "site_contact_email" TEXT,
ADD COLUMN     "site_contact_name" TEXT,
ADD COLUMN     "site_contact_phone" TEXT;
