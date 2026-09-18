import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { prisma } from '../index.js';
import { AppError } from '../middleware/errorHandler.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { authenticateKiosk } from '../middleware/kioskAuth.js';
import { createAuditLog } from '../utils/auditLog.js';

export const kiosksRouter = Router();

// BOARD = customer-work wall board; INHOUSE = the same board scoped to Basin's
// own in-house work. Both are full read-only kanbans and configure identically.
// RENTALS_DISPATCH / RENTALS_WALKIN are the rentals kanban split the same way,
// on RentalAgreement.pickupType — a dispatcher's wall vs the front counter.
const KIOSK_ROLES = [
  'BOARD', 'INHOUSE', 'STATION', 'CLAIM', 'TRAINING',
  'RENTALS_DISPATCH', 'RENTALS_WALKIN',
] as const;

// Parse an optional idle-logout window (minutes). Accepts null/'' to clear.
// Throws on garbage so the admin gets a clear error instead of a silent no-op.
function parseIdleLogout(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 240) {
    throw new AppError(400, 'idleLogoutMinutes must be a whole number between 0 and 240');
  }
  return n === 0 ? null : n;
}

// GET /api/kiosks/me — kiosk self-configuration (kiosk-token auth). The PWA
// calls this on boot to learn its site, role, and station.
kiosksRouter.get('/me', authenticateKiosk, async (req: Request, res: Response, next) => {
  try {
    const kiosk = await prisma.kiosk.findUnique({
      where: { id: req.kiosk!.kioskId },
      include: { site: { select: { id: true, name: true, shortCode: true, timezone: true } } },
    });
    if (!kiosk) throw new AppError(404, 'Kiosk not found');
    await prisma.kiosk.update({ where: { id: kiosk.id }, data: { lastSeenAt: new Date() } });
    res.json({
      slug: kiosk.slug,
      displayName: kiosk.displayName,
      role: kiosk.role,
      stationFilter: kiosk.stationFilter,
      idleLogoutMinutes: kiosk.idleLogoutMinutes,
      site: kiosk.site,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/kiosks/:slug/heartbeat — liveness ping from the kiosk
kiosksRouter.get('/:slug/heartbeat', authenticateKiosk, async (req: Request, res: Response, next) => {
  try {
    await prisma.kiosk.update({ where: { id: req.kiosk!.kioskId }, data: { lastSeenAt: new Date() } });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/kiosks — admin list
kiosksRouter.get('/', authenticate, requirePermission('system:config'), async (_req: Request, res: Response, next) => {
  try {
    const kiosks = await prisma.kiosk.findMany({
      orderBy: { slug: 'asc' },
      include: { site: { select: { id: true, name: true, shortCode: true } } },
    });
    res.json({ data: kiosks });
  } catch (err) {
    next(err);
  }
});

// POST /api/kiosks — admin provision (generates the apiToken)
kiosksRouter.post('/', authenticate, requirePermission('system:config'), async (req: Request, res: Response, next) => {
  try {
    const { slug, displayName, siteId, role, stationFilter } = req.body;
    if (!slug?.trim()) throw new AppError(400, 'slug is required');
    if (!displayName?.trim()) throw new AppError(400, 'displayName is required');
    if (!siteId) throw new AppError(400, 'siteId is required');
    if (!KIOSK_ROLES.includes(role)) {
      throw new AppError(400, `role must be one of: ${KIOSK_ROLES.join(', ')}`);
    }
    if (role === 'STATION' && !stationFilter?.trim()) {
      throw new AppError(400, 'STATION kiosks require a stationFilter');
    }
    // STATION uses stationFilter for a board column; TRAINING uses it (optionally)
    // for a CpLocation id to scope the classroom. Everyone else: null.
    const kioskStationFilter =
      role === 'STATION' || role === 'TRAINING' ? stationFilter?.trim() || null : null;
    // Idle-logout only applies to interactive CLAIM kiosks; ignore it elsewhere.
    const idleLogoutMinutes = role === 'CLAIM' ? parseIdleLogout(req.body.idleLogoutMinutes) : null;
    const site = await prisma.site.findUnique({ where: { id: siteId }, select: { id: true } });
    if (!site) throw new AppError(400, 'siteId does not match a known site');

    const kiosk = await prisma.kiosk.create({
      data: {
        slug: slug.trim().toLowerCase(),
        displayName: displayName.trim(),
        siteId,
        role,
        stationFilter: kioskStationFilter,
        idleLogoutMinutes,
        apiToken: crypto.randomBytes(24).toString('hex'),
      },
    });
    await createAuditLog({
      userId: req.user!.userId, entityType: 'kiosk', entityId: kiosk.id,
      action: 'create', changes: { slug: kiosk.slug, role }, ipAddress: req.ip,
    });
    res.status(201).json(kiosk);
  } catch (err) {
    next(err);
  }
});

// PUT /api/kiosks/:id — admin
kiosksRouter.put('/:id', authenticate, requirePermission('system:config'), async (req: Request, res: Response, next) => {
  try {
    const b = req.body;
    const data: Record<string, unknown> = {};
    if (b.displayName !== undefined) data.displayName = String(b.displayName).trim();
    if (b.stationFilter !== undefined) data.stationFilter = b.stationFilter?.trim() || null;
    if (b.idleLogoutMinutes !== undefined) data.idleLogoutMinutes = parseIdleLogout(b.idleLogoutMinutes);
    if (b.active !== undefined) data.active = b.active;
    const kiosk = await prisma.kiosk.update({ where: { id: req.params.id as string }, data });
    res.json(kiosk);
  } catch (err) {
    next(err);
  }
});
