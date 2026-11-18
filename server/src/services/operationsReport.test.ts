import { describe, expect, it, vi } from 'vitest';
import { getOperationsReport, invoiceStage, assignmentCoverage } from './operationsReport.js';
import { getPeriodActivity } from './opsStats.js';
import type { PrismaClient } from '../db.js';

export function reportFixture() {
  const date = new Date('2026-09-28T00:00:00Z');
  const person = { name: 'Synthetic Tech', isActive: true };
  const ticket = { id: 'ticket-1', ticketNumber: 'SYN-100', ticketType: 'field_service', status: 'in_progress', createdAt: new Date('2026-09-20'), serviceDate: new Date('2026-09-27'), serviceDateTo: null, company: { name: 'Synthetic Customer' }, assignedTech: person, trainingRosterRecords: [], equipmentInspections: [], billingGroup: null, billingReadiness: 'ready' };
  const invoices = ['draft', 'approved', 'queued', 'so_created', 'paid'].map((status, i) => ({ id: `invoice-${i}`, invoiceNumber: `SYN-INV-${i}`, companyName: 'Synthetic Customer', status, total: 100.01, invoiceDate: date, createdAt: date, createdBy: person, lineItems: [], qbSalesOrderTxnId: i >= 3 ? `SYN-TXN-${i}` : null, qbInvoiceTxnId: null }));
  const db = {
    serviceTicket: { findMany: vi.fn().mockResolvedValue([ticket, { ...ticket, id: 'ticket-2', ticketNumber: 'SYN-101', assignedTech: null }, { ...ticket, id: 'ticket-3', status: 'closed', total: 0, billingReadiness: 'not_billable' }]) },
    serviceRoute: { findMany: vi.fn().mockResolvedValue([{ id: 'route-1', name: 'Synthetic Route', routeNumber: 'R-1', createdAt: date, company: ticket.company, assignments: [{ isPrimary: true, user: person }], cycles: [{ startDate: new Date('2026-09-01'), endDate: new Date('2026-09-27'), totalStops: 10, completedStops: 3, assignedTech: null }] }]) },
    invoice: { findMany: vi.fn().mockResolvedValue(invoices) },
    qbSyncQueue: { findMany: vi.fn().mockResolvedValue([{ entityId: 'invoice-2', status: 'error', createdAt: new Date('2026-09-25'), errorCode: '3070', errorMessage: 'PO too long; shorten before retry' }]), findFirst: vi.fn().mockResolvedValue({ completedAt: date }) },
    rentalAgreement: { findMany: vi.fn().mockResolvedValue([{ id: 'rental-1', agreementNumber: 'SYN-RENT', company: ticket.company, createdBy: person, status: 'active', startDate: new Date('2026-08-01'), endDate: new Date('2026-09-20'), billingCadence: 'monthly', billingPolicy: { pauses: [{ startDate: '2026-09-27', endDate: '2026-09-29' }] } }]) },
    shopWorkOrder: { findMany: vi.fn().mockResolvedValue([{ id: 'shop-1', workOrderNumber: 'SYN-SHOP', company: ticket.company, intakeDate: date, status: 'in_progress', items: [{ itemNumber: 1, status: 'qc_testing', assignedTo: person }] }]) },
    jobRun: { findUnique: vi.fn().mockResolvedValue(null) },
  };
  return { db, date, ticket, invoices };
}
describe('operations report', () => {
  it('requires a QB transaction ID for acceptance and does not treat queueing as acceptance', () => {
    expect(invoiceStage({ status: 'queued', qbSalesOrderTxnId: null, qbInvoiceTxnId: null })).toBe('queued');
    expect(invoiceStage({ status: 'so_created', qbSalesOrderTxnId: null, qbInvoiceTxnId: null })).toBe('approved');
    expect(assignmentCoverage(0)).toBe('unassigned');
    expect(assignmentCoverage(2, true)).toBe('conflicted');
  });
  it('builds linked jobs, actual route progress, due rentals, QB failures and mutually exclusive money', async () => {
    const { db, date } = reportFixture();
    const report = await getOperationsReport(db as unknown as PrismaClient, date);
    expect(report.amounts).toEqual({ drafted: 100.01, approved: 100.01, queued: 100.01, accepted: 100.01, paid: 100.01 });
    expect(report.jobs[0]).toMatchObject({ coverage: 'covered', overdue: true, href: '/tickets/ticket-1' });
    expect(report.jobs[1].coverage).toBe('unassigned');
    expect(report.coverage[0]).toMatchObject({ detail: 'Synthetic Route · 3/10 stops complete · due 2026-09-27', href: '/routes?routeId=route-1', overdue: true });
    expect(report.exceptions.find(r => r.href === '/billing/invoice-2')).toMatchObject({ ageDays: 3, detail: 'QB rejected: 3070 — PO too long; shorten before retry' });
    expect(report.exceptions.find(r => r.href === '/rentals/rental-1')?.detail).toContain('Billing paused');
    expect(report.exceptions.some(r => r.href === '/tickets/ticket-3')).toBe(false);
    expect(report.exceptions.find(r => r.href === '/shop/shop-1')?.detail).toContain('qc testing');
  });
  it('does not repeat a historical rejection after a successful retry', async () => {
    const { db, date } = reportFixture();
    db.qbSyncQueue.findMany.mockResolvedValue([{ entityId: 'invoice-3', status: 'success', createdAt: date, errorCode: '', errorMessage: '' }]);
    const report = await getOperationsReport(db as unknown as PrismaClient, date, false);
    expect(report.exceptions.some(r => r.detail.includes('QB rejected'))).toBe(false);
    expect(report.amounts).toEqual({});
    expect(report.exceptions.some(r => r.href.startsWith('/billing/'))).toBe(false);
  });
  it('activity summary sums only QB-confirmed invoices and excludes voids', async () => {
    const db = { serviceTicket: { count: vi.fn().mockResolvedValue(2) }, invoice: { aggregate: vi.fn().mockResolvedValue({ _sum: { total: 10 } }) } };
    await getPeriodActivity(db as unknown as PrismaClient, new Date('2026-09-01'), new Date('2026-09-28'));
    expect(db.invoice.aggregate.mock.calls[0][0].where).toMatchObject({ status: { not: 'void' }, OR: [{ qbSalesOrderTxnId: { not: null } }, { qbInvoiceTxnId: { not: null } }] });
  });
  it('excludes legitimate local zero closeouts and tickets linked through invoice lines from billing alerts', async () => {
    const { db, date, ticket, invoices } = reportFixture();
    db.serviceTicket.findMany.mockResolvedValue([{ ...ticket, status: 'completed' }]);
    db.invoice.findMany.mockResolvedValue([{ ...invoices[0], status: 'invoiced', total: 0, lineItems: [{ sourceTicketId: ticket.id, amount: 0 }] }] as any);
    const report = await getOperationsReport(db as unknown as PrismaClient, date);
    expect(report.noChargeRecorded).toBe(1);
    expect(report.exceptions.some(r => r.href === '/tickets/ticket-1' || r.href === '/billing/invoice-0')).toBe(false);
  });
});
