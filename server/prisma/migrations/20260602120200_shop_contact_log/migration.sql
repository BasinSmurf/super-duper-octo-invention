-- Shop pickup contact-log: append-only record of customer-contact attempts
-- ("called/emailed at this time on this day") while a WO is ready for pickup.
-- Recording a contact does NOT change status. Additive, nullable JSONB.
-- Shape: [{ id, method, note, contactedAt, enteredById, enteredByName, createdAt }].
ALTER TABLE "shop_work_orders"
  ADD COLUMN "contact_log" JSONB;
