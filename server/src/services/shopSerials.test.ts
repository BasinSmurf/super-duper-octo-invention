import { describe, expect, it, vi } from 'vitest';
import { assertShopSerialsCollected } from './shopSerials.js';

describe('serial collection before QA and handover', () => {
  it('includes failed, condemned and child pieces in the collection requirement', async () => {
    const prisma = { shopWorkOrderItem: { findMany: vi.fn().mockResolvedValue([
      { id: 'ready', itemNumber: 1, serialNumber: 'SN-1' },
      { id: 'condemned', itemNumber: 2, serialNumber: '  ' },
      { id: 'child', itemNumber: 3, serialNumber: '' },
    ]) } };
    await expect(assertShopSerialsCollected(prisma as never, 'wo')).rejects.toThrow(/piece 2, piece 3/);
    expect(prisma.shopWorkOrderItem.findMany.mock.calls[0][0].where).toEqual({ workOrderId: 'wo' });
  });

  it('allows previously collected serials and scopes per-unit QA to its assembly', async () => {
    const prisma = { shopWorkOrderItem: { findMany: vi.fn().mockResolvedValue([
      { id: 'parent', itemNumber: 1, serialNumber: 'SN-1' },
      { id: 'child', itemNumber: 2, serialNumber: 'SN-2' },
    ]) } };
    await expect(assertShopSerialsCollected(prisma as never, 'wo', ['parent'])).resolves.toBeUndefined();
    expect(prisma.shopWorkOrderItem.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {
      workOrderId: 'wo', OR: [{ id: { in: ['parent'] } }, { parentItemId: { in: ['parent'] } }],
    } }));
  });
});
