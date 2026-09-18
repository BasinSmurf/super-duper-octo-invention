-- BlueLion ServicePRO-side build (docs/bluelion/SERVICEPRO-HANDOFF.md). Purely additive:
--   - `asset` entity type + assetId tracking for the real /assets + /services endpoints
--   - card.issued inbound flag storage + per-record "card printed" stamps
--   - DB-backed v1 API keys (issued from the admin UI; env V1_API_KEYS still honored)

-- AlterEnum
ALTER TYPE "BlueLionEntityType" ADD VALUE IF NOT EXISTS 'asset';

-- AlterTable: queue rows carry the BlueLion assetId returned for `asset` pushes
ALTER TABLE "bluelion_sync_queue"
  ADD COLUMN "bluelion_asset_id" TEXT;

-- AlterTable: unit registration state on the equipment row (spec §3.2)
ALTER TABLE "serialized_equipment"
  ADD COLUMN "bluelion_asset_id" TEXT,
  ADD COLUMN "bluelion_synced_at" TIMESTAMP(3);

-- AlterTable: card.issued stamps
ALTER TABLE "training_roster_records"
  ADD COLUMN "bluelion_card_id" TEXT,
  ADD COLUMN "bluelion_card_issued_at" TIMESTAMP(3);

ALTER TABLE "fit_test_records"
  ADD COLUMN "bluelion_card_id" TEXT,
  ADD COLUMN "bluelion_card_issued_at" TIMESTAMP(3);

-- CreateTable: one row per received card.issued flag, deduped on Idempotency-Key
CREATE TABLE "bluelion_card_flags" (
    "id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "event" TEXT NOT NULL DEFAULT 'card.issued',
    "card_id" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "cert_code" TEXT NOT NULL,
    "issued_on" TIMESTAMP(3) NOT NULL,
    "issued_by" TEXT,
    "template_id" TEXT,
    "template_version" INTEGER,
    "reissue_of" TEXT,
    "verify_url" TEXT,
    "payload" JSONB NOT NULL,
    "matched_entity_type" TEXT,
    "matched_entity_id" TEXT,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bluelion_card_flags_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "bluelion_card_flags_idempotency_key_key" ON "bluelion_card_flags"("idempotency_key");
CREATE INDEX "bluelion_card_flags_person_id_idx" ON "bluelion_card_flags"("person_id");

-- CreateTable: DB-backed v1 API keys
CREATE TABLE "api_keys" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "prefix_hint" TEXT,
    "scopes" JSONB NOT NULL DEFAULT '[]',
    "allowed_ips" JSONB,
    "revoked" BOOLEAN NOT NULL DEFAULT false,
    "revoked_at" TIMESTAMP(3),
    "created_by_id" TEXT,
    "last_used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "api_keys_key_hash_key" ON "api_keys"("key_hash");

ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_id_fkey"
  FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
