-- ============================================================
-- Enverus Billing Profiles — All Buyers
-- Generated 2026-03-30 from buyer-field-rules discovery
-- Run: psql $DATABASE_URL -f prisma/seed-billing-profiles.sql
-- Idempotent: uses ON CONFLICT for companies, upserts profiles
-- ============================================================

-- Basin Safety supplier DUNS (constant across all profiles)
-- supplierDuns: 016937650

-- ============================================================
-- 1. Ensure all companies exist
-- ============================================================

INSERT INTO companies (id, name, company_type, city, state, is_active, created_at, updated_at)
VALUES
  ('co-conoco',      'ConocoPhillips',        'operator', 'Williston',   'ND', true, NOW(), NOW()),
  ('co-chord',       'Chord Energy',          'operator', 'Williston',   'ND', true, NOW(), NOW()),
  ('co-continental', 'Continental Resources',  'operator', 'Watford City','ND', true, NOW(), NOW()),
  ('co-devon',       'Devon Energy',           'operator', 'Williston',   'ND', true, NOW(), NOW()),
  ('co-phoenix',     'Phoenix Operating',      'operator', 'Williston',   'ND', true, NOW(), NOW()),
  ('co-xto',         'XTO Energy',             'operator', 'Williston',   'ND', true, NOW(), NOW()),
  ('co-hess',        'Hess Corporation',       'operator', 'Minot',       'ND', true, NOW(), NOW()),
  ('co-sogc',        'SOGC',                   'operator', 'Williston',   'ND', true, NOW(), NOW()),
  ('co-limerock',    'Lime Rock Resources',    'operator', 'Williston',   'ND', true, NOW(), NOW()),
  ('co-kraken',      'Kraken Oil & Gas',       'operator', 'Williston',   'ND', true, NOW(), NOW()),
  ('co-murfin',      'Murfin Drilling',        'operator', 'Williston',   'ND', true, NOW(), NOW()),
  ('co-hunt',        'Hunt Oil',               'operator', 'Williston',   'ND', true, NOW(), NOW()),
  ('co-petrohunt',   'Petro-Hunt',             'operator', 'Williston',   'ND', true, NOW(), NOW())
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  updated_at = NOW();

-- ============================================================
-- 2. Create billing profiles (one per buyer)
--    Delete existing profiles for these companies first to avoid duplicates
-- ============================================================

-- Clean slate for these companies' Enverus profiles
DELETE FROM customer_billing_profiles WHERE company_id IN (
  'co-conoco', 'co-chord', 'co-continental', 'co-devon', 'co-phoenix', 'co-xto',
  'co-hess', 'co-sogc', 'co-limerock', 'co-kraken', 'co-murfin', 'co-hunt', 'co-petrohunt'
);

-- ============================================================
-- OPEN TICKET BUYERS (6)
-- ============================================================

-- COP — ConocoPhillips (024681877) — OpenTicket LEM
-- Most complex: ADE Invoice Approver + Line-Item Category, all allocation fields
INSERT INTO customer_billing_profiles (
  id, company_id, enverus_enabled, enverus_receipt_mode, enverus_invoice_mode,
  buyer_duns, enverus_customer_uuid, supplier_duns,
  billing_level, default_afe_number, default_cost_center,
  default_price_book_number, requires_afe,
  default_additional_data_fields, buyer_field_rules,
  is_active, effective_from, notes, created_at, updated_at
) VALUES (
  'bp-conoco', 'co-conoco', true, 'openticket', 'none',
  '024681877', '7d57e990-c5fa-4c84-bd8f-deaa9bfe1b49', '016937650',
  'company', 'BK', 'US00003696',
  '422493', true,
  '[{"itemID":"99872","name":"Invoice Approver","value":""},{"itemID":"99877","name":"Line-Item Category","value":"","adeFieldType":"detail"}]'::jsonb,
  '{
    "channel": "openticket",
    "receiptTypes": ["lem","general","hauling","chemicals"],
    "requiredFields": ["afeNumber","orderedById","chargeType","serviceDateFrom","serviceDateTo","description"],
    "fieldLabels": {
      "afeNumber": "Facility/Property",
      "costCenter": "Cost Object",
      "major": "Activity Code",
      "minor": "Functional Area",
      "orderedById": "Service Approver"
    },
    "adeFields": [
      {"itemID":"99872","name":"Invoice Approver","adeFieldType":"header","type":"text","maxLength":"25"},
      {"itemID":"99877","name":"Line-Item Category","adeFieldType":"detail","type":"text","maxLength":"25"}
    ],
    "defaults": {
      "afeNumber": "BK",
      "costCenter": "US00003696",
      "major": "FA-L48",
      "minor": "L48_OPS_H_S",
      "priceBookNumber": "422493"
    }
  }'::jsonb,
  true, '2026-01-01', 'COP OpenTicket LEM — Bakken H&S', NOW(), NOW()
);

