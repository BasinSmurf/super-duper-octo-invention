/**
 * ClassPRO routes — training scheduling & course-definition module.
 *
 * Bounded module (ADR-0002): everything ClassPRO lives under /api/classpro
 * and the cp_ table namespace. Right now that's the course catalog; sessions,
 * programs, locations and content bundles land here in later waves.
 *
 * Reads are open to any authenticated user (the wizard needs the list);
 * writes are gated on training:courses. No hard delete — courses are
 * deactivated so historical roster records keep resolving.
 */

import { Router, Request, Response } from 'express';
import { prisma } from '../db.js';
import { AppError } from '../middleware/errorHandler.js';
import { requirePermission } from '../middleware/rbac.js';
import {
  composeAddress,
  geocodeAddress,
  driveTimeFromShopMin,
  travelAutoComputeEnabled,
  geocodeEnabled,
} from '../services/classproTravel.js';
import { syncSessionToGcal } from '../services/gcalSync.js';
import { pushSessionToTicket, revertOrphanedSessions } from '../services/classproTicketPush.js';
import { matchEmployer } from '../services/employerMatch.js';

export const classProRouter = Router();

const COURSE_FIELDS = [
  'code', 'name', 'durationHours', 'validityMonths', 'passingScore',
  'vaultProClassCode', 'cardsOnSite', 'qbPartNumber', 'bookVersion',
  'testVersion', 'standard', 'description', 'sortOrder', 'isActive',
] as const;

/** Whitelist + normalize a course payload ('' → null on optional fields). */
function pickCourseData(body: Record<string, unknown>): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const f of COURSE_FIELDS) {
    if (!(f in body)) continue;
    const v = body[f];
    data[f] = typeof v === 'string' && v.trim() === '' ? null : v;
  }
  return data;
}

// GET /api/classpro/courses — the full catalog, active and retired.
classProRouter.get('/courses', async (_req: Request, res: Response, next) => {
  try {
    const courses = await prisma.cpCourse.findMany({
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    res.json({ courses });
  } catch (err) {
    next(err);
  }
});

// POST /api/classpro/courses
classProRouter.post('/courses', requirePermission('training:courses'), async (req: Request, res: Response, next) => {
  try {
    const data = pickCourseData(req.body);
    if (typeof data.code !== 'string' || !data.code) throw new AppError(400, 'code is required');
    if (typeof data.name !== 'string' || !data.name) throw new AppError(400, 'name is required');
    if (!/^[a-z0-9][a-z0-9_]*$/.test(data.code)) {
      throw new AppError(400, 'code must be a lowercase slug (letters, digits, underscores)');
    }
    const course = await prisma.cpCourse.create({ data: data as never });
    res.status(201).json(course);
  } catch (err: unknown) {
    if ((err as { code?: string }).code === 'P2002') {
      next(new AppError(409, 'A course with that code already exists'));
      return;
    }
    next(err);
  }
});

// PUT /api/classpro/courses/:id — code is immutable after create (records and
// the QB/VaultPRO maps key on it); everything else is editable.
classProRouter.put('/courses/:id', requirePermission('training:courses'), async (req: Request, res: Response, next) => {
  try {
    const data = pickCourseData(req.body);
    delete data.code;
    const course = await prisma.cpCourse.update({
      where: { id: req.params.id as string },
      data: data as never,
    });
    res.json(course);
  } catch (err) {
    next(err);
  }
});

// ============================================================
// Wave 2 — Tier-A training locations
// ============================================================

const LOCATION_FIELDS = [
  'name', 'type', 'companyId', 'address', 'city', 'state', 'zip',
  'lat', 'lng', 'driveTimeFromShopMin', 'notes', 'isActive',
] as const;
const LOCATION_TYPES = new Set(['basin', 'client', 'other']);

function pickLocationData(body: Record<string, unknown>): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const f of LOCATION_FIELDS) {
    if (!(f in body)) continue;
    const v = body[f];
    data[f] = typeof v === 'string' && v.trim() === '' ? null : v;
  }
  return data;
}

