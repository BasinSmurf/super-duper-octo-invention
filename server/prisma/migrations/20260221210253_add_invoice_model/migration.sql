-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('draft', 'approved', 'queued', 'so_created', 'invoiced', 'sent', 'paid', 'void');

-- CreateEnum
CREATE TYPE "InvoiceSourceType" AS ENUM ('billing_group', 'shop_work_order', 'rental_agreement', 'manual');

-- CreateTable
CREATE TABLE "invoices" (
    "id" TEXT NOT NULL,
    "invoice_number" TEXT NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'draft',
    "source_type" "InvoiceSourceType" NOT NULL,
    "company_id" TEXT NOT NULL,
    "company_name" TEXT NOT NULL,
    "billing_group_id" TEXT,
    "shop_work_order_id" TEXT,
    "rental_agreement_id" TEXT,
    "po_number" TEXT,
    "afe_number" TEXT,
    "cost_center" TEXT,
    "invoice_date" DATE NOT NULL,
    "due_date" DATE,
    "period_start" DATE,
    "period_end" DATE,
    "subtotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "tax_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "qb_sales_order_txn_id" TEXT,
    "qb_sales_order_number" TEXT,
    "qb_sales_order_pushed_at" TIMESTAMP(3),
    "qb_invoice_txn_id" TEXT,
    "qb_invoice_number" TEXT,
    "qb_invoice_created_at" TIMESTAMP(3),
    "enverus_submitted_at" TIMESTAMP(3),
    "enverus_receipt_id" TEXT,
    "enverus_status" TEXT,
    "approved_by_id" TEXT,
    "approved_at" TIMESTAMP(3),
    "rejected_by_id" TEXT,
    "rejected_at" TIMESTAMP(3),
    "rejection_reason" TEXT,
    "notes" TEXT,
    "internal_notes" TEXT,
    "source_modified_after_sync" BOOLEAN NOT NULL DEFAULT false,
    "source_modified_at" TIMESTAMP(3),
    "custom_data" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by_id" TEXT,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_line_items" (
    "id" TEXT NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "line_number" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "product_id" TEXT,
    "part_number" TEXT,
    "quantity" DECIMAL(10,2) NOT NULL,
    "unit_of_measure" TEXT,
    "rate" DECIMAL(12,2) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "is_taxable" BOOLEAN NOT NULL DEFAULT false,
    "source_ticket_id" TEXT,
    "source_ticket_number" TEXT,
    "source_shop_item_id" TEXT,
    "source_rental_item_id" TEXT,
    "qb_item_list_id" TEXT,
    "qb_item_full_name" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invoice_line_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "invoices_invoice_number_key" ON "invoices"("invoice_number");

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_billing_group_id_fkey" FOREIGN KEY ("billing_group_id") REFERENCES "billing_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_rejected_by_id_fkey" FOREIGN KEY ("rejected_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;
