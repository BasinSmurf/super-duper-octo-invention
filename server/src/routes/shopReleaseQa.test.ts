import { beforeEach, describe, expect, it, vi } from 'vitest';
const prisma = vi.hoisted(() => ({
  shopWorkOrder: { findUnique: vi.fn(), update: vi.fn() },
  shopWorkOrderItem: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  equipmentInspection: { findMany: vi.fn() },
  shopQaUnitResult: { findMany: vi.fn() },
  shopItemStatusLog: { create: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock('../db.js', async importOriginal => ({ ...await importOriginal<typeof import('../db.js')>(), ...(() => ({ prisma }))() }));
vi.mock('../utils/companyGuards.js', () => ({ assertShopReturnAllowed: vi.fn() }));
import { shopOrdersRouter } from './shopOrders.js';

beforeEach(() => {
  vi.clearAllMocks();
  const item = { serialNumber: 'SN-1', itemNumber: 1, id: 'unit', workOrderId: 'wo', status: 'shop_complete', equipmentCategory: 'fire_extinguisher',
    parentItemId: null, closedById: 'tech', softClosedAt: new Date(), hardClosesAt: new Date(Date.now() + 3600000) };
  prisma.shopWorkOrder.findUnique.mockResolvedValue({ id: 'wo', status: 'complete' });
  prisma.shopWorkOrderItem.findMany.mockResolvedValue([item]);
  prisma.shopWorkOrderItem.findUnique.mockResolvedValue(item);
  prisma.equipmentInspection.findMany.mockResolvedValue([{ outcome: 'fail', serviceActions: [],
    data: { qaChecklist: { fex_shell_ok: true, all_components_clean: true } } }]);
  prisma.shopQaUnitResult.findMany.mockResolvedValue([]);
  prisma.$transaction.mockImplementation(fn => fn(prisma));
});

describe('pickup rechecks failed QA on previously ready units', () => {
  it.each([
    ['/:id/release', { pickupSignedByName: 'SYNTHETIC pickup', pickupSignature: 'synthetic-test-signature' }],
    ['/:id/bulk-return', { itemIds: ['unit'] }],
    ['/:id/items/:itemId/status', { status: 'returned' }],
  ])('rejects %s before returning any equipment', async (path, body) => {
    const route = shopOrdersRouter.stack.find(l => l.route?.path === path)!.route;
    const next = vi.fn(), json = vi.fn();
    await route.stack[0].handle({ params: { id: 'wo', itemId: 'unit' }, body, user: { userId: 'tech', role: 'platform_admin' } }, { json }, next);
    expect(next.mock.calls[0]?.[0]).toMatchObject({ statusCode: 409 });
    expect(prisma.shopWorkOrderItem.update).not.toHaveBeenCalled();
    expect(prisma.shopWorkOrder.update).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
  });
});