-- Chord Energy (962884727) — OpenTicket LEM
-- Envelopes Oasis, Whiting, Enerplus. No ADE fields. serviceDescription required.
INSERT INTO customer_billing_profiles (
  id, company_id, enverus_enabled, enverus_receipt_mode, enverus_invoice_mode,
  buyer_duns, enverus_customer_uuid, supplier_duns,
  billing_level, requires_po,
  buyer_field_rules,
  is_active, effective_from, notes, created_at, updated_at
) VALUES (
  'bp-chord', 'co-chord', true, 'openticket', 'none',
  '962884727', 'a10259fb-173e-4dc3-a761-0f5b820ac54f', '016937650',
  'company', false,
  '{
    "channel": "openticket",
    "receiptTypes": ["lem","general"],
    "requiredFields": ["orderedById","chargeType","serviceDescription","serviceDateFrom"],
    "fieldLabels": {
      "afeNumber": "AFE",
      "costCenter": "Property Header",
      "orderedById": "Requisitioner"
    },
    "adeFields": [],
    "notes": "Envelopes Oasis, Whiting, Enerplus"
  }'::jsonb,
  true, '2026-01-01', 'Chord (Oasis/Whiting/Enerplus) OpenTicket', NOW(), NOW()
);

-- Continental Resources (074292095) — OpenTicket LEM
-- Charge To = afeNumber (required). costCenter labeled N/A. 1 ADE: Maintenance Work Order
INSERT INTO customer_billing_profiles (
  id, company_id, enverus_enabled, enverus_receipt_mode, enverus_invoice_mode,
  buyer_duns, enverus_customer_uuid, supplier_duns,
  billing_level, requires_afe,
  buyer_field_rules,
  is_active, effective_from, notes, created_at, updated_at
) VALUES (
  'bp-continental', 'co-continental', true, 'openticket', 'openinvoice_json',
  '074292095', 'd1eaae8d-e54e-44af-a937-7f7da6012f44', '016937650',
  'company', true,
  '{
    "channel": "both",
    "receiptTypes": ["lem","general","hauling","chemicals"],
    "ot": {
      "requiredFields": ["afeNumber","orderedById","chargeType","serviceDateFrom"],
      "fieldLabels": {
        "afeNumber": "Charge To",
        "costCenter": "N/A",
        "major": "Type",
        "minor": "GL Acct",
        "orderedById": "Requisitioner"
      },
      "adeFields": [
        {"itemID":"98390","name":"Maintenance Work Order","adeFieldType":"detail","type":"text","maxLength":"50"}
      ]
    },
    "oi": {
      "requiredFields": ["serviceCode","description","customerSiteId","rate","customerId","invoiceNumber","customerDepartmentId","serviceDateFrom","serviceDateTo","invoiceDate","quantity","afeNumber","supplierSiteId","currencyCode"],
      "adeFields": [
        {"itemID":"98390","name":"Maintenance Work Order","adeFieldType":"detail","type":"text","maxLength":"50"}
      ]
    }
  }'::jsonb,
  true, '2026-01-01', 'Continental Resources — OT + OI, AFE required', NOW(), NOW()
);

-- Devon Energy (088003756) — OpenTicket LEM
-- Leanest OT buyer. No ADE. pricing required on submit.
INSERT INTO customer_billing_profiles (
  id, company_id, enverus_enabled, enverus_receipt_mode, enverus_invoice_mode,
  buyer_duns, enverus_customer_uuid, supplier_duns,
  billing_level, requires_afe,
  buyer_field_rules,
  is_active, effective_from, notes, created_at, updated_at
) VALUES (
  'bp-devon', 'co-devon', true, 'openticket', 'none',
  '088003756', '8279ea29-cd47-414b-9ed6-eab989793f1c', '016937650',
  'company', true,
  '{
    "channel": "openticket",
    "receiptTypes": ["lem","general"],
    "requiredFields": ["afeNumber","orderedById","chargeType","pricing","serviceDateFrom","serviceDateTo"],
    "fieldLabels": {
      "afeNumber": "WBS/Cost Center/Work Order",
      "major": "GL Account",
      "minor": "Material",
      "orderedById": "Requisitioner"
    },
    "adeFields": [],
    "notes": "No costCenter visible. pricing required."
  }'::jsonb,
  true, '2026-01-01', 'Devon Energy — OT, leanest buyer', NOW(), NOW()
);

