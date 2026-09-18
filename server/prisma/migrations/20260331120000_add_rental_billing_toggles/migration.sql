-- Add billing classification toggles to rental agreements
ALTER TABLE "rental_agreements" ADD COLUMN "is_manned" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "rental_agreements" ADD COLUMN "is_rig_job" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "rental_agreements" ADD COLUMN "monitors_included" BOOLEAN NOT NULL DEFAULT false;
