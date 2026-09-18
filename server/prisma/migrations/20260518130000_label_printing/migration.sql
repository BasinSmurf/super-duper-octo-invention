-- Multi-Site Expansion · Phase 2 — Label printing backend.
-- Networked Zebra ZD411d printers, ZPL templates, and an async print queue.

CREATE TYPE "PrinterDriver" AS ENUM ('ZEBRA_ZPL');
CREATE TYPE "PrintJobStatus" AS ENUM ('QUEUED', 'PRINTING', 'SUCCEEDED', 'FAILED');

CREATE TABLE "printers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "ip_address" TEXT NOT NULL,
    "port" INTEGER NOT NULL DEFAULT 9100,
    "driver" "PrinterDriver" NOT NULL DEFAULT 'ZEBRA_ZPL',
    "label_width_mm" INTEGER NOT NULL,
    "label_height_mm" INTEGER NOT NULL,
    "default_for_station" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "last_seen_at" TIMESTAMP(3),
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "printers_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "label_templates" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "driver" "PrinterDriver" NOT NULL DEFAULT 'ZEBRA_ZPL',
    "applies_to" TEXT NOT NULL DEFAULT 'shop_work_order',
    "template" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "label_templates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "label_templates_name_key" ON "label_templates"("name");

CREATE TABLE "print_jobs" (
    "id" TEXT NOT NULL,
    "shop_work_order_id" TEXT NOT NULL,
    "shop_work_order_item_id" TEXT,
    "printer_id" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "status" "PrintJobStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "copies" INTEGER NOT NULL DEFAULT 1,
    "triggered_by_user_id" TEXT,
    "reason" TEXT NOT NULL,
    "reprint_reason" TEXT,
    "error_message" TEXT,
    "next_attempt_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    CONSTRAINT "print_jobs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "print_jobs_status_idx" ON "print_jobs"("status");

ALTER TABLE "printers" ADD CONSTRAINT "printers_site_id_fkey"
    FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_shop_work_order_id_fkey"
    FOREIGN KEY ("shop_work_order_id") REFERENCES "shop_work_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_shop_work_order_item_id_fkey"
    FOREIGN KEY ("shop_work_order_item_id") REFERENCES "shop_work_order_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_printer_id_fkey"
    FOREIGN KEY ("printer_id") REFERENCES "printers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_template_id_fkey"
    FOREIGN KEY ("template_id") REFERENCES "label_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_triggered_by_user_id_fkey"
    FOREIGN KEY ("triggered_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Seed the v1 ZPL label template (master doc §9.3).
INSERT INTO "label_templates" ("id", "name", "driver", "applies_to", "template", "active", "created_at", "updated_at")
VALUES (
    '51700000-0000-4000-8000-000000000010',
    'ticket_default',
    'ZEBRA_ZPL',
    'shop_work_order',
    E'^XA\n^FO20,20^A0N,45,45^FD${customerName}^FS\n^FO20,75^A0N,32,32^FDWO #${workOrderNumber}^FS\n^FO20,115^A0N,26,26^FDAsset: ${assetTag}^FS\n^FO20,150^A0N,22,22^FDRecv: ${receivedDate} (${siteShortCode})^FS\n^FO20,180^BY2^BCN,60,Y,N,N^FD${workOrderNumber}^FS\n^FO420,140^BQN,2,5^FDLA,${qrPayload}^FS\n^XZ',
    true,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
);
