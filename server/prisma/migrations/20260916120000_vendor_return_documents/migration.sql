ALTER TYPE "AttachmentKind" ADD VALUE 'packing_slip';

-- Commercial paperwork belongs to the shop ticket through its item, not the asset.
UPDATE "attachments"
SET "serial_number" = NULL, "serialized_equipment_id" = NULL
WHERE "kind" = 'vendor_invoice' AND "shop_item_id" IS NOT NULL;
