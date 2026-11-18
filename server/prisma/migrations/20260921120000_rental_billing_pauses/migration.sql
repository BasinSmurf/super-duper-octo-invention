ALTER TABLE "rental_agreements" ADD COLUMN "billing_policy" JSONB NOT NULL
DEFAULT '{"pauses":[],"ticketRates":null}';
