-- WI-09: the external-vendor receive step.
--
-- Transfer-out, tracking and receive-back already worked. What the receive
-- moment did not capture was anything billing could act on: the invoice existed
-- as a PDF somebody had to open, and "is the customer paying for this?" was
-- answered by a boolean (is_warranty) that could only say yes or no.
--
-- WHY FOUR VALUES AND NOT A BOOLEAN: three of the four are non-billable, for
-- three different reasons, and the difference is the entire point. "The vendor
-- covered it under warranty", "we chose to eat it", and "this was our own gear"
-- produce an identical invoice and completely different answers when somebody
-- asks where the money went. is_warranty is kept, untouched, because it drives
-- existing suppression logic and this is not the change that should retire it.
--
-- WHY THE NOTES COLUMN IS ITS OWN COLUMN: the spec asks that the billing notes
-- be structurally impossible to parse for amounts, not merely discouraged. That
-- is enforced one layer up -- `ShopBillingItem`, the projection handed to the
-- billing derivation, does not contain this column, so buildShopBillingLines
-- cannot read it. Storing the notes inside the existing `billing` JSONB would
-- have made them reachable, since that blob is passed through whole.

CREATE TYPE "ShopVendorDisposition" AS ENUM (
  'warranty',
  'pass_thru_repair',
  'no_charge',
  'internal'
);

ALTER TABLE "shop_work_order_items"
  ADD COLUMN "vendor_disposition"              "ShopVendorDisposition",
  ADD COLUMN "vendor_invoice_number"           TEXT,
  ADD COLUMN "vendor_invoice_total"            DECIMAL(12,2),
  ADD COLUMN "vendor_invoice_allocation_note"  TEXT,
  ADD COLUMN "vendor_billing_notes"            TEXT;

-- Backfill: units already back from a vendor predate the disposition and nobody
-- can retro-decide for them. They are left NULL rather than guessed.
--
-- NULL is read as "not stated" everywhere: it does NOT make a unit billable
-- (pass-through requires an explicit pass_thru_repair), and it does NOT make it
-- non-billable either -- the pre-existing is_warranty / billing.vendor logic
-- keeps deciding exactly as it did yesterday for these rows. The requirement is
-- forward-only, enforced at the receive transition, which historical rows have
-- already passed through.

-- ── A keyed total cannot be negative ────────────────────────────────────────
--
-- Structural rather than validated-at-the-route: a credit note is a real thing,
-- but it is not a vendor invoice total, and letting one in here would flow a
-- negative straight into a passthrough line via arithmetic nobody re-reads.
ALTER TABLE "shop_work_order_items"
  ADD CONSTRAINT "shop_items_vendor_invoice_total_nonneg"
  CHECK ("vendor_invoice_total" IS NULL OR "vendor_invoice_total" >= 0);

-- ── A disposition of pass_thru_repair needs a number to pass through ────────
--
-- The whole promise of the keyed total is that billing never has to open the
-- PDF. A unit marked pass-through with no total keeps that promise only by
-- accident, and fails it silently: it produces no passthrough line at all, and
-- the vendor's cost is simply never billed. Enforced here rather than in the
-- route because the route is not the only writer -- offline sync writes these
-- columns too.
ALTER TABLE "shop_work_order_items"
  ADD CONSTRAINT "shop_items_passthru_needs_total"
  CHECK (
    "vendor_disposition" IS DISTINCT FROM 'pass_thru_repair'
    OR "vendor_invoice_total" IS NOT NULL
  );
