import type { PrismaClient } from '../db.js';
import { AppError } from '../middleware/errorHandler.js';

/** Includes children and terminal dispositions: every physical piece needs identity. */
export async function assertShopSerialsCollected(
  prisma: Pick<PrismaClient, 'shopWorkOrderItem'>,
  workOrderId: string,
  itemIds?: string[],
): Promise<void> {
  const items = await prisma.shopWorkOrderItem.findMany({
    where: {
      workOrderId,
      ...(itemIds ? { OR: [{ id: { in: itemIds } }, { parentItemId: { in: itemIds } }] } : {}),
    },
    select: { id: true, itemNumber: true, serialNumber: true },
  });
  const missing = items.filter(item => !item.serialNumber?.trim());
  if (missing.length) {
    throw new AppError(409, `Record a serial for every piece before QA, closing or return. Missing serials: ${missing.map(item => `piece ${item.itemNumber}`).join(', ')}`);
  }
}
