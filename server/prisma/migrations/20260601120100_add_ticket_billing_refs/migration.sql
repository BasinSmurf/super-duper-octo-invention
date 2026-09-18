-- #3 Structured billing references on service tickets.
-- Additive, nullable JSONB. The flat po/afe/cost_center columns stay populated
-- (derived server-side from billing_refs) so the QuickBooks + Enverus contract
-- is untouched. Shape: [{ id, type:'po'|'afe'|'cost_code', value, required }].
ALTER TABLE "service_tickets"
  ADD COLUMN "billing_refs" JSONB;