-- Phoenix Operating (921385826) — OpenTicket LEM
-- Native invoiceApprover field (not ADE). No subcode visible.
INSERT INTO customer_billing_profiles (
  id, company_id, enverus_enabled, enverus_receipt_mode, enverus_invoice_mode,
  buyer_duns, enverus_customer_uuid, supplier_duns,
  billing_level,
  buyer_field_rules,
  is_active, effective_from, notes, created_at, updated_at
) VALUES (
  'bp-phoenix', 'co-phoenix', true, 'openticket', 'none',
  '921385826', 'cee59419-7cb2-4da1-9842-ce8982190dcd', '016937650',
  'company',
  '{
    "channel": "openticket",
    "receiptTypes": ["lem","general"],
    "requiredFields": ["orderedById","chargeType","serviceDescription","serviceDateFrom","serviceDateTo","description"],
    "fieldLabels": {
      "orderedById": "Requisitioner",
      "invoiceApprover": "Invoice Approver"
    },
    "adeFields": [],
    "notes": "Native invoiceApprover field (not ADE). No subcode."
  }'::jsonb,
  true, '2026-01-01', 'Phoenix Operating — OT, native invoiceApprover', NOW(), NOW()
);

-- XTO Energy (804712347) — OpenTicket LEM
-- Location required. 2 ADE: Business Unit (list!), SAP Description. Uses all 5 allocation fields.
INSERT INTO customer_billing_profiles (
  id, company_id, enverus_enabled, enverus_receipt_mode, enverus_invoice_mode,
  buyer_duns, enverus_customer_uuid, supplier_duns,
  billing_level,
  buyer_field_rules,
  is_active, effective_from, notes, created_at, updated_at
) VALUES (
  'bp-xto', 'co-xto', true, 'openticket', 'none',
  '804712347', '06dfc587-7426-4f17-bcb9-fb5a2268f368', '016937650',
  'company',
  '{
    "channel": "openticket",
    "receiptTypes": ["lem","general"],
    "requiredFields": ["orderedById","chargeType","location","serviceDateFrom"],
    "fieldLabels": {
      "afeNumber": "AFE / WBS / WO",
      "major": "GFCM",
      "minor": "MatType",
      "subcode": "Stk#Cond",
      "orderedById": "Requisitioner"
    },
    "adeFields": [
      {"itemID":"83910","name":"Business Unit","adeFieldType":"header","type":"list","referenceTypeId":60840},
      {"itemID":"50384","name":"SAP Description","adeFieldType":"header","type":"text","maxLength":"50"}
    ],
    "notes": "Location required on submit. Business Unit is a dropdown (list type). All 5 alloc fields used."
  }'::jsonb,
  true, '2026-01-01', 'XTO Energy — OT, location required, Business Unit ADE', NOW(), NOW()
);

-- ============================================================
-- OPEN INVOICE BUYERS (7)
-- ============================================================

-- Hess E&P (e6850a55-...) — OpenInvoice
-- PO required. Final Invoice ADE. fieldLease available.
INSERT INTO customer_billing_profiles (
  id, company_id, enverus_enabled, enverus_receipt_mode, enverus_invoice_mode,
  buyer_duns, enverus_customer_uuid, supplier_duns,
  billing_level, requires_po,
  buyer_field_rules,
  is_active, effective_from, notes, created_at, updated_at
) VALUES (
  'bp-hess', 'co-hess', true, 'none', 'openinvoice_json',
  NULL, 'e6850a55-8f3d-422d-8956-40b9d9b8f68c', '016937650',
  'company', true,
  '{
    "channel": "openinvoice",
    "requiredFields": ["serviceCode","description","units","customerSiteId","rate","customerId","invoiceNumber","customerDepartmentId","serviceDateFrom","serviceDateTo","invoiceDate","quantity","supplierSiteId","currencyCode","poNumber"],
    "optionalFields": ["afeNumber","requisitioner","fieldLease","workOrderNumber","assetNumber","costCenterNumber","location","ticketNumber"],
    "adeFields": [
      {"itemID":"99932","name":"Final Invoice","adeFieldType":"header","type":"text","maxLength":"3","editable":true}
    ],
    "notes": "PO required. Final Invoice ADE (Yes/No). fieldLease available."
  }'::jsonb,
  true, '2026-01-01', 'Hess E&P — OpenInvoice, PO required', NOW(), NOW()
);

