ALTER TABLE "companies" ADD COLUMN "customer_descriptions" JSONB;
ALTER TABLE "invoice_line_items" ADD COLUMN "original_description" TEXT;
