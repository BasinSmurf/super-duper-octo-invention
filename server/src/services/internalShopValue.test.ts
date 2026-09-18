import { describe, expect, it, vi } from 'vitest';
vi.mock('../index.js', () => ({ prisma: { shopWorkOrder: { findMany: vi.fn() }, product: { findMany: vi.fn() } } }));
vi.mock('../utils/servicePartMap.js', () => ({ getLaborProduct: vi.fn().mockResolvedValue(null), getMileageProduct: vi.fn().mockResolvedValue(null) }));
import { prisma } from '../index.js';
import { internalShopValue, retailShopItems } from './internalShopValue.js';
import { buildShopBillingLines, toBillingItem } from './shopBillingLines.js';

describe('internal retail valuation', () => {
  it('uses retail parts/services/labor rather than internal entered prices, without mutating work', () => {
    const item = toBillingItem({ id: 'unit', status: 'returned', isWarranty: true, serialNumber: '123', serviceType: 'repair',
      partsUsed: [{ productId: 'part', quantity: 2, unitCost: 5 }],
      billing: { services: [{ productId: 'service', quantity: 1, rate: 0, name: 'Inspection' }], labor: { hours: 2, rate: 0 } } });
    const original = JSON.stringify(item);
    const retail = retailShopItems([item], [{ id: 'part', defaultSellPrice: 20 }, { id: 'service', defaultSellPrice: 30 }], 100);
    expect(buildShopBillingLines(retail.items).reduce((s, l) => s + l.total, 0)).toBe(270);
    expect(retail.fallbackRates).toBe(0);
    expect(JSON.stringify(item)).toBe(original);
  });
  it('excludes child assemblies and reports missing catalog rate fallbacks', () => {
    const item = toBillingItem({ id: 'unit', status: 'returned', serialNumber: '123', serviceType: 'repair', partsUsed: [{ productId: 'missing', quantity: 1, unitCost: 12 }] });
    const retail = retailShopItems([item, { ...item, id: 'child', parentItemId: 'unit' }], [], null);
    expect(retail.items).toHaveLength(1);
    expect(retail.fallbackRates).toBe(1);
    expect((retail.items[0].partsUsed as any[])[0].unitCost).toBe(12);
  });
  it('reports completed internal work read-only, excludes voids and sums retail categories', async () => {
    const order = { id: 'wo', workOrderNumber: 'SW-1', company: { name: 'Internal' }, customData: null,
      completedDate: new Date('2026-09-01'), returnedDate: null, updatedAt: new Date('2026-09-02'), billingExtras: null,
      items: [{ id: 'unit', status: 'returned', serialNumber: '123', serviceType: 'inspection', equipmentCategory: 'personal_monitor', productId: 'product', product: { id: 'product', partNumber: 'P1', name: 'Inspection', defaultSellPrice: 25 }, partsUsed: null }] };
    vi.mocked(prisma.shopWorkOrder.findMany).mockResolvedValue([order, { ...order, id: 'void', customData: { voided: true } }] as never);
    vi.mocked(prisma.product.findMany).mockResolvedValue([{ id: 'product', defaultSellPrice: 25 }] as never);
    const report = await internalShopValue(new Date('2026-01-01'), new Date('2027-01-01'));
    expect(report).toMatchObject({ total: 25, workorders: 1, items: 1 });
    expect(prisma.shopWorkOrder.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ isInternal: true, status: { in: ['complete', 'closed'] } }) }));
    // Mock provides only reads: any invoice/payment/queue write would fail this test.
  });
});
