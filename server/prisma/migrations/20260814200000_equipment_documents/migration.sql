-- Unit-scoped regulatory documents (UE reports, hydro certs, condemnation
-- certs). Attachments hang off an inspection; these hang off the UNIT, so a
-- cylinder's document history survives every inspection and every pack it
-- passes through — and matches BlueLion, which attaches UE docs to the
-- cylinder's asset id rather than the case's.
CREATE TYPE "EquipmentDocumentType" AS ENUM ('ultrasonic_exam', 'hydrostatic_test', 'condemnation', 'other');

CREATE TABLE "equipment_documents" (
  "id"                 TEXT NOT NULL,
  "equipment_id"       TEXT NOT NULL,
  "doc_type"           "EquipmentDocumentType" NOT NULL,
  -- Corrections bump the revision. BlueLion dedupes documents on externalId,
  -- so a re-push under the same id returns `skipped` and leaves their copy
  -- stale; the revision is what makes a corrected report land.
  "revision"           INTEGER NOT NULL DEFAULT 1,
  "storage_key"        TEXT NOT NULL,
  "file_name"          TEXT NOT NULL,
  "mime_type"          TEXT,
  "file_size_bytes"    INTEGER,
  "issued_on"          DATE,
  "inspection_id"      TEXT,
  "bluelion_doc_id"    TEXT,
  "bluelion_synced_at" TIMESTAMP(3),
  "uploaded_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "uploaded_by_id"     TEXT,

  CONSTRAINT "equipment_documents_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "equipment_documents_equipment_id_doc_type_revision_key"
  ON "equipment_documents" ("equipment_id", "doc_type", "revision");
CREATE INDEX "equipment_documents_equipment_id_idx" ON "equipment_documents" ("equipment_id");
CREATE INDEX "equipment_documents_inspection_id_idx" ON "equipment_documents" ("inspection_id");

ALTER TABLE "equipment_documents"
  ADD CONSTRAINT "equipment_documents_equipment_id_fkey"
  FOREIGN KEY ("equipment_id") REFERENCES "serialized_equipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Provenance, not ownership: losing the inspection must not lose the document.
ALTER TABLE "equipment_documents"
  ADD CONSTRAINT "equipment_documents_inspection_id_fkey"
  FOREIGN KEY ("inspection_id") REFERENCES "equipment_inspections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "equipment_documents"
  ADD CONSTRAINT "equipment_documents_uploaded_by_id_fkey"
  FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
