import { resolveInvoiceBillingProfile } from './invoiceBillingProfile.js';
import type { prisma as database } from '../db.js';
import { buildInvoiceAsReceiptPayload, type EnverusSubmitOverrides } from './enverusPayloadBuilder.js';
import { missingRequiredBillingFields } from './locationBillingCodes.js';
import { AppError } from '../middleware/errorHandler.js';

type Database = Pick<typeof database, 'invoice' | 'serviceTicket' | 'rentalAgreement' | 'customerBillingProfile'>;
type Invoice = NonNullable<Awaited<ReturnType<typeof loadInvoice>>>;
type Profile = Invoice['company']['billingProfiles'][number];
type SubmissionType = 'invoice' | 'field_ticket';
const metadataKey = '_sundogSubmission';

async function loadInvoice(db: Database, id: string) {
  return db.invoice.findUnique({ where: { id }, include: {
    lineItems: { include: { product: true }, orderBy: { lineNumber: 'asc' } },
    company: { include: { billingProfiles: { where: { enverusEnabled: true, isActive: true }, take: 1 } } },
  } });
}

const headerFields = ['poNumber', 'afeNumber', 'costCenter', 'buyerSiteUuid', 'buyerDepartment'] as const;

/**
 * Save the biller's header picks on the invoice (so retries and the record carry
 * them), then refuse the submit while a field the profile requires is still empty.
 */
export async function settleInvoiceBillingFields(
  db: Database, invoice: Invoice, profile: Profile, overrides: EnverusSubmitOverrides,
) {
  const picks = Object.fromEntries(headerFields
    .map(key => [key, overrides[key]?.trim()] as const)
    .filter(([, value]) => !!value));
  if (Object.keys(picks).length) {
    await db.invoice.update({ where: { id: invoice.id }, data: picks });
    Object.assign(invoice, picks);
  }
  const missing = missingRequiredBillingFields(profile, {
    poNumber: invoice.poNumber,
    afeNumber: invoice.afeNumber || profile.defaultAfeNumber,
    costCenter: invoice.costCenter || profile.defaultCostCenter,
    buyerSiteUuid: invoice.buyerSiteUuid || profile.buyerSiteUuid,
    buyerDepartment: invoice.buyerDepartment || profile.defaultBuyerDepartment,
  });
  if (missing.length) throw new AppError(400, `This customer requires ${missing.join(', ')} before submitting to Enverus`);
}

/** Shared by immediate submit and queued retries; source tickets supply current location and crew. */
export async function buildCurrentInvoiceReceipt(
  db: Database, invoice: Invoice, profile: Profile,
  entityType: SubmissionType, overrides: EnverusSubmitOverrides = {},
) {
  const ids = [...new Set(invoice.lineItems.map(line => line.sourceTicketId).filter((id): id is string => !!id))];
  const tickets = ids.length ? await db.serviceTicket.findMany({ where: { id: { in: ids } }, select: {
    id: true, serviceDate: true, serviceDateTo: true, division: true, locationDisplay: true,
    well: { select: { facilityCode: true } }, pad: { select: { facilityCode: true } },
    assignedTech: { select: { name: true } },
  } }) : [];
  const codes = [...new Set(tickets.map(t => t.well?.facilityCode || t.pad?.facilityCode).filter(Boolean))];
  const crew = new Map(tickets.map(t => [t.id, t.assignedTech?.name]));
  const sourceTickets = new Map(tickets.map(t => [t.id, t]));
  const rental = invoice.rentalAgreementId ? await db.rentalAgreement.findUnique({
    where: { id: invoice.rentalAgreementId }, select: {
      startDate: true, endDate: true, well: { select: { wellName: true } }, pad: { select: { name: true } },
      facility: { select: { name: true } }, field: { select: { name: true } },
      items: { select: { id: true, deployedDate: true, returnedDate: true } },
    },
  }) : null;
  const rentalLocation = rental?.well?.wellName || rental?.pad?.name || rental?.facility?.name || rental?.field?.name;
  const locations = [...new Set(tickets.map(t => t.locationDisplay).filter((v): v is string => !!v))];
  return buildInvoiceAsReceiptPayload(invoice, invoice.lineItems.map(line => ({
    ...line,
    description: line.description || line.product?.name || 'Service',
    partNumber: line.partNumber || line.product?.partNumber,
    crewMember: line.sourceTicketId ? crew.get(line.sourceTicketId) : null,
    location: (line.sourceTicketId ? sourceTickets.get(line.sourceTicketId)?.locationDisplay : null) || rentalLocation,
    ...(() => {
      const ticket = line.sourceTicketId ? sourceTickets.get(line.sourceTicketId) : null;
      const isRental = !!invoice.rentalAgreementId || invoice.division === 'D4' || ticket?.division === 'D4';
      if (!isRental && ticket?.serviceDate) {
        // D3 is a visit: both ends are the service date, even on consolidated invoices.
        const isD3 = invoice.division === 'D3' || ticket.division === 'D3';
        return { serviceDateFrom: ticket.serviceDate, serviceDateTo: isD3 ? ticket.serviceDate : ticket.serviceDateTo || ticket.serviceDate };
      }
      // Rental invoices carry the actual billed window, including mid-sweep/month-end.
      const item = rental?.items.find(i => i.id === line.sourceRentalItemId);
      const starts = [invoice.periodStart, rental?.startDate, item?.deployedDate].filter((d): d is Date => !!d);
      const ends = [invoice.periodEnd, rental?.endDate, item?.returnedDate].filter((d): d is Date => !!d);
      return isRental ? {
        serviceDateFrom: starts.length ? new Date(Math.max(...starts.map(Number))) : ticket?.serviceDate,
        serviceDateTo: ends.length ? new Date(Math.min(...ends.map(Number))) : ticket?.serviceDateTo || ticket?.serviceDate,
      } : {};
    })(),
  })), profile, {
    ...overrides,
    receiptType: overrides.receiptType || (entityType === 'field_ticket' ? 'lem' : 'General'),
    location: overrides.location ?? rentalLocation ?? (locations.length === 1 ? locations[0] : undefined),
    facilityCode: codes.length === 1 ? codes[0] : null,
  });
}

