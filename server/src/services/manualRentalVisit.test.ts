import { beforeEach, describe, expect, it, vi } from 'vitest';
const tx = vi.hoisted(() => ({
  $queryRaw: vi.fn(), rentalAgreement: { findUnique: vi.fn(), update: vi.fn() },
  rentalAgreementItem: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  serializedEquipment: { findFirst: vi.fn(), updateMany: vi.fn() }, invoice: { findFirst: vi.fn() },
  serviceTicket: { findUnique: vi.fn(), create: vi.fn() }, auditLog: { create: vi.fn() },
  rentalDailyLog: { findFirst: vi.fn(), create: vi.fn() },
}));
const prisma = vi.hoisted(() => ({ $transaction: vi.fn() }));
vi.mock('../db.js', async importOriginal => ({ ...await importOriginal<typeof import('../db.js')>(), ...(() => ({ prisma }))() }));
vi.mock('../utils/ticketNumber.js', () => ({ generateTicketNumber: vi.fn(async () => 'FS-TEST') }));
vi.mock('./ticketReviewRules.js', () => ({ runAndCacheReviewSignal: vi.fn() }));
import { saveManualRentalVisit } from './manualRentalVisit.js';
const requestId = '11111111-1111-4111-8111-111111111111';
const good = { overallCondition: 'good', physicalDamage: false, cleanlinessOk: true, calibrationCurrent: true, accessoriesReturned: true };
const item = { id: 'inventory-row', rentalAgreementId: 'rental', productId: 'product', serializedEquipmentId: 'old',
  deployedDate: new Date('2026-10-01'), returnedDate: null, status: 'deployed', rate: 75,
  product: { id: 'product', name: 'Monitor' }, serializedEquipment: { id: 'old', serialNumber: 'OLD' }, deployInspection: { testDate: '2026-09' } };
let rental: any;
beforeEach(() => {
  vi.resetAllMocks();
  rental = { id: 'rental', companyId: 'company', status: 'active', startDate: new Date('2026-10-01'), composition: null, items: [item] };
  prisma.$transaction.mockImplementation(async fn => fn(tx));
  tx.rentalAgreement.findUnique.mockImplementation(async () => rental);
  tx.serviceTicket.findUnique.mockResolvedValue(null);
  tx.invoice.findFirst.mockResolvedValue(null);
  tx.rentalAgreementItem.findUnique.mockResolvedValue(item);
  tx.rentalAgreementItem.findFirst.mockResolvedValue(null);
  tx.rentalAgreementItem.update.mockResolvedValue({ ...item, status: 'returned' });
  tx.rentalAgreementItem.updateMany.mockResolvedValue({ count: 1 });
  tx.serializedEquipment.findFirst.mockResolvedValue({ id: 'new', serialNumber: 'NEW', productId: 'product' });
  tx.serializedEquipment.updateMany.mockResolvedValue({ count: 1 });
  tx.serviceTicket.create.mockImplementation(async ({ data }) => data);
  tx.rentalDailyLog.findFirst.mockResolvedValue(null);
});
const expected = { serial: 'OLD', type: 'Monitor', testDate: '2026-09' };
const body = (workType: string, selections: any[]) => ({ requestId, workType, serviceDate: '2026-10-20', selections, lineItems: [] });
describe('unified inventory and recorded rental visits', () => {
  it('swaps inventory ownership without changing the contract rate or deployment date', async () => {
    const ticket = await saveManualRentalVisit('rental', body('rental_swap', [{ itemId: item.id, expected, replacement: { serial: 'NEW', type: 'Monitor', testDate: '2026-10' } }]), 'tech');
    expect(tx.serializedEquipment.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'new', status: 'available', currentRentalId: null } }));
    const data = tx.rentalAgreementItem.updateMany.mock.calls[0][0].data;
    expect(data.serializedEquipmentId).toBe('new'); expect(data).not.toHaveProperty('rate'); expect(data).not.toHaveProperty('deployedDate');
    expect(tx.rentalAgreement.update.mock.calls[0][0].data.composition.manualEquipment).toEqual([]);
    expect((ticket.customData as any).equipmentChanges[0]).toMatchObject({ before: { serial: 'OLD' }, after: { serial: 'NEW' } });
  });
  it('returns mixed tracked and manual rows with individual inspection results and one closure', async () => {
    rental.composition = { manualEquipment: [{ id: 'manual', serial: 'TEXT', type: 'Monitor', testDate: '2026-10', deployedAt: '2026-10-01' }] };
    const damaged = { ...good, overallCondition: 'needs_repair', physicalDamage: true };
    const ticket = await saveManualRentalVisit('rental', body('rental_return', [
      { itemId: item.id, expected, inspection: damaged }, { itemId: 'manual', inspection: good },
    ]), 'tech');
    expect(tx.rentalAgreement.update.mock.calls[0][0].data).toMatchObject({ status: 'completed', endDate: new Date('2026-10-20') });
    expect(tx.serializedEquipment.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'repair' } }));
    expect((ticket.customData as any).inspection.results.map((row: any) => row.data.overallCondition)).toEqual(['needs_repair', 'good']);
  });
  it('refuses stale serials and unavailable replacements before recording a visit', async () => {
    await expect(saveManualRentalVisit('rental', body('rental_swap', [{ itemId: item.id, expected: { ...expected, serial: 'STALE' }, replacement: { serial: 'NEW', type: 'Monitor', testDate: '10/2026' } }]), 'tech')).rejects.toThrow('Equipment changed');
    tx.serializedEquipment.updateMany.mockResolvedValue({ count: 0 });
    await expect(saveManualRentalVisit('rental', body('rental_swap', [{ itemId: item.id, expected, replacement: { serial: 'NEW', type: 'Monitor', testDate: '10/2026' } }]), 'tech')).rejects.toThrow('no longer available');
    expect(tx.serviceTicket.create).not.toHaveBeenCalled();
  });
  it('accepts a matching lost-acknowledgement retry without changing equipment twice', async () => {
    tx.serviceTicket.findUnique.mockResolvedValue({ id: requestId, linkedRentalAgreementId: 'rental', createdById: 'tech', status: 'closed', customData: { workType: 'rental_return' } });
    await saveManualRentalVisit('rental', body('rental_return', [{ itemId: item.id, inspection: good }]), 'tech');
    expect(tx.rentalAgreementItem.update).not.toHaveBeenCalled(); expect(tx.serviceTicket.create).not.toHaveBeenCalled();
  });
});
