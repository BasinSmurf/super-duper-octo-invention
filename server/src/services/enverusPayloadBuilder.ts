/**
 * enverusPayloadBuilder.ts
 *
 * Pure functions that transform Sundog ticket/invoice data into Enverus
 * OpenInvoice API payloads.  Same pattern as qbxmlBuilder.ts — no side
 * effects, no DB calls, just data mapping.
 *
 * Receipt submit → event envelope for /events/supply-chain/v1/receipt.submit
 * Invoice submit → flat JSON for /supply-chain/v3/invoice
 */

import type { Prisma } from '../db.js';
type Decimal = Prisma.Decimal;
import { getSupplierDuns } from './enverusClient.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types — inputs from Prisma includes (not full Prisma models, just the
// shape we expect when the route does its query with selected fields)
// ─────────────────────────────────────────────────────────────────────────────

/** Ticket with the fields needed for receipt payload. */
export interface TicketForReceipt {
  id: string;
  ticketNumber: string;
  ticketType: string;
  serviceSubtype?: string | null;
  serviceDate: Date;
  serviceDateTo?: Date | null;
  locationDisplay?: string | null;
  workDescription?: string | null;
  afeNumber?: string | null;
  poNumber?: string | null;
  costCenter?: string | null;
  /** Buyer subcompany (Enverus site) from the location; else the profile's. */
  buyerSiteUuid?: string | null;
  contractNumber?: string | null;
  customerRepName?: string | null;
  subtotal?: Decimal | null;
  total?: Decimal | null;
}

export interface TicketLineItemForReceipt {
  lineNumber: number;
  lineType: string;
  description?: string | null;
  quantity: Decimal;
  unitOfMeasure?: string | null;
  rate?: Decimal | null;
  total?: Decimal | null;
  partNumber?: string | null;
  enverusProductServiceCode?: string | null;
  enverusAfeNumber?: string | null;
  enverusCostCenter?: string | null;
  product?: {
    partNumber?: string | null;
    enverusProductServiceCode?: string | null;
    enverusProductServiceDescription?: string | null;
    enverusUnitOfMeasure?: string | null;
  } | null;
}

