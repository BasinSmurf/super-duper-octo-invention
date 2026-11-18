import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = vi.hoisted(() => ({
  $transaction: vi.fn(), $queryRaw: vi.fn(),
  invoice: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn() },
  serviceTicket: { updateMany: vi.fn() },
  qbSyncQueue: { count: vi.fn(), updateMany: vi.fn() },
}));
vi.mock('../db.js', async importOriginal => ({ ...await importOriginal<typeof import('../db.js')>(), ...(() => ({ prisma }))() }));
vi.mock('../utils/auditLog.js', () => ({ createAuditLog: vi.fn() }));
import { invoicesRouter } from './invoices.js';
import { createAuditLog } from '../utils/auditLog.js';

async function voidInvoice() {
  const route = invoicesRouter.stack.find(l => l.route?.path === '/:id/void')!.route;
  await route.stack.at(-1).handle({ params: { id: 'invoice' }, body: { reason: 'Synthetic correction' }, user: { userId: 'actor' } }, { json: vi.fn() });
}
beforeEach(() => {
  vi.clearAllMocks();
  prisma.$transaction.mockImplementation(async fn => fn(prisma));
  prisma.invoice.findUnique.mockResolvedValue({ id: 'invoice', invoiceNumber: 'INV-SYNTHETIC', status: 'draft', lineItems: [{ sourceTicketId: 'class' }] });
  prisma.invoice.update.mockResolvedValue({ id: 'invoice', status: 'void' });
  prisma.invoice.findMany.mockResolvedValue([]);
  prisma.qbSyncQueue.count.mockResolvedValue(0);
});

describe('voiding one invoice in a customer-split batch', () => {
  it('keeps the class invoiced while another customer draft still bills it', async () => {
    prisma.invoice.findMany.mockResolvedValue([{ lineItems: [{ sourceTicketId: 'class' }] }]);
    await voidInvoice();
    expect(prisma.serviceTicket.updateMany).not.toHaveBeenCalled();
    expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ changes: expect.objectContaining({ releasedTickets: [] }) }));
  });
  it('releases the class only after its last live invoice is voided', async () => {
    await voidInvoice();
    expect(prisma.serviceTicket.updateMany).toHaveBeenCalledWith({ where: { id: { in: ['class'] }, status: 'invoiced' }, data: { status: 'billing_queue' } });
    expect(prisma.$queryRaw).toHaveBeenCalled();
    expect(prisma.invoice.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { status: { not: 'void' }, lineItems: { some: { sourceTicketId: { in: ['class'] } } } } }));
  });
  it('releases only fully unbilled tickets on a multi-ticket invoice', async () => {
    prisma.invoice.findUnique.mockResolvedValue({ id: 'invoice', status: 'draft', lineItems: [{ sourceTicketId: 'a' }, { sourceTicketId: 'b' }] });
    prisma.invoice.findMany.mockResolvedValue([{ lineItems: [{ sourceTicketId: 'b' }] }]);
    await voidInvoice();
    expect(prisma.serviceTicket.updateMany).toHaveBeenCalledWith({ where: { id: { in: ['a'] }, status: 'invoiced' }, data: { status: 'billing_queue' } });
  });
  it('does not release a ticket after accounting has received its invoice', async () => {
    prisma.invoice.findUnique.mockResolvedValue({ id: 'invoice', status: 'invoiced', qbInvoiceTxnId: 'external', lineItems: [{ sourceTicketId: 'class' }] });
    await voidInvoice();
    expect(prisma.serviceTicket.updateMany).not.toHaveBeenCalled();
    expect(prisma.invoice.findMany).not.toHaveBeenCalled();
  });
});
