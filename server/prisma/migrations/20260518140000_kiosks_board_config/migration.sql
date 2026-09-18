-- Multi-Site Expansion · Phase 3 — Kiosks + admin-tunable board config.

CREATE TYPE "KioskRole" AS ENUM ('BOARD', 'STATION', 'CLAIM');

CREATE TABLE "kiosks" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "role" "KioskRole" NOT NULL,
    "station_filter" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "api_token" TEXT NOT NULL,
    "last_seen_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "kiosks_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "kiosks_slug_key" ON "kiosks"("slug");
CREATE UNIQUE INDEX "kiosks_api_token_key" ON "kiosks"("api_token");

ALTER TABLE "kiosks" ADD CONSTRAINT "kiosks_site_id_fkey"
    FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "board_config" (
    "id" TEXT NOT NULL,
    "aging_thresholds" JSONB NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "board_config_pkey" PRIMARY KEY ("id")
);

-- Seed the singleton board config. Received = 24h per the §12 decision;
-- the rest carry over the previously hardcoded thresholds.
INSERT INTO "board_config" ("id", "aging_thresholds", "updated_at")
VALUES (
    '51700000-0000-4000-8000-000000000020',
    '{"received":24,"diagnosing":24,"awaiting_approval":48,"awaiting_parts":72,"warranty_out":168,"outside_service":168,"in_work":24,"qc_testing":24,"shop_complete":48}',
    CURRENT_TIMESTAMP
);
