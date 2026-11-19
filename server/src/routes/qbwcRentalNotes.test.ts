import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({
  invoice: { findUnique: vi.fn() }, rentalAgreement: { findUnique: vi.fn() },
  serviceTicket: { findMany: vi.fn() },
}));
vi.mock('../db.js', () => ({ prisma: db }));
let build: typeof import('./qbwc.js').buildQbDocDataFromInvoice;
beforeAll(async () => {
  vi.useFakeTimers();
  build = (await import('./qbwc.js')).buildQbDocDataFromInvoice;
});
afterAll(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('rental QB export wiring', () => {
  it('adds rental documentation while preserving charges and excluding qbSkip lines', async () => {
    const invoice = {
      id: 'invoice', invoiceNumber: 'INV-2026-00111', status: 'approved',
      rentalAgreementId: 'rental', shopWorkOrderId: null, division: 'D4', isDickinson: true,
      invoiceDate: new Date('2026-10-13'), periodStart: new Date('2026-10-01'), periodEnd: new Date('2026-10-06'),
      company: { name: 'Chord Energy LLC' }, companyName: 'Chord Energy LLC',
      lineItems: [
        { description: 'Air Trailer - Base Rental (Daily)', quantity: 6, rate: 500, amount: 3000, isTaxable: true, qbItemFullName: '0411003' },
        { description: 'Excluded surcharge', quantity: 1, rate: 50, amount: 50, qbSkip: true },
      ],
    };
    db.invoice.findUnique.mockResolvedValue(invoice);
    db.serviceTicket.findMany.mockResolvedValue([]);
    db.rentalAgreement.findUnique.mockResolvedValue({
      agreementNumber: 'RA-2026-0038', siteContactName: 'Braiden Bruce', pad: { name: 'G Levang 13-32-29H' },
      linkedServiceTickets: [],
      items: [{ deployedDate: new Date('2026-09-29'), returnedDate: new Date('2026-10-06'),
        product: { name: 'Air trailer' }, serializedEquipment: { serialNumber: 'ATR-10' } }],
    });
    const data = await build('invoice');
    expect(data.noteLines).toEqual(['Rental dates: 10/01/2026 to 10/06/2026']);
    expect(data.lines[0].noteLines).toEqual(['Air trailer #ATR-10']);
    expect(data.lines).toEqual([expect.objectContaining({ quantity: 6, rate: '500', amount: '3000', isTaxable: true })]);
    expect(data.memo).toBe('RA-2026-0038');
    expect(data.txnDate).toEqual(invoice.periodEnd);

    db.invoice.findUnique.mockResolvedValue({ ...invoice, lineItems: [
      ...invoice.lineItems,
      { partNumber: '0400002', description: 'FS-1 — Deploy labor', sourceTicketId: 't1', sourceTicketNumber: 'FS-1', quantity: 1.5, rate: 80, amount: 120, isTaxable: false },
      { partNumber: '0400002', description: 'FS-2 — Return labor', sourceTicketId: 't2', sourceTicketNumber: 'FS-2', quantity: 2, rate: 80, amount: 160, isTaxable: false },
      { partNumber: '0400001', description: 'FS-1 — Mileage', sourceTicketId: 't1', sourceTicketNumber: 'FS-1', quantity: 20, rate: 3, amount: 60, isTaxable: false },
      { partNumber: '0400001', description: 'FS-2 — Mileage', sourceTicketId: 't2', sourceTicketNumber: 'FS-2', quantity: 30, rate: 3, amount: 90, isTaxable: false },
    ] });
    const swept = await build('invoice');
    expect(swept.lines).toHaveLength(3);
    expect(swept.lines[1]).toMatchObject({ description: 'Labor', quantity: 3.5, amount: '280', useAmount: true });
    expect(swept.lines[2]).toMatchObject({ description: 'Mileage', quantity: 50, amount: '150', useAmount: true });
    expect(JSON.stringify(swept)).not.toContain('FS-');

    // Ordinary invoices retain their existing export shape.
    db.invoice.findUnique.mockResolvedValue({ ...invoice, rentalAgreementId: null });
    const ordinary = await build('invoice');
    expect(ordinary.noteLines).toBeUndefined();
    expect(ordinary.lines).toHaveLength(1);
  });
});
