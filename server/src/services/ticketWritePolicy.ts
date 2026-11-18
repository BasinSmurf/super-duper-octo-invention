import { prisma } from '../db.js';
import { Prisma, TicketType, TicketStatus, ServiceSubtype, ServiceDivision, LineItemType, type UserRole } from '../db.js';
import { AppError } from '../middleware/errorHandler.js';
import { allowedFields, objectBody, enumValue, numberValue, validDate } from './writeValidation.js';
import { canTransition } from './ticketStateMachine.js';

export const ticketFields = `ticketType serviceSubtype companyId fieldId padId wellId facilityId workPointId billingProfileId rigPresent presentRigId presentRigNumberlocationDisplay fieldAreaName assignedTechId serviceDate serviceDateTo arrivalTime departureTime afeNumber poNumber costCenter contractNumber billingRefs division isDickinson customerContactId customerRepName customerRepSignature techSignature dispatchNotes workDescription internalNotes linkedRentalAgreementId customData`.split(' ');

export async function validateTicketInput(data: any, create = false): Promise<void> {
  objectBody(data);
  enumValue(data.ticketType, TicketType, 'ticketType');
  enumValue(data.serviceSubtype, ServiceSubtype, 'serviceSubtype');
  enumValue(data.division, ServiceDivision, 'division');
  enumValue(data.status, TicketStatus, 'status');
  if (create && (typeof data.companyId !== 'string' || !data.companyId.trim())) throw new AppError(400, 'companyId is required');
  for (const key of ['serviceDate', 'serviceDateTo', 'arrivalTime', 'departureTime']) if (data[key] != null) validDate(data[key], key);
  if (data.arrivalTime && data.departureTime && new Date(data.departureTime) < new Date(data.arrivalTime)) throw new AppError(400, 'Departure must not precede arrival');
  for (const key of ['workDescription', 'dispatchNotes', 'internalNotes']) if (data[key] != null && (typeof data[key] !== 'string' || data[key].length > 10000)) throw new AppError(400, `${key} must be at most 10000 characters`);
  if (data.presentRigNumber != null && (typeof data.presentRigNumber !== 'string' || data.presentRigNumber.length > 40)) throw new AppError(400, 'presentRigNumber must be at most 40 characters');
  if (data.serviceSubtype === 'fit_test' && data.ticketType && !['training', 'field_service'].includes(data.ticketType)) throw new AppError(400, 'fit_test requires an occupational-health ticket');
  if (data.serviceSubtype?.startsWith('ih_') && data.ticketType && !['inspection', 'field_service'].includes(data.ticketType)) throw new AppError(400, 'IH services require an inspection or field-service ticket');
  for (const [field, model] of Object.entries({ companyId: 'company', assignedTechId: 'user', fieldId: 'field', padId: 'pad', wellId: 'well', facilityId: 'facility', workPointId: 'workPoint', billingProfileId: 'customerBillingProfile', linkedRentalAgreementId: 'rentalAgreement' })) {
    if (data[field] != null && data[field] !== '') {
      if (typeof data[field] !== 'string') throw new AppError(400, `Invalid ${field}`);
      const reference = await (prisma as any)[model].findUnique({ where: { id: data[field] }, select: field === 'linkedRentalAgreementId' ? { id: true, companyId: true } : { id: true } });
      if (!reference) throw new AppError(400, `Invalid ${field}`);
      if (field === 'linkedRentalAgreementId' && data.companyId && reference.companyId !== data.companyId) throw new AppError(400, 'Rental agreement belongs to a different customer than this ticket');
    }
  }
}

export function assertTicketWriteAccess(ticket: any, actor: { userId: string; role: string }): void {
  if (!ticket) throw new AppError(404, 'Ticket not found');
  if (!['field_tech', 'dispatch', 'field_super', 'platform_admin', 'billing_ar', 'ar_supervisor', 'trainer', 'train_admin'].includes(actor.role)) throw new AppError(403, 'Ticket editing is not permitted');
  if (['field_tech', 'trainer'].includes(actor.role)) {
    if (ticket.assignedTechId !== actor.userId && ticket.createdById !== actor.userId) throw new AppError(403, 'Can only edit your own tickets');
  }
}

