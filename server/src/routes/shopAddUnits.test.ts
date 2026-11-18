import { beforeEach, describe, expect, it, vi } from 'vitest';
const prisma = vi.hoisted(() => ({
  shopWorkOrder: { findUnique: vi.fn(), update: vi.fn() },
  shopWorkOrderItem: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn() },
  shopItemStatusLog: { create: vi.fn() },
  $transaction: vi.fn(), $queryRaw: vi.fn(), $executeRaw: vi.fn(),
}));
vi.mock('../db.js', async importOriginal => ({ ...await importOriginal<typeof import('../db.js')>(), ...(() => ({ prisma }))() }));
import { shopOrdersRouter } from './shopOrders.js';

beforeEach(() => {
  vi.clearAllMocks();
  prisma.shopWorkOrder.findUnique.mockResolvedValue({ id: 'wo', status: 'complete', totalItems: 1, intakeSiteId: 'site' });
  prisma.shopWorkOrderItem.findFirst.mockResolvedValue({ itemNumber: 1 });
  prisma.shopWorkOrderItem.findMany.mockResolvedValue([{ serialNumber: 'SYNTHETIC-061', equipmentCategory: 'fire_extinguisher', serializedEquipmentId: 'asset' }]);
  prisma.shopWorkOrderItem.create.mockResolvedValue({ id: 'new', serialNumber: 'SYNTHETIC-061' });
  prisma.$transaction.mockImplementation(fn => fn(prisma));
});

describe('add units duplicate protection', () => {
  it('retains the cross-order custody check after locking the target order', async () => {
    prisma.shopWorkOrderItem.findFirst.mockResolvedValue({ id: 'unit-on-another-open-order' });
    const route = shopOrdersRouter.stack.find(l => l.route?.path === '/:id/items' && l.route?.methods.post)!.route;
    const next = vi.fn();
    await route.stack[1].handle({ params: { id: 'wo' }, body: { items: [{ serialNumber: 'SYNTHETIC-NEW', equipmentCategory: 'fire_extinguisher' }] }, user: { userId: 'tech' } }, {}, next);
    expect(next.mock.calls[0]?.[0]).toMatchObject({ statusCode: 409, message: 'Serial number already belongs to an open work order' });
    expect(prisma.$queryRaw).toHaveBeenCalled();
    expect(prisma.$executeRaw).toHaveBeenCalled();
    expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(prisma.$executeRaw.mock.invocationCallOrder[0]);
    expect(prisma.shopWorkOrderItem.create).not.toHaveBeenCalled();
    expect(prisma.shopWorkOrder.update).not.toHaveBeenCalled();
  });

  it('rejects invalid intake data while retaining the order lock', async () => {
    const route = shopOrdersRouter.stack.find(l => l.route?.path === '/:id/items' && l.route?.methods.post)!.route;
    const next = vi.fn();
    await route.stack[1].handle({ params: { id: 'wo' }, body: { items: [{ serialNumber: 'SYNTHETIC-NEW', equipmentCategory: 'invalid-category' }] }, user: { userId: 'tech' } }, {}, next);
    expect(next.mock.calls[0]?.[0]).toMatchObject({ statusCode: 400, message: 'Invalid equipmentCategory' });
    expect(prisma.$queryRaw).toHaveBeenCalled();
    expect(prisma.shopWorkOrderItem.create).not.toHaveBeenCalled();
  });

  it.each([
    { serialNumber: 'SYNTHETIC-061', equipmentCategory: 'fire_extinguisher' },
    { serialNumber: ' synthetic-061 ', equipmentCategory: 'fire_extinguisher' },
    { serialNumber: 'renamed', equipmentCategory: 'fire_extinguisher', serializedEquipmentId: 'asset' },
  ])('rejects an existing unit without creating another chargeable copy: %j', async item => {
    const route = shopOrdersRouter.stack.find(l => l.route?.path === '/:id/items' && l.route?.methods.post)!.route;
    const next = vi.fn();
    await route.stack[1].handle({ params: { id: 'wo' }, body: { items: [item] }, user: { userId: 'tech' } }, {}, next);
    expect(prisma.shopWorkOrderItem.create).not.toHaveBeenCalled();
    expect(next.mock.calls[0]?.[0]).toMatchObject({ statusCode: 409 });
  });
});
