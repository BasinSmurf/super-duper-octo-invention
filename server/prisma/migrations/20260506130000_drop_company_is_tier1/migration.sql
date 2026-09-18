-- Tier 1 moves from per-customer to per-pad. The customer-level flag was too
-- coarse: any operator can have a mix of reservation and non-reservation pads,
-- so the geographic concept lives on Pad now (see 20260506120000_add_pad_tier1).
-- Existing values are intentionally NOT migrated forward to Pad.tier1 —
-- propagating Company.isTier1=true to all of that company's pads would produce
-- false positives.

ALTER TABLE "companies"
    DROP COLUMN IF EXISTS "is_tier1";
