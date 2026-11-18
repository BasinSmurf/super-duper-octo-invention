import { beforeEach, describe, expect, it, vi } from 'vitest';

const tx = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  rentalAgreement: { findUnique: vi.fn(), update: vi.fn() },
  rentalAgreementItem: { findUnique: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() },
  invoice: { findFirst: vi.fn() },
  serializedEquipment: { findUnique: vi.fn(), updateMany: vi.fn() },
  serviceTicket: { findUnique: vi.fn(), create: vi.fn() },
  auditLog: { create: vi.fn() },
  rentalDailyLog: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
}));
const prisma = vi.hoisted(() => ({ $transaction: vi.fn(), product: { findUnique: vi.fn() } }));
vi.mock('../db.js', async importOriginal => ({ ...await importOriginal<typeof import('../db.js')>(), ...(() => ({ prisma }))() }));
vi.mock('../utils/ticketNumber.js', () => ({ generateTicketNumber: vi.fn(async () => 'FS-2026-00001') }));
vi.mock('../services/ticketReviewRules.js', () => ({ runAndCacheReviewSignal: vi.fn() }));
import { rentalsRouter } from './rentals.js';
import { runAndCacheReviewSignal } from '../services/ticketReviewRules.js';

const route = rentalsRouter.stack.find(entry => entry.route?.path === '/:id/swap')!.route;
const requestId = '6f415682-66fb-4cbb-9f9a-f91c12fc8a82';
const body = { requestId, reason: 'Failed monitor', swaps: [{ itemId: 'i1', replacementEquipmentId: 'new', returnStatus: 'repair' }] };
async function swap(payload: unknown = body) {
  const json = vi.fn();
  const next = vi.fn();
  await route.stack[1].handle({ params: { id: 'r1' }, body: payload, user: { userId: 'u1' } }, { status: () => ({ json }) }, next);
  return { json, next };
}
beforeEach(() => {
  vi.resetAllMocks();
  // resetAllMocks also resets the ticket-number mock implementation.
  prisma.$transaction.mockImplementation(async callback => callback(tx));
  prisma.product.findUnique.mockResolvedValue({ id: 'labor', isActive: true });
  tx.rentalAgreement.findUnique.mockResolvedValue({ id: 'r1', status: 'active', companyId: 'c1' });
  tx.rentalAgreementItem.findUnique.mockResolvedValue({ id: 'i1', status: 'deployed', rentalAgreementId: 'r1',
    productId: 'p1', deployedDate: new Date('2026-08-01'), serializedEquipmentId: 'old', product: { name: 'Monitor' }, serializedEquipment: { serialNumber: 'OLD-123' } });
  tx.serializedEquipment.findUnique.mockResolvedValue({ id: 'new', productId: 'p1', serialNumber: 'NEW-456' });
  tx.serializedEquipment.updateMany.mockResolvedValue({ count: 1 });
  tx.rentalAgreementItem.updateMany.mockResolvedValue({ count: 1 });
  tx.serviceTicket.findUnique.mockResolvedValue(null);
  tx.serviceTicket.create.mockImplementation(async ({ data }) => data);
});

