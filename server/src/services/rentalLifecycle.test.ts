import { beforeEach, describe, expect, it, vi } from 'vitest';
const tx = vi.hoisted(() => ({
  $queryRaw: vi.fn(), invoice: { findFirst: vi.fn() },
  rentalAgreement: { update: vi.fn() },
  rentalAgreementItem: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
  serializedEquipment: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
}));
vi.mock('../db.js', async importOriginal => ({ ...await importOriginal<typeof import('../db.js')>(), ...(() => ({ prisma: {} }))() }));
import { deployRentalItem, returnRentalItem, rentalDate, rentalToday, closeRental } from './rentalLifecycle.js';
const rental: any = { id: 'r', status: 'active', companyId: 'c', billingRateType: 'daily' };
beforeEach(() => {
  vi.resetAllMocks();
  tx.invoice.findFirst.mockResolvedValue(null);
  tx.serializedEquipment.findUnique.mockResolvedValue({ id: 'a', status: 'available', currentRentalId: null, productId: 'p' });
  tx.rentalAgreementItem.create.mockResolvedValue({ id: 'item' });
});
describe('shared online/offline rental transitions', () => {
  it('uses the Central business date across UTC midnight', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-25T01:00:00Z'));
    try { expect(rentalToday()).toEqual(new Date('2026-09-24')); } finally { vi.useRealTimers(); }
  });
  it('closes on the actual historical pickup day once everything is back', async () => {
    tx.rentalAgreementItem.findMany.mockResolvedValue([]);
    await closeRental(tx as any, rental, 'completed', undefined, '2026-07-05');
    expect(tx.rentalAgreement.update).toHaveBeenCalledWith({ where:{id:'r'}, data:{status:'completed',endDate:new Date('2026-07-05')} });
  });
  it('refuses to close while equipment is still out, naming the units', async () => {
    tx.rentalAgreementItem.findMany.mockResolvedValue([
      { id:'item', serializedEquipment:{ serialNumber:'AT-104' } }, { id:'item2', serializedEquipment:{ serialNumber:'MX-22' } },
    ]);
    await expect(closeRental(tx as any, rental, 'completed', undefined, '2026-07-05')).rejects.toThrow('2 units are still out (AT-104, MX-22)');
    expect(tx.rentalAgreementItem.update).not.toHaveBeenCalled();
    expect(tx.rentalAgreement.update).not.toHaveBeenCalled();
  });
  it('still pulls equipment back when a rental is cancelled as not-done', async () => {
    tx.rentalAgreementItem.findMany.mockResolvedValue([{ id:'item', serializedEquipment:{ serialNumber:'AT-104' } }]);
    tx.rentalAgreementItem.findUnique.mockResolvedValue({ id:'item', rentalAgreementId:'r', serializedEquipmentId:'a', status:'deployed', deployedDate:new Date('2026-06-15') });
    await closeRental(tx as any, rental, 'cancelled', 'Customer cancelled', '2026-07-05');
    expect(tx.rentalAgreementItem.update).toHaveBeenCalledWith({ where:{id:'item'}, data:{status:'returned',returnedDate:new Date('2026-07-05')} });
  });
  it('rejects changing the date on a close replay or closing before equipment activity', async () => {
    await expect(closeRental(tx as any, {...rental,status:'completed',endDate:new Date('2026-07-05')}, 'completed', undefined, '2026-07-06')).rejects.toThrow('retry');
    tx.rentalAgreementItem.findFirst.mockResolvedValue({id:'later'});
    await expect(closeRental(tx as any, rental, 'completed', undefined, '2026-07-05')).rejects.toThrow('predates');
    expect(tx.rentalAgreement.update).not.toHaveBeenCalled();
  });
  it('rejects return through another rental before mutating anything', async () => {
    tx.rentalAgreementItem.findUnique.mockResolvedValue({ rentalAgreementId: 'other', status: 'deployed' });
    await expect(returnRentalItem(tx as any, 'r', 'item')).rejects.toThrow('not found on this agreement');
    expect(tx.serializedEquipment.updateMany).not.toHaveBeenCalled();
  });
  it('lost return acknowledgement never releases a later redeployment', async () => {
    tx.rentalAgreementItem.findUnique.mockResolvedValue({ rentalAgreementId: 'r', status: 'returned', returnedDate: new Date('2026-08-10') });
    await returnRentalItem(tx as any, 'r', 'item', { returnedDate: '2026-08-10' });
    expect(tx.rentalAgreementItem.update).not.toHaveBeenCalled();
    expect(tx.serializedEquipment.updateMany).not.toHaveBeenCalled();
  });
  it('rejects returns before deployment and rejects changed retry dates', async () => {
    tx.rentalAgreementItem.findUnique.mockResolvedValue({ rentalAgreementId: 'r', status: 'deployed', deployedDate: new Date('2026-08-15') });
    await expect(returnRentalItem(tx as any, 'r', 'item', { returnedDate: '2026-08-01' })).rejects.toThrow('between');
    tx.rentalAgreementItem.findUnique.mockResolvedValue({ rentalAgreementId: 'r', status: 'returned', returnedDate: new Date('2026-08-10') });
    await expect(returnRentalItem(tx as any, 'r', 'item', { returnedDate: '2026-08-11' })).rejects.toThrow('retry');
  });
  it('locks the serial before claiming it and activates actual early deployment', async () => {
    await deployRentalItem(tx as any, { ...rental, status: 'scheduled' }, { serializedEquipmentId: 'a', productId: 'p', rate: 0, deployedDate: '2026-08-01' });
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(tx.serializedEquipment.findUnique.mock.invocationCallOrder[0]);
    expect(tx.rentalAgreement.update).toHaveBeenCalledWith({ where: { id: 'r' }, data: { status: 'active' } });
  });
  it('refuses closed, occupied, mismatched-product and invalid-rate deployments', async () => {
    const input = { serializedEquipmentId: 'a', productId: 'p', rate: 10 };
    await expect(deployRentalItem(tx as any, { ...rental, status: 'completed' }, input)).rejects.toThrow('not active');
    await expect(deployRentalItem(tx as any, rental, { ...input, rate: -1 })).rejects.toThrow('non-negative');
    await expect(deployRentalItem(tx as any, rental, { ...input, productId: 'wrong' })).rejects.toThrow('match product');
    tx.serializedEquipment.findUnique.mockResolvedValue({ status: 'rented', productId: 'p', currentRentalId: 'other' });
    await expect(deployRentalItem(tx as any, rental, input)).rejects.toThrow('not available');
    expect(tx.rentalAgreementItem.create).not.toHaveBeenCalled();
  });
  it('rejects backdated changes to already invoiced history', async () => {
    tx.invoice.findFirst.mockResolvedValue({ invoiceNumber: 'INV-X' });
    await expect(deployRentalItem(tx as any, rental, { serializedEquipmentId: 'a', productId: 'p', deployedDate: '2026-08-01' })).rejects.toThrow('INV-X');
  });
  it('accepts matching offline creation retry without changing asset ownership', async () => {
    tx.rentalAgreementItem.findUnique.mockResolvedValue({ id: 'i', rentalAgreementId: 'r', serializedEquipmentId: 'a', productId: 'p' });
    expect(await deployRentalItem(tx as any, rental, { id: 'i', serializedEquipmentId: 'a', productId: 'p' })).toMatchObject({ id: 'i' });
    expect(tx.serializedEquipment.update).not.toHaveBeenCalled();
  });
  it('atomically returns the outgoing asset on an active replacement date', async () => {
    tx.rentalAgreementItem.findUnique.mockResolvedValue({id:'old',rentalAgreementId:'r',productId:'p',serializedEquipmentId:'old-serial',status:'deployed',deployedDate:new Date('2026-08-01')});
    await deployRentalItem(tx as any,rental,{serializedEquipmentId:'a',productId:'p',replacesItemId:'old',deployedDate:'2026-08-15'});
    expect(tx.rentalAgreementItem.update).toHaveBeenCalledWith({where:{id:'old'},data:{status:'returned',returnedDate:new Date('2026-08-15')}});
  });
  it('rejects impossible dates rather than allowing Date to roll them forward', () => {
    expect(() => rentalDate('2026-02-30', 'date')).toThrow();
    expect(rentalDate('2026-08-01T12:00:00Z', 'date')).toEqual(new Date('2026-08-01'));
  });
});
