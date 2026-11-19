/**
 * novara.ts — Routes for the Novara Flex equipment/compliance sync.
 *
 * All routes behind `requirePermission('inventory:novara')`.
 *
 *   GET    /status                    — configured? last run, counts, open issues
 *   GET    /test-connection           — probe the API + token
 *   POST   /sync                      — run now (body { dryRun, typeIds })
 *   GET    /types                     — Novara equipment types + their SP product mapping
 *   PATCH  /types/:novaraTypeId       — set productId / ownership / autoCreate / syncEnabled
 *   GET    /schedules                 — Novara inspection schedules (?typeId=)
 *   PATCH  /schedules/:novaraScheduleId — point a schedule at an SP due-date column
 *   GET    /issues                    — review queue (?state=open|resolved|all)
 *   POST   /issues/:id/dismiss        — mark an issue resolved by hand
 */

import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../db.js';
import { Prisma } from '../db.js';
import { requirePermission } from '../middleware/rbac.js';
import { AppError } from '../middleware/errorHandler.js';
import { createAuditLog } from '../utils/auditLog.js';
import { isConfigured, testConnection, NovaraApiError, getConfig } from '../services/novaraClient.js';
import {
  syncNovaraEquipment,
  SP_DATE_TARGETS,
  INTERVAL_MS,
  type NovaraSyncSummary,
} from '../services/novaraEquipmentSync.js';
import { runScheduledJob } from '../services/jobs.js';

export const novaraRouter = Router();

novaraRouter.use(requirePermission('inventory:novara'));

function mapNovaraError(err: unknown): never {
  if (err instanceof NovaraApiError) {
    const statusMap: Record<string, number> = {
      auth_failure: 502,
      rate_limited: 429,
      bad_request: 400,
      server_error: 502,
      network_timeout: 504,
      unknown: 502,
    };
    throw new AppError(statusMap[err.category] ?? 502, err.message);
  }
  throw err;
}

// ── Status + connection ─────────────────────────────────────────────────────

novaraRouter.get('/status', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const [state, lastJob, typeCounts, mappedTypes, openIssues, linkedUnits, expiredUnits] = await Promise.all([
      prisma.novaraSyncState.findUnique({ where: { id: 'singleton' } }),
      prisma.jobRun.findFirst({
        where: { jobName: 'novara.equipment-sync' },
        orderBy: { startedAt: 'desc' },
      }),
      prisma.novaraEquipmentTypeMap.count(),
      prisma.novaraEquipmentTypeMap.count({ where: { productId: { not: null }, syncEnabled: true } }),
      prisma.novaraSyncIssue.count({ where: { resolvedAt: null } }),
      prisma.serializedEquipment.count({ where: { novaraEquipmentId: { not: null } } }),
      prisma.serializedEquipment.count({ where: { novaraStatus: 'expired' } }),
    ]);

    res.json({
      configured: isConfigured(),
      baseUrl: getConfig().baseUrl, // safe to expose; the token never leaves the server
      enabled: process.env.NOVARA_SYNC_ENABLED !== 'false',
      intervalMs: INTERVAL_MS,
      lastRunAt: state?.lastRunAt ?? null,
      lastSummary: state?.lastSummary ?? null,
      lastError: state?.lastError ?? null,
      lastJob: lastJob
        ? { status: lastJob.status, startedAt: lastJob.startedAt, durationMs: lastJob.durationMs, errorMessage: lastJob.errorMessage }
        : null,
      counts: {
        types: typeCounts,
        typesMapped: mappedTypes,
        typesUnmapped: typeCounts - mappedTypes,
        openIssues,
        linkedUnits,
        expiredUnits,
      },
    });
  } catch (err) {
    next(err);
  }
});

novaraRouter.get('/test-connection', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isConfigured()) throw new AppError(400, 'Novara is not configured (NOVARA_API_TOKEN unset)');
    res.json(await testConnection());
  } catch (err) {
    try {
      mapNovaraError(err);
    } catch (mapped) {
      next(mapped);
    }
  }
});

