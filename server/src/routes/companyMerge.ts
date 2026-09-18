/**
 * Company dedupe / merge routes
 *
 * Mounted at /api/companies/merge (BEFORE the companies router so /merge/* isn't
 * swallowed by GET /companies/:id). Collapses duplicate Company rows into one
 * canonical record, reassigning every relation. See services/companyMerge.ts.
 *
 *   GET  /stats             — counts driving the dedupe UI
 *   POST /auto-merge-exact  — merge every exact-name dup with no QB conflict
 *   GET  /review            — QB-conflict exact dups + fuzzy/field-office candidates
 *   POST /merge             — merge one pair { loserId, winnerId, force? }
 *   POST /skip              — drop a company from the fuzzy review queue { companyId }
 *
 * Permission: customers:manage (dispatch, billing_ar, platform_admin).
 */

import { Router, Request, Response, NextFunction } from 'express';
import { requirePermission } from '../middleware/rbac.js';
import { createAuditLog } from '../utils/auditLog.js';
import {
  getStats, autoMergeExact, getReviewQueue, mergeCompany, skipCompany,
} from '../services/companyMerge.js';

export const companyMergeRouter = Router();

companyMergeRouter.get(
  '/stats',
  requirePermission('customers:manage'),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(await getStats());
    } catch (err) { next(err); }
  }
);

companyMergeRouter.post(
  '/auto-merge-exact',
  requirePermission('customers:manage'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await autoMergeExact();
      await createAuditLog({
        userId: req.user!.userId,
        entityType: 'company_merge',
        entityId: 'auto-exact',
        action: 'update',
        changes: { mode: 'auto_merge_exact', ...result },
        ipAddress: req.ip,
      });
      res.json(result);
    } catch (err) { next(err); }
  }
);

companyMergeRouter.get(
  '/review',
  requirePermission('customers:manage'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
      const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : undefined;
      const search = req.query.search as string | undefined;
      res.json(await getReviewQueue({ limit, offset, search }));
    } catch (err) { next(err); }
  }
);

companyMergeRouter.post(
  '/merge',
  requirePermission('customers:manage'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { loserId, winnerId, force } = req.body || {};
      if (!loserId || !winnerId) {
        res.status(400).json({ error: 'loserId and winnerId are required' });
        return;
      }
      let result;
      try {
        result = await mergeCompany(loserId, winnerId, { force: !!force });
      } catch (e: any) {
        if (e?.code === 'QB_CONFLICT') {
          res.status(409).json({ error: e.message, code: 'QB_CONFLICT' });
          return;
        }
        throw e;
      }
      await createAuditLog({
        userId: req.user!.userId,
        entityType: 'company_merge',
        entityId: loserId,
        action: 'update',
        changes: { mode: 'manual_merge', ...result },
        ipAddress: req.ip,
      });
      res.json({ ok: true, ...result });
    } catch (err) { next(err); }
  }
);

companyMergeRouter.post(
  '/skip',
  requirePermission('customers:manage'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { companyId } = req.body || {};
      if (!companyId) {
        res.status(400).json({ error: 'companyId is required' });
        return;
      }
      await skipCompany(companyId);
      res.json({ ok: true });
    } catch (err) { next(err); }
  }
);
