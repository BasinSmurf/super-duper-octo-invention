import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = vi.hoisted(() => ({
  shopWorkOrderItem: { findMany: vi.fn(), update: vi.fn() },
  shopWorkOrder: { findUnique: vi.fn(), update: vi.fn() },
  shopItemStatusLog: { create: vi.fn() },
  $transaction: vi.fn(), $queryRaw: vi.fn(),
}));
vi.mock('../db.js', async importOriginal => ({ ...await importOriginal<typeof import('../db.js')>(), ...(() => ({ prisma }))() }));
vi.mock('../utils/auditLog.js', () => ({ createAuditLog: vi.fn() }));
vi.mock('../utils/companyGuards.js', () => ({ assertShopReturnAllowed: vi.fn() }));
import { recomputeWOStatus, shopOrdersRouter } from './shopOrders.js';

beforeEach(() => {
  vi.clearAllMocks();
  prisma.shopWorkOrder.findUnique.mockResolvedValue({ id: 'wo', status: 'in_progress' });
  prisma.$transaction.mockImplementation(async (run) => run(prisma));
});

describe('work orders with condemned items', () => {
  it.each([
    ['condemned'],
    ['condemned', 'shop_complete'],
    ['condemned', 'returned'],
  ])('allows pickup once work is final: %j', async (...statuses) => {
    prisma.shopWorkOrderItem.findMany.mockResolvedValue(statuses.map(status => ({ status })));
    await recomputeWOStatus('wo');
    expect(prisma.shopWorkOrder.update).toHaveBeenCalledWith({
      where: { id: 'wo' },
      data: { status: 'complete', completedItems: statuses.length, completedDate: expect.any(Date) },
    });
  });

  it('keeps unfinished work open', async () => {
    prisma.shopWorkOrderItem.findMany.mockResolvedValue([{ status: 'condemned', serialNumber: 'SN-1' }, { status: 'in_work', serialNumber: 'SN-2' }]);
    await recomputeWOStatus('wo');
    expect(prisma.shopWorkOrder.update).toHaveBeenCalledWith({
      where: { id: 'wo' }, data: { status: 'in_progress', completedItems: 1 },
    });
  });

  async function release() {
    const route = shopOrdersRouter.stack.find(layer => layer.route?.path === '/:id/release')!.route;
    const next = vi.fn();
    await route.stack[0].handle({ params: { id: 'wo' }, body: { pickupSignedByName: 'Customer', pickupSignature: 'signature' }, user: { userId: 'user' } }, { json: vi.fn() }, next);
    return next;
  }

  it.each([false, true])('releases final items and preserves condemned disposition (all condemned: %s)', async allCondemned => {
    const ready = { serialNumber: 'SN-1', itemNumber: 1, id: 'ready', status: 'shop_complete', equipmentCategory: 'other', parentItemId: null };
    const condemned = { serialNumber: 'SN-2', itemNumber: 2, id: 'dead', status: 'condemned', equipmentCategory: 'fire_extinguisher', parentItemId: null };
    prisma.shopWorkOrder.findUnique.mockResolvedValue({ id: 'wo', status: 'complete' });
    prisma.shopWorkOrderItem.findMany.mockResolvedValueOnce(allCondemned ? [condemned] : [ready, condemned])
      .mockResolvedValueOnce(allCondemned ? [condemned] : [ready, condemned])
      .mockResolvedValueOnce(allCondemned ? [] : [ready])
      .mockResolvedValueOnce(allCondemned ? [condemned] : [{ status: 'returned' }, condemned]);
    prisma.shopWorkOrder.update.mockImplementation(async ({ data }) => {
      if (data.status === 'closed') prisma.shopWorkOrder.findUnique.mockResolvedValue({ id: 'wo', status: 'closed' });
      return data;
    });
    expect(await release()).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).toHaveBeenCalledOnce();
    expect(prisma.shopWorkOrderItem.findMany).toHaveBeenNthCalledWith(3, {
      where: { workOrderId: 'wo', status: { notIn: ['returned', 'condemned'] } },
      select: { id: true, status: true, equipmentCategory: true, parentItemId: true },
    });
    expect(prisma.shopWorkOrderItem.update).toHaveBeenCalledTimes(allCondemned ? 0 : 1);
    expect(prisma.shopWorkOrder.update).toHaveBeenLastCalledWith({ where: { id: 'wo' }, data: { completedItems: allCondemned ? 1 : 2 } });
  });

  it('still blocks release when an item needs work', async () => {
    prisma.shopWorkOrderItem.findMany.mockResolvedValue([{ status: 'condemned', serialNumber: 'SN-1' }, { status: 'in_work', serialNumber: 'SN-2' }]);
    expect(await release()).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 409 }));
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rechecks unfinished items under row locks', async () => {
    prisma.shopWorkOrderItem.findMany.mockResolvedValueOnce([{ status: 'condemned', serialNumber: 'SN-1' }])
      .mockResolvedValueOnce([{ status: 'condemned' }])
      .mockResolvedValueOnce([{ id: 'changed', status: 'in_work' }]);
    expect(await release()).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 409 }));
    expect(prisma.shopWorkOrderItem.update).not.toHaveBeenCalled();
  });
  it('blocks release even when the only missing serial belongs to a condemned piece', async () => {
    prisma.shopWorkOrderItem.findMany.mockResolvedValue([
      { id: 'ready', itemNumber: 1, serialNumber: 'SN-1' },
      { id: 'condemned', itemNumber: 2, serialNumber: '' },
    ]);
    const route = shopOrdersRouter.stack.find(layer => layer.route?.path === '/:id/release')!.route;
    const next = vi.fn();
    await route.stack[0].handle({ params: { id: 'wo' }, body: { pickupSignedByName: 'Customer', pickupSignature: 'signature' }, user: { userId: 'user' } }, { json: vi.fn() }, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 409, message: expect.stringContaining('piece 2') }));
    expect(prisma.shopWorkOrderItem.update).not.toHaveBeenCalled();
    expect(prisma.shopWorkOrder.update).not.toHaveBeenCalled();
  });
});