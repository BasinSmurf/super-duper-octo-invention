-- Novara Flex equipment + compliance sync (one-way: Novara → ServicePRO).
--
-- Novara is the system of record for "does this unit exist and is its
-- inspection current". Everything added to serialized_equipment below is
-- overwritten on every sync tick; the mapping tables are the human-owned half.

-- ── serialized_equipment: the mirrored Novara state ──────────────────────────
ALTER TABLE "serialized_equipment"
  ADD COLUMN "novara_equipment_id"      TEXT,
  ADD COLUMN "novara_status"            TEXT,
  ADD COLUMN "novara_expires_on"        DATE,
  ADD COLUMN "novara_expiring_on"       DATE,
  ADD COLUMN "novara_last_completed_on" DATE,
  ADD COLUMN "novara_in_service"        BOOLEAN,
  -- True only when the sync itself pushed this unit to out_of_service, so a
  -- later "back in service" from Novara lifts our hold and nobody else's.
  ADD COLUMN "novara_service_hold"      BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "novara_schedules"         JSONB,
  ADD COLUMN "novara_synced_at"         TIMESTAMP(3);

CREATE UNIQUE INDEX "serialized_equipment_novara_equipment_id_key"
  ON "serialized_equipment" ("novara_equipment_id");

-- ── Novara equipment type → SP product ───────────────────────────────────────
CREATE TABLE "novara_equipment_type_maps" (
  "id"                TEXT NOT NULL,
  "novara_type_id"    TEXT NOT NULL,
  "novara_type_title" TEXT NOT NULL,
  "product_id"        TEXT,
  "ownership"         "EquipmentOwnership" NOT NULL DEFAULT 'basin_safety',
  "auto_create"       BOOLEAN NOT NULL DEFAULT true,
  "sync_enabled"      BOOLEAN NOT NULL DEFAULT true,
  "equipment_count"   INTEGER NOT NULL DEFAULT 0,
  "last_seen_at"      TIMESTAMP(3),
  "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"        TIMESTAMP(3) NOT NULL,

  CONSTRAINT "novara_equipment_type_maps_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "novara_equipment_type_maps_novara_type_id_key"
  ON "novara_equipment_type_maps" ("novara_type_id");

-- Retiring a product must not delete the mapping row — it drops back to
-- "unmapped" and the units of that type show up in the review queue.
ALTER TABLE "novara_equipment_type_maps"
  ADD CONSTRAINT "novara_equipment_type_maps_product_id_fkey"
  FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Novara inspection schedule → an SP due-date column ───────────────────────
CREATE TABLE "novara_schedule_maps" (
  "id"                   TEXT NOT NULL,
  "novara_type_id"       TEXT NOT NULL,
  "novara_schedule_id"   TEXT NOT NULL,
  "novara_schedule_name" TEXT,
  -- 'calibrationDueDate' | 'bumpTestDueDate' | NULL (mirror only)
  "target_field"         TEXT,
  "last_seen_at"         TIMESTAMP(3),
  "created_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"           TIMESTAMP(3) NOT NULL,

  CONSTRAINT "novara_schedule_maps_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "novara_schedule_maps_novara_schedule_id_key"
  ON "novara_schedule_maps" ("novara_schedule_id");
CREATE INDEX "novara_schedule_maps_novara_type_id_idx"
  ON "novara_schedule_maps" ("novara_type_id");

ALTER TABLE "novara_schedule_maps"
  ADD CONSTRAINT "novara_schedule_maps_novara_type_id_fkey"
  FOREIGN KEY ("novara_type_id") REFERENCES "novara_equipment_type_maps"("novara_type_id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Review queue ─────────────────────────────────────────────────────────────
CREATE TABLE "novara_sync_issues" (
  "id"                  TEXT NOT NULL,
  "novara_equipment_id" TEXT NOT NULL,
  "novara_type_id"      TEXT NOT NULL,
  "novara_type_title"   TEXT,
  "serial_number"       TEXT,
  "novara_title"        TEXT,
  "reason"              TEXT NOT NULL,
  "detail"              TEXT,
  "first_seen_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_seen_at"        TIMESTAMP(3) NOT NULL,
  "resolved_at"         TIMESTAMP(3),

  CONSTRAINT "novara_sync_issues_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "novara_sync_issues_novara_equipment_id_key"
  ON "novara_sync_issues" ("novara_equipment_id");
CREATE INDEX "novara_sync_issues_reason_idx"    ON "novara_sync_issues" ("reason");
CREATE INDEX "novara_sync_issues_resolved_at_idx" ON "novara_sync_issues" ("resolved_at");

-- ── Last-run summary singleton ───────────────────────────────────────────────
CREATE TABLE "novara_sync_state" (
  "id"           TEXT NOT NULL DEFAULT 'singleton',
  "last_run_at"  TIMESTAMP(3),
  "last_summary" JSONB,
  "last_error"   TEXT,
  "updated_at"   TIMESTAMP(3) NOT NULL,

  CONSTRAINT "novara_sync_state_pkey" PRIMARY KEY ("id")
);