/**
 * Best-effort geocode + drive-time fill on a location payload. Only fills
 * fields that are empty, and never fails the request — no Google key / no
 * result just means the fields stay as sent (manual entry, bad-divorce).
 */
async function enrichTravel(data: Record<string, unknown>): Promise<void> {
  const addr = composeAddress(data as { address?: string | null; city?: string | null; state?: string | null; zip?: string | null });
  if (data.lat == null && data.lng == null && addr) {
    const geo = await geocodeAddress(addr);
    if (geo) {
      data.lat = geo.lat;
      data.lng = geo.lng;
    }
  }
  if (data.driveTimeFromShopMin == null && typeof data.lat === 'number' && typeof data.lng === 'number') {
    const min = await driveTimeFromShopMin(data.lat, data.lng);
    if (min != null) data.driveTimeFromShopMin = min;
  }
}

const LOCATION_INCLUDE = { company: { select: { id: true, name: true } } } as const;

// GET /api/classpro/locations
classProRouter.get('/locations', async (_req: Request, res: Response, next) => {
  try {
    const locations = await prisma.cpLocation.findMany({
      include: LOCATION_INCLUDE,
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
    });
    res.json({
      locations,
      // UI hints: whether saves auto-fill lat/lng and drive time.
      geocodeEnabled: geocodeEnabled(),
      travelAutoCompute: travelAutoComputeEnabled(),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/classpro/locations — training sites auto-create with no approval
// gate (pure scheduling, low stakes — unlike well-pad creation).
classProRouter.post('/locations', requirePermission('training:schedule'), async (req: Request, res: Response, next) => {
  try {
    const data = pickLocationData(req.body);
    if (typeof data.name !== 'string' || !data.name) throw new AppError(400, 'name is required');
    if (data.type != null && !LOCATION_TYPES.has(data.type as string)) {
      throw new AppError(400, 'type must be one of: basin, client, other');
    }
    await enrichTravel(data);
    const location = await prisma.cpLocation.create({
      data: data as never,
      include: LOCATION_INCLUDE,
    });
    res.status(201).json(location);
  } catch (err) {
    next(err);
  }
});

// PUT /api/classpro/locations/:id
classProRouter.put('/locations/:id', requirePermission('training:schedule'), async (req: Request, res: Response, next) => {
  try {
    const id = req.params.id as string;
    const existing = await prisma.cpLocation.findUnique({ where: { id } });
    if (!existing) throw new AppError(404, 'Location not found');

    const data = pickLocationData(req.body);
    if (data.type != null && !LOCATION_TYPES.has(data.type as string)) {
      throw new AppError(400, 'type must be one of: basin, client, other');
    }

    // Address changed without the caller pinning coords manually → the cached
    // geocode/drive-time is stale; clear so enrichTravel recomputes below.
    const addressChanged = (['address', 'city', 'state', 'zip'] as const)
      .some(f => f in data && data[f] !== (existing as Record<string, unknown>)[f]);
    if (addressChanged && !('lat' in req.body) && !('lng' in req.body)) {
      data.lat = null;
      data.lng = null;
      if (!('driveTimeFromShopMin' in req.body)) data.driveTimeFromShopMin = null;
    }

    // Enrich against the merged row (geocoding needs the full address), then
    // fold anything enrichment changed back into the update payload. Values
    // the caller set explicitly already match merged (data wins the spread).
    const merged: Record<string, unknown> = { ...existing, ...data };
    await enrichTravel(merged);
    for (const f of ['lat', 'lng', 'driveTimeFromShopMin'] as const) {
      if (merged[f] !== (existing as Record<string, unknown>)[f]) data[f] = merged[f];
    }

    const location = await prisma.cpLocation.update({
      where: { id },
      data: data as never,
      include: LOCATION_INCLUDE,
    });
    res.json(location);
  } catch (err) {
    next(err);
  }
});

// POST /api/classpro/locations/:id/compute-travel — explicit recompute.
classProRouter.post('/locations/:id/compute-travel', requirePermission('training:schedule'), async (req: Request, res: Response, next) => {
  try {
    const id = req.params.id as string;
    const loc = await prisma.cpLocation.findUnique({ where: { id } });
    if (!loc) throw new AppError(404, 'Location not found');
    if (!geocodeEnabled()) {
      throw new AppError(400, 'Google Maps is not configured (GOOGLE_MAPS_API_KEY) — enter coordinates and drive time manually.');
    }

    const data: Record<string, unknown> = {};
    const addr = composeAddress(loc);
    const geo = addr ? await geocodeAddress(addr) : null;
    if (geo) {
      data.lat = geo.lat;
      data.lng = geo.lng;
    }
    const lat = (data.lat ?? loc.lat) as number | null;
    const lng = (data.lng ?? loc.lng) as number | null;
    if (lat != null && lng != null) {
      const min = await driveTimeFromShopMin(lat, lng);
      if (min != null) data.driveTimeFromShopMin = min;
    }

    if (Object.keys(data).length === 0) {
      throw new AppError(422, 'Could not geocode this address — check it, or enter coordinates and drive time manually.');
    }
    const location = await prisma.cpLocation.update({
      where: { id },
      data: data as never,
      include: LOCATION_INCLUDE,
    });
    res.json(location);
  } catch (err) {
    next(err);
  }
});

// ============================================================
// Wave 2 — trainers + per-date unavailability
// ============================================================

/** Local YYYY-MM-DD for "today" in the shop's timezone. */
function todayYmd(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
}

const TRAINER_INCLUDE = {
  user: { select: { id: true, name: true, email: true, isActive: true } },
} as const;

/** "HH:MM" → minutes since midnight. */
function hmToMin(hm: string): number {
  const [h, m] = hm.split(':').map(Number);
  return h * 60 + m;
}

/** Current minutes-since-midnight in the shop's timezone. */
function nowMinLocal(): number {
  const hm = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date());
  return hmToMin(hm);
}

/** Is `min` inside the session's window including its travel bands? */
function inSessionWindow(s: { startTime: string; endTime: string; travelBeforeMin: number; travelAfterMin: number }, min: number): boolean {
  return min >= hmToMin(s.startTime) - s.travelBeforeMin && min <= hmToMin(s.endTime) + s.travelAfterMin;
}

// GET /api/classpro/trainers — trainers, upcoming outages, and DERIVED
// availableToday: active + no outage today + not inside a session (including
// its travel bands) right now. Availability is computed here, never stored.
classProRouter.get('/trainers', async (_req: Request, res: Response, next) => {
  try {
    const today = todayYmd();
    const [trainers, todaySessions] = await Promise.all([
      prisma.cpTrainer.findMany({
        include: {
          ...TRAINER_INCLUDE,
          unavailability: {
            where: { date: { gte: new Date(today) } },
            orderBy: { date: 'asc' },
          },
        },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.cpScheduledSession.findMany({
        where: { date: new Date(today), status: { in: ['scheduled', 'pushed'] }, trainerId: { not: null } },
        select: { trainerId: true, startTime: true, endTime: true, travelBeforeMin: true, travelAfterMin: true },
      }),
    ]);
    const now = nowMinLocal();
    res.json({
      trainers: trainers.map(t => ({
        ...t,
        availableToday:
          t.isActive &&
          t.user.isActive &&
          !t.unavailability.some(u => u.date.toISOString().slice(0, 10) === today) &&
          !todaySessions.some(s => s.trainerId === t.id && inSessionWindow(s, now)),
      })),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/classpro/trainers { userId } — add (or reactivate) a trainer.
classProRouter.post('/trainers', requirePermission('training:schedule'), async (req: Request, res: Response, next) => {
  try {
    const userId = req.body?.userId;
    if (typeof userId !== 'string' || !userId) throw new AppError(400, 'userId is required');
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, role: true } });
    if (!user) throw new AppError(404, 'User not found');
    if (user.role === 'customer') throw new AppError(400, 'Portal accounts cannot be trainers');

    const trainer = await prisma.cpTrainer.upsert({
      where: { userId },
      create: { userId },
      update: { isActive: true },
      include: { ...TRAINER_INCLUDE, unavailability: true },
    });
    res.status(201).json(trainer);
  } catch (err) {
    next(err);
  }
});

// PUT /api/classpro/trainers/:id { isActive } — retire / reactivate.
classProRouter.put('/trainers/:id', requirePermission('training:schedule'), async (req: Request, res: Response, next) => {
  try {
    if (typeof req.body?.isActive !== 'boolean') throw new AppError(400, 'isActive (boolean) is required');
    const trainer = await prisma.cpTrainer.update({
      where: { id: req.params.id as string },
      data: { isActive: req.body.isActive },
      include: { ...TRAINER_INCLUDE, unavailability: true },
    });
    res.json(trainer);
  } catch (err) {
    next(err);
  }
});

// POST /api/classpro/trainers/:id/unavailability { date, reason? }
classProRouter.post('/trainers/:id/unavailability', requirePermission('training:schedule'), async (req: Request, res: Response, next) => {
  try {
    const trainerId = req.params.id as string;
    const dateStr = req.body?.date;
    if (typeof dateStr !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      throw new AppError(400, 'date (YYYY-MM-DD) is required');
    }
    const reason = typeof req.body?.reason === 'string' && req.body.reason.trim() ? req.body.reason.trim() : null;
    // Upsert — marking the same day twice just updates the reason.
    const row = await prisma.cpTrainerUnavailability.upsert({
      where: { trainerId_date: { trainerId, date: new Date(dateStr) } },
      create: { trainerId, date: new Date(dateStr), reason },
      update: { reason },
    });
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/classpro/trainers/:id/unavailability/:unavailId
classProRouter.delete('/trainers/:id/unavailability/:unavailId', requirePermission('training:schedule'), async (req: Request, res: Response, next) => {
  try {
    const row = await prisma.cpTrainerUnavailability.findUnique({ where: { id: req.params.unavailId as string } });
    if (!row || row.trainerId !== (req.params.id as string)) throw new AppError(404, 'Unavailability entry not found');
    await prisma.cpTrainerUnavailability.delete({ where: { id: row.id } });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// Wave 3 — scheduled sessions + calendar feed
// ============================================================

const HM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const SESSION_STATUSES = new Set(['scheduled', 'cancelled', 'completed']); // 'pushed' is set by the wave-4 ticket push, never via this API

const SESSION_INCLUDE = {
  course: { select: { id: true, code: true, name: true, durationHours: true, cardsOnSite: true } },
  trainer: { select: { id: true, isActive: true, user: { select: { id: true, name: true } } } },
  location: { select: { id: true, name: true, city: true, type: true, driveTimeFromShopMin: true, companyId: true } },
  company: { select: { id: true, name: true } },
  _count: { select: { registrations: true } },
} as const;

const SESSION_FIELDS = [
  'courseId', 'trainerId', 'locationId', 'adHocAddress', 'date', 'startTime',
  'endTime', 'deliveryMode', 'capacity', 'travelBeforeMin', 'travelAfterMin',
  'status', 'notes', 'companyId',
] as const;

function pickSessionData(body: Record<string, unknown>): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const f of SESSION_FIELDS) {
    if (!(f in body)) continue;
    const v = body[f];
    data[f] = typeof v === 'string' && v.trim() === '' ? null : v;
  }
  return data;
}

function validateSessionData(data: Record<string, unknown>, partial: boolean): void {
  if (!partial || 'date' in data) {
    if (typeof data.date !== 'string' || !YMD_RE.test(data.date)) throw new AppError(400, 'date (YYYY-MM-DD) is required');
  }
  for (const f of ['startTime', 'endTime'] as const) {
    if (!partial || f in data) {
      if (typeof data[f] !== 'string' || !HM_RE.test(data[f] as string)) throw new AppError(400, `${f} (HH:MM, 24h) is required`);
    }
  }
  if (data.deliveryMode != null && data.deliveryMode !== 'in_house' && data.deliveryMode !== 'on_site') {
    throw new AppError(400, 'deliveryMode must be in_house or on_site');
  }
  if (data.status != null && !SESSION_STATUSES.has(data.status as string)) {
    throw new AppError(400, 'status must be one of: scheduled, cancelled, completed');
  }
  if (data.locationId != null && data.adHocAddress != null) {
    throw new AppError(400, 'Provide either locationId (reusable site) or adHocAddress, not both');
  }
}

/**
 * Fill travel bands + ad-hoc geocode on a session payload. Only fills what the
 * caller didn't set by hand (bad-divorce: no Google key → bands stay 0/manual).
 * in_house sessions default to no travel.
 */
async function enrichSessionTravel(data: Record<string, unknown>): Promise<void> {
  // Ad-hoc address → one-time geocode, cached on the session (never recomputed
  // on calendar render — quota stays bounded).
  if (typeof data.adHocAddress === 'string' && data.adHocLat == null && data.adHocLng == null) {
    const geo = await geocodeAddress(data.adHocAddress);
    if (geo) {
      data.adHocLat = geo.lat;
      data.adHocLng = geo.lng;
    }
  }

  const wantsTravel = data.deliveryMode === 'on_site';
  const hasExplicitBefore = data.travelBeforeMin != null;
  const hasExplicitAfter = data.travelAfterMin != null;
  if (!wantsTravel || (hasExplicitBefore && hasExplicitAfter)) {
    data.travelBeforeMin = data.travelBeforeMin ?? 0;
    data.travelAfterMin = data.travelAfterMin ?? 0;
    return;
  }

  let minutes: number | null = null;
  if (typeof data.locationId === 'string') {
    const loc = await prisma.cpLocation.findUnique({
      where: { id: data.locationId },
      select: { driveTimeFromShopMin: true },
    });
    minutes = loc?.driveTimeFromShopMin ?? null;
  } else if (typeof data.adHocLat === 'number' && typeof data.adHocLng === 'number') {
    minutes = await driveTimeFromShopMin(data.adHocLat, data.adHocLng);
  }
  if (!hasExplicitBefore) data.travelBeforeMin = minutes ?? 0;
  if (!hasExplicitAfter) data.travelAfterMin = minutes ?? 0;
}

// GET /api/classpro/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD — everything the
// pane of glass needs in one shot: sessions in range, active trainers, and
// outages in range. Availability is derived client-side per day from these
// (the per-NOW flag stays on GET /trainers).
classProRouter.get('/calendar', async (req: Request, res: Response, next) => {
  try {
    const from = req.query.from as string;
    const to = req.query.to as string;
    if (!YMD_RE.test(from ?? '') || !YMD_RE.test(to ?? '')) {
      throw new AppError(400, 'from and to (YYYY-MM-DD) are required');
    }
    const range = { gte: new Date(from), lte: new Date(to) };
    const [sessions, trainers, unavailability] = await Promise.all([
      prisma.cpScheduledSession.findMany({
        where: { date: range },
        include: SESSION_INCLUDE,
        orderBy: [{ date: 'asc' }, { startTime: 'asc' }],
      }),
      prisma.cpTrainer.findMany({
        where: { isActive: true, user: { isActive: true } },
        select: { id: true, user: { select: { id: true, name: true } } },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.cpTrainerUnavailability.findMany({
        where: { date: range },
        select: { id: true, trainerId: true, date: true, reason: true },
      }),
    ]);
    // Self-heal: a pushed session whose ticket was deleted/voided reverts to
    // scheduled ("ready to create") right here, so the calendar never shows
    // a class stuck on a dead ticket.
    const reverted = await revertOrphanedSessions(sessions);
    for (const s of sessions) {
      if (reverted.has(s.id)) {
        s.status = 'scheduled';
        s.ticketId = null;
      }
    }
    res.json({ sessions, trainers, unavailability });
  } catch (err) {
    next(err);
  }
});

// POST /api/classpro/sessions
classProRouter.post('/sessions', requirePermission('training:schedule'), async (req: Request, res: Response, next) => {
  try {
    const data = pickSessionData(req.body);
    validateSessionData(data, false);
    if (typeof data.courseId !== 'string' || !data.courseId) throw new AppError(400, 'courseId is required');
    const course = await prisma.cpCourse.findUnique({ where: { id: data.courseId }, select: { id: true } });
    if (!course) throw new AppError(404, 'Course not found');

    await enrichSessionTravel(data);
    const { date, ...rest } = data;
    const session = await prisma.cpScheduledSession.create({
      data: { ...rest, date: new Date(date as string) } as never,
      include: SESSION_INCLUDE,
    });
    // Best-effort: event on the shared Training calendar + trainer invite.
    await syncSessionToGcal(session.id);
    res.status(201).json(session);
  } catch (err) {
    next(err);
  }
});

// PUT /api/classpro/sessions/:id — edit / cancel / complete. Travel bands are
// re-derived when the place or mode changes and the caller didn't pin them.
classProRouter.put('/sessions/:id', requirePermission('training:schedule'), async (req: Request, res: Response, next) => {
  try {
    const id = req.params.id as string;
    const existing = await prisma.cpScheduledSession.findUnique({ where: { id } });
    if (!existing) throw new AppError(404, 'Session not found');
    if (existing.status === 'pushed' && req.body?.status !== undefined && req.body.status !== 'completed' && req.body.status !== 'cancelled') {
      throw new AppError(400, 'A pushed session already has a ticket — cancel or complete it, or edit the ticket in Sundog');
    }

    const data = pickSessionData(req.body);
    validateSessionData(data, true);

    const placeChanged =
      ('locationId' in data && data.locationId !== existing.locationId) ||
      ('adHocAddress' in data && data.adHocAddress !== existing.adHocAddress) ||
      ('deliveryMode' in data && data.deliveryMode !== existing.deliveryMode);

    if (placeChanged) {
      // Ad-hoc geocode is stale if the address changed.
      if ('adHocAddress' in data && data.adHocAddress !== existing.adHocAddress) {
        data.adHocLat = null;
        data.adHocLng = null;
      }
      const merged: Record<string, unknown> = { ...existing, ...data };
      if (!('travelBeforeMin' in data)) merged.travelBeforeMin = null;
      if (!('travelAfterMin' in data)) merged.travelAfterMin = null;
      await enrichSessionTravel(merged);
      for (const f of ['travelBeforeMin', 'travelAfterMin', 'adHocLat', 'adHocLng'] as const) {
        if (merged[f] !== (existing as Record<string, unknown>)[f]) data[f] = merged[f];
      }
    }

    const { date, ...rest } = data;
    const session = await prisma.cpScheduledSession.update({
      where: { id },
      data: (date != null ? { ...rest, date: new Date(date as string) } : rest) as never,
      include: SESSION_INCLUDE,
    });
    // Best-effort gcal follow-through: patches the event, recreates it if it
    // was deleted in gcal, and removes it (cancellation email) on cancel.
    await syncSessionToGcal(session.id);
    res.json(session);
  } catch (err) {
    next(err);
  }
});

// ============================================================
// Wave 4 — pre-registration roster + "make the class" ticket push
// ============================================================

const REG_FIELDS = ['studentName', 'employerName', 'employerCompanyId', 'contactPhone', 'contactEmail', 'notes'] as const;

function pickRegistrationData(body: Record<string, unknown>): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const f of REG_FIELDS) {
    if (!(f in body)) continue;
    const v = body[f];
    data[f] = typeof v === 'string' && v.trim() === '' ? null : (typeof v === 'string' ? v.trim().slice(0, 160) : v);
  }
  return data;
}

/** Registrations only make sense while the session is still ClassPRO's —
 *  after the push, the ticket roster is the source of truth. */
async function findRegistrableSession(sessionId: string) {
  const session = await prisma.cpScheduledSession.findUnique({
    where: { id: sessionId },
    select: { id: true, status: true, ticketId: true },
  });
  if (!session) throw new AppError(404, 'Session not found');
  if (session.status === 'pushed') {
    // The ticket may have died since the push — heal before refusing.
    const reverted = await revertOrphanedSessions([session]);
    if (!reverted.has(session.id)) {
      throw new AppError(409, 'This class has already been made into a ticket — add students on the ticket roster');
    }
    session.status = 'scheduled';
    session.ticketId = null;
  }
  if (session.status === 'cancelled') throw new AppError(409, 'Session is cancelled');
  return session;
}

// GET /api/classpro/sessions/:id/registrations
classProRouter.get('/sessions/:id/registrations', async (req: Request, res: Response, next) => {
  try {
    const registrations = await prisma.cpSessionRegistration.findMany({
      where: { sessionId: req.params.id as string },
      include: { employerCompany: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'asc' },
    });
    res.json({ registrations });
  } catch (err) {
    next(err);
  }
});

// POST /api/classpro/sessions/:id/registrations — pre-register a student.
// employerCompanyId from the picker wins; free-text employers run through the
// silent matcher (alias / exact normalized name — never fuzzy).
classProRouter.post('/sessions/:id/registrations', requirePermission('training:schedule'), async (req: Request, res: Response, next) => {
  try {
    const session = await findRegistrableSession(req.params.id as string);
    const data = pickRegistrationData(req.body);
    if (typeof data.studentName !== 'string' || !data.studentName) throw new AppError(400, 'studentName is required');
    if (data.employerCompanyId == null && typeof data.employerName === 'string') {
      data.employerCompanyId = (await matchEmployer(data.employerName))?.companyId ?? null;
    }
    const registration = await prisma.cpSessionRegistration.create({
      data: { ...data, sessionId: session.id } as never,
      include: { employerCompany: { select: { id: true, name: true } } },
    });
    res.status(201).json(registration);
  } catch (err) {
    next(err);
  }
});

// PUT /api/classpro/registrations/:id
classProRouter.put('/registrations/:id', requirePermission('training:schedule'), async (req: Request, res: Response, next) => {
  try {
    const existing = await prisma.cpSessionRegistration.findUnique({
      where: { id: req.params.id as string },
      select: { id: true, sessionId: true, employerName: true },
    });
    if (!existing) throw new AppError(404, 'Registration not found');
    await findRegistrableSession(existing.sessionId);

    const data = pickRegistrationData(req.body);
    if ('studentName' in data && !data.studentName) throw new AppError(400, 'studentName cannot be blank');
    // Employer text changed without an explicit pick → re-run the matcher.
    if (!('employerCompanyId' in req.body) && typeof data.employerName === 'string' && data.employerName !== existing.employerName) {
      data.employerCompanyId = (await matchEmployer(data.employerName))?.companyId ?? null;
    }
    const registration = await prisma.cpSessionRegistration.update({
      where: { id: existing.id },
      data: data as never,
      include: { employerCompany: { select: { id: true, name: true } } },
    });
    res.json(registration);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/classpro/registrations/:id
classProRouter.delete('/registrations/:id', requirePermission('training:schedule'), async (req: Request, res: Response, next) => {
  try {
    const existing = await prisma.cpSessionRegistration.findUnique({
      where: { id: req.params.id as string },
      select: { id: true, sessionId: true },
    });
    if (!existing) throw new AppError(404, 'Registration not found');
    await findRegistrableSession(existing.sessionId);
    await prisma.cpSessionRegistration.delete({ where: { id: existing.id } });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/classpro/sessions/:id/push — "make the class": the one idempotent
// handoff into Sundog. Creates the draft training ticket + roster, flips the
// session to 'pushed'. Re-posting returns the existing ticket.
classProRouter.post('/sessions/:id/push', requirePermission('training:schedule'), async (req: Request, res: Response, next) => {
  try {
    const result = await pushSessionToTicket(req.params.id as string, req.user?.userId ?? null);
    res.status(result.created ? 201 : 200).json(result);
  } catch (err) {
    next(err);
  }
});
