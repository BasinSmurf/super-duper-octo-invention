-- CreateEnum
CREATE TYPE "CompanyType" AS ENUM ('operator', 'customer', 'both', 'parent_only');

-- CreateEnum
CREATE TYPE "QbSyncStatus" AS ENUM ('synced', 'pending', 'error');

-- CreateEnum
CREATE TYPE "ContactRole" AS ENUM ('company_man', 'field_super', 'pusher', 'billing', 'ordering', 'safety_man');

-- CreateEnum
CREATE TYPE "EnverusReceiptMode" AS ENUM ('openinvoice', 'openticket', 'both', 'none');

-- CreateEnum
CREATE TYPE "EnverusInvoiceMode" AS ENUM ('openinvoice_json', 'openinvoice_pidx', 'none');

-- CreateEnum
CREATE TYPE "BillingLevel" AS ENUM ('well', 'pad', 'facility', 'field', 'company');

-- CreateEnum
CREATE TYPE "StackedBillingPeriod" AS ENUM ('monthly', 'weekly', 'custom');

-- CreateEnum
CREATE TYPE "ApprovalRequired" AS ENUM ('always', 'threshold', 'never');

-- CreateEnum
CREATE TYPE "FacilityType" AS ENUM ('remote_battery', 'tank_battery', 'compressor_station', 'swd_facility', 'gas_plant', 'office', 'shop', 'other');

-- CreateEnum
CREATE TYPE "WorkPointType" AS ENUM ('testing_station', 'air_system_location', 'monitor_point', 'tank', 'general');

-- CreateEnum
CREATE TYPE "WellType" AS ENUM ('OG', 'SWD', 'WI', 'GASD', 'ST', 'GASC', 'WS', 'CO2I', 'AI', 'GI', 'other');

-- CreateEnum
CREATE TYPE "WellStatus" AS ENUM ('A', 'DRY', 'PA', 'PNC', 'IA', 'Confidential', 'AB', 'LOC', 'DRL', 'TA', 'other');

-- CreateEnum
CREATE TYPE "OperatorHistorySource" AS ENUM ('dmr_import', 'manual', 'state_filing');

-- CreateEnum
CREATE TYPE "ProductCategory" AS ENUM ('monitor_personal', 'monitor_area', 'supplied_air_component', 'sensor', 'calibration_gas', 'accessory', 'consumable', 'assembly', 'labor', 'misc');

-- CreateEnum
CREATE TYPE "ProductType" AS ENUM ('sale', 'rental', 'both', 'service');

-- CreateEnum
CREATE TYPE "QbItemType" AS ENUM ('inventory', 'non_inventory', 'service', 'inventory_assembly', 'other_charge');

-- CreateEnum
CREATE TYPE "StockLocation" AS ENUM ('shop', 'truck', 'field_deployed');

-- CreateEnum
CREATE TYPE "EquipmentOwnership" AS ENUM ('basin_safety', 'customer_owned');

-- CreateEnum
CREATE TYPE "EquipmentStatus" AS ENUM ('available', 'deployed', 'rented', 'repair', 'in_transit', 'lost', 'retired');

-- CreateEnum
CREATE TYPE "TicketType" AS ENUM ('field_service', 'sale', 'rental', 'repair', 'inspection');

-- CreateEnum
CREATE TYPE "ServiceSubtype" AS ENUM ('fit_test', 'monitor', 'air_system', 'general', 'bump_test', 'calibration');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('draft', 'dispatched', 'in_progress', 'completed', 'supervisor_review', 'billing_queue', 'invoiced', 'closed');

-- CreateEnum
CREATE TYPE "LineItemType" AS ENUM ('labor', 'part', 'rental', 'assembly', 'fit_test', 'monitor_deploy', 'monitor_swap', 'monitor_pickup', 'bump_test', 'calibration', 'misc_charge');

-- CreateEnum
CREATE TYPE "TestResult" AS ENUM ('pass', 'fail');

-- CreateEnum
CREATE TYPE "AttachmentType" AS ENUM ('photo', 'signature', 'calibration_cert', 'fit_test_report', 'serial_number_photo', 'document', 'other');

-- CreateEnum
CREATE TYPE "RespiratorType" AS ENUM ('half_face', 'full_face', 'scba', 'sar');

-- CreateEnum
CREATE TYPE "FitTestMethod" AS ENUM ('saccharin', 'bitrex', 'irritant_smoke', 'portacount', 'tsi_8030', 'ambient_aerosol');

-- CreateEnum
CREATE TYPE "FitTestType" AS ENUM ('qualitative', 'quantitative');

-- CreateEnum
CREATE TYPE "RentalStatus" AS ENUM ('active', 'completed', 'cancelled');

-- CreateEnum
CREATE TYPE "RentalRateType" AS ENUM ('daily', 'weekly', 'monthly');

-- CreateEnum
CREATE TYPE "RentalItemStatus" AS ENUM ('deployed', 'returned', 'swapped', 'lost');

-- CreateEnum
CREATE TYPE "CascadeStatus" AS ENUM ('full', 'partial', 'empty', 'n_a');