const manualRoute = rentalsRouter.stack.find(entry => entry.route?.path === '/:id/equipment-visit')!.route;
const gear = { id: 'manual1', serial: 'OLD', type: 'Trailer', testDate: 'see tag', deployedAt: '2026-08-01T00:00:00Z' };
const inspection = { overallCondition: 'good', physicalDamage: false, cleanlinessOk: true, calibrationCurrent: true, accessoriesReturned: true, notes: 'Batch checked', damagePhotos: [] };
const manualBody = { requestId, workType: 'rental_return', serviceDate: '2026-08-02', selections: [{ itemId: gear.id, expected: gear }, { itemId: 'manual2' }], inspection };
async function manualVisit(payload: unknown = manualBody) {
  const json = vi.fn(), next = vi.fn();
  await manualRoute.stack[1].handle({ params: { id: 'r1' }, body: payload, user: { userId: 'u1' } }, { status: () => ({ json }) }, next);
  return { json, next };
}
describe('rental text equipment visits', () => {
  beforeEach(() => {
    tx.rentalAgreement.findUnique.mockResolvedValue({ id: 'r1', status: 'active', companyId: 'c1', startDate: new Date('2026-08-01'),
      composition: { trailer: { rate: 300 }, manualEquipment: [gear, { ...gear, id: 'manual2' }] } });
    tx.invoice.findFirst.mockResolvedValue(null);
    tx.rentalAgreementItem.findFirst.mockResolvedValue(null);
  });
  it('saves one inspection for the whole batch and completes a fully returned agreement', async () => {
    const result = await manualVisit();
    expect(result.next).not.toHaveBeenCalled();
    const ticket = tx.serviceTicket.create.mock.calls[0][0].data;
    expect(ticket.customData.inspection.itemIds).toEqual(['manual1', 'manual2']);
    expect(ticket.customData.inspection.data).toEqual(inspection);
    const change = tx.rentalAgreement.update.mock.calls[0][0].data;
    expect(change.status).toBe('completed');
    expect(change.endDate).toEqual(new Date('2026-08-02'));
    expect(change.composition.manualEquipment.map((row: any) => row.returnInspectionId)).toEqual([requestId, requestId]);
    expect(tx.serializedEquipment.updateMany).not.toHaveBeenCalled();
    expect(tx.rentalAgreementItem.updateMany).not.toHaveBeenCalled();
  });
  it('keeps partial returns active', async () => {
    expect((await manualVisit({ ...manualBody, selections: [manualBody.selections[0]] })).next).not.toHaveBeenCalled();
    expect(tx.rentalAgreement.update.mock.calls[0][0].data.status).toBeUndefined();
  });
  it('swaps arbitrary text without inventory access, preserving pricing and start date', async () => {
    const result = await manualVisit({ ...manualBody, workType: 'rental_swap', selections: [{ itemId: gear.id, expected: gear,
      replacement: { serial: 'NEW', type: 'Custom trailer', testDate: '08/2026 — tag' } }] });
    expect(result.next).not.toHaveBeenCalled();
    const change = tx.rentalAgreement.update.mock.calls[0][0].data;
    expect(change.composition.trailer.rate).toBe(300);
    expect(change.composition.manualEquipment[0]).toMatchObject({ serial: 'NEW', deployedAt: gear.deployedAt });
    expect(change.startDate).toBeUndefined();
    expect(tx.serializedEquipment.findUnique).not.toHaveBeenCalled();
    expect(tx.serviceTicket.create.mock.calls[0][0].data.customData.equipmentChanges[0].before.serial).toBe('OLD');
  });
  it('reuses a committed ticket on retry without applying the batch twice', async () => {
    tx.serviceTicket.findUnique.mockResolvedValue({ id: requestId, linkedRentalAgreementId: 'r1', createdById: 'u1', customData: { workType: 'rental_return' } });
    expect((await manualVisit()).next).not.toHaveBeenCalled();
    expect(tx.rentalAgreement.update).not.toHaveBeenCalled();
    expect(tx.serviceTicket.create).not.toHaveBeenCalled();
  });
  it('rejects a return that would change already billed history before writing', async () => {
    tx.invoice.findFirst.mockResolvedValue({ invoiceNumber: 'INV-1' });
    expect((await manualVisit()).next.mock.calls[0][0].message).toContain('INV-1');
    expect(tx.rentalAgreement.update).not.toHaveBeenCalled();
  });
  it('routes labor and mileage through ticket review', async () => {
    const result = await manualVisit({ ...manualBody, lineItems: [{ lineType: 'labor', description: 'Return', quantity: 2, rate: 90, unitOfMeasure: 'HR' }] });
    expect(result.next).not.toHaveBeenCalled();
    expect(tx.serviceTicket.create.mock.calls[0][0].data.total.toNumber()).toBe(180);
    expect(tx.serviceTicket.create.mock.calls[0][0].data.status).toBe('supervisor_review');
  });
});