/** Save only values that differ from the current defaults, not a frozen copy of defaults. */
export function serializeInvoiceSubmission(
  payload: ReturnType<typeof buildInvoiceAsReceiptPayload>, invoice: Invoice, profile: Profile,
  overrides: EnverusSubmitOverrides,
) {
  const defaults: EnverusSubmitOverrides = {
    afeNumber: invoice.afeNumber || profile.defaultAfeNumber || undefined,
    costCenter: invoice.costCenter || profile.defaultCostCenter || undefined,
    poNumber: invoice.poNumber || undefined,
    orderedByName: profile.defaultServiceApprover || profile.defaultOrderedByName || undefined,
    serviceApprover: profile.defaultServiceApprover || undefined,
    priceBookNumber: profile.defaultPriceBookNumber || undefined,
    major: profile.defaultMajor ?? undefined, minor: profile.defaultMinor ?? undefined,
  };
  const explicit = Object.fromEntries(Object.entries(overrides).filter(([key, value]) =>
    value !== undefined && key !== 'facilityCode' && key !== 'additionalDataFields' &&
    value !== defaults[key as keyof EnverusSubmitOverrides],
  )) as EnverusSubmitOverrides;
  // Keep value overrides keyed by field identity. Resolver IDs always come from
  // the current profile, so correcting an approver reference also fixes retries.
  const fields = (profile.defaultAdditionalDataFields || []) as any[];
  const additionalDataFields = overrides.additionalDataFields?.filter(field => {
    const current = fields.find(f => fieldKey(f) === fieldKey(field) ||
      (field.name && f.name === field.name) || (field.code && f.code === field.code));
    return !current || current.value !== field.value;
  }).map(field => ({ key: fieldKey(field), name: field.name, code: field.code, value: field.value,
    ...(!fields.some(f => fieldKey(f) === fieldKey(field)) ? { field } : {}),
  }));
  return JSON.stringify({ ...payload, [metadataKey]: { version: 1, overrides: explicit, additionalDataFields } });
}

function fieldKey(field: any): string {
  return field.itemID || field.code || field.name;
}