// ── Manual run ──────────────────────────────────────────────────────────────

/**
 * Run the sync now.
 *
 * Wrapped in the SAME runScheduledJob lock the interval uses, so a manual run
 * can't overlap a scheduled one and double-write (or double-spend the shared
 * ~80/min Novara request budget). If the lock is held the response says
 * `skipped` rather than silently doing nothing.
 */
novaraRouter.post('/sync', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isConfigured()) throw new AppError(400, 'Novara is not configured (NOVARA_API_TOKEN unset)');

    const { dryRun, typeIds } = req.body as { dryRun?: boolean; typeIds?: string[] };
    if (typeIds !== undefined && (!Array.isArray(typeIds) || typeIds.some(t => typeof t !== 'string'))) {
      throw new AppError(400, 'typeIds must be an array of Novara type ids');
    }

    let summary: NovaraSyncSummary | null = null;
    let failure: unknown = null;

    const job = await runScheduledJob('novara.equipment-sync', 1800, async () => {
      try {
        summary = await syncNovaraEquipment({ dryRun: !!dryRun, typeIds });
      } catch (err) {
        failure = err;
        throw err;
      }
    });

    if (job.outcome === 'skipped') {
      res.status(409).json({ outcome: 'skipped', message: 'A Novara sync is already running' });
      return;
    }
    if (job.outcome === 'error') {
      try {
        mapNovaraError(failure);
      } catch (mapped) {
        next(mapped);
      }
      return;
    }

    if (!dryRun) {
      await createAuditLog({
        userId: req.user!.userId,
        entityType: 'NovaraSync',
        entityId: 'singleton',
        action: 'update',
        changes: summary as unknown as Prisma.InputJsonValue,
        ipAddress: req.ip,
      });
    }

    res.json({ outcome: 'success', durationMs: job.durationMs, summary });
  } catch (err) {
    next(err);
  }
});

// ── Type mapping ────────────────────────────────────────────────────────────

novaraRouter.get('/types', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const types = await prisma.novaraEquipmentTypeMap.findMany({
      orderBy: [{ productId: 'asc' }, { novaraTypeTitle: 'asc' }],
      include: {
        product: { select: { id: true, partNumber: true, name: true, isSerialized: true } },
        schedules: { orderBy: { novaraScheduleName: 'asc' } },
      },
    });

    // Unresolved units per type, so the page can rank "map this one first".
    const openByType = await prisma.novaraSyncIssue.groupBy({
      by: ['novaraTypeId'],
      where: { resolvedAt: null },
      _count: { _all: true },
    });
    const openMap = new Map(openByType.map(r => [r.novaraTypeId, r._count._all]));

    res.json(types.map(t => ({ ...t, openIssues: openMap.get(t.novaraTypeId) ?? 0 })));
  } catch (err) {
    next(err);
  }
});

