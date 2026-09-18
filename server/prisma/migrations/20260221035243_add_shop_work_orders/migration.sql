-- CreateEnum
CREATE TYPE "ShopWorkOrderStatus" AS ENUM ('intake', 'in_progress', 'hold', 'complete', 'closed');

-- CreateEnum
CREATE TYPE "ShopItemStatus" AS ENUM ('received', 'diagnosing', 'awaiting_parts', 'awaiting_approval', 'in_work', 'warranty_out', 'outside_service', 'qc_testing', 'shop_complete', 'returned');

-- CreateEnum
CREATE TYPE "ShopServiceType" AS ENUM ('repair', 'recharge', 'inspection', 'test', 'calibrate', 'bump_test', 'warranty_repair', 'ue_testing', 'sensor_replace', 'general');

-- CreateEnum
CREATE TYPE "EquipmentCategoryShop" AS ENUM ('fire_extinguisher', 'area_monitor', 'personal_monitor', 'fall_arrest', 'scba', 'ue_cylinder', 'other');

-- CreateEnum
CREATE TYPE "ShipmentMethod" AS ENUM ('basin_truck', 'customer_drop_off', 'ups', 'fedex', 'other_carrier');

-- CreateTable
CREATE TABLE "shop_work_orders" (
    "id" TEXT NOT NULL,
    "work_order_number" TEXT NOT NULL,
    "status" "ShopWorkOrderStatus" NOT NULL DEFAULT 'intake',
    "company_id" TEXT NOT NULL,
    "is_internal" BOOLEAN NOT NULL DEFAULT false,
    "po_number" TEXT,
    "afe_number" TEXT,
    "intake_date" DATE NOT NULL,
    "intake_notes" TEXT,
    "intake_by_id" TEXT,
    "promised_date" DATE,
    "priority" INTEGER NOT NULL DEFAULT 5,
    "completed_date" DATE,
    "returned_date" DATE,
    "total_items" INTEGER NOT NULL DEFAULT 0,
    "completed_items" INTEGER NOT NULL DEFAULT 0,
    "primary_category" "EquipmentCategoryShop",
    "notes" TEXT,
    "custom_data" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by_id" TEXT,

    CONSTRAINT "shop_work_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shop_work_order_items" (
    "id" TEXT NOT NULL,
    "work_order_id" TEXT NOT NULL,
    "item_number" INTEGER NOT NULL,
    "serialized_equipment_id" TEXT,
    "serial_number" TEXT NOT NULL,
    "equipment_category" "EquipmentCategoryShop" NOT NULL,
    "product_id" TEXT,
    "equipment_description" TEXT,
    "service_type" "ShopServiceType" NOT NULL,
    "reported_issue" TEXT,
    "status" "ShopItemStatus" NOT NULL DEFAULT 'received',
    "diagnosis_notes" TEXT,
    "diagnosed_by_id" TEXT,
    "diagnosed_at" TIMESTAMP(3),
    "estimated_cost" DECIMAL(12,2),
    "quote_sent_at" TIMESTAMP(3),
    "quote_approved_at" TIMESTAMP(3),
    "quote_declined_at" TIMESTAMP(3),
    "assigned_to_id" TEXT,
    "work_notes" TEXT,
    "work_completed_at" TIMESTAMP(3),
    "is_warranty" BOOLEAN NOT NULL DEFAULT false,
    "warranty_vendor" TEXT,
    "sent_out_date" DATE,
    "sent_out_method" "ShipmentMethod",
    "sent_out_tracking" TEXT,
    "sent_out_to" TEXT,
    "received_back_date" DATE,
    "received_back_notes" TEXT,
    "qc_tested_by_id" TEXT,
    "qc_result" "TestResult",
    "qc_notes" TEXT,
    "qc_completed_at" TIMESTAMP(3),
    "returned_at" TIMESTAMP(3),
    "return_method" "ReturnMethod",
    "parts_used" JSONB,
    "parent_item_id" TEXT,
    "custom_data" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shop_work_order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shop_item_status_log" (
    "id" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,
    "from_status" "ShopItemStatus",
    "to_status" "ShopItemStatus" NOT NULL,
    "changed_by_id" TEXT,
    "notes" TEXT,
    "location" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shop_item_status_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "shop_work_orders_work_order_number_key" ON "shop_work_orders"("work_order_number");

-- AddForeignKey
ALTER TABLE "shop_work_orders" ADD CONSTRAINT "shop_work_orders_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shop_work_orders" ADD CONSTRAINT "shop_work_orders_intake_by_id_fkey" FOREIGN KEY ("intake_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shop_work_orders" ADD CONSTRAINT "shop_work_orders_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shop_work_order_items" ADD CONSTRAINT "shop_work_order_items_work_order_id_fkey" FOREIGN KEY ("work_order_id") REFERENCES "shop_work_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shop_work_order_items" ADD CONSTRAINT "shop_work_order_items_serialized_equipment_id_fkey" FOREIGN KEY ("serialized_equipment_id") REFERENCES "serialized_equipment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shop_work_order_items" ADD CONSTRAINT "shop_work_order_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shop_work_order_items" ADD CONSTRAINT "shop_work_order_items_diagnosed_by_id_fkey" FOREIGN KEY ("diagnosed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shop_work_order_items" ADD CONSTRAINT "shop_work_order_items_assigned_to_id_fkey" FOREIGN KEY ("assigned_to_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shop_work_order_items" ADD CONSTRAINT "shop_work_order_items_qc_tested_by_id_fkey" FOREIGN KEY ("qc_tested_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shop_work_order_items" ADD CONSTRAINT "shop_work_order_items_parent_item_id_fkey" FOREIGN KEY ("parent_item_id") REFERENCES "shop_work_order_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shop_item_status_log" ADD CONSTRAINT "shop_item_status_log_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "shop_work_order_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shop_item_status_log" ADD CONSTRAINT "shop_item_status_log_changed_by_id_fkey" FOREIGN KEY ("changed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
