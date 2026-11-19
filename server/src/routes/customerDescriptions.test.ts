import { beforeEach, describe, expect, it, vi } from 'vitest';
const prisma = vi.hoisted(() => ({
  company: { findUnique: vi.fn(), update: vi.fn() }, product: { findMany: vi.fn() },
}));
vi.mock('../db.js', async importOriginal => ({ ...await importOriginal<typeof import('../db.js')>(), ...(() => ({ prisma }))() }));
vi.mock('../utils/auditLog.js', () => ({ createAuditLog: vi.fn() }));
import { companiesRouter } from './companies.js';
import { createAuditLog } from '../utils/auditLog.js';

const product = { id: 'p1', qbItemListId: 'QB1', partNumber: 'PART1', name: 'Primary breathing air', description: null, isActive: true };
async function save(data: unknown) {
  const route = companiesRouter.stack.find(layer => layer.route?.path === '/:id/customer-descriptions' && layer.route.methods.put)!.route;
  const res = { json: vi.fn() };
  const next = vi.fn();
  await route.stack[route.stack.length - 1].handle({ params: { id: 'c1' }, body: { data }, user: { userId: 'u1' } }, res, next);
  return { res, next };
}
beforeEach(() => {
  vi.clearAllMocks();
  prisma.company.findUnique.mockResolvedValue({ customerDescriptions: [] });
  prisma.product.findMany.mockResolvedValue([product]);
});
describe('customer description configuration', () => {
  it('saves trusted QB identity and trims the description, with audit history', async () => {
    const { next } = await save([{ productId: 'p1', qbItemListId: 'forged', description: '  Cycle 1 breathing inspection  ' }]);
    expect(next).not.toHaveBeenCalled();
    expect(prisma.company.update).toHaveBeenCalledWith({ where: { id: 'c1' }, data: { customerDescriptions: [
      { productId: 'p1', qbItemListId: 'QB1', partNumber: 'PART1', standardName: product.name, standardDescription: null, description: 'Cycle 1 breathing inspection' },
    ] } });
    expect(createAuditLog).toHaveBeenCalledOnce();
  });
  it.each([null, {}, [{ productId: 'p1', description: '   ' }], [{ productId: 'p1', description: 'x'.repeat(1001) }]])('rejects invalid input', async data => {
    const { next } = await save(data);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    expect(prisma.company.update).not.toHaveBeenCalled();
  });
  it('rejects duplicate QB items and unmapped products', async () => {
    const row = { productId: 'p1', description: 'Alternate' };
    expect((await save([row, row])).next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    prisma.product.findMany.mockResolvedValue([{ ...product, qbItemListId: null }]);
    expect((await save([row])).next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    expect(prisma.company.update).not.toHaveBeenCalled();
  });
  it('removes overrides without deleting or editing catalog items', async () => {
    await save([]);
    expect(prisma.company.update).toHaveBeenCalledWith({ where: { id: 'c1' }, data: { customerDescriptions: [] } });
  });
});
