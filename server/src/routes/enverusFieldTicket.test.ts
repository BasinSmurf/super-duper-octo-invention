vi.mock('../services/enverusQueueReconciliation.js', () => ({ reconcileEnverusFailures: vi.fn(async () => 0) }));
import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = vi.hoisted(() => ({
  invoice: { findUnique: vi.fn(), update: vi.fn() },
  customerBillingProfile: { findMany: vi.fn() },
  enverusSyncQueue: { findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
}));
vi.mock('../db.js', async importOriginal => ({ ...await importOriginal<typeof import('../db.js')>(), ...(() => ({ prisma }))() }));
vi.mock('../utils/auditLog.js', () => ({ createAuditLog: vi.fn() }));
vi.mock('../middleware/rbac.js', () => ({ requirePermission: () => (_req: unknown, _res: unknown, next: () => void) => next() }));
const pollById = vi.hoisted(() => vi.fn());
const submitReceipt = vi.hoisted(() => vi.fn());
vi.mock('../services/enverusClient.js', () => ({ getSupplierDuns: () => '016937650', pollReceiptById: pollById, submitReceiptWithAttachment: submitReceipt }));
vi.mock('../utils/ticketPdfBuffer.js', () => ({ getInvoicePdfBuffer: async () => ({ buffer: Buffer.from('PDF'), fileName: 'invoice.pdf' }) }));
import { enverusRouter } from './enverus.js';

const profile = { id: 'bp1', enverusEnabled: true, enverusReceiptMode: 'openticket', buyerDuns: '001368265', defaultPriceBookNumber: '422493' };
const product = { partNumber: '0311001', enverusProductServiceCode: null };
const line = { lineNumber: 1, description: 'Breathing Air System Inspection — Primary',
  quantity: 1, rate: 185, amount: 185, partNumber: '0311001', product };
let invoice: any;

beforeEach(() => {
  vi.clearAllMocks();
  invoice = { id: 'i1', companyId: 'co1', billingProfileId: 'bp1', invoiceNumber: 'INV-2026-01379', status: 'approved',
    invoiceDate: new Date('2026-10-20'), companyName: 'ConocoPhillips', total: 185,
    lineItems: [{ ...line, product: { ...product } }], company: { billingProfiles: [profile] } };
  prisma.customerBillingProfile.findMany.mockResolvedValue([profile]);
  prisma.invoice.findUnique.mockImplementation(async () => invoice);
  prisma.enverusSyncQueue.findFirst.mockResolvedValue(null);
  prisma.enverusSyncQueue.create.mockResolvedValue({ id: 'q1' });
});

async function submit(body: Record<string, unknown> = {}) {
  const route = enverusRouter.stack.find(layer => layer.route?.path === '/field-tickets/submit/:invoiceId')!.route;
  const next = vi.fn();
  await route.stack[0].handle({ params: { invoiceId: 'i1' }, body, query: {} }, { json: vi.fn() }, next);
  expect(next).not.toHaveBeenCalled();
  return JSON.parse(prisma.enverusSyncQueue.create.mock.calls[0][0].data.requestPayload).events[0].data.transform.receipt;
}

describe('OpenTicket submission identifiers', () => {
  it('returns live compliance notices from the receipt wrapper, using the saved receipt ID', async () => {
    invoice.enverusReceiptId = '359238';
    const receipt = { itemID: '359238', status: 'SUBMITTED', complianceSummary: {
      priceBook: { yellow: { message: 'Item is not covered by the price book.' } },
    } };
    pollById.mockResolvedValue({ body: { receipt } });
    prisma.enverusSyncQueue.findMany.mockResolvedValue([]);
    const route = enverusRouter.stack.find(layer => layer.route?.path === '/field-tickets/status/:invoiceId')!.route;
    const json = vi.fn();
    const next = vi.fn();
    await route.stack[0].handle({ params: { invoiceId: 'i1' } }, { json }, next);
    expect(next).not.toHaveBeenCalled();
    expect(pollById).toHaveBeenCalledWith('359238');
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ enverusLiveData: receipt }));
  });
  it('returns an error instead of reporting a failed immediate submission as submitted or queued', async () => {
    submitReceipt.mockRejectedValueOnce(new Error('Buyer could not resolve the service'));
    const route = enverusRouter.stack.find(layer => layer.route?.path === '/field-tickets/submit/:invoiceId')!.route;
    const next = vi.fn();
    const json = vi.fn();
    await route.stack[0].handle({ params: { invoiceId: 'i1' }, body: {}, query: { immediate: 'true' } }, { json }, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 502, message: expect.stringContaining('submission failed') }));
    expect(json).not.toHaveBeenCalled();
    expect(prisma.invoice.update).toHaveBeenCalledWith({ where: { id: 'i1' }, data: { enverusStatus: 'error', enverusSubmittedAt: null } });
  });
  it('sends the selected price book in contract.number and the actual API productServiceCode field', async () => {
    const receipt = await submit({ priceBookNumber: '422493-2' });
    expect(receipt.contract).toEqual({ number: '422493-2' });
    expect(receipt).not.toHaveProperty('poNumber');
    expect(receipt).not.toHaveProperty('priceBookNumber');
    expect(receipt.lineItems[0]).toMatchObject({ productServiceCode: '0311001', description: line.description });
    expect(receipt.lineItems[0]).not.toHaveProperty('serviceCode');
    expect(receipt.lineItems[0]).not.toHaveProperty('partNumber');
  });
  it('keeps a real PO independent and prioritizes the selected book over the old contract input', async () => {
    invoice.poNumber = 'PO-123';
    const receipt = await submit({ priceBookNumber: '422493-2', contractNumber: 'CONTRACT-1' });
    expect(receipt).toMatchObject({ poNumber: 'PO-123', contract: { number: '422493-2' } });
  });
  it('uses the profile price book by default without copying it into a PO', async () => {
    const receipt = await submit();
    expect(receipt.contract).toEqual({ number: '422493' });
    expect(receipt).not.toHaveProperty('poNumber');
    expect(receipt).not.toHaveProperty('priceBookNumber');
  });
  it('prefers an explicit Enverus mapping to the local part number', async () => {
    invoice.lineItems[0].product.enverusProductServiceCode = 'ENV-0311001';
    expect((await submit()).lineItems[0]).toMatchObject({ productServiceCode: 'ENV-0311001' });
  });
  it('uses the product part number when the saved invoice line has only a QB display name', async () => {
    invoice.lineItems[0].partNumber = null;
    invoice.lineItems[0].qbItemFullName = line.description;
    expect((await submit()).lineItems[0].productServiceCode).toBe('0311001');
  });
  it('preserves the additional air system without substituting a different service', async () => {
    invoice.lineItems.push({ ...line, lineNumber: 2, description: 'Breathing Air System Inspection — Additional (each)',
      partNumber: '0311004', product: { partNumber: '0311004' }, rate: 20, amount: 20 });
    expect((await submit()).lineItems[1]).toMatchObject({ productServiceCode: '0311004', quantity: 1, rate: 20 });
  });
  it('rebuilds an old failed entry when Retry is pressed', async () => {
    prisma.enverusSyncQueue.findUnique.mockResolvedValue({ id: 'q1', entityId: 'i1', entityType: 'field_ticket',
      action: 'submit', status: 'error', endpointUrl: '/events/supply-chain/v1/receipt.submit',
      requestPayload: JSON.stringify({ events: [{ data: { transform: { receipt: {
        priceBookNumber: '422493', poNumber: '422493-2', contract: { number: '422493-2' },
      } } } }] }),
    });
    const route = enverusRouter.stack.find(layer => layer.route?.path === '/queue/:id/retry')!.route;
    const next = vi.fn();
    await route.stack[0].handle({ params: { id: 'q1' } }, { json: vi.fn() }, next);
    expect(next).not.toHaveBeenCalled();
    const data = prisma.enverusSyncQueue.update.mock.calls[0][0].data;
    const receipt = JSON.parse(data.requestPayload).events[0].data.transform.receipt;
    expect(data.status).toBe('pending');
    expect(receipt.contract).toEqual({ number: '422493-2' });
    expect(receipt).not.toHaveProperty('poNumber');
    expect(receipt.lineItems[0].productServiceCode).toBe('0311001');
  });
  it('does not requeue stale data when rebuilding Retry fails', async () => {
    prisma.enverusSyncQueue.findUnique.mockResolvedValue({ id: 'q1', entityId: 'gone', entityType: 'field_ticket', action: 'submit', status: 'error', requestPayload: '{}' });
    prisma.invoice.findUnique.mockResolvedValue(null);
    const route = enverusRouter.stack.find(layer => layer.route?.path === '/queue/:id/retry')!.route;
    const next = vi.fn();
    await route.stack[0].handle({ params: { id: 'q1' } }, { json: vi.fn() }, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('invoice no longer exists') }));
    expect(prisma.enverusSyncQueue.update).not.toHaveBeenCalled();
  });
});
