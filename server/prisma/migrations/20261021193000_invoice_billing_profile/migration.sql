ALTER TABLE "invoices" ADD COLUMN "billing_profile_id" TEXT;
ALTER TABLE "invoice_line_items" ADD COLUMN "source_ticket_line_item_id" TEXT;
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_billing_profile_id_fkey"
  FOREIGN KEY ("billing_profile_id") REFERENCES "customer_billing_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "service_tickets" ADD COLUMN "billing_approval_allocation" JSONB;
