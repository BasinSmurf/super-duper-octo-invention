-- WI-02: On-Hold reason pill.
--
-- The board's "On Hold" column is a DISPLAY collapse of four item statuses
-- (awaiting_parts, awaiting_approval, outside_service, warranty_out). Three of
-- the five reasons the shop wants on the pill already exist as those statuses,
-- so they are derived, not stored -- see services/shopHoldReason.ts. Storing
-- them would create a second copy of state that can drift out of agreement
-- with the status it duplicates.
--
-- What genuinely had no home was "waiting internal" and "other". Those get one
-- new generic status, `on_hold`, and it is the only status where hold_reason
-- must be supplied. The state machine rejects the transition without it, so
-- the rule is enforced by the schema + machine rather than by the UI.
ALTER TYPE "ShopItemStatus" ADD VALUE 'on_hold';

CREATE TYPE "ShopHoldReason" AS ENUM (
  'waiting_parts',
  'external_vendor',
  'waiting_customer_approval',
  'waiting_internal',
  'other'
);

-- hold_note is the optional short free-text qualifier rendered on card detail.
-- Display-only by construction: nothing reads it back into logic.
ALTER TABLE "shop_work_order_items" ADD COLUMN "hold_reason" "ShopHoldReason";
ALTER TABLE "shop_work_order_items" ADD COLUMN "hold_note" TEXT;