-- SOGC (078036d9-...) — OpenInvoice
-- Simple. No PO, no AFE, no ADE.
INSERT INTO customer_billing_profiles (
  id, company_id, enverus_enabled, enverus_receipt_mode, enverus_invoice_mode,
  buyer_duns, enverus_customer_uuid, supplier_duns,
  billing_level,
  buyer_field_rules,
  is_active, effective_from, notes, created_at, updated_at
) VALUES (
  'bp-sogc', 'co-sogc', true, 'none', 'openinvoice_json',
  NULL, '078036d9-2e83-4eb9-a4f7-688c119f1070', '016937650',
  'company',
  '{
    "channel": "openinvoice",
    "requiredFields": ["serviceCode","description","customerSiteId","rate","customerId","invoiceNumber","customerDepartmentId","serviceDateFrom","serviceDateTo","invoiceDate","quantity","supplierSiteId","currencyCode"],
    "optionalFields": ["afeNumber","costCenterNumber","ticketNumber"],
    "adeFields": [],
    "notes": "Simple OI. No PO, no AFE, no ADE."
  }'::jsonb,
  true, '2026-01-01', 'SOGC — OpenInvoice, simple', NOW(), NOW()
);

-- Lime Rock Resources (549a9697-...) — OpenInvoice
-- Simplest OI. No AFE even visible.
INSERT INTO customer_billing_profiles (
  id, company_id, enverus_enabled, enverus_receipt_mode, enverus_invoice_mode,
  buyer_duns, enverus_customer_uuid, supplier_duns,
  billing_level,
  buyer_field_rules,
  is_active, effective_from, notes, created_at, updated_at
) VALUES (
  'bp-limerock', 'co-limerock', true, 'none', 'openinvoice_json',
  NULL, '549a9697-4725-42e3-a4c3-24a8d12e82f8', '016937650',
  'company',
  '{
    "channel": "openinvoice",
    "requiredFields": ["serviceCode","description","customerSiteId","rate","customerId","invoiceNumber","customerDepartmentId","serviceDateFrom","serviceDateTo","invoiceDate","quantity","supplierSiteId","currencyCode"],
    "optionalFields": [],
    "adeFields": [],
    "notes": "Simplest OI. No AFE, no costCenter, no PO visible."
  }'::jsonb,
  true, '2026-01-01', 'Lime Rock — OpenInvoice, bare minimum', NOW(), NOW()
);

-- Kraken Oil & Gas (97062807-...) — OpenInvoice
-- Identical to Lime Rock.
INSERT INTO customer_billing_profiles (
  id, company_id, enverus_enabled, enverus_receipt_mode, enverus_invoice_mode,
  buyer_duns, enverus_customer_uuid, supplier_duns,
  billing_level,
  buyer_field_rules,
  is_active, effective_from, notes, created_at, updated_at
) VALUES (
  'bp-kraken', 'co-kraken', true, 'none', 'openinvoice_json',
  NULL, '97062807-efbd-4d16-8990-16d9ada37143', '016937650',
  'company',
  '{
    "channel": "openinvoice",
    "requiredFields": ["serviceCode","description","customerSiteId","rate","customerId","invoiceNumber","customerDepartmentId","serviceDateFrom","serviceDateTo","invoiceDate","quantity","supplierSiteId","currencyCode"],
    "optionalFields": [],
    "adeFields": [],
    "notes": "Identical to Lime Rock."
  }'::jsonb,
  true, '2026-01-01', 'Kraken Oil & Gas — OpenInvoice, bare minimum', NOW(), NOW()
);

