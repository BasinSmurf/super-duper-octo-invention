/**
 * boards.ts — per-site shop kanban + admin-tunable board config.
 *
 *   GET /api/boards/:siteSlug                       full site board
 *   GET /api/boards/:siteSlug/station/:stationFilter single-column slice
 *   GET /api/board-config                            current aging thresholds
 *   PUT /api/board-config                            update thresholds (admin)
 *
 * Board reads accept either a logged-in manager or a kiosk token.
 *
 * `?scope=customer|internal|all` splits the site board into the two halves of
 * the shop. The full board defaults to `customer` (matching the wall board it
 * replaces); the station slice defaults to `all`, because a bench works
 * whatever is physically in front of it regardless of who owns the gear.
 */

import { Router, Request, Response } from 'express';
import { prisma } from '../index.js';
import { AppError } from '../middleware/errorHandler.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { authenticateUserOrKiosk } from '../middleware/kioskAuth.js';
import {
  boardItemInclude,
  buildBoard,
  getAgingThresholds,
  getColumnColors,
  parseBoardScope,
  scopeWhere,
  DEFAULT_AGING_THRESHOLDS,
  type BoardScope,
} from '../services/shopBoard.js';

// Display columns that may carry a color override, and the hex format we accept.
// 'qa_testing' left the wall board with WI-01 (Re-Test folded into In Service)
// and 'received' left with the board split (intake is not a stage the wall
// needs its own column for — it folds into In Service too). Overrides already
// stored under either key are inert: the client merges overrides over its own
// defaults and never looks a dead key up.
const THEMEABLE_COLUMNS = new Set([
  'incoming', 'in_service', 'on_hold', 'ready_pickup', 'departing',
]);
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export const boardsRouter = Router();
export const boardConfigRouter = Router();

async function siteBySlug(slug: string) {
  const site = await prisma.site.findUnique({ where: { shortCode: slug.toUpperCase() } });
  if (!site) throw new AppError(404, `No site with code "${slug}"`);
  return site;
}

async function loadSiteBoard(siteId: string, scope: BoardScope) {
  const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  const orderBy = [
    { workOrder: { priority: 'asc' as const } },
    { createdAt: 'asc' as const },
  ];
  const [atSite, incoming, thresholds] = await Promise.all([
    // Items physically at this site (+ recently returned for the closed count).
    // SCBA sub-components are filtered out — they're not physical pieces.
    prisma.shopWorkOrderItem.findMany({
      where: {
        siteId,
        parentItemId: null,
        ...scopeWhere(scope),
        OR: [
          { status: { not: 'returned' } },
          { status: 'returned', updatedAt: { gte: fourteenDaysAgo } },
        ],
      },
      include: boardItemInclude,
      orderBy,
    }),
    // Items in transit toward this site (Incoming column). Per-item now: an
    // item with an open transfer event whose destination is this site.
    prisma.shopWorkOrderItem.findMany({
      where: {
        status: { not: 'returned' },
        parentItemId: null,
        ...scopeWhere(scope),
        transferItems: { some: { event: { receivedAt: null, toSiteId: siteId } } },
      },
      include: boardItemInclude,
      orderBy,
    }),
    getAgingThresholds(),
  ]);
  return buildBoard([...atSite, ...incoming], thresholds, siteId);
}

// GET /api/boards/:siteSlug
boardsRouter.get('/:siteSlug', authenticateUserOrKiosk, async (req: Request, res: Response, next) => {
  try {
    const site = await siteBySlug(req.params.siteSlug as string);
    const scope = parseBoardScope(req.query.scope, 'customer');
    const [board, columnColors] = await Promise.all([loadSiteBoard(site.id, scope), getColumnColors()]);
    res.json({
      generatedAt: new Date().toISOString(),
      site: { id: site.id, name: site.name, shortCode: site.shortCode },
      scope,
      theme: { columnColors },
      ...board,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/boards/:siteSlug/station/:stationFilter
boardsRouter.get(
  '/:siteSlug/station/:stationFilter',
  authenticateUserOrKiosk,
  async (req: Request, res: Response, next) => {
    try {
      const site = await siteBySlug(req.params.siteSlug as string);
      const stationFilter = req.params.stationFilter as string;
      const scope = parseBoardScope(req.query.scope, 'all');
      const [board, columnColors] = await Promise.all([loadSiteBoard(site.id, scope), getColumnColors()]);
      res.json({
        generatedAt: new Date().toISOString(),
        site: { id: site.id, name: site.name, shortCode: site.shortCode },
        stationFilter,
        scope,
        theme: { columnColors },
        cards: board.cards.filter(c => c.column === stationFilter),
        summary: board.summary,
      });
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/board-config
boardConfigRouter.get('/', authenticate, async (_req: Request, res: Response, next) => {
  try {
    const cfg = await prisma.boardConfig.findFirst();
    res.json({
      agingThresholds: cfg?.agingThresholds ?? DEFAULT_AGING_THRESHOLDS,
      defaults: DEFAULT_AGING_THRESHOLDS,
      columnColors: cfg?.columnColors ?? {},
    });
  } catch (err) {
    next(err);
  }
});

// PUT /api/board-config — admin. Accepts agingThresholds and/or columnColors;
// each is validated and updated independently so a colors-only or
// thresholds-only save both work.
boardConfigRouter.put('/', authenticate, requirePermission('system:config'), async (req: Request, res: Response, next) => {
  try {
    const { agingThresholds, columnColors } = req.body;
    if (agingThresholds === undefined && columnColors === undefined) {
      throw new AppError(400, 'agingThresholds or columnColors is required');
    }

    const data: { agingThresholds?: Record<string, number>; columnColors?: Record<string, string | null> } = {};

    if (agingThresholds !== undefined) {
      if (!agingThresholds || typeof agingThresholds !== 'object') {
        throw new AppError(400, 'agingThresholds must be an object');
      }
      const clean: Record<string, number> = {};
      for (const [key, value] of Object.entries(agingThresholds)) {
        const n = Number(value);
        if (Number.isFinite(n) && n > 0) clean[key] = n;
      }
      data.agingThresholds = clean;
    }

    if (columnColors !== undefined) {
      if (!columnColors || typeof columnColors !== 'object') {
        throw new AppError(400, 'columnColors must be an object');
      }
      const clean: Record<string, string | null> = {};
      for (const [key, value] of Object.entries(columnColors)) {
        if (!THEMEABLE_COLUMNS.has(key)) continue; // ignore unknown columns
        if (value === null) { clean[key] = null; continue; } // explicit neutral
        if (typeof value === 'string' && HEX_RE.test(value)) { clean[key] = value.toLowerCase(); continue; }
        throw new AppError(400, `Invalid color for "${key}" — expected #rrggbb or null`);
      }
      data.columnColors = clean;
    }

    const existing = await prisma.boardConfig.findFirst();
    const cfg = existing
      ? await prisma.boardConfig.update({ where: { id: existing.id }, data })
      // Seed aging thresholds on first create so the row is always complete.
      : await prisma.boardConfig.create({ data: { agingThresholds: DEFAULT_AGING_THRESHOLDS, ...data } });
    res.json({ agingThresholds: cfg.agingThresholds, columnColors: cfg.columnColors ?? {} });
  } catch (err) {
    next(err);
  }
});
