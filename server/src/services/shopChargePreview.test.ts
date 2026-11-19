import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../db.js', async importOriginal => ({ ...await importOriginal<typeof import('../db.js')>(), ...(() => ({ prisma: { product: { findMany: vi.fn() }, priceLevel: { findMany: vi.fn() } } }))() }));
vi.mock('../utils/servicePartMap.js', () => ({ getLaborProduct: vi.fn().mockResolvedValue({ id: 'labor', partNumber: '0600002' }), getMileageProduct: vi.fn().mockResolvedValue({ id: 'miles', partNumber: '0600001' }) }));
import { prisma } from '../db.js';
import { priceShopCharges } from './shopChargePreview.js';
import { toBillingItem } from './shopBillingLines.js';

const order = { id: 'wo', workOrderNumber: 'SW-2026-00146', companyId: 'company', tier1: false, company: { name: 'Customer', taxExempt: false, qbPriceLevelId: null as string | null }, billingExtras: { mileage: { miles: 7, rate: 1.5 } } };
const unit = toBillingItem({ id: 'item', status: 'shop_complete', serialNumber: 'dsfg', equipmentCategory: 'personal_monitor', serviceType: 'repair', isWarranty: false,
  billing: { labor: { hours: 2, rate: 85 } }, partsUsed: [800, 443, 1].map((unitCost, i) => ({ productId: `p${i}`, name: `Sensor ${i}`, quantity: 1, unitCost })),
  vendorDisposition: 'pass_thru_repair', vendorInvoiceTotal: 35 });
beforeEach(() => {
  vi.mocked(prisma.product.findMany).mockResolvedValue([{ id: 'labor', qbItemListId: 'qb-labor', qbItemFullName: '0600002' }] as never);
  vi.mocked(prisma.priceLevel.findMany).mockResolvedValue([]);
});
describe('shared shop pricing for preview and invoice', () => {
  it.each([4, 10, 40])('bills eight whole-job hours once with %i units', async count => {
    const units = Array.from({ length: count }, (_, i) => ({ ...unit, id: `unit-${i}`,
      billing: { services: [{ productId: 'inspection', partNumber: 'inspection', name: 'Inspection', quantity: 1, rate: 10 }] },
      partsUsed: null, vendorInvoiceTotal: null }));
    const { lines } = await priceShopCharges({ ...order, billingExtras: { labor: { hours: 8, rate: 85 } } }, units);
    const laborLines = lines.filter(line => line.chargeKind === 'labor');
    expect(laborLines).toHaveLength(1);
    expect(laborLines[0]).toMatchObject({ description: 'Whole-job labor', quantity: 8, rate: 85, amount: 680,
      unitOfMeasure: 'HR', partNumber: '0600002', qbItemListId: 'qb-labor', chargeKind: 'labor',
      sourceShopItemId: null, isTaxable: false });
    expect(lines.reduce((total, line) => total + line.amount, 0)).toBe(680 + count * 10);
  });
  it('applies the customer labor contract to whole-job hours', async () => {
    vi.mocked(prisma.priceLevel.findMany).mockResolvedValue([{ id: 'level', name: 'Contract', items: [
      { qbItemListId: 'qb-labor', customPrice: 70, adjustPercent: null },
    ] }] as never);
    const { lines } = await priceShopCharges({ ...order, company: { ...order.company, qbPriceLevelId: 'level' },
      billingExtras: { labor: { hours: 8, rate: 85 } } }, []);
    expect(lines[0]).toMatchObject({ quantity: 8, rate: 70, amount: 560 });
  });
  it('preserves the QB service identity and charges $100 once for $50 vendor work', async () => {
    vi.mocked(prisma.product.findMany).mockResolvedValue([{ id: 'ue', qbItemListId: 'qb-ue', qbItemFullName: '0623006' }] as never);
    const vendorUnit = { ...unit, partsUsed: null, vendorInvoiceTotal: 50, billing: {
      services: [{ productId: 'ue', partNumber: '0623006', name: 'UE Test', quantity: 1, rate: 100 }],
      vendor: { mode: 'catalog_service', serviceProductId: 'ue' },
    } };
    const { lines } = await priceShopCharges({ ...order, billingExtras: null }, [vendorUnit]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ amount: 100, partNumber: '0623006', qbItemListId: 'qb-ue', isTaxable: false });
    expect(lines[0].description).not.toContain('50');
  });
  it('keeps $1,244 taxable parts separate from $215.50 labor/vendor/mileage', async () => {
    const { lines } = await priceShopCharges(order, [unit]);
    expect(lines.reduce((s, l) => s + l.amount, 0)).toBe(1459.5);
    expect(lines.filter(l => l.isTaxable).reduce((s, l) => s + l.amount, 0)).toBe(1244);
    expect(lines.find(l => l.chargeKind === 'labor')).toMatchObject({ partNumber: '0600002', amount: 170, isTaxable: false, sourceShopItemId: 'item' });
    expect(lines.find(l => l.chargeKind === 'vendor')).toMatchObject({ amount: 35, isTaxable: false, qbItemListId: null });
  });
  it('honors exemption and contract pricing while routing Tier 1 without a surcharge', async () => {
    vi.mocked(prisma.priceLevel.findMany).mockResolvedValue([{ id: 'level', name: 'Contract', items: [{ qbItemListId: 'qb-labor', customPrice: 70, adjustPercent: null }] }] as never);
    const { lines, ruleResult } = await priceShopCharges({ ...order, tier1: true, company: { ...order.company, taxExempt: true, qbPriceLevelId: 'level' } }, [unit]);
    expect(lines.some(l => l.isTaxable)).toBe(false);
    expect(lines.find(l => l.chargeKind === 'labor')?.amount).toBe(140);
    expect(lines.reduce((sum, line) => sum + line.amount, 0)).toBe(1429.5);
    expect(ruleResult.extraLines).toEqual([]);
    expect(ruleResult.qbCustomerOverride).toBe('Pale Horse Service Inc');
  });
});