export function assertTicketEditable(ticket: any, actor: { userId: string; role: string }, submitting = false): void {
  assertTicketWriteAccess(ticket, actor);
  if (['invoiced', 'closed', 'void'].includes(ticket.status) || ticket.qbInvoiceTxnId || ticket.qbInvoiceListId || ticket.billingGroupId || ['invoiced', 'submitted'].includes(ticket.billingReadiness)) throw new AppError(409, 'Ticket is locked by billing; use the invoice correction workflow');
  if (['field_tech', 'trainer'].includes(actor.role)) {
    if (!['draft', 'in_progress', 'dispatched'].includes(ticket.status) && !(submitting && ticket.status === 'supervisor_review')) throw new AppError(403, 'Ticket has already been submitted');
  }
}

export async function editableTicket(id: string, actor: { userId: string; role: string }, submitting = false, db: Prisma.TransactionClient = prisma) {
  const ticket = await db.serviceTicket.findUnique({ where: { id } });
  assertTicketEditable(ticket, actor, submitting);
  const invoice = await db.invoiceLineItem.findFirst({ where: { sourceTicketId: id, invoice: { status: { not: 'void' } } }, select: { id: true } });
  if (invoice) throw new AppError(409, 'Ticket is linked to an active invoice');
  return ticket!;
}

