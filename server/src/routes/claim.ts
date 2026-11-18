/**
 * claim.ts — receiving-kiosk claim flow.
 *
 *   GET  /api/claim/:siteSlug/queue   received jobs at a site + tech list
 *   GET  /api/claim/techs             active shop techs (for force-claim UI)
 *   GET  /api/claim/my-items          items assigned to the current user
 *   POST /api/claim/item/:itemId      claim a single item for a tech
 *   POST /api/claim/batch             claim a whole job's items for a tech
 *
 * Mounted without the global authenticate middleware: the claim kiosk has no
 * user login, so claim reads/writes accept a kiosk token OR a manager JWT.
 */

import { Router, Request, Response } from 'express';
import { prisma } from '../db.js';
import { AppError } from '../middleware/errorHandler.js';
import { authenticate } from '../middleware/auth.js';
import { authenticateUserOrKiosk } from '../middleware/kioskAuth.js';
import { claimShopItem, claimShopItems } from '../services/claimService.js';

export const claimRouter = Router();

// Shop-floor roles that can be assigned a job.
const TECH_ROLES = ['field_tech', 'field_super'] as const;

function listTechs() {
  return prisma.user.findMany({
    where: { isActive: true, role: { in: [...TECH_ROLES] } },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });
}

// GET /api/claim/techs
claimRouter.get('/techs', authenticateUserOrKiosk, async (_req: Request, res: Response, next) => {
  try {
    res.json({ data: await listTechs() });
  } catch (err) {
    next(err);
  }
});

// GET /api/claim/my-items — the signed-in tech's active jobs
claimRouter.get('/my-items', authenticate, async (req: Request, res: Response, next) => {
  try {
    const items = await prisma.shopWorkOrderItem.findMany({
      where: {
        assignedToId: req.user!.userId,
        status: { notIn: ['returned'] },
        // SCBA sub-components ride with the parent — only show top-level jobs.
        parentItemId: null,
      },
      include: {
        workOrder: {
          select: {
            id: true,
            workOrderNumber: true,
            priority: true,
            promisedDate: true,
            company: { select: { name: true } },
          },
        },
        product: { select: { name: true } },
        site: { select: { id: true, name: true, shortCode: true } },
      },
      orderBy: [{ workOrder: { priority: 'asc' } }, { updatedAt: 'desc' }],
    });
    res.json({ data: items });
  } catch (err) {
    next(err);
  }
});

// GET /api/claim/:siteSlug/queue — received jobs waiting to be claimed.
// Received items are squashed by work order so a 100-unit drop is one tile.
claimRouter.get('/:siteSlug/queue', authenticateUserOrKiosk, async (req: Request, res: Response, next) => {
  try {
    const site = await prisma.site.findUnique({
      where: { shortCode: (req.params.siteSlug as string).toUpperCase() },
      select: { id: true, name: true, shortCode: true },
    });
    if (!site) throw new AppError(404, `No site with code "${req.params.siteSlug}"`);

    const items = await prisma.shopWorkOrderItem.findMany({
      // SCBA sub-components aren't physical pieces — only top-level units claim.
      where: { siteId: site.id, status: 'received', parentItemId: null },
      include: {
        workOrder: {
          select: {
            id: true,
            workOrderNumber: true,
            priority: true,
            intakeDate: true,
            company: { select: { name: true } },
          },
        },
        product: { select: { name: true } },
      },
      orderBy: [{ workOrder: { priority: 'asc' } }, { createdAt: 'asc' }],
    });

    // One tile per work order (already priority-then-age ordered above).
    const byWo = new Map<string, typeof items>();
    for (const it of items) {
      const bucket = byWo.get(it.workOrderId);
      if (bucket) bucket.push(it);
      else byWo.set(it.workOrderId, [it]);
    }

    const jobs = [...byWo.values()].map((bucket) => {
      const head = bucket[0]!;
      const labels = new Set(
        bucket.map(it => it.product?.name || it.equipmentDescription || it.equipmentCategory || 'Item'),
      );
      const equipment = bucket.length === 1
        ? (head.product?.name || head.equipmentDescription || head.equipmentCategory || 'Item')
        : (labels.size === 1 ? [...labels][0]! : `${labels.size} types`);
      // Oldest unit in the pile is what the "waiting" clock should reflect.
      const oldest = bucket.reduce(
        (min, it) => (it.createdAt < min ? it.createdAt : min),
        head.createdAt,
      );
      return {
        id: head.workOrderId,
        workOrder: head.workOrder,
        equipment,
        serialNumber: bucket.length === 1 ? head.serialNumber : null,
        pieceCount: bucket.length,
        itemIds: bucket.map(it => it.id),
        createdAt: oldest.toISOString(),
      };
    });

    res.json({ generatedAt: new Date().toISOString(), site, jobs, techs: await listTechs() });
  } catch (err) {
    next(err);
  }
});

// POST /api/claim/item/:itemId — claim a single item for a tech (force-claim)
claimRouter.post('/item/:itemId', authenticateUserOrKiosk, async (req: Request, res: Response, next) => {
  try {
    const techUserId = req.body?.techUserId;
    if (typeof techUserId !== 'string' || !techUserId) {
      throw new AppError(400, 'techUserId is required');
    }
    const result = await claimShopItem(req.params.itemId as string, techUserId);
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});

// POST /api/claim/batch — claim a whole job's received items for a tech
claimRouter.post('/batch', authenticateUserOrKiosk, async (req: Request, res: Response, next) => {
  try {
    const techUserId = req.body?.techUserId;
    const itemIds = req.body?.itemIds;
    if (typeof techUserId !== 'string' || !techUserId) {
      throw new AppError(400, 'techUserId is required');
    }
    if (!Array.isArray(itemIds) || itemIds.some(id => typeof id !== 'string')) {
      throw new AppError(400, 'itemIds must be an array of strings');
    }
    const result = await claimShopItems(itemIds as string[], techUserId);
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});
