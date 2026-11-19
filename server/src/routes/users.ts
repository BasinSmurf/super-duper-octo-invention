import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { prisma } from '../db.js';
import { AppError } from '../middleware/errorHandler.js';
import { requirePermission } from '../middleware/rbac.js';
import { syncWorkspaceUsers, isGoogleGroupsConfigured } from '../services/googleGroups.js';
import { getReportSubscriptions, saveReportPreference } from '../services/reportSubscriptions.js';

const VALID_ROLES = ['platform_admin', 'boss', 'field_super', 'billing_ar', 'ar_supervisor', 'dispatch', 'field_tech', 'trainer', 'train_admin'] as const;
type ValidRole = typeof VALID_ROLES[number];

export const usersRouter = Router();

// GET /api/users/active — minimal {id,name} list of every active employee, for
// pickers (e.g. shop-transfer "Transported by"). Available to any authenticated
// user. Declared BEFORE the platform_admin gate below so it isn't restricted.
usersRouter.get('/active', async (_req: Request, res: Response, next) => {
  try {
    const users = await prisma.user.findMany({
      where: { isActive: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
    res.json({ data: users });
  } catch (err) {
    next(err);
  }
});

// All remaining user management routes require the users:manage capability
usersRouter.use(requirePermission('users:manage'));

usersRouter.get('/:id/reports', async (req, res) => {
  res.json(await getReportSubscriptions(prisma, req.params.id as string));
});
usersRouter.put('/:id/reports/:type', async (req, res) => {
  await saveReportPreference(prisma, req.params.id as string, req.user!.userId, req.params.type, req.body?.cadence);
  res.json(await getReportSubscriptions(prisma, req.params.id as string));
});

// GET /api/users — list all users
usersRouter.get('/', async (_req: Request, res: Response, next) => {
  try {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        email: true,
        name: true,
        phone: true,
        role: true,
        homeSiteId: true,
        isActive: true,
        pinHash: false,       // never expose hashes
        passwordHash: false,  // never expose hashes
        lastLoginAt: true,
        createdAt: true,
      },
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
    });

    // Add hasPin / hasPassword / isGoogleAuth flags without exposing hashes
    const fullRows = await prisma.user.findMany({
      select: { id: true, pinHash: true, passwordHash: true, authProviderId: true },
    });
    const flagMap = new Map(fullRows.map(r => [r.id, r]));
    const usersWithFlags = users.map(u => {
      const f = flagMap.get(u.id);
      return {
        ...u,
        hasPin: !!f?.pinHash,
        hasPassword: !!f?.passwordHash,
        isGoogleAuth: !!f?.authProviderId,
      };
    });

    res.json({ data: usersWithFlags });
  } catch (err) {
    next(err);
  }
});

