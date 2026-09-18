/**
 * All-sites Shop Kanban board endpoint.
 *
 * Served at /api/shop-board. View-only — no actions live here. Gated by
 * authenticateUserOrKiosk so a wall tablet can render it with a provisioned
 * kiosk token (X-Kiosk-Token) and managers with their JWT, but it isn't open
 * to the public internet (ServicePRO is public-facing via Google SSO). This
 * is the all-sites board; per-site boards live at /api/boards/:siteSlug.
 * Card-building logic is shared (services/shopBoard).
 *
 * `?scope=` splits the shop in two: `customer` (the default — paying-customer
 * work, which is what this board has always shown in practice) and `internal`
 * (Basin's own gear). `all` is still accepted for anyone who wants the union.
 */

import { Router, Request, Response } from 'express';
import { prisma } from '../index.js';
import { authenticateUserOrKiosk } from '../middleware/kioskAuth.js';
import {
  boardItemInclude, buildBoard, getAgingThresholds, getColumnColors,
  parseBoardScope, scopeWhere,
} from '../services/shopBoard.js';

export const shopBoardPublicRouter = Router();

shopBoardPublicRouter.get('/', authenticateUserOrKiosk, async (req: Request, res: Response, next) => {
  try {
    const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const scope = parseBoardScope(req.query.scope, 'customer');

    const items = await prisma.shopWorkOrderItem.findMany({
      where: {
        // SCBA sub-components don't represent physical pieces — exclude them.
        parentItemId: null,
        ...scopeWhere(scope),
        OR: [
          { status: { not: 'returned' } },
          { status: 'returned', updatedAt: { gte: fourteenDaysAgo } },
        ],
      },
      include: boardItemInclude,
      orderBy: [{ workOrder: { priority: 'asc' } }, { createdAt: 'asc' }],
    });

    const [thresholds, columnColors] = await Promise.all([getAgingThresholds(), getColumnColors()]);
    const board = buildBoard(items, thresholds);

    res.json({ generatedAt: new Date().toISOString(), scope, theme: { columnColors }, ...board });
  } catch (err) {
    next(err);
  }
});
