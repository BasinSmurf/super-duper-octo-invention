import { beforeEach, describe, expect, it, vi } from 'vitest';
const prisma = vi.hoisted(() => {
  const p: any = {
    invoice: { findUnique: vi.fn(), update: vi.fn(), findMany: vi.fn() },
    serviceTicket: { findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    user: { findUnique: vi.fn() },
    $queryRaw: vi.fn(),
  };
  p.$transaction = vi.fn(async (fn: any) => fn(p));
  return p;
});
vi.mock('../db.js', async importOriginal => ({ ...await importOriginal<typeof import('../db.js')>(), ...(() => ({ prisma }))() }));
vi.mock('../utils/auditLog.js', () => ({ createAuditLog: vi.fn() }));
vi.mock('../services/ticketReviewRules.js', () => ({ runAndCacheReviewSignal: vi.fn() }));
vi.mock('../services/eventBus.js', () => ({ emitEvent: vi.fn() }));
import { invoicesRouter } from './invoices.js';
import { runAndCacheReviewSignal } from '../services/ticketReviewRules.js';

let invoice: any;
let tickets: any[];
let otherLiveInvoices: any[];
async function reject(body: any, role = 'billing_ar') {
  const route = invoicesRouter.stack.find(l => l.route?.path === '/:id/reject')!.route;
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
  await route.stack.at(-1).handle({ params: { id: 'invoice' }, body, user: { userId: 'actor', role } }, res);
  return res;
}
beforeEach(() => {
  vi.clearAllMocks();
  invoice = { id: 'invoice', invoiceNumber: 'INV-SYNTHETIC', status: 'draft', internalNotes: null,
    lineItems: [{ sourceTicketId: 't1' }, { sourceTicketId: 't2' }] };
  tickets = [
    { id: 't1', ticketNumber: 'T-1', status: 'invoiced', customData: { keep: 'me' } },
    { id: 't2', ticketNumber: 'T-2', status: 'invoiced', customData: null },
  ];
  otherLiveInvoices = [];
  prisma.invoice.findUnique.mockImplementation(async () => invoice);
  prisma.invoice.update.mockImplementation(async ({ data }: any) => Object.assign(invoice, data));
  prisma.invoice.findMany.mockImplementation(async () => otherLiveInvoices);
  prisma.serviceTicket.findMany.mockImplementation(async () => tickets);
  prisma.serviceTicket.update.mockImplementation(async ({ where, data }: any) =>
    Object.assign(tickets.find(t => t.id === where.id), data));
  prisma.user.findUnique.mockResolvedValue({ name: 'SYNTHETIC BILLER' });
});

describe('rejecting a draft invoice', () => {
  it('voids the draft and kicks its tickets back to Approvals with the note', async () => {
    const res = await reject({ reason: ' wrong PO ' });
    expect(invoice.status).toBe('void');
    expect(invoice.internalNotes).toContain('wrong PO');
    for (const t of tickets) {
      expect(t.status).toBe('supervisor_review');
      expect(t.customData.returnedForReview).toMatchObject({ note: 'wrong PO', byName: 'SYNTHETIC BILLER' });
    }
    expect(tickets[0].customData.keep).toBe('me');
    expect(runAndCacheReviewSignal).toHaveBeenCalledTimes(2);
    expect(res.json.mock.calls[0][0]).toMatchObject({ kickedBackTickets: ['T-1', 'T-2'], warnings: [] });
  });

  it('leaves a ticket that another live invoice still bills, and says so', async () => {
    otherLiveInvoices = [{ lineItems: [{ sourceTicketId: 't2' }] }];
    const res = await reject({ reason: 'wrong PO' });
    expect(tickets[0].status).toBe('supervisor_review');
    expect(tickets[1].status).toBe('invoiced');
    expect(res.json.mock.calls[0][0].warnings[0]).toContain('T-2');
  });

  it('requires a note, the void capability, and source tickets — before writing', async () => {
    await expect(reject({ reason: '  ' })).rejects.toThrow('note for the reviewer');
    await expect(reject({ reason: 'x' }, 'field_tech')).rejects.toThrow('cannot void');
    invoice.lineItems = [{ sourceTicketId: null }];
    await expect(reject({ reason: 'x' })).rejects.toThrow('Void it instead');
    expect(prisma.invoice.update).not.toHaveBeenCalled();
    expect(prisma.serviceTicket.update).not.toHaveBeenCalled();
  });

  it('un-approves an approved invoice back to draft without releasing its tickets', async () => {
    invoice.status = 'approved';
    await reject({ reason: '' });
    expect(invoice.status).toBe('draft');
    expect(prisma.serviceTicket.update).not.toHaveBeenCalled();
    expect(prisma.serviceTicket.updateMany).not.toHaveBeenCalled();
    expect(tickets.map(t => t.status)).toEqual(['invoiced', 'invoiced']);
  });
});

describe('kicking one ticket back from a draft', () => {
  let lines: any[];
  async function kickBack(body: any) {
    const route = invoicesRouter.stack.find(l => l.route?.path === '/:id/kick-back-ticket')!.route;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await route.stack.at(-1).handle({ params: { id: 'invoice' }, body, user: { userId: 'actor', role: 'billing_ar' } }, res);
    return res.json.mock.calls[0][0];
  }
  beforeEach(() => {
    Object.assign(invoice, { sourceType: 'billing_group', taxRate: 0.05 });
    tickets.push({ id: 't3', ticketNumber: 'T-3', status: 'invoiced', customData: null });
    lines = [
      { id: 'l1', sourceTicketId: 't1', amount: 100, isTaxable: true },
      { id: 'l2', sourceTicketId: 't2', amount: 40, isTaxable: false },
      { id: 'l3', sourceTicketId: 't2', amount: 60, isTaxable: true },
      { id: 'l4', sourceTicketId: 't3', amount: 200, isTaxable: true },
    ];
    prisma.invoiceLineItem = {
      findMany: vi.fn(async () => lines),
      findFirst: vi.fn(async () => null),
      deleteMany: vi.fn(async ({ where }: any) => { lines = lines.filter(l => l.sourceTicketId !== where.sourceTicketId); }),
      update: vi.fn(async ({ where, data }: any) => Object.assign(lines.find(l => l.id === where.id), data)),
    };
    prisma.serviceTicket.findUnique = vi.fn(async ({ where }: any) => tickets.find(t => t.id === where.id));
  });

  it('removes that ticket\'s lines, recalculates totals and leaves the other tickets on the draft', async () => {
    const result = await kickBack({ ticketId: 't2', reason: 'hours look wrong' });
    expect(result).toMatchObject({ voided: false, kickedBackTickets: ['T-2'] });
    expect(invoice.status).toBe('draft');
    expect(lines.map(l => [l.id, l.lineNumber])).toEqual([['l1', 1], ['l4', 2]]);
    expect(invoice).toMatchObject({ subtotal: 300, taxAmount: 15, total: 315 });
    expect(tickets.map(t => t.status)).toEqual(['invoiced', 'supervisor_review', 'invoiced']);
    expect(tickets[1].customData.returnedForReview.note).toBe('hours look wrong');
  });

  it('voids the draft when the last ticket is kicked back, keeping its lines', async () => {
    lines = [lines[0]];
    const result = await kickBack({ ticketId: 't1', reason: 'wrong well' });
    expect(result.voided).toBe(true);
    expect(invoice.status).toBe('void');
    expect(prisma.invoiceLineItem.deleteMany).not.toHaveBeenCalled();
    expect(tickets[0].status).toBe('supervisor_review');
  });

  it('refuses a draft with no source tickets, a ticket not on it, a missing note, and a non-draft', async () => {
    await expect(kickBack({ ticketId: 't1', reason: ' ' })).rejects.toThrow('note for the reviewer');
    await expect(kickBack({ ticketId: 'elsewhere', reason: 'x' })).rejects.toThrow('not on this draft');
    lines = [{ id: 'wo', sourceTicketId: null, amount: 50, isTaxable: false }];
    await expect(kickBack({ ticketId: 't1', reason: 'x' })).rejects.toThrow('not built from tickets');
    invoice.status = 'approved';
    await expect(kickBack({ ticketId: 't1', reason: 'x' })).rejects.toThrow('draft invoice');
    expect(prisma.serviceTicket.update).not.toHaveBeenCalled();
    expect(prisma.invoice.update).not.toHaveBeenCalled();
  });

  it('refuses a ticket that another live invoice also holds, naming that invoice', async () => {
    prisma.invoiceLineItem.findFirst.mockResolvedValue({ sourceTicketNumber: 'T-1', invoice: { invoiceNumber: 'INV-OTHER', status: 'approved' } });
    await expect(kickBack({ ticketId: 't1', reason: 'x' })).rejects.toThrow('INV-OTHER');
    expect(tickets[0].status).toBe('invoiced');
  });
});

describe('one live invoice per ticket when editing draft lines', () => {
  it('refuses a newly attached ticket that another live invoice holds, before deleting anything', async () => {
    invoice.lineItems = [{ id: 'old', sourceTicketId: 't1' }];
    prisma.invoiceLineItem = {
      findFirst: vi.fn(async ({ where }: any) => where.sourceTicketId.in.includes('t9')
        ? { sourceTicketNumber: 'T-9', invoice: { invoiceNumber: 'INV-OTHER', status: 'draft' } } : null),
      deleteMany: vi.fn(), create: vi.fn(async ({ data }: any) => data),
    };
    prisma.product = { findMany: vi.fn(async () => []) };
    const route = invoicesRouter.stack.find(l => l.route?.path === '/:id/line-items')!.route;
    const save = (lineItems: any[]) => route.stack.at(-1).handle(
      { params: { id: 'invoice' }, body: { lineItems }, user: { userId: 'actor', role: 'billing_ar' } },
      { status: vi.fn().mockReturnThis(), json: vi.fn() });
    await expect(save([{ sourceTicketId: 't1', amount: 1 }, { sourceTicketId: 't9', amount: 1 }])).rejects.toThrow('INV-OTHER');
    expect(prisma.invoiceLineItem.deleteMany).not.toHaveBeenCalled();
    // Tickets the draft already carries are not re-checked.
    await save([{ sourceTicketId: 't1', amount: 1 }]);
    expect(prisma.invoiceLineItem.deleteMany).toHaveBeenCalled();
  });
});
