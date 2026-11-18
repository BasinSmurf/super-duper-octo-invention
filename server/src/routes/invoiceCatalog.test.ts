import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = vi.hoisted(() => ({
  invoice: { findUnique: vi.fn(), update: vi.fn() },
  invoiceLineItem: { deleteMany: vi.fn(), create: vi.fn() },
  product: { findMany: vi.fn() },
}));
vi.mock('../db.js', async importOriginal => ({ ...await importOriginal<typeof import('../db.js')>(), ...(() => ({ prisma }))() }));
vi.mock('../utils/auditLog.js', () => ({ createAuditLog: vi.fn() }));
import { invoicesRouter } from './invoices.js';

let invoice: any;
async function save(lineItems: any[]) {
  const route = invoicesRouter.stack.find(l => l.route?.path === '/:id/line-items')!.route;
  const res = { json: vi.fn() };
  await route.stack.at(-1).handle({ params: { id: 'invoice' }, body: { lineItems } }, res);
  return res;
}
beforeEach(() => {
  vi.resetAllMocks();
  invoice = { id: 'invoice', status: 'draft', taxRate: 0.05,
    lineItems: [{ id: 'old', productId: 'inactive', qbItemListId: 'qb-old' }] };
  prisma.invoice.findUnique.mockImplementation(async () => invoice);
  prisma.invoiceLineItem.create.mockImplementation(async ({ data }) => data);
  prisma.product.findMany.mockResolvedValue([]);
});

describe('draft invoice catalog selections', () => {
  it('rejects inactive selections before deleting any saved lines', async () => {
    await expect(save([{ productId: 'inactive', amount: 100 }])).rejects.toThrow('Inactive or missing parts');
    expect(prisma.invoiceLineItem.deleteMany).not.toHaveBeenCalled();
    expect(prisma.invoice.update).not.toHaveBeenCalled();
  });
  it('does not let an existing line switch to another inactive part', async () => {
    await expect(save([{ id: 'old', productId: 'different-inactive' }])).rejects.toThrow('Inactive or missing parts');
    expect(prisma.invoiceLineItem.deleteMany).not.toHaveBeenCalled();
  });
  it.each([true, false])('preserves an existing inactive reference and the by-line taxable override %s', async isTaxable => {
    await save([{ id: 'old', productId: 'inactive', qbItemListId: 'qb-old', quantity: 1, rate: 100, amount: 100, isTaxable }]);
    expect(prisma.product.findMany).not.toHaveBeenCalled();
    expect(prisma.invoiceLineItem.create).toHaveBeenCalledWith({ data: expect.objectContaining({ productId: 'inactive', isTaxable }) });
    expect(prisma.invoice.update).toHaveBeenCalledWith({ where: { id: 'invoice' }, data: { subtotal: 100, taxAmount: isTaxable ? 5 : 0, total: isTaxable ? 105 : 100 } });
  });
  it('allows new active selections', async () => {
    prisma.product.findMany.mockResolvedValue([{ id: 'active' }]);
    await save([{ productId: 'active', quantity: 1, rate: 100, isTaxable: true }]);
    expect(prisma.invoiceLineItem.create).toHaveBeenCalledWith({ data: expect.objectContaining({ productId: 'active', isTaxable: true }) });
  });
});
