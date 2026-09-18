/**
 * permissions.ts — admin-editable RBAC matrix.
 *
 *   GET /api/permissions/matrix   capability catalog + effective role matrix
 *   PUT /api/permissions/matrix   persist overrides (system:config)
 *
 * The GET is readable by any authenticated user so the client can gate its own
 * buttons/nav off the same matrix the server enforces. The PUT is admin-only and
 * refuses to strip platform_admin of the keep-the-lights-on capabilities.
 */
import { Router, Request, Response } from 'express';
import { prisma } from '../index.js';
import { AppError } from '../middleware/errorHandler.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import {
  CAPABILITY_CATALOG,
  ALL_ROLES,
  ADMIN_LOCKED_CAPABILITIES,
  DEFAULT_PERMISSIONS,
  getEffectiveMatrix,
  loadMatrix,
  invalidateMatrix,
  isValidCapability,
  type Role,
} from '../services/permissions.js';

export const permissionsRouter = Router();

// GET /api/permissions/matrix — catalog + current effective matrix.
permissionsRouter.get('/matrix', authenticate, async (_req: Request, res: Response, next) => {
  try {
    res.json({
      roles: ALL_ROLES,
      catalog: CAPABILITY_CATALOG.map(({ key, label, group, description }) => ({ key, label, group, description })),
      matrix: getEffectiveMatrix(),
      defaults: DEFAULT_PERMISSIONS,
    });
  } catch (err) {
    next(err);
  }
});

// PUT /api/permissions/matrix — admin saves the full matrix (every capability →
// role[]). We store it whole (sparse-merge still happens on read for any newly
// added capability) after validating shape and the admin-lock invariant.
permissionsRouter.put('/matrix', authenticate, requirePermission('system:config'), async (req: Request, res: Response, next) => {
  try {
    const incoming = req.body?.matrix;
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
      throw new AppError(400, 'matrix object is required');
    }

    const clean: Record<string, Role[]> = {};
    for (const [cap, roles] of Object.entries(incoming)) {
      if (!isValidCapability(cap)) continue; // drop unknown keys silently
      if (!Array.isArray(roles)) throw new AppError(400, `roles for "${cap}" must be an array`);
      const valid = (roles as unknown[]).filter((r): r is Role => ALL_ROLES.includes(r as Role));

      // Invariant: admin must keep the lights-on capabilities. Check the INCOMING
      // value (before normalization) so the admin gets a clear 400 rather than a
      // silent re-add.
      if (ADMIN_LOCKED_CAPABILITIES.includes(cap) && !valid.includes('platform_admin')) {
        throw new AppError(400, `platform_admin cannot be removed from "${cap}"`);
      }

      // platform_admin is implicitly all-powerful; normalize it into every cap so
      // the stored matrix and the UI agree (and admin can never be locked out).
      const set = new Set<Role>(valid);
      set.add('platform_admin');
      clean[cap] = ALL_ROLES.filter((r) => set.has(r));
    }

    const existing = await prisma.permissionConfig.findFirst();
    await (existing
      ? prisma.permissionConfig.update({ where: { id: existing.id }, data: { matrix: clean } })
      : prisma.permissionConfig.create({ data: { matrix: clean } }));

    invalidateMatrix();
    await loadMatrix();

    res.json({ matrix: getEffectiveMatrix() });
  } catch (err) {
    next(err);
  }
});
