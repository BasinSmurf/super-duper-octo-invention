import { profileForBillingWork } from './billingApprovalGroups.js';
import { AppError } from '../middleware/errorHandler.js';
import { billingApprovalPlan, splitBillingApprovals, type ApprovalAllocation } from './billingApprovalSplit.js';

/** Approval uses captured quantities, independent of invoice repricing and status timestamps. */
export function ticketAllocationContext(profiles: any[], ticket: any) {
  const date = new Date(ticket.serviceDate || Date.now());
  const available = profiles.filter(profile => profile.isActive !== false &&
    (!profile.effectiveFrom || new Date(profile.effectiveFrom) <= date) &&
    (!profile.effectiveTo || new Date(profile.effectiveTo) >= date));
  const defaultProfileId = profileForBillingWork(profiles, { ...ticket, customData: null, ihTestRecords: [] })?.id || 'default';
  const approvalProfileIds = [...new Set([defaultProfileId, ...available.map(profile => profile.id)])].sort();
  const source = { ...ticket, updatedAt: undefined, approvalProfileIds };
  const lines = [...ticket.lineItems].sort((a, b) => a.id.localeCompare(b.id)).map((line, index) => ({
    lineNumber: index + 1, sourceTicketId: ticket.id, sourceTicketLineItemId: line.id,
    sourceTicketNumber: ticket.ticketNumber, description: line.description || line.lineType,
    quantity: Number(line.quantity), rate: Number(line.rate ?? 0), amount: Number(line.total ?? 0),
    unitOfMeasure: line.unitOfMeasure || 'EA', isTaxable: false,
  }));
  const initial = billingApprovalPlan(profiles, [source], lines);
  // Generated fees have no field-ticket line. The approver explicitly assigns their destination.
  if (initial.groups.length > 1) lines.push({
    lineNumber: lines.length + 1, sourceTicketId: ticket.id, sourceTicketLineItemId: `shared:${ticket.id}`,
    sourceTicketNumber: ticket.ticketNumber, description: 'Shared fees (including call-out)',
    quantity: 1, rate: 0, amount: 0, unitOfMeasure: 'assignment', isTaxable: false,
  });
  return { source, lines, plan: { ...billingApprovalPlan(profiles, [source], lines), defaultProfileId } };
}

export async function loadTicketAllocation(db: any, ticketId: string) {
  const ticket = await db.serviceTicket.findUnique({ where: { id: ticketId }, include: {
    lineItems: true, ihTestRecords: { select: { testType: true } },
  } });
  if (!ticket) throw new AppError(404, 'Ticket not found');
  const profiles = await db.customerBillingProfile.findMany({ where: { companyId: ticket.companyId, isActive: true } });
  return { ticket, profiles, ...ticketAllocationContext(profiles, ticket) };
}

export function approveTicketAllocation(profiles: any[], ticket: any, allocations: ApprovalAllocation[] | undefined,
  version: string | undefined, actorId: string | null, splitEnabled = false) {
  const { source, lines, plan } = ticketAllocationContext(profiles, ticket);
  if (typeof splitEnabled !== 'boolean') throw new AppError(400, 'splitBilling must be true or false');
  if (!splitEnabled) allocations = plan.rows.map(row => ({ key: row.key,
    parts: [{ profileId: plan.defaultProfileId, quantity: row.quantity }] }));
  splitBillingApprovals(profiles, [source], lines, allocations, splitEnabled ? version : plan.version);
  const generated = allocations?.find(row => row.key === `shared:${ticket.id}`);
  if (generated && generated.parts.length !== 1) throw new AppError(400, 'Choose one group for other billing charges');
  const resolved = plan.rows.map(row => allocations?.find(item => item.key === row.key) || {
    key: row.key, parts: [{ profileId: row.defaultProfileId!, quantity: row.quantity }],
  });
  return { splitEnabled, version: plan.version, groups: plan.groups, rows: plan.rows, allocations: resolved, approvedById: actorId, approvedAt: new Date().toISOString() };
}

/** Billing consumes only the server-owned approval record, never a new allocation from the billing page. */
export function approvedInvoiceAllocations(profiles: any[], tickets: any[], invoiceLines: any[]): ApprovalAllocation[] {
  const approved = new Map<string, ApprovalAllocation>();
  const shared = new Map<string, string>();
  for (const ticket of tickets) {
    const { source, lines, plan } = ticketAllocationContext(profiles, ticket);
    const record = ticket.billingApprovalAllocation;
    if (!record) continue; // Legacy / unattended approval keeps one default billing group.
    if (record.version !== plan.version || !record.approvedById)
      throw new AppError(409, `${ticket.ticketNumber}: allocate time and mileage in ticket approval before billing. Return this ticket for review.`);
    splitBillingApprovals(profiles, [source], lines, record.allocations, record.version);
    for (const row of record.allocations as ApprovalAllocation[]) {
      if (row.key === `shared:${ticket.id}`) {
        if (row.parts.length !== 1) throw new AppError(400, 'Choose one group for other billing charges');
        shared.set(ticket.id, row.parts[0].profileId);
      } else approved.set(row.key, row);
    }
  }
  const invoicePlan = billingApprovalPlan(profiles, invoiceApprovalTickets(profiles, tickets), invoiceLines);
  return invoicePlan.rows.map((row, index) => {
    const allocation = approved.get(row.key);
    if (allocation) {
      if (Math.abs(allocation.parts.reduce((sum, part) => sum + part.quantity, 0) - row.quantity) > 0.000001)
        throw new AppError(409, 'Billed quantities differ from approved allocation. Return the ticket for review.');
      return allocation;
    }
    const destination = row.defaultProfileId || shared.get(invoiceLines[index].sourceTicketId);
    if (!destination) throw new AppError(409, 'A generated charge needs an approval group. Return the ticket for review.');
    return { key: row.key, parts: [{ profileId: destination, quantity: row.quantity }] };
  });
}

/** Explicitly split approvals keep their destinations; other approvals use one default profile. */
export function invoiceApprovalTickets(profiles: any[], tickets: any[]) {
  return tickets.map(ticket => ({ ...ticket, approvalProfileIds: ticket.billingApprovalAllocation
    ? [...new Set<string>(ticket.billingApprovalAllocation.allocations.flatMap((row: ApprovalAllocation) => row.parts.map(part => part.profileId)))]
    : [profileForBillingWork(profiles, { ...ticket, customData: null, ihTestRecords: [] })?.id || 'default'] }));
}
