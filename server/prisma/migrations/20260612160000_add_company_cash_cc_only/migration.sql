-- Cash/Card-only customers: pay at time of service (no net-terms billing on
-- account). Drives the Stripe card-payment panel + "Cash / Card only" warning
-- on their work. Additive, non-null with a safe default so existing rows stay
-- on-account.
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "cash_cc_only" BOOLEAN NOT NULL DEFAULT false;
