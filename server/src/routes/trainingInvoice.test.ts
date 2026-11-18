import { beforeEach, describe, expect, it, vi } from 'vitest';
const prisma = vi.hoisted(() => ({
  $transaction: vi.fn(), $queryRaw: vi.fn(),
  serviceTicket: { findUnique: vi.fn(), update: vi.fn() },
  invoice: { findMany: vi.fn(), create: vi.fn() },
  company: { findUnique: vi.fn() }, product: { findFirst: vi.fn() },
}));
vi.mock('../db.js', async importOriginal => ({ ...await importOriginal<typeof import('../db.js')>(), ...(() => ({ prisma }))() }));
vi.mock('../utils/ticketNumber.js', () => ({ generateInvoiceNumber: vi.fn(async () => 'INV-SYNTHETIC') }));
vi.mock('../utils/auditLog.js', () => ({ createAuditLog: vi.fn() }));
vi.mock('../services/billingLineage.js', () => ({ upsertDocRefAndLines: vi.fn() }));
vi.mock('../services/customerDescriptions.js', () => ({ applyCustomerDescriptions: vi.fn() }));
vi.mock('../utils/courseProductMap.js', () => ({ getProductForCourse: vi.fn(async () => ({ productId: 'course', partNumber: '11011', price: 125 })), getCourseLabel: (name: string) => name, trainingBillingBasis: () => 'per_student' }));
import { invoicesRouter } from './invoices.js';
import { getProductForCourse } from '../utils/courseProductMap.js';
let saved: any[];
let ticket: any;
async function generate(billingCompanyId?: string) {
  const route = invoicesRouter.stack.find(l => l.route?.path === '/generate/from-training-ticket')!.route;
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
  await route.stack[0].handle({ body: { ticketId: 'class', billingCompanyId }, user: { userId: 'actor' } }, res);
  return res.json.mock.calls[0][0];
}
beforeEach(() => {
  vi.clearAllMocks(); saved = [];
  ticket = { id: 'class', ticketNumber: 'TR-SYNTHETIC', ticketType: 'training', status: 'billing_queue', serviceDate: new Date('2026-09-25'), company: { id: 'house', name: 'Booking company' }, customData: { invoiceByCustomer: false }, trainingRosterRecords: [
    { id: 'a', employeeName: 'SYNTHETIC A', employerCompanyId: 'employer-a', employerName: 'Employer A', courseName: 'First Aid/CPR', passed: true },
    { id: 'b', employeeName: 'SYNTHETIC B', employerCompanyId: 'employer-b', employerName: 'Employer B', courseName: 'First Aid/CPR', passed: true },
    { id: 'c', employeeName: 'SYNTHETIC C', employerCompanyId: 'employer-a', employerName: 'Employer A', courseName: 'First Aid/CPR', passed: false },
  ] };
  prisma.serviceTicket.findUnique.mockImplementation(async () => ({ ...ticket }));
  prisma.serviceTicket.update.mockImplementation(async ({ data }) => { ticket = { ...ticket, ...data }; return ticket; });
  prisma.company.findUnique.mockImplementation(async ({ where }) => ({ id: where.id, name: where.id }));
  prisma.product.findFirst.mockResolvedValue({ id: 'misc', partNumber: 'Misc' });
  prisma.invoice.findMany.mockImplementation(async () => [...saved]);
  prisma.invoice.create.mockImplementation(async ({ data }) => { const row = { ...data, id: `invoice-${saved.length + 1}`, lineItems: data.lineItems.create }; saved.push(row); return row; });
  let queue = Promise.resolve();
  prisma.$transaction.mockImplementation(async fn => {
    const previous = queue; let release!: () => void;
    queue = new Promise<void>(resolve => { release = resolve; });
    await previous;
    const prior = [...saved], priorTicket = { ...ticket };
    try { return await fn(prisma); } catch (e) { saved = prior; ticket = priorTicket; throw e; } finally { release(); }
  });
});
describe('per-employer training invoice transaction', () => {
  const classPrice = { productId: 'course', partNumber: '0112001', name: 'Safety Meeting', price: 100, billingBasis: 'per_class' as const, qbItemFullName: null, qbItemListId: null };
  it('charges a $100 class fee once to the designated employer, retaining all customer attendee lists', async () => {
    vi.mocked(getProductForCourse).mockResolvedValueOnce(classPrice);
    ticket.trainingRosterRecords.forEach((r: any) => { r.courseName = 'Safety Meeting'; r.passed = false; });
    await generate('employer-b');
    expect(saved.map(i => [i.companyId, i.subtotal])).toEqual([['employer-a', 0], ['employer-b', 100]]);
    expect(saved[1].lineItems[0]).toMatchObject({ quantity: 1, rate: 100, amount: 100, unitOfMeasure: 'CLASS' });
    expect(saved[0].lineItems[0]).toMatchObject({ description: 'Attendees (2): SYNTHETIC A, SYNTHETIC C', amount: 0 });
    expect(saved[1].lineItems[1]).toMatchObject({ description: 'Attendees (1): SYNTHETIC B', amount: 0 });
  });
  it('supports a designated booking customer with no students without duplicating the fee on retries', async () => {
    vi.mocked(getProductForCourse).mockResolvedValueOnce(classPrice);
    await generate('house'); await generate('house');
    expect(saved).toHaveLength(3);
    expect(saved.map(i => i.subtotal)).toEqual([0, 0, 100]);
    expect(saved[2].companyId).toBe('house');
  });
  it.each([undefined, 'unrelated-customer'])('requires an eligible designated payer before creating any class-fee drafts (%s)', async payer => {
    vi.mocked(getProductForCourse).mockResolvedValueOnce(classPrice);
    await expect(generate(payer)).rejects.toThrow(/customer paying/);
    expect(saved).toHaveLength(0);
    expect(ticket.status).toBe('billing_queue');
  });
  it('leaves the class ready and creates no employer drafts when course pricing is missing', async () => {
    vi.mocked(getProductForCourse).mockRejectedValueOnce(new Error('No price is configured for course Safety Meeting'));
    await expect(generate()).rejects.toThrow(/No price is configured/);
    expect(saved).toHaveLength(0);
    expect(prisma.invoice.create).not.toHaveBeenCalled();
    expect(ticket.status).toBe('billing_queue');
  });
  it('allows an explicitly configured free course and retains the per-employer attendee lines', async () => {
    vi.mocked(getProductForCourse).mockResolvedValueOnce({ productId: 'course', partNumber: '11011', name: 'Free class', price: 0, qbItemFullName: null, qbItemListId: null });
    await generate();
    expect(saved).toHaveLength(2);
    expect(saved.every(i => i.subtotal === 0 && i.status === 'draft')).toBe(true);
    expect(saved[0].lineItems).toEqual([expect.objectContaining({ description: 'Attendees (2): SYNTHETIC A, SYNTHETIC C', amount: 0 })]);
  });
  it('creates one customer batch under concurrent requests and acknowledges the retry', async () => {
    const results = await Promise.all([generate(), generate()]);
    expect(saved).toHaveLength(2);
    expect(results[0].invoices.map((i: any) => i.id)).toEqual(results[1].invoices.map((i: any) => i.id));
    expect(ticket.status).toBe('invoiced');
    expect(saved.every(i => i.status === 'draft')).toBe(true);
  });
  it('rolls back all employer invoices if a later employer fails', async () => {
    prisma.invoice.create.mockImplementation(async ({ data }) => {
      if (data.companyId === 'employer-b') throw new Error('synthetic write failure');
      const row = { ...data, id: 'first', lineItems: data.lineItems.create }; saved.push(row); return row;
    });
    await expect(generate()).rejects.toThrow('synthetic write failure');
    expect(saved).toHaveLength(0);
    expect(ticket.status).toBe('billing_queue');
  });
  it('always splits by employer, charges passed students and lists every name on a free line', async () => {
    await generate();
    expect(saved.map(i => i.companyId)).toEqual(['employer-a', 'employer-b']);
    expect(saved[0]).toMatchObject({ subtotal: 125, createdById: 'actor' });
    expect(saved[0].lineItems).toEqual([
      expect.objectContaining({ quantity: 1, rate: 125, amount: 125 }),
      expect.objectContaining({ description: 'Attendees (2): SYNTHETIC A, SYNTHETIC C', rate: 0, amount: 0 }),
    ]);
  });
  it('refuses a legacy partial batch instead of billing it twice', async () => {
    saved.push({ id: 'legacy', status: 'draft' });
    await expect(generate()).rejects.toThrow(/existing.*invoice|already.*invoice/i);
    expect(prisma.invoice.create).not.toHaveBeenCalled();
  });
  it('rejects non-training tickets', async () => {
    ticket.ticketType = 'field_service';
    await expect(generate()).rejects.toThrow(/training/i);
    expect(prisma.invoice.create).not.toHaveBeenCalled();
  });
});