export interface BillingProfileForEnverus {
  buyerDuns?: string | null;
  buyerSiteUuid?: string | null;
  buyerDunsPlus4?: string | null;
  buyerCode?: string | null;
  supplierDuns?: string | null;
  supplierSiteDunsPlus4?: string | null;
  defaultAfeNumber?: string | null;
  defaultCostCenter?: string | null;
  defaultPoNumber?: string | null;
  defaultOrderedByName?: string | null;
  enverusReceiptMode?: string | null;
  /** COP: Service Approver (individual or rig/frac fleet responsible for approval). */
  defaultServiceApprover?: string | null;
  /** COP: Price book number (e.g. "422493"). */
  defaultPriceBookNumber?: string | null;
  /** Relabeled line-field default values (COP "Activity Code"/"Functional Area").
   *  Auto-fill at submit; an explicit empty-string override clears them. */
  defaultMajor?: string | null;
  defaultMinor?: string | null;
  /** Default additional data fields for this buyer (e.g. COP: Facility Property, Activity Code).
   *  Stored as JSONB in Prisma — accepts JsonValue at the interface boundary. */
  defaultAdditionalDataFields?: unknown;
  /** Which additionalDataFields entry receives the well/pad facilityCode (matched by
   *  itemID, else code, else name). Null = no per-location injection. */
  facilityCodeAdfKey?: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Format date as YYYY-MM-DD for Enverus. */
function fmtDate(d: Date | null | undefined): string | undefined {
  if (!d) return undefined;
  return d.toISOString().split('T')[0];
}

/** Convert Decimal to number safely. */
function toNum(d: Decimal | number | null | undefined): number | undefined {
  if (d == null) return undefined;
  return typeof d === 'number' ? d : Number(d);
}

/** Resolve the Enverus product service code for a line item. */
function resolveProductCode(line: TicketLineItemForReceipt): string | undefined {
  // Per-line override first, then product-level mapping
  return (
    line.enverusProductServiceCode ||
    line.product?.enverusProductServiceCode ||
    line.partNumber ||
    line.product?.partNumber ||
    undefined
  );
}

/**
 * Inject a per-location facility code into the buyer's designated additional-data field.
 * `key` is matched against an ADF entry's itemID, then code, then name. When a matching
 * entry exists its value is overwritten; otherwise a best-effort entry is appended (the
 * buyer may not pre-seed it). No-op when either key or code is missing. Mutates + returns adf.
 */
function applyFacilityCode(
  adf: EnverusAdditionalDataField[],
  key: string | null | undefined,
  code: string | null | undefined,
): EnverusAdditionalDataField[] {
  if (!key || !code) return adf;
  const hit = adf.find((f) => f.itemID === key || f.code === key || f.name === key);
  if (hit) hit.value = code;
  else adf.push({ itemID: key, name: key, value: code });
  return adf;
}

/**
 * Sanitize additional-data fields to exactly match the shape Enverus stores on
 * an accepted receipt. Verified against APPROVED COP receipt 76571:
 *
 *   { itemID, name, value, referenceDetailId, code, type }
 *
 * Two problems this guards against, both observed crashing receipt.submit with a
 * generic 500 "Internal error." on otherwise-valid receipts (INV-2026-00055 /
 * INV-2026-00023, 2026-06-18):
 *   1. `adeFieldType` ("header"/"detail") — a Sundog-internal annotation the
 *      apply-enverus-buyer-rules.ts seed stamps on the profile. It is NOT an
 *      Enverus field; it must stay in the DB (for header/detail routing) but
 *      never hit the wire.
 *   2. Empty-valued ADE entries (e.g. an unfilled "Line-Item Category") — no
 *      reason to send a blank field, and Enverus chokes on them.
 *
 * The ADE only resolves buyer-side when `code` (reference type, e.g. "FIPP") and
 * `referenceDetailId` are present — those come from a real receipt, not the
 * field-rules, so the profile data must carry them (see COP profile seed).
 * Only the documented fields are forwarded. Returns a fresh array.
 */
function sanitizeAdditionalDataFields(
  adf: EnverusAdditionalDataField[],
): EnverusAdditionalDataField[] {
  return adf
    .filter((f) => f && f.value != null && String(f.value).trim() !== '')
    .map((f) => {
      const clean: EnverusAdditionalDataField = { value: String(f.value) };
      if (f.itemID) clean.itemID = f.itemID;
      if (f.code) clean.code = f.code;
      if (f.name) clean.name = f.name;
      if (f.referenceDetailId) clean.referenceDetailId = f.referenceDetailId;
      if (f.type) clean.type = f.type;
      return clean;
    });
}

/** Resolve unit of measure — per-line Enverus mapping, then product mapping, then line default. */
function resolveUom(line: TicketLineItemForReceipt): string | undefined {
  return (
    line.product?.enverusUnitOfMeasure ||
    line.unitOfMeasure ||
    undefined
  );
}

/**
 * Resolve AFE for a line item: per-line override → ticket-level → profile default.
 */
function resolveAfe(
  line: TicketLineItemForReceipt,
  ticket: TicketForReceipt,
  profile: BillingProfileForEnverus,
): string | undefined {
  return (
    line.enverusAfeNumber ||
    ticket.afeNumber ||
    profile.defaultAfeNumber ||
    undefined
  );
}

/** Map lineType to Enverus charge type string. */
function resolveChargeType(lineType: string | undefined): string {
  const chargeTypeMap: Record<string, string> = {
    service: 'Labor',
    labor: 'Labor',
    equipment: 'Equipment',
    material: 'Material',
    rental: 'Equipment',
    mileage: 'Equipment',
  };
  return chargeTypeMap[lineType?.toLowerCase() || ''] || 'Labor';
}

/**
 * Resolve cost center for a line item: per-line override → ticket-level → profile default.
 */
function resolveCostCenter(
  line: TicketLineItemForReceipt,
  ticket: TicketForReceipt,
  profile: BillingProfileForEnverus,
): string | undefined {
  return (
    line.enverusCostCenter ||
    ticket.costCenter ||
    profile.defaultCostCenter ||
    undefined
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Receipt Payload Builder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the receipt submit payload for `/events/supply-chain/v1/receipt.submit`.
 *
 * Wraps the receipt data in the Enverus event envelope:
 * ```json
 * { "events": [{ "data": { "transform": { "receipt": { ... } } } }] }
 * ```
 */
export function buildReceiptPayload(
  ticket: TicketForReceipt,
  lineItems: TicketLineItemForReceipt[],
  profile: BillingProfileForEnverus,
  opts?: { facilityCode?: string | null },
) {
  const supplierDuns = profile.supplierDuns || getSupplierDuns();

  // receiptType is effectively REQUIRED: Enverus defaults to 'general' if omitted,
  // which is NOT valid for Continental.
  //
  // FIELD RULES BY RECEIPT TYPE:
  //   General  — chargeType FORBIDDEN on line items
  //   LEM      — chargeType REQUIRED (Labor/Equipment/Material), AFE required
  //   Hauling  — TBD
  //   Chemicals — TBD
  const receiptType = ((profile as any).enverusReceiptType || 'lem') as string;
  const isLem = receiptType.toLowerCase() === 'lem';

  // Build line items
  const receiptLines = lineItems.map((line, idx) => {
    const lineObj: Record<string, unknown> = {
      lineItemNumber: String(line.lineNumber || idx + 1),
      description:
        line.description ||
        line.product?.enverusProductServiceDescription ||
        'Service',
      serviceDateFrom: fmtDate(ticket.serviceDate),
      serviceDateTo: fmtDate(ticket.serviceDateTo) || fmtDate(ticket.serviceDate),
    };

    // chargeType — REQUIRED for LEM, FORBIDDEN for General
    if (isLem) {
      lineObj.chargeType = resolveChargeType(line.lineType);
    }

    const psc = resolveProductCode(line);
    if (psc) lineObj.productServiceCode = psc;

    const qty = toNum(line.quantity);
    if (qty != null) lineObj.quantity = qty;

    const uom = resolveUom(line);
    if (uom) lineObj.unitOfMeasure = uom;

    const rate = toNum(line.rate);
    if (rate != null) lineObj.rate = rate;

    // Per-line AFE override
    const lineAfe = resolveAfe(line, ticket, profile);
    if (lineAfe) {
      lineObj.afe = { number: lineAfe };
    }

    // Per-line cost center override
    const lineCC = resolveCostCenter(line, ticket, profile);
    if (lineCC) {
      lineObj.costCenter = { number: lineCC };
    }

    // Per-line location
    if (ticket.locationDisplay) {
      lineObj.location = ticket.locationDisplay.slice(0, 100);
    }

    return lineObj;
  });

  // Build receipt header
  const receipt: Record<string, unknown> = {
    receiptNumber: ticket.ticketNumber,
    receiptType,
    // NOTE: submissionSource is system-assigned by OpenInvoice (it reflects the
    // integration channel, e.g. "B2B" on every receipt we've pulled). Supplying a
    // custom value clears validation but can trigger a 500 in their pipeline, so we
    // let OI set it.
    description: ticket.workDescription || `Field ticket ${ticket.ticketNumber}`,
    serviceDateFrom: fmtDate(ticket.serviceDate),
    serviceDateTo: fmtDate(ticket.serviceDateTo) || fmtDate(ticket.serviceDate),
    currencyCode: 'USD',
    buyerParty: {
      partyDUNS: profile.buyerDuns,
      ...(ticket.buyerSiteUuid || profile.buyerSiteUuid ? { buyerSiteUuid: ticket.buyerSiteUuid || profile.buyerSiteUuid } : {}),
      ...(profile.buyerCode ? { assignedBySeller: profile.buyerCode } : {}),
    },
    lineItems: receiptLines,
  };

  // Supplier party (optional — many buyers don't require it)
  if (supplierDuns) {
    receipt.supplierParty = {
      partyDUNS: supplierDuns,
      ...(profile.supplierSiteDunsPlus4
        ? { 'partyDUNS+4': profile.supplierSiteDunsPlus4 }
        : {}),
    };
  }

  // Header-level location
  if (ticket.locationDisplay) {
    // Enverus location field max 100 chars
    receipt.location = ticket.locationDisplay.slice(0, 100);
  }

  // Header-level AFE (falls back to first line if present)
  const headerAfe = ticket.afeNumber || profile.defaultAfeNumber;
  if (headerAfe) {
    receipt.afe = { number: headerAfe };
  }

  // Header-level cost center
  const headerCC = ticket.costCenter || profile.defaultCostCenter;
  if (headerCC) {
    receipt.costCenter = { number: headerCC };
  }

  // Header-level PO
  const po = ticket.poNumber || profile.defaultPoNumber;
  if (po) {
    receipt.poNumber = po;
  }

  // Header-level total
  const totalAmt = toNum(ticket.total);
  if (totalAmt != null) {
    receipt.totalAmount = totalAmt;
  }

  // Ordered-by / Service Approver — COP labels this as "Service Approver"
  // (buyer-field-rules: orderedById → "Service Approver")
  const orderedBy = ticket.customerRepName || profile.defaultServiceApprover || profile.defaultOrderedByName;
  if (orderedBy) {
    receipt.orderedByName = orderedBy;
  }

  // receipt.submit represents its price book as contract.number.
  const priceBook = ticket.contractNumber || profile.defaultPriceBookNumber;
  if (priceBook) receipt.contract = { number: priceBook };

  // Additional data fields (buyer-specific custom fields, e.g. COP Safety).
  // Clone so per-location facility-code injection doesn't mutate the profile's stored default.
  const profileAdf = profile.defaultAdditionalDataFields as EnverusAdditionalDataField[] | null | undefined;
  const adf = sanitizeAdditionalDataFields(
    applyFacilityCode(
      profileAdf ? profileAdf.map((f) => ({ ...f })) : [],
      profile.facilityCodeAdfKey,
      opts?.facilityCode,
    ),
  );
  if (adf.length > 0) {
    receipt.additionalDataFields = adf;
  }

  // Wrap in event envelope
  return {
    events: [
      {
        data: {
          transform: {
            receipt,
          },
        },
      },
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Invoice Payload Builder
// ─────────────────────────────────────────────────────────────────────────────

/** Invoice from Prisma with included line items. */
export interface InvoiceForSubmission {
  id: string;
  invoiceNumber: string;
  invoiceDate: Date;
  periodStart?: Date | null;
  periodEnd?: Date | null;
  companyName: string;
  subtotal: Decimal;
  taxAmount: Decimal;
  total: Decimal;
  poNumber?: string | null;
  afeNumber?: string | null;
  costCenter?: string | null;
  buyerSiteUuid?: string | null;
  notes?: string | null;
  qbInvoiceNumber?: string | null;
}

export interface InvoiceLineItemForSubmission {
  serviceDateFrom?: Date | null;
  serviceDateTo?: Date | null;
  location?: string | null;
  lineNumber: number;
  description: string;
  originalDescription?: string | null;
  quantity: Decimal;
  unitOfMeasure?: string | null;
  rate: Decimal;
  amount: Decimal;
  isTaxable: boolean;
  partNumber?: string | null;
  sourceTicketNumber?: string | null;
  /** Field tech who performed the work on the source ticket. Populated by the
   *  route from sourceTicket.assignedTech; used as the COP Labor-line crewMember. */
  crewMember?: string | null;
  product?: {
    partNumber?: string | null;
    enverusProductServiceCode?: string | null;
    enverusProductServiceDescription?: string | null;
    enverusUnitOfMeasure?: string | null;
  } | null;
}


// ─────────────────────────────────────────────────────────────────────────────
// Invoice-as-Receipt Payload Builder
// ─────────────────────────────────────────────────────────────────────────────

/** A single buyer-specific custom data field (e.g. COP Facility Property).
 *  `code` (reference type, e.g. "FIPP") + `referenceDetailId` are required for the
 *  buyer to resolve the ADE on submit; both come from a real receipt, not the
 *  field-rules. `adeFieldType` ("header"/"detail") is a Sundog-internal routing hint
 *  kept in the DB and stripped before the wire by sanitizeAdditionalDataFields. */
export interface EnverusAdditionalDataField {
  itemID?: string;
  code?: string;
  name?: string;
  value: string;
  referenceDetailId?: string;
  type?: string;
  adeFieldType?: string;
}

/** Optional overrides passed from the UI at submission time. */
export interface EnverusSubmitOverrides {
  orderedByName?: string;
  afeNumber?: string;
  costCenter?: string;
  poNumber?: string;
  /** Buyer subcompany (Enverus site uuid) — rides on buyerParty. */
  buyerSiteUuid?: string;
  /** Buyer remit-to department. The receipt API has no field for it; saved on the
   *  invoice so billing can pick it when invoicing in OpenInvoice. */
  buyerDepartment?: string;
  receiptType?: string;
  contractNumber?: string;
  superintendentName?: string;
  officeApproverName?: string;
  invoiceApproverName?: string;
  serviceApprover?: string;
  crewMembers?: string[];
  additionalDataFields?: EnverusAdditionalDataField[];
  /** Per-location FC facility code, resolved from the invoice's tickets (well > pad).
   *  Injected into the buyer's facilityCodeAdfKey ADF entry. */
  facilityCode?: string | null;
  // COP-specific fields (OpenTicket LEM)
  // Buyer-field-rules maps COP labels → standard Enverus fields:
  //   Facility/Property → afeNumber    Cost Object → costCenter
  //   Activity Code     → major        Functional Area → minor
  //   Service Approver  → orderedByName (already above)
  //   Invoice Approver  → header ADE; identifiers come from the buyer profile
  priceBookNumber?: string;
  major?: string;               // COP "Activity Code" (e.g. "FA-L48")
  minor?: string;               // COP "Functional Area" (e.g. "L48_OPS_H_S")
  location?: string;            // Per-line location (e.g. "Multiple Sites")
}

/**
 * Build an invoice payload formatted as a RECEIPT for the receipt.submit endpoint.
 *
 * The `/supply-chain/v3/invoice` endpoint requires elevated permissions that
 * aren't available in sandbox (or for all supplier certs). The receipt.submit
 * endpoint (`/events/supply-chain/v1/receipt.submit`) works reliably.
 *
 * We map invoice data → receipt format using the event envelope wrapper.
 * The invoiceNumber becomes the receiptNumber.
 */
export function buildInvoiceAsReceiptPayload(
  invoice: InvoiceForSubmission,
  lineItems: InvoiceLineItemForSubmission[],
  profile: BillingProfileForEnverus,
  overrides?: EnverusSubmitOverrides,
) {
  const supplierDuns = profile.supplierDuns || getSupplierDuns();

  // Receipt type: override → profile receiptMode → default 'General'
  // enverusReceiptMode stores 'openinvoice'/'openticket'/'both' — not the receipt type.
  // For now, use the override or fall back to 'General'. The UI dropdown lets the user pick.
  const receiptType = overrides?.receiptType || 'General';
  const isLem = receiptType.toLowerCase() === 'lem';

  // Resolve AFE/CC with override priority
  const effectiveAfe = overrides?.afeNumber || invoice.afeNumber || profile.defaultAfeNumber;
  const effectiveCC = overrides?.costCenter || invoice.costCenter || profile.defaultCostCenter;
  const buyerSiteUuid = overrides?.buyerSiteUuid || invoice.buyerSiteUuid || profile.buyerSiteUuid;

  // COP field mapping (from buyer-field-rules):
  //   afeNumber    → "Facility/Property" (e.g. "BK")
  //   costCenter   → "Cost Object" (e.g. "US00003696")
  //   major        → "Activity Code" (e.g. "FA-L48")
  //   minor        → "Functional Area" (e.g. "L48_OPS_H_S")
  // Override is authoritative when the key is present (even ""→explicitly cleared);
  // fall back to the profile default only when no override was sent (e.g. queued path).
  const effectiveMajor = overrides?.major !== undefined ? overrides.major : profile.defaultMajor;
  const effectiveMinor = overrides?.minor !== undefined ? overrides.minor : profile.defaultMinor;
  const effectiveLocation = overrides?.location;

  // Build line items in receipt format
  const receiptLines = lineItems.map((line, idx) => {
    const lineObj: Record<string, unknown> = {
      lineItemNumber: String(line.lineNumber || idx + 1),
      description: line.description || 'Service',
      serviceDateFrom: fmtDate(line.serviceDateFrom) || fmtDate(invoice.periodStart) || fmtDate(invoice.invoiceDate),
      serviceDateTo: fmtDate(line.serviceDateTo) || fmtDate(invoice.periodEnd) || fmtDate(invoice.periodStart) || fmtDate(invoice.invoiceDate),
    };

    // chargeType — REQUIRED for LEM, FORBIDDEN for General
    if (isLem) {
      const desc = (line.originalDescription || line.description || '').toLowerCase();
      let chargeType = 'Labor';
      if (desc.includes('equipment') || desc.includes('rental') || desc.includes('monitor')) {
        chargeType = 'Equipment';
      } else if (desc.includes('mileage') || desc.includes('mile')) {
        chargeType = 'Equipment';  // COP: mileage = Equipment charge type (see ticket 74689)
      } else if (desc.includes('part') || desc.includes('material') || desc.includes('supply')) {
        chargeType = 'Material';
      }
      lineObj.chargeType = chargeType;

      // crewMember — REQUIRED for Labor charge type per COP guidelines.
      // Source it from the field tech who performed THIS line's work (per-line,
      // from the source ticket's assigned tech), then an explicit override.
      // Do NOT fall back to orderedByName/defaultOrderedByName — that leaked the
      // Service Approver / ordered-by name onto every Labor line (2026-06-24).
      if (chargeType === 'Labor') {
        const crewName = line.crewMember || overrides?.crewMembers?.[0];
        if (crewName) lineObj.crewMember = crewName;
      }
    }

    // Enverus mappings take priority over local item identifiers. Keep display
    // descriptions separate from the code used to resolve the price book item.
    // serviceCode is an internal field-rule name, not the receipt input field.
    const psc = line.product?.enverusProductServiceCode || line.partNumber || line.product?.partNumber;
    if (psc) lineObj.productServiceCode = psc;

    const qty = toNum(line.quantity);
    if (qty != null) lineObj.quantity = qty;

    const uom = line.product?.enverusUnitOfMeasure || line.unitOfMeasure;
    if (uom) lineObj.unitOfMeasure = uom;

    const rate = toNum(line.rate);
    if (rate != null) lineObj.rate = rate;

    // Per-line AFE (COP: "Facility/Property" e.g. "BK")
    if (effectiveAfe) lineObj.afe = { number: effectiveAfe };

    // Per-line cost center (COP: "Cost Object" e.g. "US00003696")
    if (effectiveCC) lineObj.costCenter = { number: effectiveCC };

    // major = COP "Activity Code" (e.g. "FA-L48")
    if (effectiveMajor) lineObj.major = { code: effectiveMajor };

    // minor = COP "Functional Area" (e.g. "L48_OPS_H_S")
    if (effectiveMinor) lineObj.minor = { code: effectiveMinor };

    // Per-line location
    const lineLocation = effectiveLocation || line.location;
    if (lineLocation) lineObj.location = lineLocation.slice(0, 100);

    return lineObj;
  });

  // Sales tax rides as its own line. The receipt API has no tax field, and the
  // header total is tax-inclusive: without this line Enverus drops the total
  // ("different from the calculated total of the line items") and the buyer's
  // receipt comes up short of the QuickBooks invoice by the tax.
  const taxAmt = toNum(invoice.taxAmount);
  if (taxAmt != null && taxAmt > 0) {
    receiptLines.push({
      lineItemNumber: String(receiptLines.length + 1),
      description: 'Sales Tax',
      serviceDateFrom: receiptLines.map(l => String(l.serviceDateFrom)).sort()[0] ?? fmtDate(invoice.invoiceDate),
      serviceDateTo: receiptLines.map(l => String(l.serviceDateTo)).sort().at(-1) ?? fmtDate(invoice.invoiceDate),
      // LEM needs a charge type on every line; tax follows the goods, not labor.
      ...(isLem ? { chargeType: 'Material' } : {}),
      quantity: 1,
      unitOfMeasure: 'EA',
      rate: taxAmt,
      ...(effectiveAfe ? { afe: { number: effectiveAfe } } : {}),
      ...(effectiveCC ? { costCenter: { number: effectiveCC } } : {}),
      ...(effectiveMajor ? { major: { code: effectiveMajor } } : {}),
      ...(effectiveMinor ? { minor: { code: effectiveMinor } } : {}),
      ...(effectiveLocation ? { location: effectiveLocation.slice(0, 100) } : {}),
    });
  }

  // Build receipt header
  const receipt: Record<string, unknown> = {
    receiptNumber: invoice.invoiceNumber,
    receiptType,
    // submissionSource is system-assigned by OpenInvoice (see ticket-path builder note).
    description: invoice.notes || `Invoice ${invoice.invoiceNumber} for ${invoice.companyName}`,
    serviceDateFrom: receiptLines.map(l => String(l.serviceDateFrom)).sort()[0],
    serviceDateTo: receiptLines.map(l => String(l.serviceDateTo)).sort().at(-1),
    currencyCode: 'USD',
    buyerParty: {
      partyDUNS: profile.buyerDuns,
      ...(buyerSiteUuid ? { buyerSiteUuid } : {}),
      ...(profile.buyerCode ? { assignedBySeller: profile.buyerCode } : {}),
    },
    lineItems: receiptLines,
  };

  // Vendor invoice number — QB invoice # when available, for cross-referencing
  if (invoice.qbInvoiceNumber) {
    receipt.vendorInvoiceNumber = invoice.qbInvoiceNumber;
  }

  // Supplier party
  if (supplierDuns) {
    receipt.supplierParty = {
      partyDUNS: supplierDuns,
      ...(profile.supplierSiteDunsPlus4
        ? { 'partyDUNS+4': profile.supplierSiteDunsPlus4 }
        : {}),
    };
  }

  // Header-level total
  const totalAmt = toNum(invoice.total);
  if (totalAmt != null) receipt.totalAmount = totalAmt;

  // Header-level AFE
  if (effectiveAfe) receipt.afe = { number: effectiveAfe };

  // Header-level cost center
  if (effectiveCC) receipt.costCenter = { number: effectiveCC };

  // Header-level PO
  const po = overrides?.poNumber || invoice.poNumber;
  if (po) receipt.poNumber = po;

  // The receipt API calls the selected price book `contract`. Keep the old
  // contractNumber input as an alias, while an explicit priceBookNumber wins.
  const priceBook = overrides?.priceBookNumber || overrides?.contractNumber || profile.defaultPriceBookNumber;
  if (priceBook) receipt.contract = { number: priceBook };

  // Ordered-by / Service Approver — COP labels orderedByName as "Service Approver"
  // This is the COP individual or rig/frac fleet approving services
  const orderedBy = overrides?.orderedByName || overrides?.serviceApprover ||
    profile.defaultServiceApprover || profile.defaultOrderedByName;
  if (orderedBy) {
    receipt.orderedByName = orderedBy;
  }

  // Header-level location (COP: site where work was performed)
  if (effectiveLocation) receipt.location = effectiveLocation.slice(0, 100);

  // Superintendent / approvers (generic Enverus fields)
  if (overrides?.superintendentName) receipt.superintendentName = overrides.superintendentName;
  if (overrides?.officeApproverName) receipt.officeApproverName = overrides.officeApproverName;

  // Crew members (header-level)
  if (overrides?.crewMembers && overrides.crewMembers.length > 0) {
    receipt.crewMembers = overrides.crewMembers;
  }

  // Additional data fields — build from overrides + profile defaults
  // COP "Invoice Approver" = header ADE (identifiers vary by environment).
  const profileAdf2 = profile.defaultAdditionalDataFields as EnverusAdditionalDataField[] | null | undefined;
  const baseAdf = overrides?.additionalDataFields?.length
    ? overrides.additionalDataFields.map(field => {
      // A browser may still hold pre-correction field IDs. Preserve its value,
      // but always use the current profile's resolver identifiers when matched.
      const current = profileAdf2?.find(f =>
        (field.itemID && f.itemID === field.itemID) ||
        (field.code && f.code === field.code) ||
        (field.name && f.name === field.name));
      return current ? { ...field, ...current, value: field.value } : { ...field };
    })
    : profileAdf2 ? profileAdf2.map(field => ({ ...field })) : [];

  // Inject COP Invoice Approver as ADE if provided. MERGE onto the existing
  // Invoice Approver entry (from overrides or profile default) so its resolver identifiers
  // — code "FIPP" + referenceDetailId + type — are preserved; only the value
  // changes. Replacing with a bare {itemID,name,value} strips those and Enverus
  // 500s (the original bug).
  if (overrides?.invoiceApproverName) {
    const isApprover = (f: EnverusAdditionalDataField) =>
      f.name === 'Invoice Approver' || f.code === 'FIPP';
    const existing = baseAdf.find(isApprover) || profileAdf2?.find(isApprover);
    const filtered = baseAdf.filter((f) => !isApprover(f));
    filtered.push({
      ...(existing || {}),
      name: 'Invoice Approver',
      value: overrides.invoiceApproverName.slice(0, 25),
    });
    baseAdf.length = 0;
    baseAdf.push(...filtered);
  }

  // Inject the per-location facility code last, so it wins over both the static
  // profile default and any hand-typed ADF override (location is the system of record).
  const adf = sanitizeAdditionalDataFields(
    applyFacilityCode(baseAdf, profile.facilityCodeAdfKey, overrides?.facilityCode),
  );
  if (adf.length > 0) {
    receipt.additionalDataFields = adf;
  }

  // Wrap in event envelope (same format as receipt.submit)
  return {
    events: [
      {
        data: {
          transform: {
            receipt,
          },
        },
      },
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Validate that a billing profile has enough Enverus config for receipt submission. */
export function validateProfileForReceipt(
  profile: BillingProfileForEnverus,
): string[] {
  const errors: string[] = [];
  if (!profile.buyerDuns && !profile.buyerCode) {
    errors.push('Billing profile must have buyerDuns or buyerCode configured');
  }
  if (profile.enverusReceiptMode === 'none') {
    errors.push('Enverus receipt mode is set to "none" on billing profile');
  }
  return errors;
}

/** Validate that a billing profile has enough Enverus config for invoice submission. */
export function validateProfileForInvoice(
  profile: BillingProfileForEnverus,
): string[] {
  const errors: string[] = [];
  if (!profile.buyerDuns && !profile.buyerCode) {
    errors.push('Billing profile must have buyerDuns or buyerCode configured');
  }
  return errors;
}

/** Validate that line items have enough product mapping for Enverus. */
export function validateLineItemsForReceipt(
  lines: TicketLineItemForReceipt[],
): string[] {
  const errors: string[] = [];
  if (lines.length === 0) {
    errors.push('At least one line item is required');
  }
  for (const line of lines) {
    const psc = resolveProductCode(line);
    if (!psc) {
      errors.push(
        `Line ${line.lineNumber}: missing Enverus product/service code (set on line item or product)`,
      );
    }
  }
  return errors;
}
