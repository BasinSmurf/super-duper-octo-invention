import { Router, Request, Response } from 'express';
import { prisma } from '../index.js';
import { AppError } from '../middleware/errorHandler.js';
import { requirePermission } from '../middleware/rbac.js';
import { createAuditLog } from '../utils/auditLog.js';

export const shopTransfersRouter = Router();

// Two-phase shop-to-shop transfers between Basin Sites (Phase 5), per-item.
//   initiate → chosen items (default: the whole WO) become "in transit";
//              items stay put, their tech claims are dropped.
//   receive  → just that shipment's items move to the destination Site.
// Per-item location truth lives on ShopWorkOrderItem.siteId. An item is "in
// transit" while it has a row on an unreceived ShopTransferEvent. The WO-level
// transitToSiteId cache is kept coherent (set only when the WHOLE WO is in
// transit to one site) for legacy consumers; events are the source of truth.

const STALE_TRANSFER_DAYS = parseInt(process.env.STALE_TRANSFER_DAYS || '3', 10);

/**
 * Recompute the WO-level transit cache from its items' open transfers. Sets
 * transitToSiteId only when every top-level item is in transit to the same
 * site; otherwise clears it (a partial transfer leaves the WO "mixed").
 */
async function syncWoTransitCache(
  tx: Pick<typeof prisma, 'shopWorkOrderItem' | 'shopWorkOrder'>,
  workOrderId: string,
) {
  const items = await tx.shopWorkOrderItem.findMany({
    where: { workOrderId, parentItemId: null },
    select: {
      transferItems: {
        where: { event: { receivedAt: null } },
        select: { event: { select: { toSiteId: true, transferredAt: true, transferredById: true } } },
      },
    },
  });
  if (items.length === 0) return;

  const dests = new Set<string>();
  let allInTransit = true;
  let initiatedAt: Date | null = null;
  let initiatedById: string | null = null;
  for (const it of items) {
    const open = it.transferItems[0]?.event;
    if (open) {
      dests.add(open.toSiteId);
      initiatedAt = open.transferredAt;
      initiatedById = open.transferredById ?? null;
    } else {
      allInTransit = false;
    }
  }

  const wholeWoOneDest = allInTransit && dests.size === 1;
  await tx.shopWorkOrder.update({
    where: { id: workOrderId },
    data: wholeWoOneDest
      ? { transitToSiteId: [...dests][0], transitInitiatedAt: initiatedAt, transitInitiatedById: initiatedById }
      : { transitToSiteId: null, transitInitiatedAt: null, transitInitiatedById: null },
  });
}

// GET /api/shop-transfers/stale — open transfers past the staleness threshold
shopTransfersRouter.get('/stale', requirePermission('reports:ops'), async (_req: Request, res: Response) => {
  const cutoff = new Date(Date.now() - STALE_TRANSFER_DAYS * 24 * 60 * 60 * 1000);
  const stale = await prisma.shopTransferEvent.findMany({
    where: { receivedAt: null, transferredAt: { lt: cutoff } },
    orderBy: { transferredAt: 'asc' },
    include: {
      fromSite: { select: { name: true, shortCode: true } },
      toSite: { select: { name: true, shortCode: true } },
      transferredBy: { select: { name: true } },
      transportedBy: { select: { name: true } },
      workOrder: { select: { id: true, workOrderNumber: true, company: { select: { name: true } } } },
      _count: { select: { items: true } },
    },
  });
  res.json({ thresholdDays: STALE_TRANSFER_DAYS, data: stale });
});

// GET /api/shop-transfers?workOrderId=… — transfer chain + per-item transit state
shopTransfersRouter.get('/', async (req: Request, res: Response) => {
  const workOrderId = req.query.workOrderId;
  if (typeof workOrderId !== 'string' || !workOrderId) {
    throw new AppError(400, 'workOrderId is required');
  }

  const [events, items, wo] = await Promise.all([
    prisma.shopTransferEvent.findMany({
      where: { workOrderId },
      orderBy: { transferredAt: 'asc' },
      include: {
        fromSite: { select: { id: true, name: true, shortCode: true } },
        toSite: { select: { id: true, name: true, shortCode: true } },
        transferredBy: { select: { id: true, name: true } },
        transportedBy: { select: { id: true, name: true } },
        receivedBy: { select: { id: true, name: true } },
        items: { select: { itemId: true } },
      },
    }),
    prisma.shopWorkOrderItem.findMany({
      where: { workOrderId, parentItemId: null },
      orderBy: { itemNumber: 'asc' },
      select: {
        id: true,
        itemNumber: true,
        serialNumber: true,
        equipmentDescription: true,
        equipmentCategory: true,
        siteId: true,
        transferItems: {
          where: { event: { receivedAt: null } },
          select: { event: { select: { id: true, toSiteId: true } } },
        },
      },
    }),
    prisma.shopWorkOrder.findUnique({
      where: { id: workOrderId },
      select: { intakeSiteId: true },
    }),
  ]);
  if (!wo) throw new AppError(404, 'Shop work order not found');

  const transfers = events.map(({ items: evItems, ...e }) => ({
    ...e,
    itemIds: evItems.map(i => i.itemId),
  }));

  const itemStates = items.map(it => ({
    id: it.id,
    itemNumber: it.itemNumber,
    serialNumber: it.serialNumber,
    equipmentDescription: it.equipmentDescription,
    equipmentCategory: it.equipmentCategory,
    siteId: it.siteId,
    inTransitToSiteId: it.transferItems[0]?.event.toSiteId ?? null,
    transferEventId: it.transferItems[0]?.event.id ?? null,
  }));

  res.json({ transfers, items: itemStates, intakeSiteId: wo.intakeSiteId });
});

