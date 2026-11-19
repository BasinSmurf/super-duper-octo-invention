import type { PrismaClient } from '../db.js';
import { computeRentalBillingState } from './rentalBilling.js';

const DAY = 86400000;
export const ageDays = (date: Date, now: Date) => Math.max(0, Math.floor((+now - +date) / DAY));
const day = (date: Date) => date.toISOString().slice(0, 10);
export interface OperationsRow {
  number: string; customer: string; owner: string | null; href: string;
  ageDays: number; ageBasis: string; detail: string;
  coverage?: 'covered' | 'unassigned' | 'conflicted'; overdue?: boolean;
  category?: string;
}
export function assignmentCoverage(activeOwners: number, conflicting = false): NonNullable<OperationsRow['coverage']> {
  return conflicting ? 'conflicted' : activeOwners > 0 ? 'covered' : 'unassigned';
}
export function invoiceStage(invoice: { status: string; qbSalesOrderTxnId: string | null; qbInvoiceTxnId: string | null }) {
  if (invoice.status === 'paid') return 'paid';
  if (invoice.qbSalesOrderTxnId || invoice.qbInvoiceTxnId) return 'accepted';
  if (invoice.status === 'queued') return 'queued';
  if (invoice.status === 'draft' || invoice.status === 'awaiting_signature') return 'drafted';
  return 'approved';
}