novaraRouter.patch('/types/:novaraTypeId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const novaraTypeId = req.params.novaraTypeId as string;
    const { productId, ownership, autoCreate, syncEnabled } = req.body as {
      productId?: string | null;
      ownership?: 'basin_safety' | 'customer_owned';
      autoCreate?: boolean;
      syncEnabled?: boolean;
    };

    const existing = await prisma.novaraEquipmentTypeMap.findUnique({ where: { novaraTypeId } });
    if (!existing) throw new AppError(404, 'Novara equipment type not found — run a sync to discover it');

    const data: Record<string, unknown> = {};

    if (productId !== undefined) {
      if (productId === null) data.productId = null;
      else {
        const product = await prisma.product.findUnique({
          where: { id: productId },
          select: { id: true, isSerialized: true },
        });
        if (!product) throw new AppError(400, 'Product not found');
        // Novara tracks individually-identified units; a non-serialized product
        // would put every one of them on one bulk catalog row. This is the only
        // hard requirement — `isActive` is a catalog/pricing flag and SP's own
        // equipment-create path doesn't gate on it either, so blocking here
        // would just be a dead end for a legitimately retired-from-sale product
        // that still has units in the field. The picker flags them instead.
        data.productId = productId;
      }
    }
    if (ownership !== undefined) {
      if (ownership !== 'basin_safety' && ownership !== 'customer_owned') {
        throw new AppError(400, 'ownership must be basin_safety or customer_owned');
      }
      data.ownership = ownership;
    }
    if (autoCreate !== undefined) data.autoCreate = !!autoCreate;
    if (syncEnabled !== undefined) data.syncEnabled = !!syncEnabled;

    if (!Object.keys(data).length) throw new AppError(400, 'Nothing to update');

    const updated = await prisma.novaraEquipmentTypeMap.update({
      where: { novaraTypeId },
      data,
      include: { product: { select: { id: true, partNumber: true, name: true } } },
    });

    await createAuditLog({
      userId: req.user!.userId,
      entityType: 'NovaraEquipmentTypeMap',
      entityId: updated.id,
      action: 'update',
      changes: data as Prisma.InputJsonValue,
      ipAddress: req.ip,
    });

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// ── Schedule mapping ────────────────────────────────────────────────────────

novaraRouter.get('/schedules', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const typeId = req.query.typeId as string | undefined;
    const schedules = await prisma.novaraScheduleMap.findMany({
      where: typeId ? { novaraTypeId: typeId } : undefined,
      orderBy: [{ novaraTypeId: 'asc' }, { novaraScheduleName: 'asc' }],
      include: { type: { select: { novaraTypeTitle: true } } },
    });
    res.json({ targets: SP_DATE_TARGETS, schedules });
  } catch (err) {
    next(err);
  }
});

novaraRouter.patch('/schedules/:novaraScheduleId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const novaraScheduleId = req.params.novaraScheduleId as string;
    const { targetField } = req.body as { targetField?: string | null };

    if (targetField === undefined) throw new AppError(400, 'targetField is required (null to unmap)');
    if (targetField !== null && !(SP_DATE_TARGETS as readonly string[]).includes(targetField)) {
      throw new AppError(400, `targetField must be null or one of: ${SP_DATE_TARGETS.join(', ')}`);
    }

    const existing = await prisma.novaraScheduleMap.findUnique({ where: { novaraScheduleId } });
    if (!existing) throw new AppError(404, 'Novara schedule not found — run a sync to discover it');

    const updated = await prisma.novaraScheduleMap.update({
      where: { novaraScheduleId },
      data: { targetField },
    });

    await createAuditLog({
      userId: req.user!.userId,
      entityType: 'NovaraScheduleMap',
      entityId: updated.id,
      action: 'update',
      changes: { targetField },
      ipAddress: req.ip,
    });

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// ── Review queue ────────────────────────────────────────────────────────────

novaraRouter.get('/issues', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const state = (req.query.state as string) || 'open';
    const where =
      state === 'all' ? {} : state === 'resolved' ? { resolvedAt: { not: null } } : { resolvedAt: null };

    const issues = await prisma.novaraSyncIssue.findMany({
      where,
      orderBy: [{ reason: 'asc' }, { lastSeenAt: 'desc' }],
      take: 500,
    });
    res.json(issues);
  } catch (err) {
    next(err);
  }
});

/**
 * Dismiss an issue by hand — for Novara records SP genuinely doesn't want
 * (a retired serial, a duplicate). The next run re-opens it if the unit is
 * still returned and still can't land, which is intentional: dismissal is a
 * note, not a permanent filter. To stop a whole type, turn off syncEnabled.
 */
novaraRouter.post('/issues/:id/dismiss', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const existing = await prisma.novaraSyncIssue.findUnique({ where: { id } });
    if (!existing) throw new AppError(404, 'Issue not found');

    const updated = await prisma.novaraSyncIssue.update({
      where: { id },
      data: { resolvedAt: new Date() },
    });

    await createAuditLog({
      userId: req.user!.userId,
      entityType: 'NovaraSyncIssue',
      entityId: id,
      action: 'update',
      changes: { dismissed: true },
      ipAddress: req.ip,
    });

    res.json(updated);
  } catch (err) {
    next(err);
  }
});
