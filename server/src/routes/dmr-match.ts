/**
 * Well ↔ DMR backfill / dedupe routes
 *
 * Mounted at /api/locations/dmr/match. Matches orphaned active wells (no API#)
 * to the now-populated dmr_reference_wells and backfills identity+classification.
 *
 *   GET  /stats            — counts driving the backfill UI
 *   GET  /review           — page of unmatched wells + fuzzy DMR candidates
 *   GET  /search?q=        — free-text search across ALL unclaimed DMR rows, for
 *                             manual matches the automatic fuzzy candidates miss
 *   POST /apply            — apply one match { wellId, dmrReferenceId }
 *   POST /cleanup-orphans   — delete wells with no DMR match + no history at all
 *                             { wellIds?: string[] } — omit for the bulk sweep
 *   POST /skip             — mark a well reviewed-but-skipped { wellId }
 *
 * Permission: locations:import_dmr (platform_admin), same as the CSV import.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { requirePermission } from '../middleware/rbac.js';
import { createAuditLog } from '../utils/auditLog.js';
import {
  getStats, getReviewQueue, applyMatch, skipWell,
  mergeWell, searchDmrCandidates, cleanupOrphanWells,
} from '../services/wellDmrMatch.js';

export const dmrMatchRouter = Router();

dmrMatchRouter.get(
  '/stats',
  requirePermission('locations:import_dmr'),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(await getStats());
    } catch (err) { next(err); }
  }
);
dmrMatchRouter.post(
  '/merge',
  requirePermission('locations:import_dmr'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { loserWellId, winnerWellId } = req.body || {};
      if (!loserWellId || !winnerWellId) {
        res.status(400).json({ error: 'loserWellId and winnerWellId are required' });
        return;
      }
      await mergeWell(loserWellId, winnerWellId);
      await createAuditLog({
        userId: req.user!.userId,
        entityType: 'dmr_well_match',
        entityId: loserWellId,
        action: 'update',
        changes: { mode: 'manual_merge', winnerWellId },
        ipAddress: req.ip,
      });
      res.json({ ok: true });
    } catch (err) { next(err); }
  }
);

dmrMatchRouter.get(
  '/review',
  requirePermission('locations:import_dmr'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
      const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : undefined;
      const search = req.query.search as string | undefined;
      res.json(await getReviewQueue({ limit, offset, search }));
    } catch (err) { next(err); }
  }
);

dmrMatchRouter.get(
  '/search',
  requirePermission('locations:import_dmr'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = (req.query.q as string) || '';
      res.json(await searchDmrCandidates(q));
    } catch (err) { next(err); }
  }
);

dmrMatchRouter.post(
  '/apply',
  requirePermission('locations:import_dmr'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { wellId, dmrReferenceId } = req.body || {};
      if (!wellId || !dmrReferenceId) {
        res.status(400).json({ error: 'wellId and dmrReferenceId are required' });
        return;
      }
      try {
        await applyMatch(wellId, dmrReferenceId);
      } catch (e: any) {
        if (e?.code === 'P2002') {
          const conflict = e.conflictingWell as { wellId: string; wellName: string | null; operatorName: string | null } | undefined;
          res.status(409).json({
            error: conflict
              ? `That API number is already assigned to "${conflict.wellName || 'another well'}"${conflict.operatorName ? ` (${conflict.operatorName})` : ''} — that record likely has the wrong API and needs fixing first.`
              : 'That API number is already assigned to another well.',
            conflictingWell: conflict ?? null,
          });
          return;
        }
        throw e;
      }
      await createAuditLog({
        userId: req.user!.userId,
        entityType: 'dmr_well_match',
        entityId: wellId,
        action: 'update',
        changes: { mode: 'manual_apply', dmrReferenceId },
        ipAddress: req.ip,
      });
      res.json({ ok: true });
    } catch (err) { next(err); }
  }
);

dmrMatchRouter.post(
  '/cleanup-orphans',
  requirePermission('locations:import_dmr'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const wellIds = Array.isArray(req.body?.wellIds) ? req.body.wellIds : undefined;
      const result = await cleanupOrphanWells(wellIds);
      await createAuditLog({
        userId: req.user!.userId,
        entityType: 'dmr_well_match',
        entityId: wellIds ? wellIds.join(',') : 'bulk',
        action: 'delete',
        changes: { mode: 'cleanup_orphans', ...result },
        ipAddress: req.ip,
      });
      res.json(result);
    } catch (err) { next(err); }
  }
);

dmrMatchRouter.post(
  '/skip',
  requirePermission('locations:import_dmr'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { wellId } = req.body || {};
      if (!wellId) {
        res.status(400).json({ error: 'wellId is required' });
        return;
      }
      await skipWell(wellId);
      res.json({ ok: true });
    } catch (err) { next(err); }
  }
);
