import { beforeEach, describe, expect, it, vi } from 'vitest';
const prisma = vi.hoisted(() => ({
  serializedEquipment: { findUnique: vi.fn(), update: vi.fn(), count: vi.fn() },
  product: { findUnique: vi.fn() }, $transaction: vi.fn(),
}));
vi.mock('../db.js', async importOriginal => ({ ...await importOriginal<typeof import('../db.js')>(), ...(() => ({ prisma }))() }));
vi.mock('../utils/auditLog.js', () => ({ createAuditLog: vi.fn() }));
vi.mock('../services/printing.js', () => ({ sendZpl: vi.fn() }));
vi.mock('../services/equipmentLabel.js', () => ({ equipmentLabelZpl: vi.fn(), generateEquipmentBadgePdf: vi.fn() }));
import { equipmentRouter } from './equipment.js';
import { createAuditLog } from '../utils/auditLog.js';

const updateRoute = equipmentRouter.stack.find(entry => entry.route?.path === '/:id' && entry.route.methods.put)!.route;
async function update(body: unknown) {
  const json = vi.fn(); const next = vi.fn();
  await updateRoute.stack[1].handle({ params: { id: 'unit' }, body, user: { userId: 'u1' } }, { json }, next);
  return { json, next };
}
beforeEach(() => {
  vi.clearAllMocks();
  prisma.serializedEquipment.findUnique.mockResolvedValue({ id: 'unit', productId: 'old-product', customData: { source: 'import', scba: { durationMinutes: 5 } } });
  prisma.product.findUnique.mockResolvedValue({ id: 'new-product', isActive: true, isSerialized: true, isAssembly: false });
  prisma.serializedEquipment.count.mockResolvedValue(0);
  prisma.serializedEquipment.update.mockResolvedValue({ id: 'unit', productId: 'new-product' });
});
describe('equipment product type changes', () => {
  it('saves and audits a replacement product while preserving unrelated metadata', async () => {
    const result = await update({ productId: 'new-product' });
    expect(result.next).not.toHaveBeenCalled();
    expect(prisma.serializedEquipment.update).toHaveBeenCalledWith({ where: { id: 'unit' }, data: { productId: 'new-product', customData: { source: 'import' } } });
    expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ changes: expect.objectContaining({ productId: { from: 'old-product', to: 'new-product' } }) }));
  });
  it('blocks changing an assembly with contents to a non-assembly product', async () => {
    prisma.serializedEquipment.count.mockResolvedValue(2);
    const result = await update({ productId: 'new-product' });
    expect(result.next.mock.calls[0][0].statusCode).toBe(400);
    expect(prisma.serializedEquipment.update).not.toHaveBeenCalled();
  });
  it('permits switching to another assembly while retaining contents', async () => {
    prisma.product.findUnique.mockResolvedValue({ isActive: true, isSerialized: true, isAssembly: true });
    const result = await update({ productId: 'new-product' });
    expect(result.next).not.toHaveBeenCalled();
    expect(prisma.serializedEquipment.count).not.toHaveBeenCalled();
  });
  it.each([null, { isActive: false, isSerialized: true }, { isActive: true, isSerialized: false }])('rejects invalid replacement products: %j', async product => {
    prisma.product.findUnique.mockResolvedValue(product);
    const result = await update({ productId: 'new-product' });
    expect(result.next.mock.calls[0][0].statusCode).toBe(400);
    expect(prisma.serializedEquipment.update).not.toHaveBeenCalled();
  });
  it('requires authentication for SCBA creation and editing', () => {
    for (const path of ['/scba', '/:id/scba']) {
      const route = equipmentRouter.stack.find(entry => entry.route?.path === path)!.route;
      const json = vi.fn(); const next = vi.fn();
      route.stack[0].handle({}, { status: () => ({ json }) }, next);
      expect(json).toHaveBeenCalledWith({ error: 'Not authenticated' });
      expect(next).not.toHaveBeenCalled();
    }
  });
});
