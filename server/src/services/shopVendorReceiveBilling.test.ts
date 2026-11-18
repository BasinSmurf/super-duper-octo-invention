import { describe, expect, it, vi } from 'vitest';
vi.mock('../db.js', async importOriginal => ({ ...await importOriginal<typeof import('../db.js')>(), ...(() => ({ prisma: { product: { findMany: vi.fn() } } }))() }));
import { prisma } from '../db.js';
import { applyReceiveBilling } from './shopVendorReceiveBilling.js';
import { parseReceivePayload } from './shopVendorReceive.js';
import { buildShopBillingLines } from './shopBillingLines.js';

function transaction(billing: unknown = {}) {
  return {
    shopWorkOrderItem: { findUnique: vi.fn().mockResolvedValue({ billing }), update: vi.fn() },
    equipmentInspection: { findFirst: vi.fn().mockResolvedValue({ id: 'qa', category: 'ue_cylinder', serviceActions: ['visual_only'] }), update: vi.fn() },
  };
}
const receive = { vendorDisposition: 'pass_thru_repair', vendorInvoiceTotal: 50 };
describe('billing selected during vendor receiving', () => {
  it('bills our $100 service once, retains $50 cost, and selects UE in draft QA', async () => {
    vi.mocked(prisma.product.findMany).mockResolvedValue([{ id: 'ue', partNumber: '0623003', name: 'UE test', unitOfMeasure: 'EA' }] as never);
    const tx = transaction();
    const payload = parseReceivePayload({ ...receive, vendorBillingMode: 'catalog_service', vendorService: { productId: 'ue', quantity: 1, rate: 100 } }).payload!;
    await applyReceiveBilling(tx as never, 'unit', payload);
    const billing = tx.shopWorkOrderItem.update.mock.calls[0][0].data.billing;
    expect(billing.vendor).toMatchObject({ cost: 50, mode: 'catalog_service', serviceProductId: 'ue' });
    const lines = buildShopBillingLines([{ id: 'unit', status: 'shop_complete', serialNumber: 'SN-1', serviceType: 'repair', billing, vendorDisposition: 'pass_thru_repair', vendorInvoiceTotal: 50 } as never]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ productId: 'ue', rate: 100, quantity: 1 });
    expect(tx.equipmentInspection.update.mock.calls[0][0].data.serviceActions).toEqual(['visual_only', 'ue_test']);
  });
  it('replaces an earlier override with bill through without keeping its charge or stale markup', async () => {
    const tx = transaction({ labor: { hours: 2, rate: 85 }, services: [{ productId: 'ue', partNumber: '0623003', quantity: 1, rate: 100 }, { productId: 'other', partNumber: '0631001', quantity: 1, rate: 35 }], vendor: { mode: 'catalog_service', serviceProductId: 'ue', cost: 321, freight: 20, markupPct: 10 } });
    await applyReceiveBilling(tx as never, 'unit', parseReceivePayload({ ...receive, vendorBillingMode: 'passthrough' }).payload!);
    expect(tx.shopWorkOrderItem.update.mock.calls[0][0].data.billing).toMatchObject({ labor: { hours: 2, rate: 85 }, services: [{ productId: 'other' }], vendor: { mode: 'passthrough', cost: 50, freight: 0, markupPct: 0 } });
    expect(tx.shopWorkOrderItem.update.mock.calls[0][0].data.billing.vendor.serviceProductId).toBeUndefined();
  });
  it('rejects missing or invalid override selections before writing billing', async () => {
    expect(parseReceivePayload({ ...receive, vendorBillingMode: 'catalog_service' }).ok).toBe(false);
    expect(parseReceivePayload({ ...receive, vendorBillingMode: 'unknown' }).ok).toBe(false);
    const tx = transaction();
    await expect(applyReceiveBilling(tx as never, 'unit', parseReceivePayload({ ...receive, vendorBillingMode: 'catalog_service', vendorService: { productId: 'ue', quantity: 1, rate: -1 } }).payload!)).rejects.toThrow();
    expect(tx.shopWorkOrderItem.update).not.toHaveBeenCalled();
  });
  it('keeps older clients on bill through and does not alter non-billable returns', async () => {
    expect(parseReceivePayload(receive).payload?.billingMode).toBe('passthrough');
    const tx = transaction();
    await applyReceiveBilling(tx as never, 'unit', parseReceivePayload({ vendorDisposition: 'warranty' }).payload!);
    expect(tx.shopWorkOrderItem.update).not.toHaveBeenCalled();
  });
});
