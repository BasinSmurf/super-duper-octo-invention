import { beforeEach, describe, expect, it, vi } from 'vitest';
const prisma = vi.hoisted(() => ({ invoice: { findUnique: vi.fn(), update: vi.fn() }, qbSyncQueue: { create: vi.fn() } }));
vi.mock('../db.js', async importOriginal => ({ ...await importOriginal<typeof import('../db.js')>(), ...(() => ({ prisma }))() }));
vi.mock('../utils/auditLog.js', () => ({ createAuditLog: vi.fn() }));
import { invoicesRouter } from './invoices.js';
let invoice: any;
async function action(name: string) {
  const route = invoicesRouter.stack.find(l => l.route?.path === `/:id/${name}`)!.route;
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
  await route.stack.at(-1).handle({ params: { id: 'invoice' }, user: { userId: 'actor' } }, res);
  return res;
}
beforeEach(() => {
  vi.clearAllMocks();
  invoice = { id: 'invoice', invoiceNumber: 'INV-SYNTHETIC', status: 'draft', total: 0,
    company: { name: 'SYNTHETIC EMPLOYER', qbCustomerFullName: 'SYNTHETIC EMPLOYER' },
    lineItems: [{ lineNumber: 1, description: 'Students: SYNTHETIC A, SYNTHETIC B', amount: 0 }] };
  prisma.invoice.findUnique.mockImplementation(async () => invoice);
  prisma.invoice.update.mockImplementation(async ({ data }) => Object.assign(invoice, data));
});
describe('no-charge employer invoice closeout', () => {
  it.each(['approve', 'queue'])('blocks an unmapped paying customer during %s instead of silently closing it', async name => {
    invoice.status = name === 'queue' ? 'approved' : 'draft';
    invoice.company = { name: 'SYNTHETIC CUSTOMER' };
    invoice.companyName = 'SYNTHETIC CUSTOMER';
    invoice.total = 6200;
    invoice.lineItems = [{ lineNumber: 1, description: 'Rental charge', amount: 6200, qbItemFullName: '0411014' }];
    const res = await action(name);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].validationErrors.customer).toContain('no QuickBooks customer mapping');
    expect(invoice.status).toBe(name === 'queue' ? 'approved' : 'draft');
    expect(prisma.invoice.update).not.toHaveBeenCalled();
    expect(prisma.qbSyncQueue.create).not.toHaveBeenCalled();
  });
  it('preserves genuine no-charge records without a QB customer mapping', async () => {
    invoice.company = { name: 'SYNTHETIC CUSTOMER' };
    await action('approve');
    expect(invoice.status).toBe('approved');
    await action('queue');
    expect(invoice.status).toBe('invoiced');
    expect(prisma.qbSyncQueue.create).not.toHaveBeenCalled();
  });
  it('approves then records attendee-only invoices without an accounting job', async () => {
    const approval = await action('approve');
    expect(approval.status).not.toHaveBeenCalled();
    expect(invoice.status).toBe('approved');
    await action('queue');
    expect(invoice.status).toBe('invoiced');
    expect(prisma.qbSyncQueue.create).not.toHaveBeenCalled();
    expect(invoice.lineItems[0].description).toContain('SYNTHETIC A');
  });
  it('still rejects a positive line without a QB mapping', async () => {
    invoice.lineItems.push({ lineNumber: 2, description: 'Class fee', amount: 100 });
    const res = await action('approve');
    expect(res.status).toHaveBeenCalledWith(400);
    expect(invoice.status).toBe('draft');
  });
  it.each(['approve', 'queue'])('identifies the package rather than its equipment notes during %s', async name => {
    invoice.status = name === 'queue' ? 'approved' : 'draft';
    invoice.total = 3150;
    invoice.lineItems = [{ lineNumber: 1,
      description: 'Rental — Standard Package @ $500/day\nItems deployed:\n- SCBA Tank Cylinder #DG60690',
      amount: 3000 }];
    const res = await action(name);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].validationErrors.unmappedLines).toEqual([
      'Line 1: "Rental — Standard Package @ $500/day" (Part# none) — no QB item mapping',
    ]);
    expect(invoice.lineItems[0].description).toContain('SCBA Tank Cylinder #DG60690');
    expect(prisma.qbSyncQueue.create).not.toHaveBeenCalled();
  });
  it('does not treat an empty invoice as a no-charge record', async () => {
    invoice.lineItems = [];
    const res = await action('approve');
    expect(res.status).toHaveBeenCalledWith(400);
    expect(invoice.status).toBe('draft');
  });
});