/** Old queue rows predate override metadata. Refresh defaults and recover only safe input values. */
function legacyOverrides(receipt: any, invoice: Invoice, profile: Profile, type: SubmissionType): EnverusSubmitOverrides {
  const overrides: EnverusSubmitOverrides = {
    receiptType: receipt.receiptType,
    afeNumber: invoice.afeNumber || profile.defaultAfeNumber || receipt.afe?.number,
    costCenter: invoice.costCenter || profile.defaultCostCenter || receipt.costCenter?.number,
    priceBookNumber: profile.defaultPriceBookNumber || receipt.priceBookNumber,
    orderedByName: profile.defaultServiceApprover || profile.defaultOrderedByName || receipt.orderedByName,
    major: profile.defaultMajor ?? receipt.lineItems?.[0]?.major,
    minor: profile.defaultMinor ?? receipt.lineItems?.[0]?.minor,
    additionalDataFields: Array.isArray(profile.defaultAdditionalDataFields)
      ? profile.defaultAdditionalDataFields as unknown as EnverusSubmitOverrides['additionalDataFields']
      : receipt.additionalDataFields,
    location: receipt.location, superintendentName: receipt.superintendentName,
    officeApproverName: receipt.officeApproverName, crewMembers: receipt.crewMembers,
  };
  // Before the mapping fix, the OT form's price book was copied to BOTH PO and
  // contract, while the profile's default stayed in priceBookNumber.
  const oldPriceBookAlias = type === 'field_ticket' && receipt.poNumber &&
    receipt.poNumber === receipt.contract?.number && receipt.poNumber !== invoice.poNumber;
  if (oldPriceBookAlias) overrides.priceBookNumber = receipt.poNumber;
  else {
    overrides.poNumber = invoice.poNumber || receipt.poNumber;
    // A separately selected book is a per-submission choice.
    overrides.priceBookNumber = receipt.priceBookNumber || receipt.contract?.number || profile.defaultPriceBookNumber;
  }
  return overrides;
}

export async function rebuildInvoiceSubmission(
  db: Database, entry: { entityId: string; entityType: string; requestPayload: string | null },
) {
  const invoice = await loadInvoice(db, entry.entityId);
  if (!invoice) throw new Error('Cannot rebuild Enverus submission: invoice no longer exists');
  const profile = await resolveInvoiceBillingProfile(db, invoice);
  if (!profile || !profile.enverusEnabled) throw new Error('Cannot rebuild Enverus submission: no active Enverus billing profile');
  if (!['approved', 'queued', 'so_created', 'invoiced'].includes(invoice.status)) {
    throw new Error(`Cannot rebuild Enverus submission: invoice is ${invoice.status}`);
  }
  const type = entry.entityType as SubmissionType;
  if (type === 'field_ticket' && !['openticket', 'both'].includes(profile.enverusReceiptMode)) {
    throw new Error('Cannot rebuild Enverus submission: billing profile no longer permits OpenTicket');
  }
  if (!profile.buyerDuns && !profile.buyerCode) throw new Error('Cannot rebuild Enverus submission: missing buyer identity');
  const stored = entry.requestPayload ? JSON.parse(entry.requestPayload) : {};
  const metadata = stored[metadataKey];
  if (metadata && metadata.version !== 1) throw new Error('Unsupported Enverus submission metadata version');
  const overrides: EnverusSubmitOverrides = metadata
    ? { ...metadata.overrides }
    : legacyOverrides(stored.events?.[0]?.data?.transform?.receipt || {}, invoice, profile, type);
  if (metadata?.additionalDataFields?.length) {
    const fields = (profile.defaultAdditionalDataFields || []) as any[];
    const savedFields = stored.events?.[0]?.data?.transform?.receipt?.additionalDataFields || [];
    // IDs can change between environments. Recover stable field identity from
    // old snapshots, then use the current profile's itemID and resolver ID.
    metadata.additionalDataFields = metadata.additionalDataFields.map((override: any) => {
      const previous = override.field || savedFields.find((f: any) => fieldKey(f) === override.key);
      const name = override.name || previous?.name;
      const code = override.code || previous?.code;
      const current = fields.find(field => fieldKey(field) === override.key ||
        (name && field.name === name) || (code && field.code === code));
      return current ? { key: fieldKey(current), name: current.name, code: current.code, value: override.value } : override;
    });
    overrides.additionalDataFields = fields.map(field => {
      const override = metadata.additionalDataFields.find((f: any) => f.key === fieldKey(field));
      return override ? { ...field, value: override.value } : { ...field };
    });
    for (const override of metadata.additionalDataFields) {
      if (override.field && !fields.some(field => fieldKey(field) === override.key)) {
        overrides.additionalDataFields.push({ ...override.field, value: override.value });
      }
    }
  }
  const payload = await buildCurrentInvoiceReceipt(db, invoice, profile, type, overrides);
  // Do not reclassify explicit overrides as defaults on every retry.
  const requestPayload = metadata
    ? JSON.stringify({ ...payload, [metadataKey]: metadata })
    : serializeInvoiceSubmission(payload, invoice, profile, overrides);
  return { payload, requestPayload };
}
