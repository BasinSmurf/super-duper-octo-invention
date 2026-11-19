import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = vi.hoisted(() => ({
  shopWorkOrderItem: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn() },
  shopWorkOrder: { findUnique: vi.fn(), update: vi.fn() },
  attachment: { count: vi.fn() },
  equipmentInspection: { findFirst: vi.fn(), create: vi.fn() },
  shopItemStatusLog: { create: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock('../db.js', async importOriginal => ({ ...await importOriginal<typeof import('../db.js')>(), ...(() => ({ prisma }))() }));
vi.mock('../services/blueLionEnqueue.js', () => ({ enqueueInspectionRecord: vi.fn().mockResolvedValue(undefined) }));
import { enqueueInspectionRecord } from '../services/blueLionEnqueue.js';
import { shopOrdersRouter } from './shopOrders.js';

function completedItem(overrides = {}) {
  return {
    id: 'unit', workOrderId: 'wo', itemNumber: 1, status: 'shop_complete',
    serialNumber: 'SYNTHETIC-1', serializedEquipmentId: null,
    equipmentCategory: 'fire_extinguisher', parentItemId: null,
    softClosedAt: new Date(), hardClosesAt: new Date(Date.now() + 3_600_000), closedById: 'tech',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.shopWorkOrderItem.findUnique.mockResolvedValue(completedItem());
  prisma.shopWorkOrderItem.findMany.mockImplementation(async ({ where }) => {
    if (where.parentItemId) return [];
    return [completedItem({ status: 'condemned' })];
  });
  prisma.shopWorkOrderItem.update.mockResolvedValue(completedItem({ status: 'condemned' }));
  prisma.shopWorkOrder.findUnique.mockResolvedValue({ id: 'wo', status: 'complete' });
  prisma.attachment.count.mockResolvedValue(1);
  prisma.equipmentInspection.findFirst.mockResolvedValue(null);
  prisma.equipmentInspection.create.mockResolvedValue({ id: 'condemn-inspection' });
  prisma.$transaction.mockImplementation(run => run(prisma));
});

async function condemn(userId = 'tech', role = 'tech') {
  const route = shopOrdersRouter.stack.find(layer => layer.route?.path === '/:id/items/:itemId/status')!.route;
  const next = vi.fn(), json = vi.fn();
  await route.stack[0].handle({
    params: { id: 'wo', itemId: 'unit' }, body: { status: 'condemned' }, user: { userId, role },
  }, { json }, next);
  return { next, json };
}

describe('condemning a completed unit before pickup', () => {
  it.each(['received', 'awaiting_parts', 'awaiting_approval', 'warranty_out', 'outside_service'])('allows an evidenced condemnation from %s', async status => {
    prisma.shopWorkOrderItem.findUnique.mockResolvedValue(completedItem({ status, softClosedAt: null, hardClosesAt: null, closedById: null }));
    const { next } = await condemn();
    expect(next).not.toHaveBeenCalled();
    expect(prisma.equipmentInspection.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ outcome: 'condemn' }) }));
  });

  it.each([['tech', 'tech'], ['supervisor', 'field_super']])('allows %s during the correction window with evidence', async (userId, role) => {
    const { next, json } = await condemn(userId, role);
    expect(next).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ status: 'condemned' }));
    expect(prisma.equipmentInspection.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ outcome: 'condemn', shopItemId: 'unit', lockedAt: expect.any(Date) }),
    }));
    expect(enqueueInspectionRecord).toHaveBeenCalledWith('condemn-inspection');
    expect(prisma.shopItemStatusLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      fromStatus: 'shop_complete', toStatus: 'condemned', changedById: userId,
    }) });
    // Correcting a disposition must preserve the existing close deadline/closer.
    const data = prisma.shopWorkOrderItem.update.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('softClosedAt');
    expect(data).not.toHaveProperty('hardClosesAt');
    expect(data).not.toHaveProperty('closedById');
    expect(prisma.shopWorkOrder.update).toHaveBeenCalledWith({
      where: { id: 'wo' }, data: { status: 'complete', completedItems: 1 },
    });
  });

  it('still requires evidence before creating a condemn inspection or changing status', async () => {
    prisma.attachment.count.mockResolvedValue(0);
    const { next } = await condemn();
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 409, message: expect.stringContaining('without evidence') }));
    expect(prisma.equipmentInspection.create).not.toHaveBeenCalled();
    expect(prisma.shopWorkOrderItem.update).not.toHaveBeenCalled();
  });

  it('still blocks edits by another technician', async () => {
    const { next } = await condemn('other-tech');
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 409, message: expect.stringContaining('closed by someone else') }));
    expect(prisma.shopWorkOrderItem.update).not.toHaveBeenCalled();
  });

  it('still requires an admin reopen after hard close', async () => {
    prisma.shopWorkOrderItem.findUnique.mockResolvedValue(completedItem({ hardClosesAt: new Date(Date.now() - 1) }));
    const { next } = await condemn('admin', 'platform_admin');
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 409, message: expect.stringContaining('record is final') }));
    expect(prisma.shopWorkOrderItem.update).not.toHaveBeenCalled();
  });

  it('does not allow condemning an already returned unit', async () => {
    prisma.shopWorkOrderItem.findUnique.mockResolvedValue(completedItem({ status: 'returned' }));
    const { next } = await condemn();
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    expect(prisma.shopWorkOrderItem.update).not.toHaveBeenCalled();
  });
});