// POST /api/shop-transfers — initiate a transfer of some or all of a WO's items
shopTransfersRouter.post('/', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const { workOrderId, toSiteId, notes, itemIds, transportedById } = req.body ?? {};
  if (typeof workOrderId !== 'string' || !workOrderId) {
    throw new AppError(400, 'workOrderId is required');
  }
  if (typeof toSiteId !== 'string' || !toSiteId) {
    throw new AppError(400, 'toSiteId is required');
  }

  // "Transported by" — optional; any active employee. Validate when present.
  let transportedId: string | null = null;
  if (transportedById !== undefined && transportedById !== null && transportedById !== '') {
    if (typeof transportedById !== 'string') throw new AppError(400, 'transportedById must be a user id');
    const transporter = await prisma.user.findUnique({
      where: { id: transportedById },
      select: { id: true, isActive: true },
    });
    if (!transporter || !transporter.isActive) {
      throw new AppError(400, 'transportedById does not match an active employee');
    }
    transportedId = transporter.id;
  }

  const allItems = await prisma.shopWorkOrderItem.findMany({
    where: { workOrderId, parentItemId: null },
    select: {
      id: true,
      siteId: true,
      transferItems: { where: { event: { receivedAt: null } }, select: { id: true } },
    },
  });
  if (allItems.length === 0) throw new AppError(400, 'Work order has no items to transfer');

  // Resolve the target items: explicit selection, or all not-yet-in-transit
  // items (the whole-WO default).
  let selected: typeof allItems;
  if (Array.isArray(itemIds) && itemIds.length > 0) {
    const wanted = new Set(itemIds.map(String));
    selected = allItems.filter(i => wanted.has(i.id));
    if (selected.length !== wanted.size) {
      throw new AppError(400, 'Some selected items do not belong to this work order');
    }
    if (selected.some(i => i.transferItems.length > 0)) {
      throw new AppError(409, 'Some selected items are already in transit');
    }
  } else {
    selected = allItems.filter(i => i.transferItems.length === 0);
  }
  if (selected.length === 0) throw new AppError(400, 'No transferable items selected');

  // One shipment = one source site.
  const fromSites = new Set(selected.map(i => i.siteId));
  if (fromSites.size > 1) {
    throw new AppError(400, 'Selected items are at different sites — transfer one site at a time');
  }
  const fromSiteId = [...fromSites][0];
  if (toSiteId === fromSiteId) throw new AppError(400, 'Items are already at that site');

  const dest = await prisma.site.findUnique({
    where: { id: toSiteId },
    select: { id: true, active: true },
  });
  if (!dest) throw new AppError(400, 'toSiteId does not match a known site');
  if (!dest.active) throw new AppError(400, 'Destination site is inactive');

  const now = new Date();
  const event = await prisma.$transaction(async (tx) => {
    const ev = await tx.shopTransferEvent.create({
      data: {
        workOrderId,
        fromSiteId,
        toSiteId,
        transferredById: userId,
        transportedById: transportedId,
        transferredAt: now,
        notes: notes ?? null,
        items: { create: selected.map(i => ({ itemId: i.id })) },
      },
    });
    // Mid-workflow handoff — the units are leaving; drop the source tech's claim.
    await tx.shopWorkOrderItem.updateMany({
      where: { id: { in: selected.map(i => i.id) }, assignedToId: { not: null } },
      data: { assignedToId: null },
    });
    await syncWoTransitCache(tx, workOrderId);
    return ev;
  });

  await createAuditLog({
    userId,
    action: 'create',
    entityType: 'shop_transfer_event',
    entityId: event.id,
    changes: { workOrderId, fromSiteId, toSiteId, itemCount: selected.length },
  });
  res.status(201).json(event);
});

// POST /api/shop-transfers/:id/receive — destination confirms the shipment arrived
shopTransfersRouter.post('/:id/receive', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const event = await prisma.shopTransferEvent.findUnique({
    where: { id: req.params.id as string },
    select: {
      id: true,
      workOrderId: true,
      toSiteId: true,
      receivedAt: true,
      items: { select: { itemId: true } },
    },
  });
  if (!event) throw new AppError(404, 'Transfer not found');
  if (event.receivedAt) throw new AppError(409, 'This transfer has already been received');

  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.shopTransferEvent.update({
      where: { id: event.id },
      data: { receivedAt: now, receivedById: userId },
    });
    const itemIds = event.items.map(i => i.itemId);
    if (itemIds.length > 0) {
      // Only this shipment's items move to the destination Site.
      await tx.shopWorkOrderItem.updateMany({
        where: { id: { in: itemIds } },
        data: { siteId: event.toSiteId },
      });
    } else {
      // Legacy event with no item links — fall back to whole-WO move.
      await tx.shopWorkOrderItem.updateMany({
        where: { workOrderId: event.workOrderId },
        data: { siteId: event.toSiteId },
      });
    }
    await syncWoTransitCache(tx, event.workOrderId);
  });

  await createAuditLog({
    userId,
    action: 'update',
    entityType: 'shop_transfer_event',
    entityId: event.id,
    changes: { received: true, toSiteId: event.toSiteId },
  });
  res.json({ ok: true, workOrderId: event.workOrderId, toSiteId: event.toSiteId });
});
