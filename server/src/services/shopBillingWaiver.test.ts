import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../index.js', () => ({ prisma: { $transaction: vi.fn() } }));
vi.mock('./shopBillingQueue.js', async importOriginal => ({ ...await importOriginal<typeof import('./shopBillingQueue.js')>(), getBilledShopWorkOrderIds: vi.fn() }));
import { prisma } from '../index.js';
import { getBilledShopWorkOrderIds, shopBillingExcluded } from './shopBillingQueue.js';
import { assertShopBillingAllowed, invoiceWaiverBlocker, previewShopBillingWaiver, waiveShopBilling } from './shopBillingWaiver.js';
import { DEFAULT_PERMISSIONS } from './permissions.js';

const order = { id: 'wo', workOrderNumber: 'SW-1', status: 'closed', isInternal: false, customData: { keep: true }, company: { name: 'Customer' }, payments: [] };
const invoice = { id: 'inv', invoiceNumber: 'INV-1', shopWorkOrderId: 'wo', status: 'draft', qbSalesOrderTxnId: null, qbInvoiceTxnId: null, payments: [], lineItems: [], customData: { keep: true } };
function fixture() {
  return {
    $executeRaw: vi.fn(), $queryRaw: vi.fn(),
    shopWorkOrder: { findMany: vi.fn().mockResolvedValue([order]), findUniqueOrThrow: vi.fn().mockResolvedValue(order), update: vi.fn() },
    serviceTicket: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn(), findUnique: vi.fn().mockResolvedValue({ id: 'ticket' }), update: vi.fn() },
    billingReasonCode: { upsert: vi.fn(), findUnique: vi.fn().mockResolvedValue({ code: 'SHOP_BILLING_WAIVED', isActive: true }) },
    invoice: { findMany: vi.fn().mockResolvedValue([invoice]), findUniqueOrThrow: vi.fn().mockResolvedValue(invoice), update: vi.fn() },
    qbSyncQueue: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn() },
    enverusSyncQueue: { findMany: vi.fn().mockResolvedValue([]) },
    signatureRequest: { updateMany: vi.fn() }, auditLog: { create: vi.fn() },
  };
}
beforeEach(() => { vi.clearAllMocks(); vi.mocked(getBilledShopWorkOrderIds).mockResolvedValue(new Set()); });

describe('shop billing waiver', () => {
  it('defaults exclusively to platform admin', () => expect(DEFAULT_PERMISSIONS['shop_orders:waive_billing']).toEqual(['platform_admin']));
  it('hides internal, voided and waived work but not ordinary closed work', () => {
    expect(shopBillingExcluded(order)).toBe(false);
    expect(shopBillingExcluded({ ...order, isInternal: true })).toBe(true);
    expect(shopBillingExcluded({ ...order, customData: { voided: true } })).toBe(true);
    expect(shopBillingExcluded({ ...order, customData: { billingWaiver: { reason: 'Cleanup' } } })).toBe(true);
  });
  it('blocks QB history even on a void invoice, in-flight transmission, and payments', () => {
    expect(invoiceWaiverBlocker(invoice, false, false)).toBeNull();
    expect(invoiceWaiverBlocker({ ...invoice, status: 'void', qbInvoiceTxnId: 'qb' }, false, false)).toContain('QuickBooks');
    expect(invoiceWaiverBlocker(invoice, true, false)).toContain('QuickBooks');
    expect(invoiceWaiverBlocker(invoice, false, true)).toContain('payment');
    expect(invoiceWaiverBlocker({ ...invoice, status: 'paid' }, false, false)).toContain('paid');
  });
  it('does not target already handled work without active billing', async () => {
    const db = fixture(); db.invoice.findMany.mockResolvedValue([]);
    vi.mocked(getBilledShopWorkOrderIds).mockResolvedValue(new Set(['wo']));
    expect(await previewShopBillingWaiver(db as never)).toEqual([]);
  });
  it('blocks mixed invoices rather than cancelling unrelated work', async () => {
    const db = fixture(); db.invoice.findMany.mockResolvedValue([{ ...invoice, lineItems: [{ sourceTicketId: 'unrelated' }] }] as never);
    expect((await previewShopBillingWaiver(db as never))[0].blockers.join()).toContain('other work');
  });
  it('atomically waives, voids local invoices, cancels pending jobs and signatures, and audits', async () => {
    const db = fixture();
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(db));
    expect(await waiveShopBilling(['wo'], 'Historical cleanup', 'admin')).toEqual({ waived: 1, voidedInvoices: 1 });
    expect(db.shopWorkOrder.update).toHaveBeenCalledWith(expect.objectContaining({ data: { customData: expect.objectContaining({ keep: true, billingWaiver: expect.objectContaining({ reason: 'Historical cleanup', waivedById: 'admin' }) }) } }));
    expect(db.invoice.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'void' }) }));
    expect(db.qbSyncQueue.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'skipped' }) }));
    expect(db.signatureRequest.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'VOIDED' }) }));
    expect(db.auditLog.create).toHaveBeenCalledTimes(2);
  });
  it('revalidates the entire selection before writing anything', async () => {
    const db = fixture(); vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(db));
    await expect(waiveShopBilling(['wo', 'stale'], 'Cleanup', 'admin')).rejects.toThrow('Nothing was changed');
    expect(db.shopWorkOrder.update).not.toHaveBeenCalled();
    expect(db.invoice.update).not.toHaveBeenCalled();
  });
  it('closes legacy repair tickets and records a nonbillable decision through the readiness guard', async () => {
    const db = fixture();
    db.serviceTicket.findMany.mockResolvedValue([{ id: 'ticket', status: 'billing_queue', customData: { shopWorkOrderId: 'wo' } }] as never);
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(db));
    await waiveShopBilling(['wo'], 'Cleanup', 'admin');
    expect(db.serviceTicket.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ billingReadiness: 'not_billable', billingReadinessReasonCode: 'SHOP_BILLING_WAIVED', billingReadinessSetById: 'admin' }) }));
    expect(db.auditLog.create).toHaveBeenCalledTimes(3);
  });
  it('prevents later direct and legacy invoice generation for waived work', async () => {
    const db = fixture(); db.shopWorkOrder.findMany.mockResolvedValue([{ ...order, customData: { billingWaiver: {} } }] as never);
    await expect(assertShopBillingAllowed(db as never, ['wo'])).rejects.toThrow('closed without billing');
  });
});
