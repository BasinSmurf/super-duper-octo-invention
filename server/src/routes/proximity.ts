/**
 * Spatial proximity routes — "thing is next to other thing"
 *
 * Mounted at /api/locations/proximity.
 *
 *   GET  /pad-merges          — clusters of padded wells spanning >1 pad (consolidation candidates)
 *   POST /pad-merges/apply    — merge fragmented pads { winnerPadId, loserPadIds[] }
 *
 * Permission: locations:manage (mutations) / locations:read for lookups.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { requirePermission } from '../middleware/rbac.js';
import { createAuditLog } from '../utils/auditLog.js';
import {
  suggestPadMerges, mergePads, DEFAULT_PAD_RADIUS_FT,
} from '../services/wellProximity.js';

export const proximityRouter = Router();

const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : undefined;
};

proximityRouter.get(
  '/pad-merges',
  requirePermission('locations:manage'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const radiusFt = num(req.query.radiusFt) ?? DEFAULT_PAD_RADIUS_FT;
      res.json(await suggestPadMerges(radiusFt));
    } catch (err) { next(err); }
  }
);

proximityRouter.post(
  '/pad-merges/apply',
  requirePermission('locations:manage'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { winnerPadId, loserPadIds, newName } = req.body || {};
      if (!winnerPadId || !Array.isArray(loserPadIds) || loserPadIds.length === 0) {
        res.status(400).json({ error: 'winnerPadId and a non-empty loserPadIds[] are required' });
        return;
      }
      const result = await mergePads(winnerPadId, loserPadIds, typeof newName === 'string' ? newName : undefined);
      await createAuditLog({
        userId: req.user!.userId,
        entityType: 'pad',
        entityId: winnerPadId,
        action: 'update',
        changes: { mode: 'proximity_pad_merge', loserPadIds, newName, ...result },
        ipAddress: req.ip,
      });
      res.json(result);
    } catch (err) { next(err); }
  }
);
