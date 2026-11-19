/**
 * blueLion.ts — Routes for the BlueLion training-cert integration.
 *
 * All routes behind `requirePermission('billing:bluelion')`.
 *
 *   GET    /test-connection            — probe the BlueLion LAN vhost + token
 *   POST   /trainings/sync/:ticketId   — manually (re)enqueue a training ticket's roster (body { force })
 *   POST   /trainings/backfill         — enqueue all finalized training tickets' un-synced rosters
 *   POST   /occ-health/sync/:ticketId  — manually (re)enqueue an Occ Health ticket's fit-test records (body { force })
 *   POST   /occ-health/backfill        — enqueue all finalized Occ Health tickets' un-synced records
 *   POST   /services/backfill          — the DUMP: enqueue every locked terminal-outcome equipment
 *                                        inspection as asset registration + service event
 *   POST   /documents/backfill         — enqueue every attachment whose kind now has a BlueLion
 *                                        docType, including ones held back before 2026-08-31
 *   GET    /queue                      — list queue rows (?status= filter)
 *   GET    /queue/stats                — count by status
 *   POST   /queue/:id/retry            — reset an error row to pending
 *   POST   /queue/:id/resolve          — resolve an `ambiguous` row with a chosen blueLionId
 *   DELETE /queue/:id                  — drop a queue row
 */

import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../db.js';
import { requirePermission } from '../middleware/rbac.js';
import { AppError } from '../middleware/errorHandler.js';
import { createAuditLog } from '../utils/auditLog.js';
import { testConnection } from '../services/blueLionClient.js';
import {
  enqueueTrainingRosterForTicket,
  enqueueOccHealthForTicket,
  enqueueInspectionRecord,
  enqueueAttachment,
  FINALIZED_TRAINING_STATUSES,
} from '../services/blueLionEnqueue.js';
import { BLUELION_PUSHABLE_ATTACHMENT_KINDS } from '../services/equipmentDocuments.js';

export const blueLionRouter = Router();

blueLionRouter.use(requirePermission('billing:bluelion'));

// ── Connection + catalog ──────────────────────────────────────────────────

blueLionRouter.get('/test-connection', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await testConnection());
  } catch (err) {
    next(err);
  }
});

// ── Enqueue ───────────────────────────────────────────────────────────────

blueLionRouter.post('/trainings/sync/:ticketId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ticketId } = req.params;
    const force = req.body?.force === true;

    const ticket = await prisma.serviceTicket.findUnique({
      where: { id: ticketId as string },
      select: { id: true, ticketType: true },
    });
    if (!ticket) throw new AppError(404, 'Ticket not found');
    if (ticket.ticketType !== 'training') throw new AppError(400, 'Not a training ticket');

    const result = await enqueueTrainingRosterForTicket(ticketId as string, { force });

    await createAuditLog({
      userId: req.user?.userId,
      entityType: 'bluelion_queue',
      entityId: ticketId as string,
      action: 'create',
      changes: { action: 'sync_training', force, ...result },
    });

    res.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof AppError) return next(err);
    next(err);
  }
});

blueLionRouter.post('/trainings/backfill', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tickets = await prisma.serviceTicket.findMany({
      where: {
        ticketType: 'training',
        status: { in: FINALIZED_TRAINING_STATUSES as never },
      },
      select: { id: true },
    });

    const totals = { tickets: tickets.length, enqueued: 0, skipped: 0, needsAttention: 0 };
    for (const t of tickets) {
      const r = await enqueueTrainingRosterForTicket(t.id);
      totals.enqueued += r.enqueued;
      totals.skipped += r.skipped;
      totals.needsAttention += r.needsAttention;
    }

    await createAuditLog({
      userId: req.user?.userId,
      entityType: 'bluelion_queue',
      entityId: 'backfill',
      action: 'create',
      changes: totals,
    });

    res.json({ ok: true, ...totals });
  } catch (err) {
    next(err);
  }
});

// Occ Health: same shape as the trainings sync, but enqueues the ticket's
// fit-test records (FIT-TEST + AUDIO certs).
blueLionRouter.post('/occ-health/sync/:ticketId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ticketId } = req.params;
    const force = req.body?.force === true;

    const ticket = await prisma.serviceTicket.findUnique({
      where: { id: ticketId as string },
      select: { id: true, ticketType: true },
    });
    if (!ticket) throw new AppError(404, 'Ticket not found');
    if (ticket.ticketType !== 'training') throw new AppError(400, 'Not a training/Occ Health ticket');

    const result = await enqueueOccHealthForTicket(ticketId as string, { force });

    await createAuditLog({
      userId: req.user?.userId,
      entityType: 'bluelion_queue',
      entityId: ticketId as string,
      action: 'create',
      changes: { action: 'sync_occ_health', force, ...result },
    });

    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});

