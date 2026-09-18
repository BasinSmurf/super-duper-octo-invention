-- Evidence files on an inspection: condemn / cannot-service photos and the
-- external UE report PDF. Mirrors ticket_attachments. Independent of the
-- inspection's append-only lock (evidence can arrive after lock).
CREATE TABLE "equipment_inspection_attachments" (
    "id" TEXT NOT NULL,
    "inspection_id" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "file_type" "AttachmentType" NOT NULL,
    "file_path" TEXT NOT NULL,
    "file_size_bytes" INTEGER,
    "mime_type" TEXT,
    "offline_blob_id" TEXT,
    "uploaded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uploaded_by_id" TEXT,

    CONSTRAINT "equipment_inspection_attachments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "equipment_inspection_attachments_inspection_id_idx" ON "equipment_inspection_attachments"("inspection_id");

ALTER TABLE "equipment_inspection_attachments"
    ADD CONSTRAINT "equipment_inspection_attachments_inspection_id_fkey"
    FOREIGN KEY ("inspection_id") REFERENCES "equipment_inspections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "equipment_inspection_attachments"
    ADD CONSTRAINT "equipment_inspection_attachments_uploaded_by_id_fkey"
    FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