-- CreateEnum
CREATE TYPE "EquipmentCheckStatus" AS ENUM ('operational', 'issue_minor', 'issue_major', 'needs_service');

-- CreateEnum
CREATE TYPE "RepairStatus" AS ENUM ('intake', 'diagnose', 'quote_pending', 'quote_approved', 'quote_declined', 'in_repair', 'qc_testing', 'qc_failed', 'complete', 'returned', 'closed');

-- CreateEnum
CREATE TYPE "RepairSourceType" AS ENUM ('walk_in', 'field_swap', 'scheduled_inspection', 'inspection_finding', 'warranty', 'internal');

-- CreateEnum
CREATE TYPE "RepairLaborType" AS ENUM ('diagnosis', 'repair', 'qc_testing');

-- CreateEnum
CREATE TYPE "ReturnMethod" AS ENUM ('shipped', 'picked_up', 'redeployed', 'returned_to_stock');

-- CreateEnum
CREATE TYPE "BillingGroupStatus" AS ENUM ('open', 'review', 'ready_to_invoice', 'invoiced', 'closed');

-- CreateEnum
CREATE TYPE "QbSyncEntityType" AS ENUM ('customer', 'item', 'invoice', 'sales_order', 'payment_query');

-- CreateEnum
CREATE TYPE "QbSyncAction" AS ENUM ('add', 'mod', 'query');

-- CreateEnum
CREATE TYPE "QbQueueStatus" AS ENUM ('pending', 'sent', 'success', 'error', 'skipped');

-- CreateEnum
CREATE TYPE "EnverusEntityType" AS ENUM ('receipt', 'field_ticket', 'invoice');

-- CreateEnum
CREATE TYPE "EnverusTarget" AS ENUM ('openinvoice', 'openticket');

-- CreateEnum
CREATE TYPE "EnverusSyncAction" AS ENUM ('submit', 'cancel', 'resubmit', 'save');

-- CreateEnum
CREATE TYPE "EnverusQueueStatus" AS ENUM ('pending', 'submitted', 'accepted', 'rejected', 'error', 'retrying');

-- CreateEnum
CREATE TYPE "EnverusReceiptStatus" AS ENUM ('submitted', 'approved', 'disputed', 'cancelled');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('field_tech', 'dispatch', 'field_super', 'billing_ar', 'boss', 'platform_admin');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('create', 'update', 'delete', 'status_change', 'sync', 'submit', 'approve');

-- CreateEnum
CREATE TYPE "TicketSourceType" AS ENUM ('dispatch', 'self_created', 'template', 'field_swap', 'inspection_finding');

