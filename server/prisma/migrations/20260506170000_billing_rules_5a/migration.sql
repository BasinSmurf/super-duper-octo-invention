-- Wave 5 Slice 5A — billing-rules engine surface.
--
--   invoices.qb_customer_override        — customer NAME to use in QB instead
--                                          of the actual operator (Tier 1 →
--                                          Pale Horse Services pass-through).
--                                          NULL = no override, use invoice.companyId.
--   invoice_line_items.qb_skip           — true when the QBWC SalesOrder/Invoice
--                                          builder must filter the line out.
--                                          Used for the Tier 1 5% surcharge that
--                                          rides on the SP invoice + Enverus push
--                                          but never goes to QB.
--   ticket_line_items.qb_skip            — parity column reserved for future
--                                          ticket-side rules.

ALTER TABLE "invoices"
    ADD COLUMN IF NOT EXISTS "qb_customer_override" TEXT;

ALTER TABLE "invoice_line_items"
    ADD COLUMN IF NOT EXISTS "qb_skip" BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE "ticket_line_items"
    ADD COLUMN IF NOT EXISTS "qb_skip" BOOLEAN NOT NULL DEFAULT FALSE;
