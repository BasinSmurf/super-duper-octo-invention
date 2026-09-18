-- Batch QA (WI-06): one QA event, N per-unit results.
--
-- WHY TWO TABLES INSTEAD OF N COPIES: the stated instinct was N full copies so
-- every Vault record stands alone. That instinct is right for Vault and wrong
-- for ServicePRO. A mis-entered batch of four is ONE mistake; correcting it as
-- four updates is four chances to half-fail and leave four units disagreeing
-- about what was inspected. So the shared checklist lives in one row and is
-- read through -- and gets flattened into a self-contained per-unit snapshot at
-- hard close, when the record stops being correctable anyway.
--
-- WHY THIS COULD NOT REUSE equipment_inspections FOR THE LIVE RECORD: that
-- table is append-only by design (locked_at set => the server rejects updates,
-- corrections are new rows with corrects_id). WI-06's acceptance criterion is
-- "correcting the batch checklist updates ONE row and is reflected across all
-- four units", which an append-only per-unit table cannot express. The
-- inspection is still the ledger spine -- it is just written at hard close,
-- from the snapshot, rather than at QA time.

CREATE TYPE "ShopQaOutcome" AS ENUM ('pass', 'fail');

CREATE TABLE "shop_qa_events" (
  "id"                TEXT NOT NULL,
  "work_order_id"     TEXT NOT NULL,
  "category"          "EquipmentInspectionCategory" NOT NULL,
  "checklist_version" TEXT NOT NULL,
  "checklist_results" JSONB NOT NULL DEFAULT '{}',
  "service_actions"   JSONB NOT NULL DEFAULT '[]',
  "notes"             TEXT,
  "performed_by_id"   TEXT,
  "performed_at"      TIMESTAMP(3) NOT NULL,
  "corrected_at"      TIMESTAMP(3),
  "corrected_by_id"   TEXT,
  "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "shop_qa_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "shop_qa_unit_results" (
  "id"                  TEXT NOT NULL,
  "qa_event_id"         TEXT NOT NULL,
  "item_id"             TEXT NOT NULL,
  "outcome"             "ShopQaOutcome" NOT NULL,
  "checklist_overrides" JSONB NOT NULL DEFAULT '{}',
  "failed_keys"         JSONB NOT NULL DEFAULT '[]',
  "notes"               TEXT,
  "inspection_id"       TEXT,
  "vault_snapshot"      JSONB,
  "vault_snapshot_at"   TIMESTAMP(3),
  "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"          TIMESTAMP(3) NOT NULL,
  CONSTRAINT "shop_qa_unit_results_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "shop_qa_events_work_order_id_idx" ON "shop_qa_events"("work_order_id");
CREATE INDEX "shop_qa_unit_results_item_id_idx" ON "shop_qa_unit_results"("item_id");

-- One result per unit per batch. Re-submitting the same batch must update the
-- unit's result, not stack a second one beside it -- a unit with two outcomes
-- in one QA event is a question nobody should have to answer at an audit.
CREATE UNIQUE INDEX "shop_qa_unit_results_qa_event_id_item_id_key"
  ON "shop_qa_unit_results"("qa_event_id", "item_id");

-- At most one QA result may claim a given materialized inspection.
CREATE UNIQUE INDEX "shop_qa_unit_results_inspection_id_key"
  ON "shop_qa_unit_results"("inspection_id");

ALTER TABLE "shop_qa_events"
  ADD CONSTRAINT "shop_qa_events_work_order_id_fkey"
  FOREIGN KEY ("work_order_id") REFERENCES "shop_work_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "shop_qa_events"
  ADD CONSTRAINT "shop_qa_events_performed_by_id_fkey"
  FOREIGN KEY ("performed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "shop_qa_events"
  ADD CONSTRAINT "shop_qa_events_corrected_by_id_fkey"
  FOREIGN KEY ("corrected_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "shop_qa_unit_results"
  ADD CONSTRAINT "shop_qa_unit_results_qa_event_id_fkey"
  FOREIGN KEY ("qa_event_id") REFERENCES "shop_qa_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "shop_qa_unit_results"
  ADD CONSTRAINT "shop_qa_unit_results_item_id_fkey"
  FOREIGN KEY ("item_id") REFERENCES "shop_work_order_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "shop_qa_unit_results"
  ADD CONSTRAINT "shop_qa_unit_results_inspection_id_fkey"
  FOREIGN KEY ("inspection_id") REFERENCES "equipment_inspections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── The snapshot is write-once ──────────────────────────────────────────────
--
-- Structural enforcement, same argument as WI-05's soft-close trigger. The
-- snapshot IS the immutable record; if it can be rewritten, "immutable" is a
-- convention that holds until the first route forgets. A route that must
-- remember to check is a route that eventually does not.
--
-- Writing the snapshot for the first time is allowed. Changing it afterwards,
-- or clearing it, is not.
CREATE OR REPLACE FUNCTION shop_qa_snapshot_is_write_once() RETURNS TRIGGER AS $$
BEGIN
    IF OLD.vault_snapshot IS NOT NULL
       AND (NEW.vault_snapshot IS DISTINCT FROM OLD.vault_snapshot
            OR NEW.vault_snapshot_at IS DISTINCT FROM OLD.vault_snapshot_at)
    THEN
        RAISE EXCEPTION
            'shop_qa_unit_results.vault_snapshot is write-once (result %)', OLD.id
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER shop_qa_snapshot_immutable
    BEFORE UPDATE ON "shop_qa_unit_results"
    FOR EACH ROW EXECUTE FUNCTION shop_qa_snapshot_is_write_once();
