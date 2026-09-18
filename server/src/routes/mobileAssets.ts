import { Router, Request, Response } from 'express';
import { prisma } from '../index.js';
import { AppError } from '../middleware/errorHandler.js';
import { requirePermission } from '../middleware/rbac.js';

// Thin, standalone, operator-agnostic named assets (rigs, air trailers) —
// see MobileAsset in schema.prisma. Deliberately no operator/company
// scoping, no approval queue: a field tech should be able to search or add
// one in a couple of taps.
export const mobileAssetsRouter = Router();

// GET /api/mobile-assets?kind=rig&search=...
mobileAssetsRouter.get('/', requirePermission('locations:request'), async (req: Request, res: Response, next) => {
  try {
    const { kind, search, active } = req.query;
    const where: Record<string, unknown> = {};
    if (kind) where.kind = kind as string;
    if (search) where.name = { contains: search as string, mode: 'insensitive' };
    if (active !== undefined) where.isActive = active === 'true';
    else where.isActive = true;

    const data = await prisma.mobileAsset.findMany({
      where,
      orderBy: { name: 'asc' },
      take: 50,
    });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// GET /api/mobile-assets/:id — used to hydrate a picker from a stored id
// (e.g. re-opening a ticket that already has a presentRigId) without a
// name-search round-trip.
mobileAssetsRouter.get('/:id', requirePermission('locations:request'), async (req: Request, res: Response, next) => {
  try {
    const mobileAsset = await prisma.mobileAsset.findUnique({ where: { id: req.params.id as string } });
    if (!mobileAsset) throw new AppError(404, 'Not found');
    res.json(mobileAsset);
  } catch (err) {
    next(err);
  }
});

// POST /api/mobile-assets — { name, kind }
mobileAssetsRouter.post('/', requirePermission('locations:request'), async (req: Request, res: Response, next) => {
  try {
    const { name, kind } = req.body;
    if (typeof name !== 'string' || !name.trim()) throw new AppError(400, 'name is required');
    if (kind !== 'rig' && kind !== 'air_trailer') throw new AppError(400, "kind must be 'rig' or 'air_trailer'");

    const mobileAsset = await prisma.mobileAsset.create({
      data: { name: name.trim(), kind },
    });
    res.status(201).json(mobileAsset);
  } catch (err) {
    next(err);
  }
});
