import { describe, expect, it, vi } from 'vitest';
vi.mock('../utils/companyGuards.js', () => ({ assertCompanyActive: vi.fn() }));
import { createShopWorkOrderWithItems, normalizeIntakeComponents } from './shopWoCreate.js';

function setup(count: number, massIntake: boolean) {
  const tx = {
    site: { findFirst: vi.fn().mockResolvedValue({ id: 'site' }) },
    shopWorkOrder: { create: vi.fn().mockResolvedValue({ id: 'wo', workOrderNumber: 'WO-1' }), update: vi.fn() },
    shopWorkOrderItem: { create: vi.fn().mockImplementation(async ({ data }) => ({ ...data, id: `item-${data.itemNumber}` })) },
    shopItemStatusLog: { create: vi.fn() },
  };
  const contact = { name: 'Customer', phone: '5551234', preferred: 'call' };
  const args = { workOrderNumber: 'WO-1', userId: 'user', payload: {
    companyId: 'company', dropOffContact: contact, pickupContact: contact, massIntake,
    items: Array.from({ length: count }, () => ({ serialNumber: '', equipmentCategory: 'ue_cylinder', serviceType: 'ue_testing' })),
  } };
  return { tx, args };
}

describe('parts not included', () => {
  const unit = (components: any[]) => ({ serialNumber: 'CYL-1001', equipmentCategory: 'scba', serviceType: 'inspection', components });
  const comp = (type: string, serialNumber?: string, notIncluded?: boolean) => ({ type, serialNumber, notIncluded, serviceType: 'inspection' });

  it('records flagged and placeholder parts on the parent instead of creating child units', () => {
    const items = [unit([comp('regulator', undefined, true), comp('mask', 'N/A'), comp('harness', 'n/a'), comp('bottle', 'BT-2002')])];
    normalizeIntakeComponents(items);
    expect(items[0].components).toEqual([comp('bottle', 'BT-2002')]);
    expect((items[0] as any).customData).toEqual({ partsNotIncluded: ['regulator', 'mask', 'harness'] });
  });

  it('does not call a part missing when another of the same type came in', () => {
    const items = [unit([comp('bottle', 'BT-2002'), comp('bottle', 'NONE')])];
    normalizeIntakeComponents(items);
    expect(items[0].components).toHaveLength(1);
    expect((items[0] as any).customData).toBeUndefined();
  });

  it('keeps existing customData and leaves complete assemblies alone', () => {
    const items = [{ ...unit([comp('regulator', 'RG-3003'), comp('mask', undefined, true)]), customData: { unitSerialPart: 'bottle' } }];
    normalizeIntakeComponents(items);
    expect(items[0].customData).toEqual({ unitSerialPart: 'bottle', partsNotIncluded: ['mask'] });
  });
});

describe('mass shop intake', () => {
  it('creates all 11 pieces atomically without fabricating or dropping serials', async () => {
    const { tx, args } = setup(11, true);
    const result = await createShopWorkOrderWithItems(tx as never, args);
    expect(result.totalItems).toBe(11);
    expect(tx.shopWorkOrderItem.create).toHaveBeenCalledTimes(11);
    expect(tx.shopWorkOrderItem.create).toHaveBeenLastCalledWith({ data: expect.objectContaining({ itemNumber: 11, serialNumber: '', equipmentCategory: 'ue_cylinder', serviceType: 'ue_testing' }) });
  });
  it.each([[10, true], [1001, true], [11, false]])('rejects invalid count or missing serial authorization (%i, %s)', async (count, massIntake) => {
    const { tx, args } = setup(count as number, massIntake as boolean);
    await expect(createShopWorkOrderWithItems(tx as never, args)).rejects.toThrow();
    expect(tx.shopWorkOrder.create).not.toHaveBeenCalled();
  });
});
