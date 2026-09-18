-- Direct-sale counter receipts: persist the pre-tax basket + chosen tax
-- jurisdiction on the Payment so the QB SalesReceipt is rebuilt from real lines
-- (+ ItemSalesTaxRef) and QB recomputes tax to match the counter total.
ALTER TABLE "payments" ADD COLUMN "tax_jurisdiction_id" TEXT;
ALTER TABLE "payments" ADD COLUMN "line_items_json" JSONB;
