import { Router, Request, Response } from 'express';
import { prisma } from '../db.js';
import { AppError } from '../middleware/errorHandler.js';
import { requirePermission } from '../middleware/rbac.js';
import { createAuditLog } from '../utils/auditLog.js';

export const salesTaxRatesRouter = Router();

// GET / — list jurisdictions. Read-open to any authenticated user (drives the
// invoice editor + Direct Sale dropdowns). ?activeOnly=1 to hide retired rows.
salesTaxRatesRouter.get('/', async (req: Request, res: Response) => {
  const activeOnly = req.query.activeOnly === '1' || req.query.activeOnly === 'true';
  const rates = await prisma.salesTaxRate.findMany({
    where: activeOnly ? { active: true } : undefined,
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  });
  res.json({ data: rates });
});

// POST / — create a jurisdiction (billing/admin).
salesTaxRatesRouter.post('/', requirePermission('billing:profiles'), async (req: Request, res: Response) => {
  const { id, name, rate, county, isCountyDefault, qbTaxItemName, active, sortOrder } = req.body;
  if (!id || !name || rate == null) throw new AppError(400, 'id, name, and rate are required');
  if (Number(rate) < 0 || Number(rate) > 1) throw new AppError(400, 'rate must be a decimal between 0 and 1 (e.g. 0.05 for 5%)');

  const created = await prisma.salesTaxRate.create({
    data: {
      id: String(id).trim(),
      name: String(name).trim(),
      rate: Number(rate),
      county: county?.trim() || null,
      isCountyDefault: !!isCountyDefault,
      qbTaxItemName: qbTaxItemName?.trim() || null,
      active: active ?? true,
      sortOrder: sortOrder ?? 0,
    },
  });
  await createAuditLog({
    userId: (req as any).user?.id,
    entityType: 'sales_tax_rate',
    entityId: created.id,
    action: 'create',
    changes: { name: created.name, rate: created.rate.toString() },
    ipAddress: req.ip,
  });
  res.status(201).json(created);
});

// PUT /:id — update a jurisdiction (billing/admin).
salesTaxRatesRouter.put('/:id', requirePermission('billing:profiles'), async (req: Request, res: Response) => {
  const { name, rate, county, isCountyDefault, qbTaxItemName, active, sortOrder } = req.body;
  if (rate != null && (Number(rate) < 0 || Number(rate) > 1)) {
    throw new AppError(400, 'rate must be a decimal between 0 and 1 (e.g. 0.05 for 5%)');
  }
  const existing = await prisma.salesTaxRate.findUnique({ where: { id: req.params.id as string } });
  if (!existing) throw new AppError(404, 'Tax jurisdiction not found');

  const updated = await prisma.salesTaxRate.update({
    where: { id: req.params.id as string },
    data: {
      name: name?.trim() ?? existing.name,
      rate: rate != null ? Number(rate) : existing.rate,
      county: county !== undefined ? (county?.trim() || null) : existing.county,
      isCountyDefault: isCountyDefault !== undefined ? !!isCountyDefault : existing.isCountyDefault,
      qbTaxItemName: qbTaxItemName !== undefined ? (qbTaxItemName?.trim() || null) : existing.qbTaxItemName,
      active: active !== undefined ? !!active : existing.active,
      sortOrder: sortOrder ?? existing.sortOrder,
    },
  });
  await createAuditLog({
    userId: (req as any).user?.id,
    entityType: 'sales_tax_rate',
    entityId: updated.id,
    action: 'update',
    changes: { name: updated.name, rate: updated.rate.toString(), active: updated.active },
    ipAddress: req.ip,
  });
  res.json(updated);
});

export default salesTaxRatesRouter;
