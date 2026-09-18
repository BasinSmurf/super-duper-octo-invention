-- CreateEnum (IF NOT EXISTS pattern for safety)
DO $$ BEGIN
  CREATE TYPE "SignatureRequired" AS ENUM ('none', 'ticket', 'invoice', 'both');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Add signature fields to customer_billing_profiles
ALTER TABLE "customer_billing_profiles"
  ADD COLUMN IF NOT EXISTS "signature_required" "SignatureRequired" NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS "signature_approvers" JSONB;
