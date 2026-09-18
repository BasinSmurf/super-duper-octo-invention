import { Router, Request, Response } from 'express';
import { prisma } from '../index.js';
import { AppError } from '../middleware/errorHandler.js';
import { requirePermission } from '../middleware/rbac.js';
import { createAuditLog } from '../utils/auditLog.js';
import { sendZpl, testLabelZpl, sampleLabelZpl } from '../services/printing.js';

export const printersRouter = Router();

const OFFLINE_AFTER_MS = 5 * 60 * 1000; // master doc §9.7 — "not seen in >5 min"

// GET /api/printers — list. Available to any authenticated user because the
// reprint UI needs the printer dropdown; ?siteId / ?active filter.
printersRouter.get('/', async (req: Request, res: Response, next) => {
  try {
    const where: { active?: boolean; siteId?: string } = {};
    if (req.query.active !== undefined) where.active = req.query.active === 'true';
    if (req.query.siteId) where.siteId = String(req.query.siteId);

    const printers = await prisma.printer.findMany({
      where,
      orderBy: { name: 'asc' },
      include: { site: { select: { id: true, name: true, shortCode: true } } },
    });
    res.json({ data: printers });
  } catch (err) {
    next(err);
  }
});

// GET /api/printers/:id/status
printersRouter.get('/:id/status', async (req: Request, res: Response, next) => {
  try {
    const printer = await prisma.printer.findUnique({
      where: { id: req.params.id as string },
      select: { id: true, name: true, active: true, lastSeenAt: true, lastError: true },
    });
    if (!printer) throw new AppError(404, 'Printer not found');
    const online =
      printer.lastSeenAt != null && Date.now() - printer.lastSeenAt.getTime() < OFFLINE_AFTER_MS;
    res.json({ ...printer, online });
  } catch (err) {
    next(err);
  }
});

// POST /api/printers — admin
printersRouter.post('/', requirePermission('system:config'), async (req: Request, res: Response, next) => {
  try {
    const { name, siteId, ipAddress, port, labelWidthMm, labelHeightMm, defaultForStation, active } = req.body;
    if (!name?.trim()) throw new AppError(400, 'Name is required');
    if (!siteId) throw new AppError(400, 'siteId is required');
    if (!ipAddress?.trim()) throw new AppError(400, 'IP address is required');

    const site = await prisma.site.findUnique({ where: { id: siteId }, select: { id: true } });
    if (!site) throw new AppError(400, 'siteId does not match a known site');

    const printer = await prisma.printer.create({
      data: {
        name: name.trim(),
        siteId,
        ipAddress: ipAddress.trim(),
        port: Number(port) || 9100,
        labelWidthMm: Number(labelWidthMm) || 0,
        labelHeightMm: Number(labelHeightMm) || 0,
        defaultForStation: defaultForStation?.trim() || null,
        active: active ?? true,
      },
    });
    await createAuditLog({
      userId: req.user!.userId, entityType: 'printer', entityId: printer.id,
      action: 'create', changes: { name: printer.name, siteId }, ipAddress: req.ip,
    });
    res.status(201).json(printer);
  } catch (err) {
    next(err);
  }
});

// PUT /api/printers/:id — admin
printersRouter.put('/:id', requirePermission('system:config'), async (req: Request, res: Response, next) => {
  try {
    const b = req.body;
    const data: Record<string, unknown> = {};
    if (b.name !== undefined) data.name = String(b.name).trim();
    if (b.ipAddress !== undefined) data.ipAddress = String(b.ipAddress).trim();
    if (b.port !== undefined) data.port = Number(b.port) || 9100;
    if (b.labelWidthMm !== undefined) data.labelWidthMm = Number(b.labelWidthMm) || 0;
    if (b.labelHeightMm !== undefined) data.labelHeightMm = Number(b.labelHeightMm) || 0;
    if (b.defaultForStation !== undefined) data.defaultForStation = b.defaultForStation?.trim() || null;
    if (b.active !== undefined) data.active = b.active;
    if (b.siteId !== undefined) {
      const site = await prisma.site.findUnique({ where: { id: b.siteId }, select: { id: true } });
      if (!site) throw new AppError(400, 'siteId does not match a known site');
      data.siteId = b.siteId;
    }

    const printer = await prisma.printer.update({ where: { id: req.params.id as string }, data });
    await createAuditLog({
      userId: req.user!.userId, entityType: 'printer', entityId: printer.id,
      action: 'update', changes: data as Record<string, string | number | boolean | null>, ipAddress: req.ip,
    });
    res.json(printer);
  } catch (err) {
    next(err);
  }
});

// POST /api/printers/:id/test — admin — send a one-off test label synchronously
// so the operator gets immediate pass/fail feedback on the network path.
printersRouter.post('/:id/test', requirePermission('system:config'), async (req: Request, res: Response, next) => {
  try {
    const printer = await prisma.printer.findUnique({ where: { id: req.params.id as string } });
    if (!printer) throw new AppError(404, 'Printer not found');

    // Print the real shop-label layout with sample data when a template is
    // configured, so the test tag matches what intake actually prints; fall
    // back to the bare diagnostic label only if no template exists yet.
    const template = await prisma.labelTemplate.findFirst({
      where: { name: 'ticket_default', active: true },
    });
    const zpl = template ? sampleLabelZpl(template.template) : testLabelZpl(printer.name);

    try {
      await sendZpl(printer, zpl, 1);
      await prisma.printer.update({
        where: { id: printer.id },
        data: { lastSeenAt: new Date(), lastError: null },
      });
      res.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await prisma.printer.update({
        where: { id: printer.id },
        data: { lastError: message.slice(0, 500) },
      });
      throw new AppError(502, `Test print failed: ${message}`);
    }
  } catch (err) {
    next(err);
  }
});
