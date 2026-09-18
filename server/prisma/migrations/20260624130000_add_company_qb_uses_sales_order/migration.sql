-- Per-customer QB document type flag.
-- Default false = post a QB Invoice directly (InvoiceAdd).
-- true = push a SalesOrder for this customer (legacy opt-in; a human converts
-- SO->Invoice in QB Desktop).
ALTER TABLE "companies" ADD COLUMN "qb_uses_sales_order" BOOLEAN NOT NULL DEFAULT false;
