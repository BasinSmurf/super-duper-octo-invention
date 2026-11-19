/**
 * claimService.ts — a tech claiming a shop work order item.
 *
 * "Claim" is the receiving-kiosk action: a tech takes a unit sitting in
 * Received and starts working it. Assigns the tech and moves the item
 * Received → In Work. Also used by managers force-claiming from the web UI.
 */

import { prisma } from '../db.js';
import { AppError } from '../middleware/errorHandler.js';
import { canTransitionShopItem } from './shopStateMachine.js';
import { recomputeWOStatus } from '../routes/shopOrders.js';

export async function claimShopItem(
  itemId: string,
  techUserId: string,
): Promise<{ itemId: string; status: string; assignedToName: string }> {
  const item = await prisma.shopWorkOrderItem.findUnique({
    where: { id: itemId },
    select: { id: true, status: true, workOrderId: true },
  });
  if (!item) throw new AppError(404, 'Item not found');
  if (item.status !== 'received') {
    throw new AppError(409, 'Only items still in Received can be claimed');
  }
  if (!canTransitionShopItem('received', 'in_work')) {
    throw new AppError(409, 'Item cannot move to In Work');
  }

  const tech = await prisma.user.findUnique({
    where: { id: techUserId },
    select: { id: true, name: true, isActive: true },
  });
  if (!tech || !tech.isActive) throw new AppError(400, 'Unknown or inactive tech');

  await prisma.$transaction(async (tx) => {
    await tx.shopWorkOrderItem.update({
      where: { id: itemId },
      data: { status: 'in_work', assignedToId: techUserId },
    });
    await tx.shopItemStatusLog.create({
      data: {
        itemId,
        fromStatus: 'received',
        toStatus: 'in_work',
        changedById: techUserId,
        notes: 'Claimed',
        location: 'Basin Shop',
      },
    });
  });

  // Item left Received → the WO is now in progress.
  await recomputeWOStatus(item.workOrderId);

  return { itemId, status: 'in_work', assignedToName: tech.name };
}

/**
 * Batch claim — the kiosk squashes a job's Received units into one tile, so
 * claiming takes the whole pile (e.g. 100 pcs) to one tech in a single tap.
 * Only items still in Received are moved; anything already claimed is skipped.
 */
export async function claimShopItems(
  itemIds: string[],
  techUserId: string,
): Promise<{ claimedCount: number; assignedToName: string }> {
  if (!itemIds.length) throw new AppError(400, 'No items to claim');
  if (!canTransitionShopItem('received', 'in_work')) {
    throw new AppError(409, 'Item cannot move to In Work');
  }

  const tech = await prisma.user.findUnique({
    where: { id: techUserId },
    select: { id: true, name: true, isActive: true },
  });
  if (!tech || !tech.isActive) throw new AppError(400, 'Unknown or inactive tech');

  const items = await prisma.shopWorkOrderItem.findMany({
    where: { id: { in: itemIds }, status: 'received' },
    select: { id: true, workOrderId: true },
  });
  if (!items.length) throw new AppError(409, 'None of these items are still in Received');

  await prisma.$transaction(async (tx) => {
    await tx.shopWorkOrderItem.updateMany({
      where: { id: { in: items.map(i => i.id) } },
      data: { status: 'in_work', assignedToId: techUserId },
    });
    await tx.shopItemStatusLog.createMany({
      data: items.map(i => ({
        itemId: i.id,
        fromStatus: 'received' as const,
        toStatus: 'in_work' as const,
        changedById: techUserId,
        notes: 'Claimed',
        location: 'Basin Shop',
      })),
    });
  });

  // One recompute per affected work order.
  for (const woId of new Set(items.map(i => i.workOrderId))) {
    await recomputeWOStatus(woId);
  }

  return { claimedCount: items.length, assignedToName: tech.name };
}
