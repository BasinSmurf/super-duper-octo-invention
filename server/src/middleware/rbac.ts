import { Request, Response, NextFunction } from 'express';
import { roleHasCapability, getEffectiveMatrix } from '../services/permissions.js';

type Role = 'field_tech' | 'dispatch' | 'field_super' | 'billing_ar' | 'trainer' | 'train_admin' | 'boss' | 'platform_admin' | 'customer';

export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    if (!roles.includes(req.user.role as Role)) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    next();
  };
}

export function requirePermission(permission: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    // Unknown capability = misconfiguration. The matrix is seeded from the
    // capability catalog, so a missing key means a typo at the call site.
    if (!(permission in getEffectiveMatrix())) {
      res.status(500).json({ error: `Unknown permission: ${permission}` });
      return;
    }

    if (!roleHasCapability(req.user.role, permission)) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    next();
  };
}