-- Murfin Drilling (8aa01ab1-...) — OpenInvoice
-- Lots of optional fields. No required beyond core.
INSERT INTO customer_billing_profiles (
  id, company_id, enverus_enabled, enverus_receipt_mode, enverus_invoice_mode,
  buyer_duns, enverus_customer_uuid, supplier_duns,
  billing_level,
  buyer_field_rules,
  is_active, effective_from, notes, created_at, updated_at
) VALUES (
  'bp-murfin', 'co-murfin', true, 'none', 'openinvoice_json',
  NULL, '8aa01ab1-ce67-43c4-81a0-99584f71ea5a', '016937650',
  'company',
  '{
    "channel": "openinvoice",
    "requiredFields": ["serviceCode","description","customerSiteId","rate","customerId","invoiceNumber","customerDepartmentId","serviceDateFrom","serviceDateTo","invoiceDate","quantity","supplierSiteId","currencyCode"],
    "optionalFields": ["afeNumber","requisitioner","fieldLease","assetNumber","costCenterNumber","workOrderNumber","location","poNumber","ticketNumber"],
    "adeFields": [],
    "notes": "Lots of optional fields but nothing extra required."
  }'::jsonb,
  true, '2026-01-01', 'Murfin Drilling — OpenInvoice, many optional fields', NOW(), NOW()
);

-- Hunt AP (7772d9ed-...) — OpenInvoice
-- Similar to Murfin minus costCenter/workOrder.
INSERT INTO customer_billing_profiles (
  id, company_id, enverus_enabled, enverus_receipt_mode, enverus_invoice_mode,
  buyer_duns, enverus_customer_uuid, supplier_duns,
  billing_level,
  buyer_field_rules,
  is_active, effective_from, notes, created_at, updated_at
) VALUES (
  'bp-hunt', 'co-hunt', true, 'none', 'openinvoice_json',
  NULL, '7772d9ed-c18c-466a-b9e6-33d914254c1e', '016937650',
  'company',
  '{
    "channel": "openinvoice",
    "requiredFields": ["serviceCode","description","customerSiteId","rate","customerId","invoiceNumber","customerDepartmentId","serviceDateFrom","serviceDateTo","invoiceDate","quantity","supplierSiteId","currencyCode"],
    "optionalFields": ["afeNumber","requisitioner","fieldLease","assetNumber","location","poNumber","ticketNumber"],
    "adeFields": [],
    "notes": "Similar to Murfin minus costCenter/workOrder."
  }'::jsonb,
  true, '2026-01-01', 'Hunt AP — OpenInvoice', NOW(), NOW()
);

-- Petro-Hunt LLC (2d6a4c0e-...) — OpenInvoice
-- Accounting Month + Business Unit Override required (buyer-side). Includes Petro-Hunt Dakota as dept/site.
INSERT INTO customer_billing_profiles (
  id, company_id, enverus_enabled, enverus_receipt_mode, enverus_invoice_mode,
  buyer_duns, enverus_customer_uuid, supplier_duns,
  billing_level,
  buyer_field_rules,
  is_active, effective_from, notes, created_at, updated_at
) VALUES (
  'bp-petrohunt', 'co-petrohunt', true, 'none', 'openinvoice_json',
  NULL, '2d6a4c0e-7643-4382-aa5d-f806de875161', '016937650',
  'company',
  '{
    "channel": "openinvoice",
    "requiredFields": ["serviceCode","description","customerSiteId","rate","customerId","invoiceNumber","customerDepartmentId","serviceDateFrom","serviceDateTo","invoiceDate","quantity","supplierSiteId","currencyCode"],
    "optionalFields": ["afeNumber","costCenterNumber","location","ticketNumber"],
    "buyerSideRequired": ["Accounting Month","Business Unit Override"],
    "adeFields": [],
    "notes": "Accounting Month + Business Unit Override required by buyer (may be auto-filled). Petro-Hunt Dakota = separate dept/site under same UUID."
  }'::jsonb,
  true, '2026-01-01', 'Petro-Hunt LLC — OpenInvoice, Dakota is a dept/site', NOW(), NOW()
);

-- ============================================================
-- Summary
-- ============================================================
-- OT: COP, Chord, Continental, Devon, Phoenix, XTO
-- OI: Hess, SOGC, Lime Rock, Kraken, Murfin, Hunt, Petro-Hunt
-- Both: Continental (OT + OI)
-- Total: 13 profiles, 13 companies