-- CreateTable
CREATE TABLE "companies" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "legal_name" TEXT,
    "parent_company_id" TEXT,
    "company_type" "CompanyType" NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "address" TEXT,
    "city" TEXT,
    "state" TEXT,
    "zip" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "website" TEXT,
    "qb_customer_list_id" TEXT,
    "qb_customer_full_name" TEXT,
    "qb_price_level" TEXT,
    "qb_sync_status" "QbSyncStatus",
    "custom_data" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "companies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operator_aliases" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "dmr_operator_name" TEXT NOT NULL,
    "is_current" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,

    CONSTRAINT "operator_aliases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_billing_profiles" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "enverus_enabled" BOOLEAN NOT NULL DEFAULT false,
    "enverus_receipt_mode" "EnverusReceiptMode" NOT NULL DEFAULT 'none',
    "enverus_invoice_mode" "EnverusInvoiceMode" NOT NULL DEFAULT 'none',
    "buyer_duns" TEXT,
    "buyer_site_uuid" TEXT,
    "buyer_duns_plus4" TEXT,
    "buyer_code" TEXT,
    "supplier_duns" TEXT,
    "supplier_site_duns_plus4" TEXT,
    "stacked_billing_enabled" BOOLEAN NOT NULL DEFAULT false,
    "stacked_billing_group_by" "BillingLevel",
    "stacked_billing_period" "StackedBillingPeriod",
    "stacked_billing_fiscal_month_start" INTEGER NOT NULL DEFAULT 1,
    "billing_level" "BillingLevel" NOT NULL DEFAULT 'company',
    "default_afe_number" TEXT,
    "default_cost_center" TEXT,
    "default_po_number" TEXT,
    "requires_po" BOOLEAN NOT NULL DEFAULT false,
    "requires_afe" BOOLEAN NOT NULL DEFAULT false,
    "approval_required" "ApprovalRequired" NOT NULL DEFAULT 'never',
    "approval_threshold_amount" DECIMAL(12,2),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by_id" TEXT,
    "billing_options" JSONB,
    "custom_data" JSONB,

    CONSTRAINT "customer_billing_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_contacts" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "title" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "role" "ContactRole" NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dmr_reference_wells" (
    "id" TEXT NOT NULL,
    "dmr_file_number" INTEGER,
    "api_number" TEXT,
    "api_short" TEXT,
    "operator_name" TEXT,
    "well_name" TEXT,
    "well_name_base" TEXT,
    "total_depth" INTEGER,
    "spud_date" DATE,
    "field_name" TEXT,
    "quarter_quarter" TEXT,
    "section" INTEGER,
    "township" INTEGER,
    "range" INTEGER,
    "feet_ns" INTEGER,
    "ns_line" TEXT,
    "feet_ew" INTEGER,
    "ew_line" TEXT,
    "latitude" DECIMAL(10,7),
    "longitude" DECIMAL(10,7),
    "well_type" TEXT,
    "well_status" TEXT,
    "county" TEXT,
    "symbol" TEXT,
    "raw_data" JSONB,
    "matched_well_id" TEXT,
    "matched_company_id" TEXT,
    "import_batch_date" DATE,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dmr_reference_wells_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fields" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "county" TEXT,
    "state" TEXT NOT NULL DEFAULT 'ND',
    "notes" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fields_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pads" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "field_id" TEXT NOT NULL,
    "current_operator_id" TEXT,
    "section" INTEGER,
    "township" INTEGER,
    "range" INTEGER,
    "latitude" DECIMAL(10,7),
    "longitude" DECIMAL(10,7),
    "county" TEXT,
    "directions" TEXT,
    "access_notes" TEXT,
    "auto_generated" BOOLEAN NOT NULL DEFAULT false,
    "manually_verified" BOOLEAN NOT NULL DEFAULT false,
    "pending_review" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "custom_data" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wells" (
    "id" TEXT NOT NULL,
    "pad_id" TEXT,
    "field_id" TEXT NOT NULL,
    "current_operator_id" TEXT,
    "dmr_file_number" INTEGER,
    "api_number" TEXT,
    "api_short" TEXT,
    "well_name" TEXT,
    "well_name_base" TEXT,
    "total_depth" INTEGER,
    "spud_date" DATE,
    "quarter_quarter" TEXT,
    "section" INTEGER,
    "township" INTEGER,
    "range" INTEGER,
    "feet_ns" INTEGER,
    "ns_line" TEXT,
    "feet_ew" INTEGER,
    "ew_line" TEXT,
    "latitude" DECIMAL(10,7),
    "longitude" DECIMAL(10,7),
    "well_type" "WellType",
    "well_status" "WellStatus",
    "county" TEXT,
    "has_supplied_air" BOOLEAN NOT NULL DEFAULT false,
    "has_area_monitors" BOOLEAN NOT NULL DEFAULT false,
    "is_high_risk" BOOLEAN NOT NULL DEFAULT false,
    "risk_notes" TEXT,
    "is_active_for_service" BOOLEAN NOT NULL DEFAULT true,
    "service_notes" TEXT,
    "dmr_reference_id" TEXT,
    "dmr_import_date" DATE,
    "dmr_raw_data" JSONB,
    "pending_review" BOOLEAN NOT NULL DEFAULT false,
    "custom_data" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wells_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "facilities" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "facility_type" "FacilityType" NOT NULL,
    "field_id" TEXT,
    "pad_id" TEXT,
    "current_operator_id" TEXT,
    "latitude" DECIMAL(10,7),
    "longitude" DECIMAL(10,7),
    "county" TEXT,
    "section" INTEGER,
    "township" INTEGER,
    "range" INTEGER,
    "directions" TEXT,
    "access_notes" TEXT,
    "has_supplied_air" BOOLEAN NOT NULL DEFAULT false,
    "has_area_monitors" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "service_notes" TEXT,
    "pending_review" BOOLEAN NOT NULL DEFAULT false,
    "custom_data" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "facilities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_points" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "work_point_type" "WorkPointType" NOT NULL,
    "well_id" TEXT,
    "pad_id" TEXT,
    "facility_id" TEXT,
    "has_supplied_air" BOOLEAN NOT NULL DEFAULT false,
    "has_area_monitor" BOOLEAN NOT NULL DEFAULT false,
    "equipment_notes" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "work_points_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operator_history" (
    "id" TEXT NOT NULL,
    "well_id" TEXT,
    "pad_id" TEXT,
    "facility_id" TEXT,
    "previous_operator_id" TEXT NOT NULL,
    "new_operator_id" TEXT NOT NULL,
    "effective_date" DATE NOT NULL,
    "source" "OperatorHistorySource" NOT NULL,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "operator_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" TEXT NOT NULL,
    "part_number" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" "ProductCategory" NOT NULL,
    "product_type" "ProductType" NOT NULL,
    "unit_of_measure" TEXT,
    "default_sell_price" DECIMAL(12,2),
    "default_rental_rate_daily" DECIMAL(12,2),
    "default_rental_rate_weekly" DECIMAL(12,2),
    "default_rental_rate_monthly" DECIMAL(12,2),
    "cost" DECIMAL(12,2),
    "is_serialized" BOOLEAN NOT NULL DEFAULT false,
    "is_assembly" BOOLEAN NOT NULL DEFAULT false,
    "is_taxable" BOOLEAN NOT NULL DEFAULT false,
    "tax_classification" TEXT,
    "qb_item_list_id" TEXT,
    "qb_item_full_name" TEXT,
    "qb_item_type" "QbItemType",
    "enverus_product_service_code" TEXT,
    "enverus_product_service_description" TEXT,
    "enverus_unit_of_measure" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "custom_data" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assembly_components" (
    "id" TEXT NOT NULL,
    "assembly_product_id" TEXT NOT NULL,
    "component_product_id" TEXT NOT NULL,
    "quantity_per_assembly" INTEGER NOT NULL,
    "sort_order" INTEGER NOT NULL,
    "is_optional" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "assembly_components_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory" (
    "id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "stock_location" "StockLocation" NOT NULL,
    "assigned_to_user_id" TEXT,
    "assigned_to_location_id" TEXT,
    "quantity_on_hand" INTEGER NOT NULL,
    "last_counted_at" TIMESTAMP(3),
    "notes" TEXT,

    CONSTRAINT "inventory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "serialized_equipment" (
    "id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "serial_number" TEXT NOT NULL,
    "ownership" "EquipmentOwnership" NOT NULL,
    "status" "EquipmentStatus" NOT NULL DEFAULT 'available',
    "current_pad_id" TEXT,
    "current_well_id" TEXT,
    "current_facility_id" TEXT,
    "current_customer_id" TEXT,
    "current_rental_id" TEXT,
    "calibration_due_date" DATE,
    "last_calibration_date" DATE,
    "bump_test_due_date" DATE,
    "purchase_date" DATE,
    "warranty_expiry" DATE,
    "condition_notes" TEXT,
    "custom_data" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "serialized_equipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_tickets" (
    "id" TEXT NOT NULL,
    "ticket_number" TEXT NOT NULL,
    "ticket_type" "TicketType" NOT NULL,
    "service_subtype" "ServiceSubtype",
    "status" "TicketStatus" NOT NULL DEFAULT 'draft',
    "company_id" TEXT NOT NULL,
    "field_id" TEXT,
    "pad_id" TEXT,
    "well_id" TEXT,
    "facility_id" TEXT,
    "work_point_id" TEXT,
    "billing_profile_id" TEXT,
    "location_display" TEXT,
    "billing_group_key" TEXT,
    "field_area_name" TEXT,
    "assigned_tech_id" TEXT,
    "dispatched_by_id" TEXT,
    "dispatched_at" TIMESTAMP(3),
    "service_date" DATE NOT NULL,
    "service_date_to" DATE,
    "arrival_time" TIMESTAMP(3),
    "departure_time" TIMESTAMP(3),
    "afe_number" TEXT,
    "po_number" TEXT,
    "cost_center" TEXT,
    "contract_number" TEXT,
    "customer_contact_id" TEXT,
    "customer_rep_name" TEXT,
    "customer_rep_signature" TEXT,
    "tech_signature" TEXT,
    "dispatch_notes" TEXT,
    "work_description" TEXT,
    "internal_notes" TEXT,
    "subtotal" DECIMAL(12,2),
    "tax_amount" DECIMAL(12,2),
    "total" DECIMAL(12,2),
    "qb_invoice_list_id" TEXT,
    "qb_invoice_number" TEXT,
    "qb_invoice_txn_id" TEXT,
    "billing_group_id" TEXT,
    "enverus_receipt_id" TEXT,
    "enverus_receipt_status" "EnverusReceiptStatus",
    "enverus_invoice_id" TEXT,
    "enverus_invoice_status" TEXT,
    "offline_id" TEXT,
    "offline_created" BOOLEAN NOT NULL DEFAULT false,
    "last_synced_at" TIMESTAMP(3),
    "sync_conflict" BOOLEAN NOT NULL DEFAULT false,
    "source_ticket_id" TEXT,
    "source_type" "TicketSourceType",
    "custom_data" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),
    "created_by_id" TEXT,

    CONSTRAINT "service_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_line_items" (
    "id" TEXT NOT NULL,
    "ticket_id" TEXT NOT NULL,
    "line_number" INTEGER NOT NULL,
    "line_type" "LineItemType" NOT NULL,
    "product_id" TEXT,
    "description" TEXT,
    "quantity" DECIMAL(10,2) NOT NULL,
    "unit_of_measure" TEXT,
    "rate" DECIMAL(12,2),
    "total" DECIMAL(12,2),
    "hours_regular" DECIMAL(6,2),
    "hours_overtime" DECIMAL(6,2),
    "hours_travel" DECIMAL(6,2),
    "part_number" TEXT,
    "serial_number_installed" TEXT,
    "serial_number_removed" TEXT,
    "equipment_id_installed" TEXT,
    "equipment_id_removed" TEXT,
    "test_result" "TestResult",
    "cal_gas_lot_number" TEXT,
    "rental_agreement_id" TEXT,
    "rental_start_date" DATE,
    "rental_end_date" DATE,
    "well_id_override" TEXT,
    "work_point_id_override" TEXT,
    "enverus_product_service_code" TEXT,
    "enverus_afe_number" TEXT,
    "enverus_cost_center" TEXT,
    "sort_order" INTEGER NOT NULL,
    "custom_data" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ticket_line_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_assembly_parts_used" (
    "id" TEXT NOT NULL,
    "ticket_line_item_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "part_number" TEXT NOT NULL,
    "serial_number" TEXT,
    "quantity_used" INTEGER NOT NULL,
    "unit_cost" DECIMAL(12,2),
    "notes" TEXT,

    CONSTRAINT "ticket_assembly_parts_used_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_attachments" (
    "id" TEXT NOT NULL,
    "ticket_id" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "file_type" "AttachmentType" NOT NULL,
    "file_path" TEXT NOT NULL,
    "file_size_bytes" INTEGER,
    "mime_type" TEXT,
    "offline_blob_id" TEXT,
    "uploaded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uploaded_by_id" TEXT,
    "enverus_attachment_id" TEXT,

    CONSTRAINT "ticket_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fit_test_records" (
    "id" TEXT NOT NULL,
    "ticket_id" TEXT NOT NULL,
    "ticket_line_item_id" TEXT,
    "employee_name" TEXT NOT NULL,
    "employee_id" TEXT,
    "employer_name" TEXT,
    "respirator_make" TEXT,
    "respirator_model" TEXT,
    "respirator_size" TEXT,
    "respirator_type" "RespiratorType",
    "test_type" "FitTestType",
    "test_method" "FitTestMethod",
    "fit_factor" DECIMAL(10,2),
    "pass_fail" "TestResult" NOT NULL,
    "test_date" DATE NOT NULL,
    "expiry_date" DATE,
    "notes" TEXT,
    "tested_by_id" TEXT,
    "well_id" TEXT,
    "site_location_id" TEXT,

    CONSTRAINT "fit_test_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rental_agreements" (
    "id" TEXT NOT NULL,
    "agreement_number" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "field_id" TEXT,
    "pad_id" TEXT,
    "well_id" TEXT,
    "facility_id" TEXT,
    "status" "RentalStatus" NOT NULL DEFAULT 'active',
    "start_date" DATE NOT NULL,
    "end_date" DATE,
    "billing_rate_type" "RentalRateType" NOT NULL,
    "po_number" TEXT,
    "afe_number" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rental_agreements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rental_agreement_items" (
    "id" TEXT NOT NULL,
    "rental_agreement_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "serialized_equipment_id" TEXT NOT NULL,
    "rate" DECIMAL(12,2),
    "rate_type" "RentalRateType" NOT NULL,
    "deployed_date" DATE NOT NULL,
    "returned_date" DATE,
    "status" "RentalItemStatus" NOT NULL DEFAULT 'deployed',

    CONSTRAINT "rental_agreement_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rental_daily_logs" (
    "id" TEXT NOT NULL,
    "rental_agreement_id" TEXT NOT NULL,
    "log_date" DATE NOT NULL,
    "logged_by_id" TEXT NOT NULL,
    "equipment_present" BOOLEAN NOT NULL,
    "equipment_status" "EquipmentCheckStatus" NOT NULL,
    "cascade_status" "CascadeStatus",
    "bottles_full_count" INTEGER,
    "bottles_total_count" INTEGER,
    "monitors_bump_tested" BOOLEAN,
    "monitors_operational_count" INTEGER,
    "monitors_total_count" INTEGER,
    "notes" TEXT,
    "offline_id" TEXT,
    "offline_created" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rental_daily_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "repair_orders" (
    "id" TEXT NOT NULL,
    "repair_number" TEXT NOT NULL,
    "status" "RepairStatus" NOT NULL DEFAULT 'intake',
    "serialized_equipment_id" TEXT NOT NULL,
    "serial_number" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "source_type" "RepairSourceType" NOT NULL,
    "source_ticket_id" TEXT,
    "reported_issue" TEXT,
    "company_id" TEXT,
    "is_billable" BOOLEAN NOT NULL DEFAULT true,
    "is_warranty" BOOLEAN NOT NULL DEFAULT false,
    "warranty_vendor" TEXT,
    "owner_type" "EquipmentOwnership" NOT NULL,
    "diagnosis_notes" TEXT,
    "diagnosed_by_id" TEXT,
    "diagnosed_at" TIMESTAMP(3),
    "estimated_cost" DECIMAL(12,2),
    "quote_sent_at" TIMESTAMP(3),
    "quote_approved_at" TIMESTAMP(3),
    "quote_approved_by" TEXT,
    "quote_notes" TEXT,
    "repaired_by_id" TEXT,
    "repair_notes" TEXT,
    "repair_completed_at" TIMESTAMP(3),
    "qc_tested_by_id" TEXT,
    "qc_result" "TestResult",
    "qc_notes" TEXT,
    "qc_completed_at" TIMESTAMP(3),
    "return_method" "ReturnMethod",
    "returned_at" TIMESTAMP(3),
    "tracking_number" TEXT,
    "invoice_ticket_id" TEXT,
    "custom_data" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by_id" TEXT,

    CONSTRAINT "repair_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "repair_order_parts" (
    "id" TEXT NOT NULL,
    "repair_order_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "part_number" TEXT NOT NULL,
    "description" TEXT,
    "quantity" INTEGER NOT NULL,
    "unit_cost" DECIMAL(12,2),
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "repair_order_parts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "repair_order_labor" (
    "id" TEXT NOT NULL,
    "repair_order_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "hours" DECIMAL(6,2) NOT NULL,
    "labor_type" "RepairLaborType" NOT NULL,
    "work_date" DATE NOT NULL,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "repair_order_labor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_groups" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "billing_profile_id" TEXT NOT NULL,
    "group_key" TEXT NOT NULL,
    "field_id" TEXT,
    "field_area_name" TEXT,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "status" "BillingGroupStatus" NOT NULL DEFAULT 'open',
    "ticket_count" INTEGER NOT NULL DEFAULT 0,
    "total_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "qb_invoice_list_id" TEXT,
    "qb_invoice_number" TEXT,
    "enverus_invoice_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMP(3),

    CONSTRAINT "billing_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "qb_sync_queue" (
    "id" TEXT NOT NULL,
    "entity_type" "QbSyncEntityType" NOT NULL,
    "entity_id" TEXT NOT NULL,
    "action" "QbSyncAction" NOT NULL,
    "qbxml_request" TEXT,
    "qbxml_response" TEXT,
    "status" "QbQueueStatus" NOT NULL DEFAULT 'pending',
    "error_message" TEXT,
    "error_code" TEXT,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "priority" INTEGER NOT NULL DEFAULT 5,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "qb_sync_queue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enverus_sync_queue" (
    "id" TEXT NOT NULL,
    "entity_type" "EnverusEntityType" NOT NULL,
    "entity_id" TEXT NOT NULL,
    "target" "EnverusTarget" NOT NULL,
    "action" "EnverusSyncAction" NOT NULL,
    "endpoint_url" TEXT,
    "request_payload" TEXT,
    "response_payload" TEXT,
    "response_status_code" INTEGER,
    "status" "EnverusQueueStatus" NOT NULL DEFAULT 'pending',
    "enverus_item_id" TEXT,
    "error_message" TEXT,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submitted_at" TIMESTAMP(3),
    "responded_at" TIMESTAMP(3),

    CONSTRAINT "enverus_sync_queue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "role" "UserRole" NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "pin_hash" TEXT,
    "password_hash" TEXT,
    "auth_provider_id" TEXT,
    "last_login_at" TIMESTAMP(3),
    "last_sync_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "action" "AuditAction" NOT NULL,
    "changes" JSONB,
    "ip_address" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "legacy_tickets" (
    "id" TEXT NOT NULL,
    "doforms_ticket_id" TEXT,
    "ticket_date" DATE,
    "customer_name_raw" TEXT,
    "location_text_raw" TEXT,
    "tech_name_raw" TEXT,
    "ticket_type_raw" TEXT,
    "notes_full_text" TEXT,
    "raw_json" JSONB,
    "matched_company_id" TEXT,
    "matched_pad_id" TEXT,
    "matched_well_id" TEXT,
    "matched_user_id" TEXT,
    "import_date" DATE,

    CONSTRAINT "legacy_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "dmr_reference_wells_api_number_key" ON "dmr_reference_wells"("api_number");

-- CreateIndex
CREATE UNIQUE INDEX "wells_api_number_key" ON "wells"("api_number");

-- CreateIndex
CREATE UNIQUE INDEX "products_part_number_key" ON "products"("part_number");

-- CreateIndex
CREATE UNIQUE INDEX "serialized_equipment_serial_number_key" ON "serialized_equipment"("serial_number");

-- CreateIndex
CREATE UNIQUE INDEX "service_tickets_ticket_number_key" ON "service_tickets"("ticket_number");

-- CreateIndex
CREATE UNIQUE INDEX "rental_agreements_agreement_number_key" ON "rental_agreements"("agreement_number");

-- CreateIndex
CREATE UNIQUE INDEX "repair_orders_repair_number_key" ON "repair_orders"("repair_number");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- AddForeignKey
ALTER TABLE "companies" ADD CONSTRAINT "companies_parent_company_id_fkey" FOREIGN KEY ("parent_company_id") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operator_aliases" ADD CONSTRAINT "operator_aliases_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_billing_profiles" ADD CONSTRAINT "customer_billing_profiles_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_billing_profiles" ADD CONSTRAINT "customer_billing_profiles_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_contacts" ADD CONSTRAINT "customer_contacts_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dmr_reference_wells" ADD CONSTRAINT "dmr_reference_wells_matched_well_id_fkey" FOREIGN KEY ("matched_well_id") REFERENCES "wells"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dmr_reference_wells" ADD CONSTRAINT "dmr_reference_wells_matched_company_id_fkey" FOREIGN KEY ("matched_company_id") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pads" ADD CONSTRAINT "pads_field_id_fkey" FOREIGN KEY ("field_id") REFERENCES "fields"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pads" ADD CONSTRAINT "pads_current_operator_id_fkey" FOREIGN KEY ("current_operator_id") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wells" ADD CONSTRAINT "wells_pad_id_fkey" FOREIGN KEY ("pad_id") REFERENCES "pads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wells" ADD CONSTRAINT "wells_field_id_fkey" FOREIGN KEY ("field_id") REFERENCES "fields"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wells" ADD CONSTRAINT "wells_current_operator_id_fkey" FOREIGN KEY ("current_operator_id") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "facilities" ADD CONSTRAINT "facilities_field_id_fkey" FOREIGN KEY ("field_id") REFERENCES "fields"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "facilities" ADD CONSTRAINT "facilities_pad_id_fkey" FOREIGN KEY ("pad_id") REFERENCES "pads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "facilities" ADD CONSTRAINT "facilities_current_operator_id_fkey" FOREIGN KEY ("current_operator_id") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_points" ADD CONSTRAINT "work_points_well_id_fkey" FOREIGN KEY ("well_id") REFERENCES "wells"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_points" ADD CONSTRAINT "work_points_pad_id_fkey" FOREIGN KEY ("pad_id") REFERENCES "pads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_points" ADD CONSTRAINT "work_points_facility_id_fkey" FOREIGN KEY ("facility_id") REFERENCES "facilities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operator_history" ADD CONSTRAINT "operator_history_well_id_fkey" FOREIGN KEY ("well_id") REFERENCES "wells"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operator_history" ADD CONSTRAINT "operator_history_pad_id_fkey" FOREIGN KEY ("pad_id") REFERENCES "pads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operator_history" ADD CONSTRAINT "operator_history_facility_id_fkey" FOREIGN KEY ("facility_id") REFERENCES "facilities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operator_history" ADD CONSTRAINT "operator_history_previous_operator_id_fkey" FOREIGN KEY ("previous_operator_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operator_history" ADD CONSTRAINT "operator_history_new_operator_id_fkey" FOREIGN KEY ("new_operator_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assembly_components" ADD CONSTRAINT "assembly_components_assembly_product_id_fkey" FOREIGN KEY ("assembly_product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assembly_components" ADD CONSTRAINT "assembly_components_component_product_id_fkey" FOREIGN KEY ("component_product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory" ADD CONSTRAINT "inventory_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory" ADD CONSTRAINT "inventory_assigned_to_user_id_fkey" FOREIGN KEY ("assigned_to_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "serialized_equipment" ADD CONSTRAINT "serialized_equipment_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "serialized_equipment" ADD CONSTRAINT "serialized_equipment_current_pad_id_fkey" FOREIGN KEY ("current_pad_id") REFERENCES "pads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "serialized_equipment" ADD CONSTRAINT "serialized_equipment_current_well_id_fkey" FOREIGN KEY ("current_well_id") REFERENCES "wells"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "serialized_equipment" ADD CONSTRAINT "serialized_equipment_current_facility_id_fkey" FOREIGN KEY ("current_facility_id") REFERENCES "facilities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "serialized_equipment" ADD CONSTRAINT "serialized_equipment_current_customer_id_fkey" FOREIGN KEY ("current_customer_id") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "serialized_equipment" ADD CONSTRAINT "serialized_equipment_current_rental_id_fkey" FOREIGN KEY ("current_rental_id") REFERENCES "rental_agreements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_tickets" ADD CONSTRAINT "service_tickets_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_tickets" ADD CONSTRAINT "service_tickets_field_id_fkey" FOREIGN KEY ("field_id") REFERENCES "fields"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_tickets" ADD CONSTRAINT "service_tickets_pad_id_fkey" FOREIGN KEY ("pad_id") REFERENCES "pads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_tickets" ADD CONSTRAINT "service_tickets_well_id_fkey" FOREIGN KEY ("well_id") REFERENCES "wells"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_tickets" ADD CONSTRAINT "service_tickets_facility_id_fkey" FOREIGN KEY ("facility_id") REFERENCES "facilities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_tickets" ADD CONSTRAINT "service_tickets_work_point_id_fkey" FOREIGN KEY ("work_point_id") REFERENCES "work_points"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_tickets" ADD CONSTRAINT "service_tickets_billing_profile_id_fkey" FOREIGN KEY ("billing_profile_id") REFERENCES "customer_billing_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_tickets" ADD CONSTRAINT "service_tickets_assigned_tech_id_fkey" FOREIGN KEY ("assigned_tech_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_tickets" ADD CONSTRAINT "service_tickets_dispatched_by_id_fkey" FOREIGN KEY ("dispatched_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_tickets" ADD CONSTRAINT "service_tickets_customer_contact_id_fkey" FOREIGN KEY ("customer_contact_id") REFERENCES "customer_contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_tickets" ADD CONSTRAINT "service_tickets_billing_group_id_fkey" FOREIGN KEY ("billing_group_id") REFERENCES "billing_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_tickets" ADD CONSTRAINT "service_tickets_source_ticket_id_fkey" FOREIGN KEY ("source_ticket_id") REFERENCES "service_tickets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_tickets" ADD CONSTRAINT "service_tickets_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_line_items" ADD CONSTRAINT "ticket_line_items_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "service_tickets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_line_items" ADD CONSTRAINT "ticket_line_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_line_items" ADD CONSTRAINT "ticket_line_items_equipment_id_installed_fkey" FOREIGN KEY ("equipment_id_installed") REFERENCES "serialized_equipment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_line_items" ADD CONSTRAINT "ticket_line_items_equipment_id_removed_fkey" FOREIGN KEY ("equipment_id_removed") REFERENCES "serialized_equipment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_line_items" ADD CONSTRAINT "ticket_line_items_well_id_override_fkey" FOREIGN KEY ("well_id_override") REFERENCES "wells"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_line_items" ADD CONSTRAINT "ticket_line_items_work_point_id_override_fkey" FOREIGN KEY ("work_point_id_override") REFERENCES "work_points"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_assembly_parts_used" ADD CONSTRAINT "ticket_assembly_parts_used_ticket_line_item_id_fkey" FOREIGN KEY ("ticket_line_item_id") REFERENCES "ticket_line_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_assembly_parts_used" ADD CONSTRAINT "ticket_assembly_parts_used_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_attachments" ADD CONSTRAINT "ticket_attachments_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "service_tickets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_attachments" ADD CONSTRAINT "ticket_attachments_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fit_test_records" ADD CONSTRAINT "fit_test_records_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "service_tickets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fit_test_records" ADD CONSTRAINT "fit_test_records_ticket_line_item_id_fkey" FOREIGN KEY ("ticket_line_item_id") REFERENCES "ticket_line_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fit_test_records" ADD CONSTRAINT "fit_test_records_tested_by_id_fkey" FOREIGN KEY ("tested_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fit_test_records" ADD CONSTRAINT "fit_test_records_well_id_fkey" FOREIGN KEY ("well_id") REFERENCES "wells"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fit_test_records" ADD CONSTRAINT "fit_test_records_site_location_id_fkey" FOREIGN KEY ("site_location_id") REFERENCES "work_points"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rental_agreements" ADD CONSTRAINT "rental_agreements_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rental_agreements" ADD CONSTRAINT "rental_agreements_field_id_fkey" FOREIGN KEY ("field_id") REFERENCES "fields"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rental_agreements" ADD CONSTRAINT "rental_agreements_pad_id_fkey" FOREIGN KEY ("pad_id") REFERENCES "pads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rental_agreements" ADD CONSTRAINT "rental_agreements_well_id_fkey" FOREIGN KEY ("well_id") REFERENCES "wells"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rental_agreements" ADD CONSTRAINT "rental_agreements_facility_id_fkey" FOREIGN KEY ("facility_id") REFERENCES "facilities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rental_agreement_items" ADD CONSTRAINT "rental_agreement_items_rental_agreement_id_fkey" FOREIGN KEY ("rental_agreement_id") REFERENCES "rental_agreements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rental_agreement_items" ADD CONSTRAINT "rental_agreement_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rental_agreement_items" ADD CONSTRAINT "rental_agreement_items_serialized_equipment_id_fkey" FOREIGN KEY ("serialized_equipment_id") REFERENCES "serialized_equipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rental_daily_logs" ADD CONSTRAINT "rental_daily_logs_rental_agreement_id_fkey" FOREIGN KEY ("rental_agreement_id") REFERENCES "rental_agreements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rental_daily_logs" ADD CONSTRAINT "rental_daily_logs_logged_by_id_fkey" FOREIGN KEY ("logged_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repair_orders" ADD CONSTRAINT "repair_orders_serialized_equipment_id_fkey" FOREIGN KEY ("serialized_equipment_id") REFERENCES "serialized_equipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repair_orders" ADD CONSTRAINT "repair_orders_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repair_orders" ADD CONSTRAINT "repair_orders_source_ticket_id_fkey" FOREIGN KEY ("source_ticket_id") REFERENCES "service_tickets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repair_orders" ADD CONSTRAINT "repair_orders_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repair_orders" ADD CONSTRAINT "repair_orders_diagnosed_by_id_fkey" FOREIGN KEY ("diagnosed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repair_orders" ADD CONSTRAINT "repair_orders_repaired_by_id_fkey" FOREIGN KEY ("repaired_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repair_orders" ADD CONSTRAINT "repair_orders_qc_tested_by_id_fkey" FOREIGN KEY ("qc_tested_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repair_orders" ADD CONSTRAINT "repair_orders_invoice_ticket_id_fkey" FOREIGN KEY ("invoice_ticket_id") REFERENCES "service_tickets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repair_orders" ADD CONSTRAINT "repair_orders_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repair_order_parts" ADD CONSTRAINT "repair_order_parts_repair_order_id_fkey" FOREIGN KEY ("repair_order_id") REFERENCES "repair_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repair_order_parts" ADD CONSTRAINT "repair_order_parts_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repair_order_labor" ADD CONSTRAINT "repair_order_labor_repair_order_id_fkey" FOREIGN KEY ("repair_order_id") REFERENCES "repair_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repair_order_labor" ADD CONSTRAINT "repair_order_labor_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_groups" ADD CONSTRAINT "billing_groups_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_groups" ADD CONSTRAINT "billing_groups_billing_profile_id_fkey" FOREIGN KEY ("billing_profile_id") REFERENCES "customer_billing_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_groups" ADD CONSTRAINT "billing_groups_field_id_fkey" FOREIGN KEY ("field_id") REFERENCES "fields"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