// PUT /api/users/:id/pin — set or change a user's PIN
usersRouter.put('/:id/pin', async (req: Request, res: Response, next) => {
  try {
    const { id } = req.params;
    const { pin } = req.body;

    if (!pin) {
      throw new AppError(400, 'PIN is required');
    }

    const pinStr = String(pin).trim();

    // Validate: 4-6 digits only
    if (!/^\d{4,6}$/.test(pinStr)) {
      throw new AppError(400, 'PIN must be 4-6 digits');
    }

    // Verify user exists
    const user = await prisma.user.findUnique({ where: { id: id as string } });
    if (!user) {
      throw new AppError(404, 'User not found');
    }

    // Hash and store
    const saltRounds = parseInt(process.env.PIN_SALT_ROUNDS || '10', 10);
    const pinHash = await bcrypt.hash(pinStr, saltRounds);

    await prisma.user.update({
      where: { id: id as string },
      data: { pinHash },
    });

    console.log(`[users] PIN set for ${user.email} by admin ${req.user!.userId}`);
    res.json({ ok: true, message: `PIN set for ${user.name || user.email}` });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/users/:id/pin — clear a user's PIN
usersRouter.delete('/:id/pin', async (req: Request, res: Response, next) => {
  try {
    const { id } = req.params;

    const user = await prisma.user.findUnique({ where: { id: id as string } });
    if (!user) {
      throw new AppError(404, 'User not found');
    }

    await prisma.user.update({
      where: { id: id as string },
      data: { pinHash: null },
    });

    console.log(`[users] PIN cleared for ${user.email} by admin ${req.user!.userId}`);
    res.json({ ok: true, message: `PIN cleared for ${user.name || user.email}` });
  } catch (err) {
    next(err);
  }
});

// PUT /api/users/:id/deactivate — toggle user active status
usersRouter.put('/:id/toggle-active', async (req: Request, res: Response, next) => {
  try {
    const { id } = req.params;

    const user = await prisma.user.findUnique({ where: { id: id as string } });
    if (!user) {
      throw new AppError(404, 'User not found');
    }

    // Don't let admin deactivate themselves
    if (user.id === req.user!.userId) {
      throw new AppError(400, 'Cannot deactivate your own account');
    }

    const updated = await prisma.user.update({
      where: { id: id as string },
      data: { isActive: !user.isActive },
    });

    console.log(`[users] ${updated.email} ${updated.isActive ? 'activated' : 'deactivated'} by admin ${req.user!.userId}`);
    res.json({ ok: true, isActive: updated.isActive });
  } catch (err) {
    next(err);
  }
});

// PUT /api/users/:id/role — change a user's role
usersRouter.put('/:id/role', async (req: Request, res: Response, next) => {
  try {
    const { id } = req.params;
    const { role } = req.body;

    if (!role || !VALID_ROLES.includes(role as ValidRole)) {
      throw new AppError(400, `role must be one of: ${VALID_ROLES.join(', ')}`);
    }

    const user = await prisma.user.findUnique({ where: { id: id as string } });
    if (!user) throw new AppError(404, 'User not found');

    // Don't let an admin demote themselves — guards against lockout
    if (user.id === req.user!.userId && role !== 'platform_admin') {
      throw new AppError(400, 'Cannot change your own role away from platform_admin');
    }

    const updated = await prisma.user.update({
      where: { id: id as string },
      data: { role: role as ValidRole },
    });
    console.log(`[users] role for ${updated.email} set to ${role} by admin ${req.user!.userId}`);
    res.json({ ok: true, role: updated.role });
  } catch (err) {
    next(err);
  }
});

// PUT /api/users/:id/home-site — set (or clear) a user's default working Site.
// The home site is what the client's SiteSwitcher defaults to at the start of a
// session, so a Williston tech lands on Williston instead of the alphabetical first.
usersRouter.put('/:id/home-site', async (req: Request, res: Response, next) => {
  try {
    const { id } = req.params;
    const { siteId } = req.body as { siteId?: string | null };

    const user = await prisma.user.findUnique({ where: { id: id as string } });
    if (!user) throw new AppError(404, 'User not found');

    // null/empty clears the home site (falls back to alphabetical default)
    const newSiteId = siteId ? String(siteId) : null;
    if (newSiteId) {
      const site = await prisma.site.findUnique({ where: { id: newSiteId } });
      if (!site) throw new AppError(400, 'Site not found');
    }

    const updated = await prisma.user.update({
      where: { id: id as string },
      data: { homeSiteId: newSiteId },
    });

    console.log(`[users] home site for ${updated.email} set to ${newSiteId ?? 'none'} by admin ${req.user!.userId}`);
    res.json({ ok: true, homeSiteId: updated.homeSiteId });
  } catch (err) {
    next(err);
  }
});

// PUT /api/users/:id/password — set a local password.
// Only permitted for users without a Google auth link (authProviderId is null).
// Rationale: Google-SSO users should have their password managed in Google;
// we never want Sundog to be a password-reset vector for Workspace identities.
usersRouter.put('/:id/password', async (req: Request, res: Response, next) => {
  try {
    const { id } = req.params;
    const { password } = req.body;

    if (!password || typeof password !== 'string') {
      throw new AppError(400, 'password is required');
    }
    if (password.length < 8) {
      throw new AppError(400, 'password must be at least 8 characters');
    }

    const user = await prisma.user.findUnique({ where: { id: id as string } });
    if (!user) throw new AppError(404, 'User not found');

    if (user.authProviderId) {
      throw new AppError(
        400,
        'This user signs in with Google. Manage their password in Google Workspace, not Sundog.'
      );
    }

    const saltRounds = parseInt(process.env.PASSWORD_SALT_ROUNDS || '12', 10);
    const passwordHash = await bcrypt.hash(password, saltRounds);

    await prisma.user.update({
      where: { id: id as string },
      data: { passwordHash },
    });

    console.log(`[users] password set for ${user.email} by admin ${req.user!.userId}`);
    res.json({ ok: true, message: `Password updated for ${user.name || user.email}` });
  } catch (err) {
    next(err);
  }
});

// POST /api/users/sync-google — pre-provision users from Google Workspace Directory
usersRouter.post('/sync-google', async (req: Request, res: Response, next) => {
  try {
    if (!isGoogleGroupsConfigured()) {
      throw new AppError(
        400,
        'Google Workspace integration not configured. Set GOOGLE_SA_KEY_PATH and GOOGLE_ADMIN_EMAIL.'
      );
    }

    console.log(`[users] Google Workspace sync triggered by admin ${req.user!.userId}`);
    const report = await syncWorkspaceUsers();
    console.log(`[users] sync complete:`, report);
    res.json({ ok: true, report });
  } catch (err) {
    next(err);
  }
});
