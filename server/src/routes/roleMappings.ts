import { Router, Request, Response } from 'express';
import { prisma } from '../db.js';
import { AppError } from '../middleware/errorHandler.js';
import { requirePermission } from '../middleware/rbac.js';
import { isGoogleGroupsConfigured } from '../services/googleGroups.js';

export const roleMappingsRouter = Router();

// SSO role mappings are part of user management
roleMappingsRouter.use(requirePermission('users:manage'));

// GET /api/role-mappings — list all mappings
roleMappingsRouter.get('/', async (_req: Request, res: Response, next) => {
  try {
    const mappings = await prisma.googleRoleMapping.findMany({
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
    });
    res.json({
      data: mappings,
      googleGroupsConfigured: isGoogleGroupsConfigured(),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/role-mappings — create a new mapping
roleMappingsRouter.post('/', async (req: Request, res: Response, next) => {
  try {
    const { googleGroupEmail, sundogRole, priority } = req.body;

    if (!googleGroupEmail || !sundogRole) {
      throw new AppError(400, 'googleGroupEmail and sundogRole are required');
    }

    // Validate role is a real UserRole
    const validRoles = ['field_tech', 'dispatch', 'field_super', 'billing_ar', 'ar_supervisor', 'trainer', 'train_admin', 'boss', 'platform_admin'];
    if (!validRoles.includes(sundogRole)) {
      throw new AppError(400, `Invalid role: ${sundogRole}. Valid: ${validRoles.join(', ')}`);
    }

    const mapping = await prisma.googleRoleMapping.create({
      data: {
        googleGroupEmail: googleGroupEmail.toLowerCase().trim(),
        sundogRole,
        priority: priority ?? 0,
      },
    });

    res.status(201).json(mapping);
  } catch (err: any) {
    if (err.code === 'P2002') {
      next(new AppError(409, 'A mapping for this group email already exists'));
    } else {
      next(err);
    }
  }
});

// PUT /api/role-mappings/:id — update a mapping
roleMappingsRouter.put('/:id', async (req: Request, res: Response, next) => {
  try {
    const { id } = req.params;
    const { googleGroupEmail, sundogRole, priority, isActive } = req.body;

    const data: any = {};
    if (googleGroupEmail !== undefined) data.googleGroupEmail = googleGroupEmail.toLowerCase().trim();
    if (sundogRole !== undefined) data.sundogRole = sundogRole;
    if (priority !== undefined) data.priority = priority;
    if (isActive !== undefined) data.isActive = isActive;

    const mapping = await prisma.googleRoleMapping.update({
      where: { id: id as string },
      data,
    });

    res.json(mapping);
  } catch (err: any) {
    if (err.code === 'P2025') {
      next(new AppError(404, 'Mapping not found'));
    } else if (err.code === 'P2002') {
      next(new AppError(409, 'A mapping for this group email already exists'));
    } else {
      next(err);
    }
  }
});

// DELETE /api/role-mappings/:id — delete a mapping
roleMappingsRouter.delete('/:id', async (req: Request, res: Response, next) => {
  try {
    await prisma.googleRoleMapping.delete({
      where: { id: req.params.id as string },
    });
    res.json({ ok: true });
  } catch (err: any) {
    if (err.code === 'P2025') {
      next(new AppError(404, 'Mapping not found'));
    } else {
      next(err);
    }
  }
});
