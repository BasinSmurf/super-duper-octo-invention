import { Request, Response, NextFunction } from 'express';
import { roleHasCapability, getEffectiveMatrix, CAPABILITY_CATALOG } from '../services/permissions.js';
import { permissionDeniedMessage } from '../services/permissionMessages.js';

type Role = 'field_tech' | 'dispatch' | 'field_super' | 'billing_ar' | 'ar_supervisor' | 'trainer' | 'train_admin' | 'boss' | 'platform_admin' | 'customer';

export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    if (!roles.includes(req.user.role as Role)) {
      res.status(403).json({ error: permissionDeniedMessage('perform this action', roles) });
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
      const label = CAPABILITY_CATALOG.find(cap => cap.key === permission)?.label;
      const action = !label ? 'perform this action'
        : /^(create|edit|approve|manage|view|request|import|void|delete|cancel|close|force-close|reassign|complete|send|force)\b/i.test(label)
          ? label : `access ${label.charAt(0).toLowerCase() + label.slice(1)}`;
      const roles = [...getEffectiveMatrix()[permission], 'platform_admin'];
      res.status(403).json({ error: permissionDeniedMessage(action, roles) });
      return;
    }

    next();
  };
}