/** Read-only snapshot. Calendar comparisons use UTC date-only values, matching Prisma @db.Date. */
export async function getOperationsReport(db: PrismaClient, now = new Date(), includeFinancial = true) {
  const today = new Date(`${day(now)}T00:00:00Z`);
  const person = { select: { name: true, isActive: true } } as const;
  const [tickets, routes, invoices, attempts, rentals, shop, contact, connector] = await Promise.all([
    db.serviceTicket.findMany({ where: { status: { not: 'void' }, OR: [{ status: { notIn: ['closed', 'invoiced'] } }, { billingReadiness: { in: ['unclassified', 'ready'] } }, { ticketType: 'training', trainingRosterRecords: { some: { OR: [{ employerCompanyId: null }, { passed: true, cardIssuedOfficial: false }] } } }] },
      select: { id: true, ticketNumber: true, ticketType: true, status: true, serviceDate: true, serviceDateTo: true, createdAt: true, completedAt: true,
        syncConflict: true, rejectionReason: true, reviewSignal: true, billingReadiness: true, billingReadinessReasonCode: true, total: true,
        company: { select: { name: true } }, assignedTech: person,
        trainingRosterRecords: { select: { employerCompanyId: true, passed: true, cardIssuedOfficial: true, blueLionCardIssuedAt: true } },
        equipmentInspections: { where: { outcome: { in: ['fail', 'cannot_service', 'requires_parts'] }, correctedBy: { none: {} } }, select: { serialNumber: true, outcome: true, notes: true } },
        billingGroup: { select: { invoices: { where: { status: { not: 'void' } }, select: { id: true } } } } } }),
    db.serviceRoute.findMany({ where: { isActive: true }, select: { id: true, name: true, routeNumber: true, createdAt: true,
      company: { select: { name: true } }, assignments: { select: { isPrimary: true, user: person } },
      cycles: { where: { status: 'active' }, select: { startDate: true, endDate: true, totalStops: true, completedStops: true, assignedTech: person } } } }),
    db.invoice.findMany({ where: { status: { not: 'void' } }, select: { id: true, invoiceNumber: true, companyName: true, status: true, total: true,
      invoiceDate: true, createdAt: true, approvedAt: true, qbSalesOrderTxnId: true, qbInvoiceTxnId: true,
      rentalAgreementId: true, periodEnd: true, createdBy: person, lineItems: { select: { sourceTicketId: true, amount: true } } } }),
    db.qbSyncQueue.findMany({ where: { entityType: { in: ['invoice', 'sales_order'] }, action: { in: ['add', 'mod'] } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], distinct: ['entityId'],
      select: { entityId: true, status: true, createdAt: true, errorMessage: true, errorCode: true } }),
    db.rentalAgreement.findMany({ where: { status: { in: ['active', 'completed'] } }, select: { id: true, agreementNumber: true, status: true,
      startDate: true, endDate: true, billingCadence: true, billingPolicy: true, createdBy: person, company: { select: { name: true } } } }),
    db.shopWorkOrder.findMany({ where: { status: { not: 'closed' } }, select: { id: true, workOrderNumber: true, status: true, intakeDate: true,
      promisedDate: true, company: { select: { name: true } }, items: { select: { itemNumber: true, status: true, assignedTo: person } } } }),
    db.qbSyncQueue.findFirst({ where: { status: 'success', completedAt: { not: null } }, orderBy: { completedAt: 'desc' }, select: { completedAt: true } }),
    db.jobRun.findUnique({ where: { id: 'qb-connector-contact' }, select: { finishedAt: true } }),
  ]);
  const jobs: OperationsRow[] = [], coverage: OperationsRow[] = [], exceptions: OperationsRow[] = [];
  const invoicedTickets = new Set(invoices.flatMap(i => i.lineItems.map(l => l.sourceTicketId)).filter(Boolean));
  for (const t of tickets) {
    const row: OperationsRow = { number: t.ticketNumber, customer: t.company.name, owner: t.assignedTech?.name ?? null,
      href: `/tickets/${t.id}`, ageDays: ageDays(t.createdAt, now), ageBasis: 'created', category: t.ticketType, detail: t.status.replaceAll('_', ' ') };
    if (['draft', 'dispatched', 'in_progress'].includes(t.status)) {
      jobs.push({ ...row, coverage: assignmentCoverage(t.assignedTech?.isActive ? 1 : 0, t.syncConflict),
        overdue: (t.serviceDateTo ?? t.serviceDate) < today, detail: `${row.detail} · scheduled ${day(t.serviceDate)}${t.assignedTech && !t.assignedTech.isActive ? ' · assigned technician inactive' : ''}` });
    }
    const reasons: string[] = [];
    if (t.status === 'supervisor_review') reasons.push('Supervisor review required');
    if (t.rejectionReason && !['closed', 'invoiced', 'billing_queue'].includes(t.status)) reasons.push(t.rejectionReason);
    if (t.syncConflict) reasons.push('Device sync conflict needs resolution');
    const signal = t.reviewSignal as { reasons?: string[] } | null;
    if (t.status === 'supervisor_review' && Array.isArray(signal?.reasons)) reasons.push(...signal.reasons);
    if (!['closed', 'invoiced'].includes(t.status)) for (const inspection of t.equipmentInspections) {
      reasons.push(`Inspection ${inspection.serialNumber}: ${inspection.outcome.replaceAll('_', ' ')} — ${inspection.notes || 'Review equipment disposition and follow-up'}`);
    }
    if (['completed', 'billing_queue', 'closed'].includes(t.status) && !invoicedTickets.has(t.id) && !t.billingGroup?.invoices.length && !['not_billable', 'invoiced', 'submitted'].includes(t.billingReadiness)) {
      reasons.push('Completed work: review billing lineage and create invoice');
    }
    if (t.ticketType === 'training' && t.serviceDate <= today) {
      if ((t.serviceDateTo ?? t.serviceDate) < today && ['draft', 'dispatched', 'in_progress'].includes(t.status)) reasons.push('Training closeout overdue: complete class and review billing');
      if (!t.trainingRosterRecords.length) reasons.push('Training roster missing');
      if (!invoicedTickets.has(t.id) && t.trainingRosterRecords.some(r => !r.employerCompanyId)) reasons.push('Training payer mapping requires review');
      if (t.trainingRosterRecords.some(r => r.passed && !r.cardIssuedOfficial && !r.blueLionCardIssuedAt)) reasons.push('Training cards awaiting official issuance');
    }
    if (reasons.length) exceptions.push({ ...row, detail: reasons.join(' · ') });
  }
  for (const r of routes) {
    const primaries = r.assignments.filter(a => a.isPrimary && a.user.isActive);
    const owners = r.assignments.filter(a => a.user.isActive).map(a => a.user.name);
    const cycles = r.cycles.length ? r.cycles : [null];
    for (const cycle of cycles) {
      const cycleOwner = cycle?.assignedTech;
      coverage.push({ number: r.routeNumber ?? r.name, customer: r.company.name, owner: cycleOwner?.name ?? (owners.join(', ') || null),
        href: `/routes?routeId=${encodeURIComponent(r.id)}`, ageDays: ageDays(cycle?.startDate ?? r.createdAt, now), ageBasis: cycle ? 'cycle start' : 'created',
        coverage: assignmentCoverage(cycleOwner ? Number(cycleOwner.isActive) : owners.length, primaries.length > 1),
        overdue: !!cycle?.endDate && cycle.endDate < today && cycle.completedStops < cycle.totalStops,
        detail: cycle ? `${r.name} · ${cycle.completedStops}/${cycle.totalStops} stops complete${cycle.endDate ? ` · due ${day(cycle.endDate)}` : ' · no due date'}` : `${r.name} · no active cycle` });
    }
  }
  const amounts = { drafted: 0, approved: 0, queued: 0, accepted: 0, paid: 0 };
  const latest = new Map(attempts.map(a => [a.entityId, a]));
  let noChargeRecorded = 0;
  for (const inv of invoices) {
    if (inv.status === 'invoiced' && !inv.qbSalesOrderTxnId && !inv.qbInvoiceTxnId && Number(inv.total) === 0 && inv.lineItems.length && inv.lineItems.every(l => Number(l.amount) === 0)) {
      if (day(inv.invoiceDate) === day(today)) noChargeRecorded++;
      continue;
    }
    const stage = invoiceStage(inv);
    if (day(inv.invoiceDate) === day(today)) amounts[stage] += Math.round(Number(inv.total) * 100);
    const attempt = latest.get(inv.id);
    let detail = '';
    if (attempt?.status === 'error') detail = `QB rejected: ${attempt.errorCode ? `${attempt.errorCode} — ` : ''}${attempt.errorMessage || 'No rejection detail returned; inspect QB export and retry'}`;
    else if (attempt && ['pending', 'sent'].includes(attempt.status)) detail = 'QB queued — accounting acceptance not yet received';
    else if (stage === 'queued') detail = 'QB queued — no active export attempt found; review queue and retry';
    else if (stage === 'drafted') detail = 'Invoice approval/signature backlog';
    else if (stage === 'approved') detail = 'Approved — QB acceptance not recorded';
    if (detail) exceptions.push({ number: inv.invoiceNumber, customer: inv.companyName, owner: inv.createdBy ? `${inv.createdBy.name} (creator)` : null,
      href: `/billing/${inv.id}`, ageDays: ageDays(attempt && ['error', 'pending', 'sent'].includes(attempt.status) ? attempt.createdAt : inv.createdAt, now),
      ageBasis: attempt && ['error', 'pending', 'sent'].includes(attempt.status) ? 'QB attempt' : 'created', detail });
  }
  for (const key of Object.keys(amounts) as (keyof typeof amounts)[]) amounts[key] /= 100;
  for (const r of rentals) {
    const state = computeRentalBillingState(r, invoices.filter(i => i.rentalAgreementId === r.id));
    const reasons: string[] = [];
    if (state.nextDueDate && state.nextDueDate <= today) reasons.push(`Rental billing due ${day(state.nextDueDate)}`);
    if (r.status === 'active' && r.endDate && r.endDate < today) reasons.push(`Pickup overdue since ${day(r.endDate)}`);
    const policy = r.billingPolicy as { pauses?: { startDate: string; endDate: string }[] } | null;
    const pauses = policy?.pauses?.filter(p => p.startDate <= day(today) && p.endDate >= day(today)) ?? [];
    if (pauses.length) reasons.push(`Billing paused: review ${pauses.map(p => `${p.startDate} through ${p.endDate}`).join(', ')}`);
    if (reasons.length) exceptions.push({ number: r.agreementNumber, customer: r.company.name, owner: r.createdBy ? `${r.createdBy.name} (creator)` : null,
      href: `/rentals/${r.id}`, ageDays: ageDays(state.nextDueDate ?? r.startDate, now), ageBasis: state.nextDueDate ? 'billing due' : 'rental start',
      detail: `${reasons.join(' · ')} · invoice coverage through ${state.lastBilledThrough ? day(state.lastBilledThrough) : 'never'} (includes drafts)` });
  }
  for (const order of shop) {
    const blockers = order.items.filter(i => ['awaiting_approval', 'awaiting_parts', 'qc_testing', 'on_hold', 'outside_service', 'warranty_out'].includes(i.status));
    const reasons = blockers.map(i => `Unit ${i.itemNumber}: ${i.status.replaceAll('_', ' ')}`);
    if (order.status === 'complete') reasons.push('Ready for pickup');
    if (order.promisedDate && order.promisedDate < today) reasons.push(`Promised ${day(order.promisedDate)}`);
    if (reasons.length) exceptions.push({ number: order.workOrderNumber, customer: order.company.name,
      owner: [...new Set(blockers.map(i => i.assignedTo?.name).filter(Boolean))].join(', ') || null,
      href: `/shop/${order.id}`, ageDays: ageDays(order.intakeDate, now), ageBasis: 'intake', detail: reasons.join(' · ') });
  }
  exceptions.sort((a, b) => b.ageDays - a.ageDays || a.number.localeCompare(b.number));
  return { generatedAt: now.toISOString(), date: day(today), dateBasis: 'UTC calendar date; amounts use invoice date and current, mutually exclusive status (paid is invoice value, not cash receipts).',
    amounts: includeFinancial ? amounts : {} as Record<string, number>, noChargeRecorded: includeFinancial ? noChargeRecorded : 0, jobs, coverage,
    exceptions: includeFinancial ? exceptions : exceptions.filter(r => !r.href.startsWith('/billing/')),
    lastSuccessfulQbResponseAt: contact?.completedAt?.toISOString() ?? null,
    lastConnectorContactAt: connector?.finishedAt?.toISOString() ?? null,
    coverageBasis: 'Covered means an active assigned technician, not verified attendance. Conflicted means a job sync conflict or multiple primary route technicians. Overdue means scheduled end/service date or cycle deadline has passed.' };
}
export type OperationsReport = Awaited<ReturnType<typeof getOperationsReport>>;
