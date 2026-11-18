import { Router, Request, Response } from 'express';
import { prisma } from '../db.js';
import { AppError } from '../middleware/errorHandler.js';
import { requirePermission } from '../middleware/rbac.js';
import { createAuditLog } from '../utils/auditLog.js';

export const sitesRouter = Router();

// GET /api/sites — list sites. Available to any authenticated user since the
// top-bar site switcher needs it; pass ?active=true to hide soft-deleted ones.
sitesRouter.get('/', async (req: Request, res: Response, next) => {
  try {
    const where: { active?: boolean } = {};
    if (req.query.active !== undefined) where.active = req.query.active === 'true';
    const sites = await prisma.site.findMany({ where, orderBy: { name: 'asc' } });
    res.json({ data: sites });
  } catch (err) {
    next(err);
  }
});

// POST /api/sites — admin only.
sitesRouter.post('/', requirePermission('system:config'), async (req: Request, res: Response, next) => {
  try {
    const name = (req.body.name ?? '').trim();
    const shortCode = (req.body.shortCode ?? '').trim().toUpperCase();
    if (!name) throw new AppError(400, 'Name is required');
    if (!shortCode) throw new AppError(400, 'Short code is required');

    const site = await prisma.site.create({
      data: {
        name,
        shortCode,
        address: (req.body.address ?? '').trim() || null,
        timezone: (req.body.timezone ?? '').trim() || 'America/Chicago',
        active: req.body.active ?? true,
        salesTaxJurisdictionId: (req.body.salesTaxJurisdictionId ?? '').trim() || null,
      },
    });
    await createAuditLog({
      userId: req.user!.userId, entityType: 'site', entityId: site.id,
      action: 'create', changes: { name, shortCode }, ipAddress: req.ip,
    });
    res.status(201).json(site);
  } catch (err) {
    next(err);
  }
});

// PUT /api/sites/:id — admin only. Soft-delete via { active: false }.
sitesRouter.put('/:id', requirePermission('system:config'), async (req: Request, res: Response, next) => {
  try {
    const data: Record<string, unknown> = {};
    if (req.body.name !== undefined) {
      const name = (req.body.name ?? '').trim();
      if (!name) throw new AppError(400, 'Name cannot be empty');
      data.name = name;
    }
    if (req.body.shortCode !== undefined) {
      const shortCode = (req.body.shortCode ?? '').trim().toUpperCase();
      if (!shortCode) throw new AppError(400, 'Short code cannot be empty');
      data.shortCode = shortCode;
    }
    if (req.body.address !== undefined) data.address = (req.body.address ?? '').trim() || null;
    if (req.body.timezone !== undefined) data.timezone = (req.body.timezone ?? '').trim() || 'America/Chicago';
    if (req.body.active !== undefined) data.active = req.body.active;
    if (req.body.salesTaxJurisdictionId !== undefined) data.salesTaxJurisdictionId = (req.body.salesTaxJurisdictionId ?? '').trim() || null;

    const site = await prisma.site.update({ where: { id: req.params.id as string }, data });
    await createAuditLog({
      userId: req.user!.userId, entityType: 'site', entityId: site.id,
      action: 'update', changes: data as Record<string, string | boolean | null>, ipAddress: req.ip,
    });
    res.json(site);
  } catch (err) {
    next(err);
  }
});