blueLionRouter.post('/occ-health/backfill', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tickets = await prisma.serviceTicket.findMany({
      where: {
        ticketType: 'training',
        status: { in: FINALIZED_TRAINING_STATUSES as never },
        fitTestRecords: { some: {} },
      },
      select: { id: true },
    });

    const totals = { tickets: tickets.length, enqueued: 0, skipped: 0, needsAttention: 0 };
    for (const t of tickets) {
      const r = await enqueueOccHealthForTicket(t.id);
      totals.enqueued += r.enqueued;
      totals.skipped += r.skipped;
      totals.needsAttention += r.needsAttention;
    }

    await createAuditLog({
      userId: req.user?.userId,
      entityType: 'bluelion_queue',
      entityId: 'occ_health_backfill',
      action: 'create',
      changes: totals,
    });

    res.json({ ok: true, ...totals });
  } catch (err) {
    next(err);
  }
});

// The services DUMP: enqueue ALL existing locked, terminal-outcome equipment
// inspections (shop + field) — each yields an asset registration (once per
// kind+serial) + a service event. Idempotent on externalId, so re-running is
// safe; already-queued/synced rows count as skipped. The queue processor then
// drains to BlueLion at its normal batch pace.
blueLionRouter.post('/services/backfill', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const inspections = await prisma.equipmentInspection.findMany({
      where: {
        lockedAt: { not: null },
        outcome: { in: ['pass', 'condemn'] },
      },
      select: { id: true },
      orderBy: { inspectedAt: 'asc' },
    });
    const notEligible = await prisma.equipmentInspection.count({
      where: { OR: [{ lockedAt: null }, { outcome: { notIn: ['pass', 'condemn'] } }] },
    });

    const totals = { inspections: inspections.length, enqueued: 0, skipped: 0, notEligible };
    for (const i of inspections) {
      const r = await enqueueInspectionRecord(i.id);
      totals.enqueued += r.enqueued;
      totals.skipped += r.skipped;
    }

    await createAuditLog({
      userId: req.user?.userId,
      entityType: 'bluelion_queue',
      entityId: 'services_backfill',
      action: 'create',
      changes: totals,
    });

    res.json({ ok: true, ...totals });
  } catch (err) {
    next(err);
  }
});

// Drain the document backlog.
//
// Before 2026-08-31 BlueLion's docType vocabulary had a home for UE reports and
// nothing else, so ServicePRO HELD the other categories rather than filing them
// under a plausible-sounding neighbour. Those are not superseded records — they
// are absent ones, and now that the four types exist they can simply be sent.
//
// Two cases, and they need different handling:
//   * never queued  — the kind had no docType when the file was captured, so
//                     enqueueAttachment returned before writing a row at all.
//   * queued, then closed out `skipped` — the row exists and reads as finished,
//                     so a plain enqueue would decline to touch it. Forced.
//
// Rows that already reached BlueLion (`added`) are left strictly alone: the
// Vault dedupes on externalId, but re-driving a synced row would still rewrite
// a record of what happened for no gain.
blueLionRouter.post('/documents/backfill', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const attachments = await prisma.attachment.findMany({
      where: { kind: { in: BLUELION_PUSHABLE_ATTACHMENT_KINDS as never[] } },
      select: { id: true },
      orderBy: { capturedAt: 'asc' },
    });

    // One query, not one per attachment — a shop with a year of photos makes
    // the naive version a few thousand round trips.
    const existing = await prisma.blueLionSyncQueue.findMany({
      where: { externalId: { in: attachments.map((a) => `sp-att-${a.id}`) } },
      select: { externalId: true, resultStatus: true },
    });
    const priorResult = new Map(existing.map((r) => [r.externalId, r.resultStatus]));

    const totals = { attachments: attachments.length, enqueued: 0, forced: 0, skipped: 0 };
    for (const a of attachments) {
      const prior = priorResult.get(`sp-att-${a.id}`);
      const force = prior === 'skipped';
      const r = await enqueueAttachment(a.id, { force });
      if (r.enqueued && force) totals.forced += r.enqueued;
      else totals.enqueued += r.enqueued;
      totals.skipped += r.skipped;
    }

    await createAuditLog({
      userId: req.user?.userId,
      entityType: 'bluelion_queue',
      entityId: 'documents_backfill',
      action: 'create',
      changes: totals,
    });

    res.json({ ok: true, ...totals });
  } catch (err) {
    next(err);
  }
});

// ── Queue management ────────────────────────────────────────────────────────

