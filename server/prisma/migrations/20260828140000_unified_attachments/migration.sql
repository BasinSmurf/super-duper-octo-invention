-- Unified attachment table + the two-hop storage pipeline's state columns.
--
-- WHY ONE TABLE: this repo had two near-identical attachment tables
-- (ticket_attachments, equipment_inspection_attachments) with two near-identical
-- sync handlers, and the Division 6 batch wanted to add a third for per-unit
-- photos. Three copies of the same logic is where they silently diverge. The
-- inspection table folds in here; ticket_attachments is left alone on purpose
-- (it is read by the ticket wizard, the PDF generators and the Enverus payload
-- builder, and moving it deserves its own change) but its column exists so that
-- move is a data migration rather than another schema argument.
--
-- WHY THE STORAGE COLUMNS: "delete the local copy once synced" has to mean
-- synced to the SP SERVER, not synced to the object store. A device that drops
-- its only copy on an optimistic write, while B2 is unreachable, loses the file
-- -- and a photo of a condemned cylinder cannot be re-taken. So bytes move in
-- two acknowledged hops and the state is recorded, not inferred.

CREATE TYPE "AttachmentKind" AS ENUM (
  'photo',
  'ue_report',
  'pozi_report',
  'vendor_invoice',
  'test_paperwork',
  'signature',
  'document',
  'other'
);

CREATE TYPE "AttachmentStorageState" AS ENUM ('buffered', 'remote', 'failed');

CREATE TABLE "attachments" (
  "id"                      TEXT NOT NULL,
  "shop_item_id"            TEXT,
  "inspection_id"           TEXT,
  "ticket_id"               TEXT,
  "serial_number"           TEXT,
  "serialized_equipment_id" TEXT,
  "kind"                    "AttachmentKind" NOT NULL,
  "file_name"               TEXT NOT NULL,
  "mime_type"               TEXT,
  "file_size_bytes"         INTEGER,
  "sha256"                  TEXT NOT NULL,
  "storage_state"           "AttachmentStorageState" NOT NULL DEFAULT 'buffered',
  "buffer_key"              TEXT,
  "remote_key"              TEXT,
  "upload_attempts"         INTEGER NOT NULL DEFAULT 0,
  "last_upload_error"       TEXT,
  "last_attempt_at"         TIMESTAMP(3),
  "uploaded_at"             TIMESTAMP(3),
  "offline_blob_id"         TEXT,
  "captured_at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "uploaded_by_id"          TEXT,
  "created_at"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"              TIMESTAMP(3) NOT NULL,
  CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

-- Exactly one parent. Same guard EquipmentInspection already uses for its own
-- shop-item-or-ticket split; an attachment with two parents or none is not a
-- state any code should have to consider.
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_one_parent"
  CHECK (
    (("shop_item_id" IS NOT NULL)::int
   + ("inspection_id" IS NOT NULL)::int
   + ("ticket_id" IS NOT NULL)::int) = 1
  );

-- Bytes must be somewhere. 'remote' without a remote_key, or 'buffered'
-- without a buffer_key, would be a row claiming a file exists when it does not.
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_bytes_located"
  CHECK (
    ("storage_state" = 'remote'   AND "remote_key" IS NOT NULL)
 OR ("storage_state" IN ('buffered', 'failed') AND "buffer_key" IS NOT NULL)
  );

CREATE INDEX "attachments_shop_item_id_idx"  ON "attachments"("shop_item_id");
CREATE INDEX "attachments_inspection_id_idx" ON "attachments"("inspection_id");
CREATE INDEX "attachments_ticket_id_idx"     ON "attachments"("ticket_id");
CREATE INDEX "attachments_serial_number_idx" ON "attachments"("serial_number");
-- The uploader's work queue: not-yet-remote, oldest attempt first.
CREATE INDEX "attachments_storage_state_last_attempt_at_idx"
  ON "attachments"("storage_state", "last_attempt_at");

ALTER TABLE "attachments" ADD CONSTRAINT "attachments_shop_item_id_fkey"
  FOREIGN KEY ("shop_item_id") REFERENCES "shop_work_order_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_inspection_id_fkey"
  FOREIGN KEY ("inspection_id") REFERENCES "equipment_inspections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_ticket_id_fkey"
  FOREIGN KEY ("ticket_id") REFERENCES "service_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_serialized_equipment_id_fkey"
  FOREIGN KEY ("serialized_equipment_id") REFERENCES "serialized_equipment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_uploaded_by_id_fkey"
  FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Backfill from equipment_inspection_attachments ───────────────────────────
--
-- Existing rows are already at their final resting place: they were written
-- straight to the configured store by the old inline path, so they are 'remote'
-- with remote_key = the old file_path.
--
-- sha256 is UNKNOWN for these. Rather than invent a checksum or make the column
-- nullable (which would let new rows skip verification too), they carry the
-- sentinel below. The uploader skips anything already 'remote', so no historical
-- row is ever checked against a checksum nobody computed; a verification that
-- always passes would be worse than an honest gap.
INSERT INTO "attachments" (
  "id", "inspection_id", "serial_number", "serialized_equipment_id",
  "kind", "file_name", "mime_type", "file_size_bytes", "sha256",
  "storage_state", "remote_key", "offline_blob_id",
  "captured_at", "uploaded_by_id", "created_at", "updated_at"
)
SELECT
  a."id",
  a."inspection_id",
  i."serial_number",
  i."serialized_equipment_id",
  CASE a."file_type"::text
    WHEN 'photo'               THEN 'photo'
    WHEN 'serial_number_photo' THEN 'photo'
    WHEN 'signature'           THEN 'signature'
    WHEN 'document'            THEN 'document'
    ELSE 'other'
  END::"AttachmentKind",
  a."file_name",
  a."mime_type",
  a."file_size_bytes",
  'legacy:unverified',
  'remote',
  a."file_path",
  a."offline_blob_id",
  a."uploaded_at",
  a."uploaded_by_id",
  a."uploaded_at",
  NOW()
FROM "equipment_inspection_attachments" a
JOIN "equipment_inspections" i ON i."id" = a."inspection_id";

DROP TABLE "equipment_inspection_attachments";
