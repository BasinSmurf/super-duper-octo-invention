-- ShopWork refactor (Wave 1c): add a terminal 'condemned' shop-item status.
-- A unit reaches 'condemned' when an inspection (initial or re-test) condemns it
-- — reachable from 'diagnosing' (Inspecting) and 'qc_testing' (ReTest). Condemn
-- stays billable (inspection labor); only the orthogonal is_warranty flag
-- suppresses billing. Additive only — no existing rows change.
ALTER TYPE "ShopItemStatus" ADD VALUE IF NOT EXISTS 'condemned';