describe('D4 rental equipment swap', () => {
  it.each([undefined, '', '   '])('accepts an optional or blank reason (%s)', async reason => {
    const result = await swap({ ...body, reason });
    expect(result.next).not.toHaveBeenCalled();
    expect(tx.serviceTicket.create.mock.calls[0][0].data.workDescription).toBe('Equipment swap\nMonitor: OLD-123 → NEW-456 (returned repair)');
  });
  it('saves hours and mileage with server-calculated totals and routes charges to review', async () => {
    const result = await swap({ ...body, reason: '', lineItems: [
      { lineType: 'labor', productId: 'labor', partNumber: '0400002', quantity: 1.5, rate: 85, total: 9999,
        priceLevelName: 'Customer contract', listRate: 100, contractRate: 85 },
      { lineType: 'travel', productId: 'mileage', partNumber: '0400001', quantity: 20, rate: 3, total: 9999 },
    ] });
    expect(result.next).not.toHaveBeenCalled();
    const saved = tx.serviceTicket.create.mock.calls[0][0].data;
    expect(saved.status).toBe('supervisor_review');
    expect(saved.customData.recordOnly).toBe(false);
    expect(Number(saved.subtotal)).toBe(187.5);
    expect(Number(saved.total)).toBe(187.5);
    expect(saved.lineItems.create).toHaveLength(2);
    expect(Number(saved.lineItems.create[0].total)).toBe(127.5);
    expect(saved.lineItems.create[0].notes).toContain('OLD-123 → NEW-456');
    expect(saved.lineItems.create[0].customData.priceLevel).toEqual({ name: 'Customer contract', listRate: 100, contractRate: 85 });
    expect(saved.lineItems.create[1]).toMatchObject({ lineType: 'travel', quantity: 20, rate: 3, lineNumber: 2, sortOrder: 1 });
    expect(runAndCacheReviewSignal).toHaveBeenCalledWith(requestId);
  });
  it('keeps explicitly free swaps as record-only tickets', async () => {
    await swap({ ...body, reason: null, lineItems: [{ lineType: 'labor', quantity: 1, rate: 0 }] });
    const saved = tx.serviceTicket.create.mock.calls[0][0].data;
    expect(saved.status).toBe('closed');
    expect(saved.customData.recordOnly).toBe(true);
    expect(Number(saved.total)).toBe(0);
    expect(saved.lineItems.create).toHaveLength(1);
    expect(runAndCacheReviewSignal).not.toHaveBeenCalled();
  });
  it.each([
    { lineType: 'labor', quantity: 1, rate: null },
    { lineType: 'labor', quantity: 1, rate: -1 },
    { lineType: 'labor', quantity: -1, rate: 85 },
    { lineType: 'labor', quantity: 1.234, rate: 85 },
    { lineType: 'invalid', quantity: 1, rate: 85 },
  ])('rejects invalid charges before changing inventory: %o', async line => {
    expect((await swap({ ...body, lineItems: [line] })).next.mock.calls[0][0].statusCode).toBe(400);
    expect(tx.serializedEquipment.updateMany).not.toHaveBeenCalled();
    expect(tx.serviceTicket.create).not.toHaveBeenCalled();
  });
  it('uses the edited historical date for service and keeps completion at recording time', async () => {
    const result = await swap({ ...body, serviceDate: '2026-08-15' });
    expect(result.next).not.toHaveBeenCalled();
    const data = tx.serviceTicket.create.mock.calls[0][0].data;
    expect(data.serviceDate).toEqual(new Date('2026-08-15'));
    expect(data.completedAt.getTime()).toBeGreaterThan(data.serviceDate.getTime());
    expect(tx.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ changes: expect.objectContaining({ serviceDate: '2026-08-15' }) }) });
  });
  it.each(['', null, 'not-a-date', '2026-02-30', '2999-01-01'])('rejects invalid or future swap date %s before mutation', async serviceDate => {
    expect((await swap({ ...body, serviceDate })).next.mock.calls[0][0].statusCode).toBe(400);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it('rejects a swap before deployment without claiming the replacement', async () => {
    expect((await swap({ ...body, serviceDate: '2026-07-31' })).next.mock.calls[0][0].statusCode).toBe(400);
    expect(tx.serializedEquipment.updateMany).not.toHaveBeenCalled();
  });
  it('defaults older clients to the current business date', async () => {
    const result = await swap();
    expect(result.next).not.toHaveBeenCalled();
    expect(tx.serviceTicket.create.mock.calls[0][0].data.serviceDate).toBeInstanceOf(Date);
  });
  it('swaps serials without changing the rental item rate, dates, product, or status', async () => {
    const result = await swap();
    expect(result.next).not.toHaveBeenCalled();
    expect(tx.rentalAgreementItem.updateMany).toHaveBeenCalledWith({
      where: { id: 'i1', status: 'deployed', serializedEquipmentId: 'old' },
      data: { serializedEquipmentId: 'new', deployInspection: expect.anything() },
    });
    expect(tx.serializedEquipment.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'new', status: 'available', currentRentalId: null },
      data: { status: 'rented', currentRentalId: 'r1', currentCustomerId: 'c1' },
    }));
    expect(tx.serviceTicket.create).toHaveBeenCalledWith({ data: expect.objectContaining({ division: 'D4', status: 'closed', linkedRentalAgreementId: 'r1',
      workDescription: expect.stringContaining('OLD-123 → NEW-456'), customData: expect.objectContaining({ recordOnly: true, workType: 'rental_swap' }) }) });
    expect(tx.auditLog.create).toHaveBeenCalled();
  });
  it.each(['completed', 'cancelled', 'scheduled'])('rejects %s rentals', async status => {
    tx.rentalAgreement.findUnique.mockResolvedValue({ status });
    expect((await swap()).next.mock.calls[0][0].statusCode).toBe(409);
    expect(tx.serializedEquipment.updateMany).not.toHaveBeenCalled();
  });
  it('rejects equipment on another rental', async () => {
    tx.rentalAgreementItem.findUnique.mockResolvedValue({ status: 'deployed', rentalAgreementId: 'other' });
    expect((await swap()).next.mock.calls[0][0].statusCode).toBe(409);
    expect(tx.serializedEquipment.updateMany).not.toHaveBeenCalled();
  });
  it('rejects a different catalog product before changing equipment', async () => {
    tx.serializedEquipment.findUnique.mockResolvedValue({ id: 'new', productId: 'p2' });
    expect((await swap()).next.mock.calls[0][0].statusCode).toBe(400);
    expect(tx.serializedEquipment.updateMany).not.toHaveBeenCalled();
  });
  it('rejects a replacement claimed by another request', async () => {
    tx.serializedEquipment.updateMany.mockResolvedValueOnce({ count: 0 });
    expect((await swap()).next.mock.calls[0][0].statusCode).toBe(409);
    expect(tx.serviceTicket.create).not.toHaveBeenCalled();
  });
  it('rejects duplicate replacement selections before entering a transaction', async () => {
    expect((await swap({ ...body, swaps: [...body.swaps, { ...body.swaps[0], itemId: 'i2' }] })).next.mock.calls[0][0].statusCode).toBe(400);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it('returns the existing ticket on a retry without swapping twice', async () => {
    const prior = { id: requestId, linkedRentalAgreementId: 'r1', createdById: 'u1', customData: { workType: 'rental_swap' } };
    tx.serviceTicket.findUnique.mockResolvedValue(prior);
    expect((await swap()).json).toHaveBeenCalledWith(prior);
    expect(tx.serializedEquipment.updateMany).not.toHaveBeenCalled();
  });
  it('requires authentication', () => {
    const json = vi.fn();
    const next = vi.fn();
    route.stack[0].handle({}, { status: () => ({ json }) }, next);
    expect(json).toHaveBeenCalledWith({ error: 'Not authenticated' });
    expect(next).not.toHaveBeenCalled();
  });
});