blueLionRouter.get('/queue', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const status = req.query.status as string | undefined;
    const rows = await prisma.blueLionSyncQueue.findMany({
      where: status ? { status: status as never } : undefined,
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

blueLionRouter.get('/queue/stats', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const stats = await prisma.blueLionSyncQueue.groupBy({ by: ['status'], _count: true });
    const result: Record<string, number> = {};
    for (const row of stats) result[row.status] = row._count;
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// Bulk retry — for the case that actually happens: a config/transport fault
// failed a whole backfill at once, and per-row retry means hundreds of clicks.
// Scoped to `error` (permanent transport/5xx failures) by design: retrying
// `needs_attention` en masse just re-fails, since ambiguous rows need a person
// picked and invalid rows need the source data fixed first.
blueLionRouter.post('/queue/retry-errors', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? (req.body.ids as string[]) : undefined;
    const where = ids?.length ? { id: { in: ids }, status: 'error' as const } : { status: 'error' as const };

    const { count } = await prisma.blueLionSyncQueue.updateMany({
      where,
      data: {
        status: 'pending',
        errorMessage: null,
        responsePayload: null,
        responseStatusCode: null,
        resultStatus: null,
        retryCount: 0,
      },
    });

    await createAuditLog({
      userId: req.user?.userId,
      entityType: 'bluelion_queue',
      entityId: 'retry_errors',
      action: 'update',
      changes: { action: 'retry_errors', scoped: !!ids?.length, retried: count },
    });

    res.json({ ok: true, retried: count, message: `${count} row${count === 1 ? '' : 's'} re-queued` });
  } catch (err) {
    next(err);
  }
});

blueLionRouter.post('/queue/:id/retry', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const entry = await prisma.blueLionSyncQueue.findUnique({ where: { id: id as string } });
    if (!entry) throw new AppError(404, 'Queue entry not found');
    if (!['error', 'needs_attention'].includes(entry.status)) {
      throw new AppError(400, `Cannot retry entry with status "${entry.status}"`);
    }

    const updated = await prisma.blueLionSyncQueue.update({
      where: { id: id as string },
      data: {
        status: 'pending',
        errorMessage: null,
        responsePayload: null,
        responseStatusCode: null,
        resultStatus: null,
        candidates: undefined,
        retryCount: 0,
      },
    });

    await createAuditLog({
      userId: req.user?.userId,
      entityType: 'bluelion_queue',
      entityId: id as string,
      action: 'update',
      changes: { action: 'retry', previousStatus: entry.status, externalId: entry.externalId },
    });

    res.json({ ok: true, entry: updated });
  } catch (err) {
    if (err instanceof AppError) return next(err);
    next(err);
  }
});

// Resolve an `ambiguous` row: the operator picked which existing BlueLion person
// this cert belongs to. Stamp the id on the source record — roster or fit-test,
// per entityType — so it's reused going forward, and re-queue the push with
// person.blueLionId set.
blueLionRouter.post('/queue/:id/resolve', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const blueLionId = req.body?.blueLionId;
    if (!blueLionId || typeof blueLionId !== 'string') {
      throw new AppError(400, 'blueLionId (string) is required');
    }

    const entry = await prisma.blueLionSyncQueue.findUnique({ where: { id: id as string } });
    if (!entry) throw new AppError(404, 'Queue entry not found');
    if (entry.resultStatus !== 'ambiguous') {
      throw new AppError(400, `Only ambiguous entries can be resolved (this one is "${entry.resultStatus ?? entry.status}")`);
    }

    if (entry.entityType === 'training') {
      await prisma.trainingRosterRecord
        .update({ where: { id: entry.entityId }, data: { blueLionPersonId: blueLionId } })
        .catch(() => {
          throw new AppError(404, 'Roster record for this entry no longer exists');
        });
    } else {
      await prisma.fitTestRecord
        .update({ where: { id: entry.entityId }, data: { blueLionPersonId: blueLionId } })
        .catch(() => {
          throw new AppError(404, 'Fit test record for this entry no longer exists');
        });
    }

    const updated = await prisma.blueLionSyncQueue.update({
      where: { id: id as string },
      data: {
        status: 'pending',
        errorMessage: null,
        candidates: undefined,
        resultStatus: null,
        responsePayload: null,
        retryCount: 0,
      },
    });

    await createAuditLog({
      userId: req.user?.userId,
      entityType: 'bluelion_queue',
      entityId: id as string,
      action: 'update',
      changes: { action: 'resolve_ambiguous', blueLionId, externalId: entry.externalId },
    });

    res.json({ ok: true, entry: updated });
  } catch (err) {
    if (err instanceof AppError) return next(err);
    next(err);
  }
});

blueLionRouter.delete('/queue/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const entry = await prisma.blueLionSyncQueue.findUnique({ where: { id: id as string } });
    if (!entry) throw new AppError(404, 'Queue entry not found');

    await prisma.blueLionSyncQueue.delete({ where: { id: id as string } });

    await createAuditLog({
      userId: req.user?.userId,
      entityType: 'bluelion_queue',
      entityId: id as string,
      action: 'delete',
      changes: { externalId: entry.externalId, status: entry.status },
    });

    res.json({ ok: true, message: 'Queue entry removed' });
  } catch (err) {
    if (err instanceof AppError) return next(err);
    next(err);
  }
});