/** Keep a line edit and its derived totals in one transaction; serialize sibling edits. */
export async function mutateTicketLine(ticketId: string, action: 'create' | 'update' | 'delete', id: string | undefined, data: any, actor: { userId: string; role: string }, submitting = false) {
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM service_tickets WHERE id = ${ticketId} FOR UPDATE`;
    await editableTicket(ticketId, actor, submitting, tx);
    const existing = id ? await tx.ticketLineItem.findUnique({ where: { id } }) : null;
    if (existing && existing.ticketId !== ticketId) throw new AppError(404, 'Line item not found on this ticket');
    if (action !== 'create' && !existing) throw new AppError(404, 'Line item not found on this ticket');
    if (action === 'create' && existing) return existing;
    let result;
    if (action === 'delete') result = await tx.ticketLineItem.delete({ where: { id } });
    else {
      const clean = await validateLineInput(data, existing);
      if (action === 'create') {
        const last = await tx.ticketLineItem.findFirst({ where: { ticketId }, orderBy: { lineNumber: 'desc' }, select: { lineNumber: true } });
        const lineNumber = (last?.lineNumber ?? 0) + 1;
        result = await tx.ticketLineItem.create({ data: { ...clean, id, ticketId, lineNumber, sortOrder: clean.sortOrder ?? lineNumber } });
      } else result = await tx.ticketLineItem.update({ where: { id }, data: clean });
    }
    await refreshTicketTotals(ticketId, tx);
    return result;
  });
}

export function assertDraftDeletion(ticket: any): void {
  if (ticket.status !== 'draft') throw new AppError(409, 'Only drafts can be permanently deleted; void submitted work instead');
}

export function assertOfflineStatus(current: string | null, next: string | undefined, role: string): void {
  if (!next || next === current) return;
  // Offline Finish deliberately combines starting/completing/submitting work.
  if ((!current || ['draft', 'dispatched', 'in_progress', 'completed'].includes(current)) && next === 'supervisor_review' && ['field_tech', 'dispatch', 'field_super', 'platform_admin', 'trainer', 'train_admin'].includes(role)) return;
  if (!current && ['draft', 'in_progress'].includes(next)) return;
  // Approval and billing changes must use the server transition endpoint.
  if (['billing_queue', 'invoiced', 'closed', 'void', 'awaiting_signature'].includes(next) || !current || !canTransition(current as any, next as any, role as UserRole)) throw new AppError(403, 'Invalid offline status transition; use the ticket transition endpoint');
}

const lineFields = `lineType productId description quantity unitOfMeasure rate total hoursRegular hoursOvertime hoursTravel partNumber serialNumberInstalled serialNumberRemoved equipmentIdInstalled equipmentIdRemoved testResult calGasLotNumber rentalAgreementId rentalStartDate rentalEndDate wellIdOverride workPointIdOverride enverusProductServiceCode enverusAfeNumber enverusCostCenter sortOrder lineNumber notes customData`.split(' ');
export async function validateLineInput(data: any, existing?: any): Promise<any> {
  objectBody(data);
  allowedFields(data, lineFields);
  const combined = { ...existing, ...data };
  enumValue(combined.lineType, LineItemType, 'lineType');
  if (!combined.lineType) throw new AppError(400, 'lineType is required');
  const quantity = data.quantity === undefined && existing ? Number(existing.quantity) : combined.quantity;
  numberValue(quantity, 'quantity', 0.01, 99999999.99);
  const rate = data.rate === undefined && existing ? Number(existing.rate ?? 0) : (combined.rate ?? 0);
  numberValue(rate, 'rate');
  if (new Prisma.Decimal(quantity).decimalPlaces() > 2 || new Prisma.Decimal(rate).decimalPlaces() > 2) throw new AppError(400, 'Quantity and rate support at most two decimal places');
  if (combined.rate == null && combined.total != null && Number(combined.total) !== 0) throw new AppError(400, 'A rate is required for a priced line');
  for (const field of ['hoursRegular', 'hoursOvertime', 'hoursTravel']) if (data[field] != null) numberValue(data[field], field, 0, 9999.99);
  for (const field of ['lineNumber', 'sortOrder']) if (data[field] != null && (!Number.isInteger(data[field]) || data[field] < 0 || data[field] > 100000)) throw new AppError(400, `Invalid ${field}`);
  for (const field of ['description', 'notes']) if (data[field] != null && (typeof data[field] !== 'string' || data[field].length > 10000)) throw new AppError(400, `${field} must be at most 10000 characters`);
  if (data.productId) {
    const product = await prisma.product.findUnique({ where: { id: data.productId }, select: { id: true, isActive: true } });
    if (!product) throw new AppError(400, 'Invalid productId');
    if (!product.isActive && data.productId !== existing?.productId) {
      throw new AppError(400, 'Inactive parts cannot be added to tickets; choose an active part');
    }
  }
  // Decimal arithmetic prevents floating-point penny drift. Client totals are advisory only.
  const total = new Prisma.Decimal(quantity).mul(rate).toDecimalPlaces(2);
  numberValue(total.toNumber(), 'line total');
  if (data.total != null) numberValue(data.total, 'total');
  return { ...data, quantity, rate, total };
}

export async function refreshTicketTotals(ticketId: string, db: any = prisma): Promise<void> {
  const lines = await db.ticketLineItem.findMany({ where: { ticketId }, select: { total: true } });
  const subtotal = lines.reduce((sum: Prisma.Decimal, line: any) => sum.add(line.total ?? 0), new Prisma.Decimal(0));
  numberValue(subtotal.toNumber(), 'ticket total');
  await db.serviceTicket.update({ where: { id: ticketId }, data: { subtotal, total: subtotal } });
}

export async function assertBillingEligible(ticket: any, signedDocument = false): Promise<void> {
  if (!ticket) throw new AppError(404, 'Ticket not found');
  const lines = await prisma.ticketLineItem.findMany({ where: { ticketId: ticket.id } });
  // Safety classes derive their per-employer charges from the roster at
  // invoice generation. Requiring a manual line here blocks normal closeout
  // or encourages a duplicate charge. Fit tests still use ordinary lines.
  const rosterBilled = ticket.ticketType === 'training' && ticket.serviceSubtype !== 'fit_test';
  const hasRoster = rosterBilled && !lines.length
    ? await prisma.trainingRosterRecord.count({ where: { ticketId: ticket.id } }) > 0
    : false;
  if (!lines.length && !hasRoster) throw new AppError(400, 'Billable line items are required before approval');
  if (!ticket.division) throw new AppError(400, 'Division is required before approval');
  const shop = ticket.ticketType === 'repair' || ['shop_repair', 'air_fill', 'calibration', 'bump_test'].includes(ticket.serviceSubtype);
  if (ticket.ticketType === 'field_service' && !shop && !ticket.linkedRentalAgreementId) {
    if (!ticket.arrivalTime || !ticket.departureTime) throw new AppError(400, 'Arrival and departure times are required before approval');
    if (!['fit_test', 'ih_audiometric'].includes(ticket.serviceSubtype) && !ticket.padId && !ticket.wellId && !ticket.facilityId && !ticket.fieldId) throw new AppError(400, 'A service location is required before approval');
  }
  const mismatch = ticket.customData?.customerLocationMismatch;
  if (mismatch && (mismatch.status === 'pending' || (mismatch.status === 'left' && !mismatch.reason?.trim()))) throw new AppError(400, 'Resolve the customer/site mismatch before approval');
  const profile = ticket.billingProfileId ? await prisma.customerBillingProfile.findUnique({ where: { id: ticket.billingProfileId } }) : null;
  if (['ticket', 'both'].includes(profile?.signatureRequired ?? '') && !ticket.customerRepSignature && !ticket.techSignature && !signedDocument) throw new AppError(400, 'A signed ticket is required before approval');
  await refreshTicketTotals(ticket.id);
}
