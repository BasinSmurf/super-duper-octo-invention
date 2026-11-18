import { Router, Request, Response } from 'express';
import Fuse from 'fuse.js';
import { prisma } from '../db.js';
import { AppError } from '../middleware/errorHandler.js';
import type { TicketStatus } from '../db.js';
import { requirePermission } from '../middleware/rbac.js';
import { createAuditLog } from '../utils/auditLog.js';
import { emitEvent } from '../services/eventBus.js';
import { isVerificationCurrent, validateExpiryDays, workPointIdentityChanged } from '../services/workPointVerification.js';
import { dmrImportRouter } from './dmr-import.js';
import { dmrMatchRouter } from './dmr-match.js';
import { proximityRouter } from './proximity.js';
import { findExistingWellCandidates, wellsWithoutHistory, mergeWell, normalizeWellName, wellNameBase, type ExistingWellCandidate } from '../services/wellDmrMatch.js';

export const locationsRouter = Router();

// Mount DMR sub-routers. /dmr/match must precede /dmr so its routes aren't
// shadowed by the import router mounted at /dmr.
locationsRouter.use('/dmr/match', dmrMatchRouter);
locationsRouter.use('/dmr', dmrImportRouter);
locationsRouter.use('/proximity', proximityRouter);

// ============================================================
// FIELDS
// ============================================================

locationsRouter.get('/work-point-verification-settings', async (_req, res, next) => {
  try {
    const config = await prisma.workPointVerificationConfig.findUnique({ where: { id: 'default' } });
    res.json({ expiryDays: config?.expiryDays ?? 0 });
  } catch (error) { next(error); }
});

locationsRouter.put('/work-point-verification-settings', requirePermission('system:config'), async (req, res, next) => {
  try {
    const expiryDays = validateExpiryDays(req.body?.expiryDays);
    await prisma.$transaction(async tx => {
      await tx.workPointVerificationConfig.upsert({ where: { id: 'default' }, create: { id: 'default', expiryDays }, update: { expiryDays } });
      await tx.auditLog.create({ data: { userId: req.user!.userId, entityType: 'WorkPointVerificationConfig', entityId: 'default', action: 'update', changes: { expiryDays } } });
    });
    res.json({ expiryDays });
  } catch (error) { next(error); }
});

locationsRouter.get('/fields', async (req: Request, res: Response, next) => {
  try {
    const { search, active } = req.query;
    const where: any = {};
    if (search) where.name = { contains: search as string, mode: 'insensitive' };
    if (active !== undefined) where.isActive = active === 'true';

    const fields = await prisma.field.findMany({
      where,
      include: {
        _count: { select: { pads: true, wells: true, facilities: true } },
      },
      orderBy: { name: 'asc' },
    });
    res.json(fields);
  } catch (err) {
    next(err);
  }
});

locationsRouter.get('/fields/:id', async (req: Request, res: Response, next) => {
  try {
    const field = await prisma.field.findUnique({
      where: { id: req.params.id as string },
      include: {
        pads: { where: { isActive: true }, include: { _count: { select: { wells: true } } } },
        facilities: { where: { isActive: true } },
      },
    });
    if (!field) throw new AppError(404, 'Field not found');
    res.json(field);
  } catch (err) {
    next(err);
  }
});

locationsRouter.post('/fields', requirePermission('locations:manage'), async (req: Request, res: Response, next) => {
  try {
    const field = await prisma.field.create({ data: req.body });
    await createAuditLog({
      userId: req.user!.userId, entityType: 'field', entityId: field.id,
      action: 'create', changes: req.body, ipAddress: req.ip,
    });
    res.status(201).json(field);
  } catch (err) {
    next(err);
  }
});

locationsRouter.put('/fields/:id', requirePermission('locations:manage'), async (req: Request, res: Response, next) => {
  try {
    const field = await prisma.field.update({ where: { id: req.params.id as string }, data: req.body });
    res.json(field);
  } catch (err) {
    next(err);
  }
});

// ============================================================
// PADS
// ============================================================

locationsRouter.get('/pads', async (req: Request, res: Response, next) => {
  try {
    const { fieldId, operatorId, search, active, pendingReview, limit = '50', offset = '0' } = req.query;
    const where: any = {};
    if (fieldId) where.fieldId = fieldId as string;
    if (operatorId) where.currentOperatorId = operatorId as string;
    if (search) where.name = { contains: search as string, mode: 'insensitive' };
    if (active !== undefined) where.isActive = active === 'true';
    if (pendingReview === 'true') where.pendingReview = true;

    const [pads, total] = await Promise.all([
      prisma.pad.findMany({
        where,
        include: {
          field: { select: { id: true, name: true } },
          currentOperator: { select: { id: true, name: true } },
          _count: { select: { wells: true, workPoints: true } },
        },
        orderBy: { name: 'asc' },
        take: parseInt(limit as string, 10),
        skip: parseInt(offset as string, 10),
      }),
      prisma.pad.count({ where }),
    ]);
    res.json({ data: pads, total });
  } catch (err) {
    next(err);
  }
});

locationsRouter.get('/pads/:id', async (req: Request, res: Response, next) => {
  try {
    const pad = await prisma.pad.findUnique({
      where: { id: req.params.id as string },
      include: {
        field: true,
        currentOperator: { select: { id: true, name: true } },
        wells: { where: { isActiveForService: true } },
        workPoints: { where: { isActive: true } },
      },
    });
    if (!pad) throw new AppError(404, 'Pad not found');
    res.json(pad);
  } catch (err) {
    next(err);
  }
});

locationsRouter.post('/pads', requirePermission('locations:manage'), async (req: Request, res: Response, next) => {
  try {
    const pad = await prisma.pad.create({ data: req.body });
    await createAuditLog({
      userId: req.user!.userId, entityType: 'pad', entityId: pad.id,
      action: 'create', changes: req.body, ipAddress: req.ip,
    });
    res.status(201).json(pad);
  } catch (err) {
    next(err);
  }
});

locationsRouter.put('/pads/:id', requirePermission('locations:manage'), async (req: Request, res: Response, next) => {
  try {
    const pad = await prisma.pad.update({ where: { id: req.params.id as string }, data: req.body });
    res.json(pad);
  } catch (err) {
    next(err);
  }
});

// ============================================================
// WELLS
// ============================================================

locationsRouter.get('/wells', async (req: Request, res: Response, next) => {
  try {
    const { padId, fieldId, operatorId, search, apiNumber, active, dmrVerified, limit = '50', offset = '0' } = req.query;
    const where: any = {};
    if (padId) where.padId = padId as string;
    if (fieldId) where.fieldId = fieldId as string;
    // operatorId=none finds wells with NO operator. They're otherwise
    // unreachable: every picker scopes by a real operator id, so an
    // operator-less well is filtered out of the exact screens you'd use to
    // give it one.
    if (operatorId) where.currentOperatorId = operatorId === 'none' ? null : operatorId as string;
    if (search) {
      where.OR = [
        { wellName: { contains: search as string, mode: 'insensitive' } },
        { apiNumber: { contains: search as string, mode: 'insensitive' } },
      ];
    }
    if (apiNumber) where.apiNumber = apiNumber as string;
    if (active !== undefined) where.isActiveForService = active === 'true';
    // Restricts to wells matched against DMR canon (dmrReferenceId set) — used
    // by the pad-builder well-picker, which should only offer verified wells.
    if (dmrVerified === 'true') where.dmrReferenceId = { not: null };

    const [wells, total] = await Promise.all([
      prisma.well.findMany({
        where,
        include: {
          pad: { select: { id: true, name: true } },
          field: { select: { id: true, name: true } },
          currentOperator: { select: { id: true, name: true } },
        },
        orderBy: { wellName: 'asc' },
        take: parseInt(limit as string, 10),
        skip: parseInt(offset as string, 10),
      }),
      prisma.well.count({ where }),
    ]);
    res.json({ data: wells, total });
  } catch (err) {
    next(err);
  }
});

// GET /wells/unassigned — wells not assigned to any pad. Must be registered
// before GET /wells/:id, or Express matches :id="unassigned" first and this
// handler never runs.
locationsRouter.get('/wells/unassigned', requirePermission('locations:manage'), async (req: Request, res: Response, next) => {
  try {
    const { operatorId, search, limit = '50', offset = '0' } = req.query;

    const where: any = { padId: null };
    // 'none' = the no-operator bucket (see GET /wells).
    if (operatorId) where.currentOperatorId = operatorId === 'none' ? null : operatorId as string;
    if (search) {
      where.OR = [
        { wellName: { contains: search as string, mode: 'insensitive' } },
        { apiNumber: { contains: search as string, mode: 'insensitive' } },
      ];
    }

    const [wells, total] = await Promise.all([
      prisma.well.findMany({
        where,
        include: {
          field: { select: { id: true, name: true } },
          currentOperator: { select: { id: true, name: true } },
        },
        orderBy: [{ currentOperator: { name: 'asc' } }, { wellName: 'asc' }],
        take: parseInt(limit as string, 10),
        skip: parseInt(offset as string, 10),
      }),
      prisma.well.count({ where }),
    ]);

    // Also return operator summary for filtering
    const operatorSummary = await prisma.well.groupBy({
      by: ['currentOperatorId'],
      where: { padId: null },
      _count: true,
    });

    res.json({ data: wells, total, operatorSummary });
  } catch (err) {
    next(err);
  }
});

locationsRouter.get('/wells/:id', async (req: Request, res: Response, next) => {
  try {
    const well = await prisma.well.findUnique({
      where: { id: req.params.id as string },
      include: {
        pad: true,
        field: true,
        currentOperator: { select: { id: true, name: true } },
        workPoints: { where: { isActive: true } },
      },
    });
    if (!well) throw new AppError(404, 'Well not found');
    const noHistoryIds = await wellsWithoutHistory([well.id]);
    res.json({ ...well, hasHistory: !noHistoryIds.has(well.id) });
  } catch (err) {
    next(err);
  }
});

// DELETE /wells/:id — delete a well outright. Re-verifies history server-side
// (never trust the client's stale "no history" pill) so a ticket/rental that
// landed on this well after the page loaded can't be silently orphaned.
locationsRouter.delete('/wells/:id', requirePermission('locations:manage'), async (req: Request, res: Response, next) => {
  try {
    const id = req.params.id as string;
    const well = await prisma.well.findUnique({ where: { id }, select: { id: true, wellName: true } });
    if (!well) throw new AppError(404, 'Well not found');
    const noHistoryIds = await wellsWithoutHistory([id]);
    if (!noHistoryIds.has(id)) {
      throw new AppError(409, 'This well has history (tickets, rentals, equipment, etc.) and cannot be deleted.');
    }
    await prisma.well.delete({ where: { id } });
    await createAuditLog({
      userId: req.user!.userId, entityType: 'well', entityId: id,
      action: 'delete', changes: { wellName: well.wellName }, ipAddress: req.ip,
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /wells/:id/merge — fold this well (loser) into another well (winner):
// every ticket/rental/equipment/etc. reassigns to the winner, then this well
// is soft-deactivated with a breadcrumb. Reuses the same mergeWell used by the
// DMR dedupe queue, tagged 'manual_merge' so the two paths stay distinguishable.
locationsRouter.post('/wells/:id/merge', requirePermission('locations:manage'), async (req: Request, res: Response, next) => {
  try {
    const loserId = req.params.id as string;
    const { winnerWellId } = req.body || {};
    if (!winnerWellId) throw new AppError(400, 'winnerWellId is required');
    await mergeWell(loserId, winnerWellId, 'manual_merge');
    await createAuditLog({
      userId: req.user!.userId, entityType: 'well', entityId: loserId,
      action: 'update', changes: { mode: 'manual_merge', winnerWellId }, ipAddress: req.ip,
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

locationsRouter.post('/wells', requirePermission('locations:manage'), async (req: Request, res: Response, next) => {
  try {
    const well = await prisma.well.create({ data: req.body });
    await createAuditLog({
      userId: req.user!.userId, entityType: 'well', entityId: well.id,
      action: 'create', changes: req.body, ipAddress: req.ip,
    });
    res.status(201).json(well);
  } catch (err) {
    next(err);
  }
});

// Fields that identify the well or tie it to DMR/billing (API#, operator,
// legal location, classification) are locked to platform_admin — a wrong
// edit here silently breaks DMR matching, dedup, or invoicing. Everyone with
// locations:manage can still touch the low-stakes fields below (facility
// code, asset category, active toggle, risk/service notes).
const WELL_ADMIN_ONLY_FIELDS = new Set([
  'wellName', 'wellNameBase', 'apiNumber', 'apiShort', 'dmrFileNumber',
  'totalDepth', 'spudDate', 'wellType', 'wellStatus', 'county',
  'quarterQuarter', 'section', 'township', 'range',
  'feetNs', 'nsLine', 'feetEw', 'ewLine', 'latitude', 'longitude',
  'currentOperatorId', 'fieldId', 'padId',
]);

locationsRouter.put('/wells/:id', requirePermission('locations:manage'), async (req: Request, res: Response, next) => {
  try {
    if (req.user!.role !== 'platform_admin' && Object.keys(req.body).some(k => WELL_ADMIN_ONLY_FIELDS.has(k))) {
      throw new AppError(403, 'Only a platform admin can edit core well identity fields (API #, operator, legal location, classification).');
    }
    const well = await prisma.well.update({ where: { id: req.params.id as string }, data: req.body });
    res.json(well);
  } catch (err) {
    next(err);
  }
});

// PUT /wells/:id/reassign — move a well to a different pad (or unassign)
locationsRouter.put('/wells/:id/reassign', requirePermission('locations:manage'), async (req: Request, res: Response, next) => {
  try {
    const { padId } = req.body; // null = unassign from pad

    const existing = await prisma.well.findUnique({
      where: { id: req.params.id as string },
      select: { id: true, padId: true, wellName: true },
    });
    if (!existing) throw new AppError(404, 'Well not found');

    const well = await prisma.well.update({
      where: { id: req.params.id as string },
      data: { padId: padId || null },
      include: {
        pad: { select: { id: true, name: true } },
        currentOperator: { select: { id: true, name: true } },
      },
    });

    await createAuditLog({
      userId: req.user!.userId,
      entityType: 'well',
      entityId: well.id,
      action: 'update' as any, // reassign — uses 'update' until next schema migration
      changes: { action: 'reassign', oldPadId: existing.padId, newPadId: padId || null, wellName: existing.wellName },
      ipAddress: req.ip,
    });

    res.json(well);
  } catch (err) {
    next(err);
  }
});

// POST /wells/bulk-reassign — assign multiple wells to a pad
locationsRouter.post('/wells/bulk-reassign', requirePermission('locations:manage'), async (req: Request, res: Response, next) => {
  try {
    const { wellIds, padId } = req.body;
    if (!Array.isArray(wellIds) || wellIds.length === 0) {
      throw new AppError(400, 'wellIds array required');
    }

    const result = await prisma.well.updateMany({
      where: { id: { in: wellIds } },
      data: { padId: padId || null },
    });

    await createAuditLog({
      userId: req.user!.userId,
      entityType: 'well',
      entityId: padId || 'bulk',
      action: 'update' as any, // bulk_reassign — uses 'update' until next schema migration
      changes: { action: 'bulk_reassign', wellIds, padId, count: result.count },
      ipAddress: req.ip,
    });

    res.json({ updated: result.count });
  } catch (err) {
    next(err);
  }
});

// POST /wells/bulk-set-operator — stamp an operator onto wells that have none
//
// The recovery path for wells that got activated before the operator became
// mandatory (see POST /dmr/activate): with currentOperatorId null they drop out
// of every operator-scoped picker, so there was no screen left that could fix
// them. Claiming an unclaimed well is deliberately open to locations:manage —
// REPLACING an operator that's already set stays platform_admin only, same as
// the currentOperatorId gate on PUT /wells/:id, and only that case writes
// OperatorHistory (a null -> X stamp isn't a change of hands, it's a backfill).
locationsRouter.post('/wells/bulk-set-operator', requirePermission('locations:manage'), async (req: Request, res: Response, next) => {
  try {
    const { wellIds, operatorId } = req.body as { wellIds?: unknown; operatorId?: unknown };
    if (!Array.isArray(wellIds) || wellIds.length === 0) throw new AppError(400, 'wellIds array required');
    if (typeof operatorId !== 'string' || !operatorId) throw new AppError(400, 'operatorId required');

    const company = await prisma.company.findUnique({ where: { id: operatorId }, select: { id: true, name: true } });
    if (!company) throw new AppError(404, 'Operator not found');

    const wells = await prisma.well.findMany({
      where: { id: { in: wellIds as string[] } },
      select: { id: true, currentOperatorId: true },
    });
    const unclaimed = wells.filter(w => !w.currentOperatorId);
    const reassigned = wells.filter(w => w.currentOperatorId && w.currentOperatorId !== company.id);
    const alreadyOurs = wells.length - unclaimed.length - reassigned.length;

    if (reassigned.length > 0 && req.user!.role !== 'platform_admin') {
      throw new AppError(403, `${reassigned.length} of these wells already have an operator — only a platform admin can move a well to a different operator.`);
    }

    const { claimed, moved } = await prisma.$transaction(async (tx) => {
      let claimed = 0;
      if (unclaimed.length > 0) {
        claimed = (await tx.well.updateMany({
          where: { id: { in: unclaimed.map(w => w.id) } },
          data: { currentOperatorId: company.id },
        })).count;
      }
      let moved = 0;
      if (reassigned.length > 0) {
        await tx.operatorHistory.createMany({
          data: reassigned.map(w => ({
            wellId: w.id,
            previousOperatorId: w.currentOperatorId!,
            newOperatorId: company.id,
            effectiveDate: new Date(),
            source: 'manual' as const,
            notes: 'bulk operator correction',
          })),
        });
        moved = (await tx.well.updateMany({
          where: { id: { in: reassigned.map(w => w.id) } },
          data: { currentOperatorId: company.id },
        })).count;
      }
      return { claimed, moved };
    });

    await createAuditLog({
      userId: req.user!.userId,
      entityType: 'well',
      entityId: company.id,
      action: 'update' as any,
      changes: { action: 'bulk_set_operator', operatorId: company.id, operatorName: company.name, wellIds, claimed, moved, alreadyOurs },
      ipAddress: req.ip,
    });

    res.json({ claimed, moved, alreadyOurs, operator: company });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// DMR BULK ACTIVATION
// ============================================================

// Well Type / Status enum mappings (MT descriptive → Prisma enum)
const WELL_TYPE_MAP: Record<string, string> = {
  OG: 'OG', SWD: 'SWD', WI: 'WI', GASD: 'GASD', ST: 'ST',
  GASC: 'GASC', WS: 'WS', CO2I: 'CO2I', AI: 'AI', GI: 'GI',
  Oil: 'OG', 'Oil & Gas': 'OG', Gas: 'OG', 'Dry Hole': 'OG',
  'Injection, EOR': 'WI', 'Injection - Disposal': 'SWD',
  'Water Source': 'WS', 'Stratigraphic Test': 'ST',
};
const WELL_STATUS_MAP: Record<string, string> = {
  A: 'A', DRY: 'DRY', PA: 'PA', PNC: 'PNC', IA: 'IA',
  Confidential: 'Confidential', AB: 'AB', LOC: 'LOC', DRL: 'DRL', TA: 'TA',
  Producing: 'A', 'Active Injection': 'A', Completed: 'A', 'Shut In': 'IA',
  'P&A - Approved': 'PA', Spudded: 'DRL', 'Permit to Drill': 'LOC',
  'Temporarily Abandoned': 'TA', 'Abandoned - Unapproved': 'AB',
};

export interface ActivateResolution { dmrWellId: string; action: 'link' | 'create'; wellId?: string }
export interface AmbiguousActivation {
  dmrWellId: string; wellName: string | null; apiNumber: string | null; fieldName: string | null;
  candidates: ExistingWellCandidate[];
}

/** Parse+validate a client-supplied resolutions array into a lookup map. */
function parseResolutions(input: unknown): Map<string, ActivateResolution> {
  const map = new Map<string, ActivateResolution>();
  if (!Array.isArray(input)) return map;
  for (const r of input) {
    if (!r || typeof r.dmrWellId !== 'string') continue;
    if (r.action === 'link' && typeof r.wellId === 'string') map.set(r.dmrWellId, { dmrWellId: r.dmrWellId, action: 'link', wellId: r.wellId });
    else if (r.action === 'create') map.set(r.dmrWellId, { dmrWellId: r.dmrWellId, action: 'create' });
  }
  return map;
}

/**
 * Materialize a set of DMR reference wells into system wells under one company,
 * creating fields + name-grouped pads as needed. Skips rows whose API already
 * exists (idempotent). Canonical activation core — used by activate-by-operator.
 * Pads are grouped by well-name base + STR here; run the Builder's proximity Consolidate
 * afterward to collapse fragments into true physical pads.
 *
 * Before creating anything, checks each row against existing UNATTACHED wells
 * (no API#) for a name match — those are wells from a prior DoForms/Azure
 * import that may be this exact physical well, just never DMR-identified. A
 * row with a candidate and no matching `resolutions` entry is skipped (not
 * created) and reported in `ambiguous` — the caller must re-run with an
 * explicit link/create decision. This is deliberately conservative: a fuzzy
 * hit can be a different wellbore entirely (e.g. an "-1" vs its "-1H"
 * horizontal re-entry), so nothing here auto-links.
 */
async function materializeDmrWells(
  dmrWells: Awaited<ReturnType<typeof prisma.dmrReferenceWell.findMany>>,
  companyId: string,
  resolutions: Map<string, ActivateResolution> = new Map(),
): Promise<{
  fieldsCreated: number; padsCreated: number; wellsCreated: number; wellsLinked: number;
  wellsSkipped: number; needsReview: number; errors: number; ambiguous: AmbiguousActivation[];
}> {
  const stats = { fieldsCreated: 0, padsCreated: 0, wellsCreated: 0, wellsLinked: 0, wellsSkipped: 0, needsReview: 0, errors: 0 };
  const ambiguous: AmbiguousActivation[] = [];
  const apiNumbers = dmrWells.map(w => w.apiNumber).filter((a): a is string => a != null);
  const existingByApi = new Set(
    (await prisma.well.findMany({ where: { apiNumber: { in: apiNumbers } }, select: { apiNumber: true } })).map(w => w.apiNumber)
  );
  const toProcess = dmrWells.filter(d => !(d.apiNumber && existingByApi.has(d.apiNumber)));
  stats.wellsSkipped += dmrWells.length - toProcess.length;

  const candidatesByDmrId = await findExistingWellCandidates(toProcess.map(d => ({ id: d.id, wellName: d.wellName })));

  const fieldCache = new Map<string, string>();
  (await prisma.field.findMany({ select: { id: true, name: true, state: true } }))
    .forEach(f => fieldCache.set(`${f.name.toLowerCase()}|${(f.state || 'ND').toUpperCase()}`, f.id));

  // Pads are manual-only — DMR activation never looks up or creates one.
  // Wells land unattached (padId undefined); a human attaches them to a real
  // pad afterward via the well reassign endpoint. Auto-grouping by
  // well-name-base + STR used to spawn a fresh Pad per fragment, most of
  // which were never real physical locations.
  const padId: string | undefined = undefined;

  for (const d of toProcess) {
    const candidates = candidatesByDmrId.get(d.id);
    const resolution = resolutions.get(d.id);

    if (candidates && candidates.length > 0 && !resolution) {
      stats.needsReview++;
      ambiguous.push({ dmrWellId: d.id, wellName: d.wellName, apiNumber: d.apiNumber, fieldName: d.fieldName, candidates });
      continue;
    }

    const state = 'ND';
    const fieldKey = `${(d.fieldName || 'Unknown').toLowerCase()}|${state}`;
    let fieldId = fieldCache.get(fieldKey);
    if (!fieldId) {
      const existing = await prisma.field.findFirst({ where: { name: { equals: d.fieldName || 'Unknown', mode: 'insensitive' } } });
      if (existing) fieldId = existing.id;
      else { const c = await prisma.field.create({ data: { name: d.fieldName || 'Unknown', county: d.county, state } }); fieldId = c.id; stats.fieldsCreated++; }
      fieldCache.set(fieldKey, fieldId);
    }

    if (resolution?.action === 'link' && resolution.wellId) {
      try {
        const existing = await prisma.well.findUnique({ where: { id: resolution.wellId }, select: { apiNumber: true, currentOperatorId: true } });
        if (!existing || existing.apiNumber) { stats.errors++; continue; }
        await prisma.well.update({
          where: { id: resolution.wellId },
          data: {
            fieldId, padId, currentOperatorId: existing.currentOperatorId ?? companyId,
            dmrFileNumber: d.dmrFileNumber, apiNumber: d.apiNumber, apiShort: d.apiShort,
            // Linking says "this row IS that API", so the state's designation
            // for that API becomes the name. Keeping the typed one is how a
            // well ends up named as a well we don't have.
            ...(normalizeWellName(d.wellName)
              ? { wellName: normalizeWellName(d.wellName)!, wellNameBase: wellNameBase(normalizeWellName(d.wellName)) }
              : { wellNameBase: d.wellNameBase }),
            totalDepth: d.totalDepth, spudDate: d.spudDate,
            quarterQuarter: d.quarterQuarter, section: d.section, township: d.township, range: d.range,
            feetNs: d.feetNs, nsLine: d.nsLine, feetEw: d.feetEw, ewLine: d.ewLine,
            latitude: d.latitude, longitude: d.longitude,
            wellType: (WELL_TYPE_MAP[d.wellType || ''] || 'other') as any,
            wellStatus: (WELL_STATUS_MAP[d.wellStatus || ''] || 'other') as any,
            county: d.county,
            dmrReferenceId: d.id, dmrImportDate: new Date(), dmrRawData: d.rawData || undefined,
          },
        });
        await prisma.dmrReferenceWell.update({
          where: { id: d.id },
          data: { matchedWellId: resolution.wellId, matchedCompanyId: existing.currentOperatorId ?? companyId },
        });
        stats.wellsLinked++;
      } catch (e: any) {
        if (e.code === 'P2002') stats.wellsSkipped++; else stats.errors++;
      }
      continue;
    }

    try {
      const well = await prisma.well.create({
        data: {
          fieldId, padId, currentOperatorId: companyId,
          dmrFileNumber: d.dmrFileNumber, apiNumber: d.apiNumber, apiShort: d.apiShort,
          wellName: normalizeWellName(d.wellName), wellNameBase: wellNameBase(normalizeWellName(d.wellName)),
          totalDepth: d.totalDepth, spudDate: d.spudDate,
          quarterQuarter: d.quarterQuarter, section: d.section, township: d.township, range: d.range,
          feetNs: d.feetNs, nsLine: d.nsLine, feetEw: d.feetEw, ewLine: d.ewLine,
          latitude: d.latitude, longitude: d.longitude,
          wellType: (WELL_TYPE_MAP[d.wellType || ''] || 'other') as any,
          wellStatus: (WELL_STATUS_MAP[d.wellStatus || ''] || 'other') as any,
          county: d.county,
          dmrReferenceId: d.id, dmrImportDate: new Date(), dmrRawData: d.rawData || undefined,
        },
      });
      await prisma.dmrReferenceWell.update({ where: { id: d.id }, data: { matchedWellId: well.id, matchedCompanyId: companyId } });
      stats.wellsCreated++;
    } catch (e: any) {
      if (e.code === 'P2002') stats.wellsSkipped++; else stats.errors++;
    }
  }
  return { ...stats, ambiguous };
}
// GET /dmr/operators — distinct DMR operator names with UNACTIVATED well counts,
// for the "activate everything for <operator>" picker. No hardcoded alias list.
locationsRouter.get('/dmr/operators', requirePermission('locations:manage'), async (req: Request, res: Response, next) => {
  try {
    const search = String(req.query.search || '').trim();
    const grouped = await prisma.dmrReferenceWell.groupBy({
      by: ['operatorName'],
      where: {
        matchedWellId: null,
        operatorName: search ? { contains: search, mode: 'insensitive' } : { not: null },
      },
      _count: { _all: true },
    });
    const data = grouped
      .filter(g => g.operatorName)
      .map(g => ({ operatorName: g.operatorName as string, unactivatedCount: g._count._all }))
      .sort((a, b) => b.unactivatedCount - a.unactivatedCount)
      .slice(0, 50);
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// POST /dmr/activate-by-operator — activate every unactivated DMR well for one
// operator name into the system under a chosen company. General (no alias map):
// pick "BURLINGTON RESOURCES…", activate under a Burlington company, then run a
// buyout (Transfer Operator on the target company) to fold it into ConocoPhillips.
// Body: { operatorName, targetCompanyId, statuses?, dryRun?, resolutions? }
//
// Idempotent + resumable: DMR rows already matched (matchedWellId set) drop
// out of the query, so a row that's ambiguous on the first pass — reported
// in the response's `ambiguous` array, nothing created for it — can be
// resolved and the SAME call repeated; only the still-unresolved rows remain.
locationsRouter.post('/dmr/activate-by-operator', requirePermission('locations:manage'), async (req: Request, res: Response, next) => {
  try {
    const { operatorName, operatorNames, targetCompanyId, statuses, dryRun = false, resolutions } = req.body as {
      operatorName?: string; operatorNames?: string[]; targetCompanyId?: string; statuses?: string[]; dryRun?: boolean; resolutions?: unknown;
    };
    // Accept one name or several (operators often have name variants in DMR,
    // e.g. "BURLINGTON … LP" vs "BURLINGTON … COMPANY" — grab them together).
    const names = (operatorNames && operatorNames.length ? operatorNames : operatorName ? [operatorName] : [])
      .map(n => String(n).trim()).filter(Boolean);
    if (names.length === 0) throw new AppError(400, 'operatorName or operatorNames[] is required');

    const where: any = {
      matchedWellId: null,
      operatorName: { in: names },
    };
    if (Array.isArray(statuses) && statuses.length > 0) where.wellStatus = { in: statuses };

    const dmrWells = await prisma.dmrReferenceWell.findMany({ where });
    const apiNumbers = dmrWells.map(w => w.apiNumber).filter((a): a is string => a != null);
    const existingApis = new Set(
      (await prisma.well.findMany({ where: { apiNumber: { in: apiNumbers } }, select: { apiNumber: true } })).map(w => w.apiNumber)
    );
    const toActivate = dmrWells.filter(w => !w.apiNumber || !existingApis.has(w.apiNumber));

    if (dryRun) {
      const candidatesByDmrId = await findExistingWellCandidates(toActivate.map(d => ({ id: d.id, wellName: d.wellName })));
      const ambiguous: AmbiguousActivation[] = [];
      candidatesByDmrId.forEach((candidates, dmrWellId) => {
        const d = toActivate.find(w => w.id === dmrWellId)!;
        ambiguous.push({ dmrWellId, wellName: d.wellName, apiNumber: d.apiNumber, fieldName: d.fieldName, candidates });
      });
      res.json({
        dryRun: true, operatorNames: names, matched: dmrWells.length, alreadyExist: existingApis.size,
        wouldActivate: toActivate.length - ambiguous.length, ambiguous,
      });
      return;
    }

    if (!targetCompanyId) throw new AppError(400, 'targetCompanyId is required to activate');
    const company = await prisma.company.findUnique({ where: { id: targetCompanyId }, select: { id: true, name: true } });
    if (!company) throw new AppError(404, 'targetCompanyId not found');

    const { ambiguous, ...stats } = await materializeDmrWells(toActivate, company.id, parseResolutions(resolutions));

    await createAuditLog({
      userId: req.user!.userId,
      entityType: 'dmr_bulk_activate',
      entityId: company.id,
      action: 'create' as any,
      changes: { action: 'activate_by_operator', operatorNames: names, targetCompanyId: company.id, targetCompanyName: company.name, ...stats },
      ipAddress: req.ip,
    });

    res.json({ operatorNames: names, targetCompany: company, stats, ambiguous });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// FACILITIES
// ============================================================

locationsRouter.get('/facilities', async (req: Request, res: Response, next) => {
  try {
    const { fieldId, type, active } = req.query;
    const where: any = {};
    if (fieldId) where.fieldId = fieldId as string;
    if (type) where.facilityType = type as string;
    if (active !== undefined) where.isActive = active === 'true';

    const facilities = await prisma.facility.findMany({
      where,
      include: {
        field: { select: { id: true, name: true } },
        currentOperator: { select: { id: true, name: true } },
      },
      orderBy: { name: 'asc' },
    });
    res.json(facilities);
  } catch (err) {
    next(err);
  }
});

locationsRouter.post('/facilities', requirePermission('locations:manage'), async (req: Request, res: Response, next) => {
  try {
    const facility = await prisma.facility.create({ data: req.body });
    await createAuditLog({
      userId: req.user!.userId, entityType: 'facility', entityId: facility.id,
      action: 'create', changes: req.body, ipAddress: req.ip,
    });
    res.status(201).json(facility);
  } catch (err) {
    next(err);
  }
});

locationsRouter.put('/facilities/:id', requirePermission('locations:manage'), async (req: Request, res: Response, next) => {
  try {
    const facility = await prisma.facility.update({ where: { id: req.params.id as string }, data: req.body });
    res.json(facility);
  } catch (err) {
    next(err);
  }
});

// ============================================================
// WORK POINTS
// ============================================================

locationsRouter.get('/work-points', async (req: Request, res: Response, next) => {
  try {
    const { wellId, wellIds, padId, padIds, facilityId, mobileAssetId, active } = req.query;

    // Build OR conditions — work points can be attached to wells, pads,
    // facilities, or a thin standalone MobileAsset (e.g. a re-homed air
    // trailer, see MobileAsset in schema.prisma)
    const orConditions: any[] = [];

    if (wellIds) {
      const ids = (wellIds as string).split(',').map(s => s.trim()).filter(Boolean);
      if (ids.length > 0) orConditions.push({ wellId: { in: ids } });
    } else if (wellId) {
      orConditions.push({ wellId: wellId as string });
    }

    if (padIds) {
      const ids = (padIds as string).split(',').map(s => s.trim()).filter(Boolean);
      if (ids.length > 0) orConditions.push({ padId: { in: ids } });
    } else if (padId) {
      orConditions.push({ padId: padId as string });
    }

    if (facilityId) orConditions.push({ facilityId: facilityId as string });
    if (mobileAssetId) orConditions.push({ mobileAssetId: mobileAssetId as string });

    const where: any = {};
    if (orConditions.length > 0) where.OR = orConditions;
    if (active !== undefined) where.isActive = active === 'true';

    const workPoints = await prisma.workPoint.findMany({
      where,
      orderBy: { name: 'asc' },
    });

    // Normalize customData: map 'bottles' → 'cylinders' for client compatibility
    const normalized = workPoints.map(wp => {
      const cd = wp.customData as any;
      if (cd && cd.bottles && !cd.cylinders) {
        return {
          ...wp,
          customData: {
            ...cd,
            cylinders: cd.bottles.map((b: any) => ({
              serialNumber: b.serialNumber || '',
              hydroDate: b.hydroDate || null,
              isActive: b.isActive ?? true,
            })),
          },
        };
      }
      return wp;
    });

    const config = await prisma.workPointVerificationConfig.findUnique({ where: { id: 'default' } });
    const expiryDays = config?.expiryDays ?? 0;
    res.json({ data: normalized.map(wp => ({ ...wp, verificationCurrent: isVerificationCurrent(wp.verified, wp.dateVerified, expiryDays) })), expiryDays });
  } catch (err) {
    next(err);
  }
});

locationsRouter.post('/work-points', requirePermission('locations:manage'), async (req: Request, res: Response, next) => {
  try {
    const { verified, dateVerified, verificationChangedAt, ...data } = req.body;
    const wp = await prisma.workPoint.create({ data });
    res.status(201).json(wp);
  } catch (err) {
    next(err);
  }
});

locationsRouter.put('/work-points/:id', requirePermission('locations:manage'), async (req: Request, res: Response, next) => {
  try {
    const existing = await prisma.workPoint.findUnique({ where: { id: req.params.id as string } });
    if (!existing) throw new AppError(404, 'Work point not found');
    const { verified, dateVerified, verificationChangedAt, ...data } = req.body;
    const changed = workPointIdentityChanged(existing, data);
    const wp = await prisma.workPoint.update({ where: { id: existing.id }, data: { ...data, ...(changed ? { verified: false, dateVerified: null, verificationChangedAt: new Date() } : {}) } });
    res.json(wp);
  } catch (err) {
    next(err);
  }
});

// ============================================================
// DMR REFERENCE WELLS — search only (read-only for users)
// ============================================================

locationsRouter.get('/dmr', async (req: Request, res: Response, next) => {
  try {
    const { search, operator, fieldName, section, township, range, limit = '50', offset = '0' } = req.query;
    const where: any = {};

    if (search) {
      where.OR = [
        { wellName: { contains: search as string, mode: 'insensitive' } },
        { apiNumber: { contains: search as string, mode: 'insensitive' } },
        { operatorName: { contains: search as string, mode: 'insensitive' } },
      ];
    }
    if (operator) where.operatorName = { contains: operator as string, mode: 'insensitive' };
    if (fieldName) where.fieldName = { contains: fieldName as string, mode: 'insensitive' };
    if (section) where.section = parseInt(section as string, 10);
    if (township) where.township = parseInt(township as string, 10);
    if (range) where.range = parseInt(range as string, 10);

    const [wells, total] = await Promise.all([
      prisma.dmrReferenceWell.findMany({
        where,
        orderBy: [{ operatorName: 'asc' }, { wellName: 'asc' }],
        take: parseInt(limit as string, 10),
        skip: parseInt(offset as string, 10),
      }),
      prisma.dmrReferenceWell.count({ where }),
    ]);

    res.json({ data: wells, total });
  } catch (err) {
    next(err);
  }
});

// POST /api/locations/dmr/activate — activate DMR wells into operational working set
//
// 2026-05-06 finish: when padId is provided we now derive the operator from
// the pad if the caller didn't supply one (no more wells materialized with a
// null currentOperatorId), and if that pad is pendingReview we clear the
// pending flag in the same call — so picking a pending pad in DmrBrowserPage's
// activate bar doubles as a resolve. The two flows now interop instead of
// living in parallel.
//
// Before creating, each row is checked against existing UNATTACHED wells (no
// API#) for a name match. A row with a candidate and no matching
// `resolutions` entry is skipped — reported in `ambiguous` — rather than
// risking a duplicate orphan of a well that's already in the system under a
// different (pre-DMR) name. Idempotent/resumable: matched rows drop out via
// the `dmr.matchedWellId` guard below, so re-posting the same dmrWellIds with
// resolutions for just the ambiguous ones picks up where the first call left off.
locationsRouter.post('/dmr/activate', requirePermission('locations:manage'), async (req: Request, res: Response, next) => {
  try {
    const { dmrWellIds, fieldId, padId, operatorId, resolutions } = req.body;
    if (!Array.isArray(dmrWellIds) || dmrWellIds.length === 0) {
      throw new AppError(400, 'dmrWellIds array required');
    }

    // Look up the target pad once to inherit operator + detect pendingReview.
    let resolvedOperatorId: string | undefined = operatorId || undefined;
    let padWasPending = false;
    if (padId) {
      const pad = await prisma.pad.findUnique({
        where: { id: padId as string },
        select: { currentOperatorId: true, pendingReview: true },
      });
      if (!pad) throw new AppError(404, 'Target pad not found');
      if (!resolvedOperatorId && pad.currentOperatorId) {
        resolvedOperatorId = pad.currentOperatorId;
      }
      padWasPending = pad.pendingReview;
    }

    // A well activated with no operator is invisible to every operator-scoped
    // picker in the app (the pad builder's well search, AddPadModal's attach
    // step, the company's location list), so it can't be found or grouped
    // afterward — it just silently rots as an orphan. Refuse before
    // materializing anything rather than creating one.
    //
    // Passing operatorId explicitly is also THE way to activate a well under a
    // different company than DMR lists for it: DMR operator names go stale
    // after every trade, so the caller's choice always wins over the
    // reference row's operatorName.
    if (!resolvedOperatorId) {
      throw new AppError(
        400,
        'An operator is required to activate a well. Pass operatorId, or pick a pad that already has an operator.',
      );
    }

    const dmrWells = await prisma.dmrReferenceWell.findMany({
      where: { id: { in: dmrWellIds } },
    });
    const resolutionMap = parseResolutions(resolutions);
    const unmatched = dmrWells.filter(d => !d.matchedWellId);
    const candidatesByDmrId = await findExistingWellCandidates(unmatched.map(d => ({ id: d.id, wellName: d.wellName })));
    const ambiguous: AmbiguousActivation[] = [];

    // Materialize wells + clear the pending pad atomically. Without the tx a
    // mid-batch failure would commit some wells (and DMR cross-links) while
    // leaving the pad pending — exactly the kind of orphan that backs up the
    // approvals queue. Single-row activate (a 1-element array) rides the same path.
    const { activated, padCleared } = await prisma.$transaction(async (tx) => {
      const activated = [];
      for (const dmr of unmatched) {
        const candidates = candidatesByDmrId.get(dmr.id);
        const resolution = resolutionMap.get(dmr.id);

        if (candidates && candidates.length > 0 && !resolution) {
          ambiguous.push({ dmrWellId: dmr.id, wellName: dmr.wellName, apiNumber: dmr.apiNumber, fieldName: dmr.fieldName, candidates });
          continue;
        }

        if (resolution?.action === 'link' && resolution.wellId) {
          const existing = await tx.well.findUnique({ where: { id: resolution.wellId }, select: { apiNumber: true, currentOperatorId: true } });
          if (!existing || existing.apiNumber) continue; // don't clobber an already-identified well
          const linked = await tx.well.update({
            where: { id: resolution.wellId },
            data: {
              fieldId: fieldId || undefined,
              padId: padId || undefined,
              currentOperatorId: existing.currentOperatorId ?? resolvedOperatorId,
              dmrFileNumber: dmr.dmrFileNumber,
              apiNumber: dmr.apiNumber,
              apiShort: dmr.apiShort,
              // See the link path above — the API's state designation wins.
              ...(normalizeWellName(dmr.wellName)
                ? { wellName: normalizeWellName(dmr.wellName)!, wellNameBase: wellNameBase(normalizeWellName(dmr.wellName)) }
                : { wellNameBase: dmr.wellNameBase }),
              totalDepth: dmr.totalDepth,
              spudDate: dmr.spudDate,
              quarterQuarter: dmr.quarterQuarter,
              section: dmr.section,
              township: dmr.township,
              range: dmr.range,
              feetNs: dmr.feetNs,
              nsLine: dmr.nsLine,
              feetEw: dmr.feetEw,
              ewLine: dmr.ewLine,
              latitude: dmr.latitude,
              longitude: dmr.longitude,
              wellType: (WELL_TYPE_MAP[dmr.wellType || ''] || 'other') as any,
              wellStatus: (WELL_STATUS_MAP[dmr.wellStatus || ''] || 'other') as any,
              county: dmr.county,
              dmrReferenceId: dmr.id,
              dmrImportDate: new Date(),
              dmrRawData: dmr.rawData || undefined,
            },
          });
          await tx.dmrReferenceWell.update({
            where: { id: dmr.id },
            data: { matchedWellId: linked.id, matchedCompanyId: existing.currentOperatorId ?? resolvedOperatorId },
          });
          activated.push(linked);
          continue;
        }

        const well = await tx.well.create({
          data: {
            fieldId: fieldId || undefined,
            padId: padId || undefined,
            currentOperatorId: resolvedOperatorId,
            dmrFileNumber: dmr.dmrFileNumber,
            apiNumber: dmr.apiNumber,
            apiShort: dmr.apiShort,
            wellName: normalizeWellName(dmr.wellName),
            wellNameBase: wellNameBase(normalizeWellName(dmr.wellName)),
            totalDepth: dmr.totalDepth,
            spudDate: dmr.spudDate,
            quarterQuarter: dmr.quarterQuarter,
            section: dmr.section,
            township: dmr.township,
            range: dmr.range,
            feetNs: dmr.feetNs,
            nsLine: dmr.nsLine,
            feetEw: dmr.feetEw,
            ewLine: dmr.ewLine,
            latitude: dmr.latitude,
            longitude: dmr.longitude,
            wellType: (WELL_TYPE_MAP[dmr.wellType || ''] || 'other') as any,
            wellStatus: (WELL_STATUS_MAP[dmr.wellStatus || ''] || 'other') as any,
            county: dmr.county,
            dmrReferenceId: dmr.id,
            dmrImportDate: new Date(),
            dmrRawData: dmr.rawData || undefined,
          },
        });

        // Update DMR reference to track the match
        await tx.dmrReferenceWell.update({
          where: { id: dmr.id },
          data: { matchedWellId: well.id, matchedCompanyId: resolvedOperatorId },
        });

        activated.push(well);
      }

      // Resolve interop: if the target pad was pending and we materialized at
      // least one well onto it, clear pendingReview + mark verified. Operator
      // gets stamped if the pad didn't already have one.
      let padCleared = false;
      if (padId && padWasPending && activated.length > 0) {
        await tx.pad.update({
          where: { id: padId as string },
          data: {
            pendingReview: false,
            manuallyVerified: true,
            ...(resolvedOperatorId ? { currentOperatorId: resolvedOperatorId } : {}),
          },
        });
        padCleared = true;
      }

      return { activated, padCleared };
    });

    // Post-commit side effects.
    if (padCleared) {
      void emitEvent('location.resolved', {
        padId: padId as string,
        resolution: 'dmr_activated',
        actorUserId: req.user!.userId,
        resolvedAt: new Date().toISOString(),
      });
    }

    // Post-commit bookkeeping. The wells are already committed, so a failure
    // here must not come back as a failed activation — which is exactly what
    // used to happen: entityId was handed the OPTIONAL body fieldId, so every
    // caller that omitted it (the DMR browser's activate bar, AddWellModal)
    // got a 500 from the audit insert AFTER its wells had been created, and
    // with no pad in play those wells had no operator either.
    try {
      await createAuditLog({
        userId: req.user!.userId,
        entityType: 'dmr_activation',
        entityId: (padId as string) || resolvedOperatorId,
        action: 'create',
        changes: {
          dmrWellIds, activatedCount: activated.length, padId: padId || null,
          fieldId: (fieldId as string) || null, operatorId: resolvedOperatorId,
          padCleared, needsReview: ambiguous.length,
        },
        ipAddress: req.ip,
      });
    } catch (auditErr) {
      console.error('[dmr/activate] audit log write failed (activation itself committed)', auditErr);
    }

    res.status(201).json({ activated: activated.length, wells: activated, padCleared, ambiguous });
  } catch (err) {
    next(err);
  }
});
// POST /api/locations/request — field tech location request (non-blocking)
locationsRouter.post('/request', requirePermission('locations:request'), async (req: Request, res: Response, next) => {
  try {
    const { type, name, fieldId, directions, latitude, longitude, section, township, range, notes, wellNames, companyId } = req.body;

    if (type === 'pad') {
      // Dedup gap fix (2026-05-06): a tech-typed name that case-insensitively
      // matches an existing active pad in the same field SHOULD attach to the
      // existing pad rather than spawning a duplicate that has to be merged
      // later. We only match within the same field to avoid yanking a request
      // onto a same-named pad in a different geography. Trim + collapse
      // whitespace before comparing so "APPLEDOORN  14-19H" matches
      // "Appledoorn 14-19H".
      const normalizedName = String(name || '').trim().replace(/\s+/g, ' ');
      // Case-insensitive exact match: prefer same-field same-name. If the
      // requesting customer has a same-named pad in a DIFFERENT field, treat
      // that as the dedup hit too — the tech may have picked the wrong field.
      const dedupOr = [
        ...(fieldId ? [{ fieldId }] : []),
        ...(companyId ? [{ currentOperatorId: companyId as string }] : []),
      ];
      if (normalizedName && dedupOr.length > 0) {
        const existing = await prisma.pad.findFirst({
          where: {
            isActive: true,
            name: { equals: normalizedName, mode: 'insensitive' },
            OR: dedupOr,
          },
        });
        if (existing) {
          // If the tech provided well names and the existing pad isn't
          // already pending, stash the new well requests in customData so
          // the approver sees they were asked for. Don't flip pendingReview
          // ourselves — if the existing pad is verified, a tech asking for
          // a well off it isn't an emergency, and surprising flag flips on
          // verified pads would confuse approvers. The wellNames sit as a
          // hint for the next approval pass.
          if (Array.isArray(wellNames) && wellNames.length > 0) {
            const cd = (existing.customData as Record<string, unknown> | null) || {};
            const prior = Array.isArray(cd.pendingWellRequests)
              ? (cd.pendingWellRequests as Array<Record<string, unknown>>)
              : [];
            await prisma.pad.update({
              where: { id: existing.id },
              data: {
                customData: {
                  ...cd,
                  pendingWellRequests: [
                    ...prior,
                    { requestedBy: req.user!.userId, wellNames, notes, requestedAt: new Date().toISOString() },
                  ],
                } as any,
              },
            });
          }
          console.log(
            `[locations/request] Dedup hit: matched "${normalizedName}" in field ${fieldId} to existing pad ${existing.id} (${existing.name})`,
          );
          res.status(200).json({
            message: 'Matched existing pad — no duplicate created',
            location: existing,
            dedupMatched: true,
          });
          return;
        }
      }

      const pad = await prisma.pad.create({
        data: {
          name: normalizedName || name,
          fieldId,
          // Stamp the operator on creation when known — otherwise the pending
          // pad shows up "UNASSIGNED" in approvals even though we knew who
          // the request was for. Approver can still change it on resolve.
          ...(companyId ? { currentOperatorId: companyId as string } : {}),
          directions,
          latitude,
          longitude,
          section,
          township,
          range,
          pendingReview: true,
          autoGenerated: false,
          customData: {
            requestedBy: req.user!.userId,
            requestedForCompanyId: companyId || null,
            wellNames,
            notes,
          },
        },
      });
      res.status(201).json({ message: 'Location request submitted', location: pad });
    } else if (type === 'facility') {
      const facility = await prisma.facility.create({
        data: {
          name,
          facilityType: req.body.facilityType || 'other',
          fieldId,
          directions,
          latitude,
          longitude,
          section,
          township,
          range,
          pendingReview: true,
          customData: { requestedBy: req.user!.userId, notes },
        },
      });
      res.status(201).json({ message: 'Location request submitted', location: facility });
    } else {
      throw new AppError(400, 'type must be "pad" or "facility"');
    }
  } catch (err) {
    next(err);
  }
});

// ============================================================
// LOCATION REQUEST APPROVAL QUEUE (shell-game resolve)
// ============================================================

// Generic words that carry no identity for a pad/well name. Stripped before
// token gating so "Lavern Pad" vs "Lavern Battery" still match on LAVERN but
// "Lavern" vs "Steven" never match on a shared noise word.
const MATCH_NOISE = new Set([
  'PAD', 'BATTERY', 'CTB', 'FACILITY', 'WELL', 'WELLS', 'SWD', 'DUAL', 'LW',
  'SITE', 'TANK', 'UNIT', 'THE', 'AND', 'NEW', 'OLD', 'COMP', 'COMPRESSOR',
]);

// Mobile PadAssetCategory values only — these get the cross-operator/field
// dedup search bypass below since they're never tied to one operator.
// gas_plant/tank_battery/etc. are real single-operator places and must NOT
// be in this list — same-operator/same-field matching already handles them
// correctly, and including them here would surface e.g. one operator's
// "Field Office" as a false duplicate of an unrelated operator's.
// rig/truck retired — rigs are now the thin standalone MobileAsset model,
// trucks are free text captured directly on Air Fill tickets.
const FLOATING_ASSET_CATEGORIES: Array<'other_mobile'> = ['other_mobile'];

/**
 * Significant tokens for match gating. Uppercases, splits on non-alphanumerics,
 * drops noise words, and keeps any token that contains a digit (well
 * designations like 42X / 14EXF / 5-8H — the real identity of a location) or
 * is a >=3-char word. The designation digits are what separate "Lavern
 * 42X-14EXF" from "Lavern 11-2H" even when the lease name is shared.
 */
function significantTokens(s: string | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const t of (s || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim().split(/\s+/)) {
    if (!t || MATCH_NOISE.has(t)) continue;
    if (/\d/.test(t) || t.length >= 3) out.add(t);
  }
  return out;
}

function sharesToken(a: Set<string>, b: Set<string>): boolean {
  for (const t of a) if (b.has(t)) return true;
  return false;
}

/**
 * Pull API-number variants out of free-text well names + any materialized
 * wells. Techs occasionally paste an API ("33-025-02946") into the request;
 * an exact API hit is the strongest possible DMR match, so we look it up
 * directly and bypass the fuzzy name gate for those.
 */
function apiVariantsFrom(names: string[], apis: (string | null)[]): string[] {
  const variants = new Set<string>();
  const add = (raw: string) => {
    const digits = raw.replace(/\D/g, '');
    if (digits.length < 8) return;
    variants.add(raw);
    variants.add(digits);
    if (digits.length >= 10) {
      variants.add(`${digits.slice(0, 2)}-${digits.slice(2, 5)}-${digits.slice(5, 10)}`);
      // DMR rows are keyed by the canonical zero-padded 14-digit form — a
      // 10/12-digit input must probe that too or it misses every stored row.
      if (digits.length < 14) variants.add(digits.padEnd(14, '0'));
    }
  };
  for (const a of apis) if (a) add(a);
  const apiRe = /\b\d{2}[-\s]?\d{3}[-\s]?\d{5}\b/g;
  for (const n of names) {
    const m = (n || '').match(apiRe);
    if (m) for (const x of m) add(x);
  }
  return [...variants];
}

/**
 * DMR/API candidate computation for a pad request — shared by the pending-
 * queue listing (informational) AND the resolve endpoint (where it gates
 * "keep as manual" — see POST /requests/:padId/resolve). Candidate pool is
 * filtered by section/township/range when available, falling back to
 * county (via pad.field.county) and finally to unfiltered. Fuse.js scores
 * against a concat of pad name + requested well names.
 */
async function computeDmrMatchesForPad(
  pad: { name: string; section: number | null; township: number | null; range: number | null; field?: { county: string | null } | null },
  wellNames: string[],
  existingApis: (string | null)[] = [],
): Promise<any[]> {
  // Build a UNION candidate pool (deduped by id). The old code required an
  // EXACT section/township/range hit before it would even fall back to
  // county — so a request with no S/T/R (or one fat-fingered digit) and no
  // field county surfaced ZERO candidates even when the well was sitting in
  // the DMR table. We now gather from several angles and rank across all:
  //   1. exact API number (strongest — bypasses the name gate)
  //   2. exact section/township/range
  //   3. name-token contains (finds "LAVERN ..." regardless of S/T/R/county)
  //   4. county (breadth fallback)
  const reqTokens = significantTokens([pad.name, ...wellNames].join(' '));
  const apiVariants = apiVariantsFrom([pad.name, ...wellNames], existingApis);
  const exactApiIds = new Set<string>();
  const byId = new Map<string, any>();
  const pushAll = (rows: any[]) => { for (const r of rows) if (!byId.has(r.id)) byId.set(r.id, r); };

  if (apiVariants.length > 0) {
    const apiRows = await prisma.dmrReferenceWell.findMany({
      where: { OR: [{ apiNumber: { in: apiVariants } }, { apiShort: { in: apiVariants } }] },
      take: 25,
    });
    for (const r of apiRows) exactApiIds.add(r.id);
    pushAll(apiRows);
  }
  if (pad.section !== null && pad.township !== null && pad.range !== null) {
    pushAll(await prisma.dmrReferenceWell.findMany({
      where: { section: pad.section, township: pad.township, range: pad.range },
      take: 200,
    }));
  }
  // Probe the DB with the most distinctive alpha tokens (the lease name),
  // not the digit designations — "LAVERN" narrows 40k rows to a handful;
  // "42X" would match thousands.
  const probeTokens = [...reqTokens].filter(t => !/\d/.test(t) && t.length >= 3)
    .sort((a, b) => b.length - a.length).slice(0, 3);
  for (const t of probeTokens) {
    pushAll(await prisma.dmrReferenceWell.findMany({
      where: { OR: [
        { wellName: { contains: t, mode: 'insensitive' } },
        { wellNameBase: { contains: t, mode: 'insensitive' } },
      ] },
      take: 100,
    }));
  }
  if (byId.size === 0 && pad.field?.county) {
    pushAll(await prisma.dmrReferenceWell.findMany({
      where: { county: pad.field.county },
      take: 300,
    }));
  }
  const candidates = [...byId.values()];

  // Fuse search against well name + wellNameBase + fieldName, then gate:
  // keep a candidate only if it's an exact API hit, scores very strongly,
  // or shares a significant token with the request. This is what kills the
  // "Lavern ≈ Steven" false positives the loose county pool produced.
  const searchQuery = [pad.name, ...wellNames].filter(Boolean).join(' ');
  let matches: any[] = [];
  if (candidates.length > 0 && searchQuery) {
    const fuse = new Fuse(candidates, {
      keys: ['wellName', 'wellNameBase', 'fieldName'],
      threshold: 0.4,
      includeScore: true,
      ignoreLocation: true,
    });
    const ranked = fuse.search(searchQuery);
    // Ensure exact-API rows always appear even if Fuse ranks them low.
    const seen = new Set(ranked.map(r => r.item.id));
    const extras = candidates.filter(c => exactApiIds.has(c.id) && !seen.has(c.id)).map(c => ({ item: c, score: 0 }));
    matches = [...extras, ...ranked]
      .filter(r => {
        if (exactApiIds.has(r.item.id)) return true;
        if ((r.score ?? 1) <= 0.2) return true;
        return sharesToken(reqTokens, significantTokens([r.item.wellName, r.item.wellNameBase].join(' ')));
      })
      .sort((a, b) => (a.score ?? 1) - (b.score ?? 1))
      .slice(0, 5)
      .map(r => ({
        id: r.item.id,
        apiNumber: r.item.apiNumber,
        wellName: r.item.wellName,
        wellNameBase: r.item.wellNameBase,
        operatorName: r.item.operatorName,
        wellType: r.item.wellType,
        wellStatus: r.item.wellStatus,
        county: r.item.county,
        section: r.item.section,
        township: r.item.township,
        range: r.item.range,
        latitude: r.item.latitude,
        longitude: r.item.longitude,
        matchScore: exactApiIds.has(r.item.id) ? 0 : r.score,
        exactApi: exactApiIds.has(r.item.id),
      }));
  }
  return matches;
}

/**
 * GET /api/locations/requests/pending
 * Pending pads awaiting admin review, each annotated with top-5 DMR fuzzy matches.
 */
locationsRouter.get('/requests/pending', requirePermission('locations:approve'), async (_req: Request, res: Response, next) => {
  try {
    const pendingPads = await prisma.pad.findMany({
      where: { pendingReview: true, isActive: true },
      include: {
        field: { select: { id: true, name: true, county: true } },
        currentOperator: { select: { id: true, name: true } },
        wells: { select: { id: true, wellName: true, apiNumber: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Per-pad: build candidate set, fuse-match, attach top 5.
    const out = await Promise.all(pendingPads.map(async (pad) => {
      const cd = (pad.customData as Record<string, unknown> | null) || {};
      const wellNames = Array.isArray(cd.wellNames) ? (cd.wellNames as string[]) : [];
      const requestedBy = (cd.requestedBy as string | undefined) || null;
      const notes = (cd.notes as string | undefined) || null;

      const matches = await computeDmrMatchesForPad(pad, wellNames, pad.wells.map(w => w.apiNumber));

      // Requester display info
      let requester: { id: string; name: string | null; email: string | null } | null = null;
      if (requestedBy) {
        const u = await prisma.user.findUnique({
          where: { id: requestedBy },
          select: { id: true, name: true, email: true },
        });
        if (u) requester = { id: u.id, name: u.name, email: u.email };
      }

      // Existing-pad candidates: pads in the same field PLUS any pads
      // operated by the customer this request was made for (across fields —
      // the tech may have picked the wrong field at request time). Fuse-
      // search by name with a loose threshold (0.55) to catch suffix
      // variations like "Blue Buttes Compressor" vs "Blue Buttes Compressor New".
      // Customer match takes priority in the candidate pool ordering since
      // it's the higher-signal hint.
      const requestedForCompanyId = (cd.requestedForCompanyId as string | undefined)
        || pad.currentOperator?.id
        || null;
      let existingPadMatches: Array<{
        id: string;
        name: string;
        fieldName: string | null;
        currentOperatorName: string | null;
        wellCount: number;
        isActive: boolean;
        manuallyVerified: boolean;
        matchScore: number | undefined;
        sameField: boolean;
        sameOperator: boolean;
        assetCategory: string;
      }> = [];
      const candidatePadIds = new Set<string>();
      const candidatePool: Array<any> = [];

      // Pull customer-operated pads first (high signal)
      if (requestedForCompanyId) {
        const operatorPads = await prisma.pad.findMany({
          where: {
            currentOperatorId: requestedForCompanyId,
            isActive: true,
            id: { not: pad.id },
          },
          include: {
            field: { select: { id: true, name: true } },
            currentOperator: { select: { id: true, name: true } },
            _count: { select: { wells: true } },
          },
          take: 200,
        });
        for (const p of operatorPads) {
          if (!candidatePadIds.has(p.id)) {
            candidatePool.push(p);
            candidatePadIds.add(p.id);
          }
        }
      }

      // Then same-field pads (catches dups operated by other companies in
      // the same physical area)
      if (pad.fieldId) {
        const sameFieldPads = await prisma.pad.findMany({
          where: {
            fieldId: pad.fieldId,
            isActive: true,
            id: { not: pad.id },
          },
          include: {
            field: { select: { id: true, name: true } },
            currentOperator: { select: { id: true, name: true } },
            _count: { select: { wells: true } },
          },
          take: 200,
        });
        for (const p of sameFieldPads) {
          if (!candidatePadIds.has(p.id)) {
            candidatePool.push(p);
            candidatePadIds.add(p.id);
          }
        }
      }

      // Floating assets (rigs, trucks) are flagged specifically because they
      // move between operators/fields — the two pools above would never
      // catch a rig requested under a different operator in a different
      // field than where it's already flagged. Search ALL of them regardless
      // of this request's operator/field so the same rig/truck record gets
      // reused everywhere instead of re-created per job.
      const floatingAssets = await prisma.pad.findMany({
        where: {
          assetCategory: { in: FLOATING_ASSET_CATEGORIES },
          isActive: true,
          id: { not: pad.id },
        },
        include: {
          field: { select: { id: true, name: true } },
          currentOperator: { select: { id: true, name: true } },
          _count: { select: { wells: true } },
        },
        take: 200,
      });
      for (const p of floatingAssets) {
        if (!candidatePadIds.has(p.id)) {
          candidatePool.push(p);
          candidatePadIds.add(p.id);
        }
      }

      if (candidatePool.length > 0) {
        const padFuse = new Fuse(candidatePool, {
          keys: ['name'],
          threshold: 0.45,
          includeScore: true,
          // ignoreLocation lets "Blue Buttes Compressor" match "Blue Buttes Compressor New"
          // (suffix doesn't tank the score the way it does with location-aware search)
          ignoreLocation: true,
        });
        const padTokens = significantTokens(pad.name);
        existingPadMatches = padFuse.search(pad.name)
          // Token gate: a candidate must share a significant token with the
          // request name unless it's a near-identical fuse hit. Without this,
          // ignoreLocation + a loose threshold surfaces "Lavern" as a 60% match
          // for "Steven" purely on shared letters.
          .filter(r => (r.score ?? 1) <= 0.2 || sharesToken(padTokens, significantTokens(r.item.name)))
          .slice(0, 8)
          .map(r => ({
          id: r.item.id,
          name: r.item.name,
          fieldName: r.item.field?.name ?? null,
          currentOperatorName: r.item.currentOperator?.name ?? null,
          wellCount: r.item._count.wells,
          isActive: r.item.isActive,
          manuallyVerified: r.item.manuallyVerified,
          matchScore: r.score,
          sameField: r.item.field?.id === pad.fieldId,
          sameOperator: !!requestedForCompanyId && r.item.currentOperator?.id === requestedForCompanyId,
          assetCategory: r.item.assetCategory as string,
        }));
      }

      // If we have a requestedForCompanyId but the pad doesn't carry an
      // operator name on currentOperator (legacy rows), look it up so the
      // approver still sees who the request was for.
      let requestedFor: { id: string; name: string } | null = null;
      if (requestedForCompanyId) {
        if (pad.currentOperator && pad.currentOperator.id === requestedForCompanyId) {
          requestedFor = pad.currentOperator;
        } else {
          const c = await prisma.company.findUnique({
            where: { id: requestedForCompanyId },
            select: { id: true, name: true },
          });
          if (c) requestedFor = c;
        }
      }

      return {
        id: pad.id,
        name: pad.name,
        field: pad.field,
        currentOperator: pad.currentOperator,
        requestedFor,
        section: pad.section,
        township: pad.township,
        range: pad.range,
        latitude: pad.latitude,
        longitude: pad.longitude,
        directions: pad.directions,
        wells: pad.wells,
        requestedWellNames: wellNames,
        requester,
        notes,
        createdAt: pad.createdAt,
        dmrMatches: matches,
        existingPadMatches,
      };
    }));

    res.json({ data: out, total: out.length });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/locations/requests/:padId/resolve
 * Body: { dmrWellIds?: string[], operatorCompanyId?: string, keepAsManual?: boolean, mergeIntoPadId?: string }
 *
 * Three modes:
 *   - DMR match: materialize Well rows from the given DMR reference wells, link
 *     them to the pad + operator, stamp the DmrReferenceWell.matchedWellId.
 *   - Keep as manual: just clear pendingReview / set manuallyVerified.
 *   - Merge into existing pad: this pending pad is actually a duplicate of
 *     an already-active pad. Move all child records (tickets, wells, etc.)
 *     onto the winner and deactivate the pending pad. Tickets that were
 *     attached to the pending pad follow automatically.
 *
 * Exactly one mode applies per call. operatorCompanyId is optional and honored
 * in all modes: in DMR / keep-as-manual it stamps the resolved pad; in merge
 * mode, when it differs from the winner's current operator, it transfers the
 * winner pad + its wells to that operator (with OperatorHistory) — the buyout
 * case where a tech requests under the new operator but the pad still shows the
 * old one.
 */
locationsRouter.post('/requests/:padId/resolve', requirePermission('locations:approve'), async (req: Request, res: Response, next) => {
  try {
    const padId = req.params.padId as string;
    const { dmrWellIds, operatorCompanyId, keepAsManual, mergeIntoPadId, overrideDmrMatch, assetCategory } = req.body as {
      dmrWellIds?: string[];
      operatorCompanyId?: string;
      keepAsManual?: boolean;
      mergeIntoPadId?: string;
      overrideDmrMatch?: boolean;
      // Flags a rig/truck/other mobile asset so future requests for the same
      // name match it regardless of operator/field (see GET /requests/pending).
      // Applied to the merge WINNER when merging, or to this pad itself
      // otherwise — never relevant on the DMR-materialization path since a
      // real wellbore is never a floating asset.
      assetCategory?: 'site' | 'other_mobile'
        | 'gas_plant' | 'tank_battery' | 'compressor_station' | 'swd_facility' | 'office' | 'shop';
    };

    const pad = await prisma.pad.findUnique({
      where: { id: padId },
      include: { field: true, wells: { select: { apiNumber: true } } },
    });
    if (!pad) throw new AppError(404, 'Pad not found');
    if (!pad.pendingReview) throw new AppError(400, 'Pad is not pending review');

    // Checked ONCE, up front, for every mode — not just merge mode, which is
    // where the check used to live alone.
    //
    // operatorCompanyId usually arrives as the pad's own
    // customData.requestedForCompanyId, captured when a tech filed the
    // request. Companies get merged (POST /api/companies/merge), so by the
    // time somebody approves the queue that id may name a Company row that no
    // longer exists. The DMR branch then fed it straight into well.create /
    // dmrReferenceWell.update, which failed the foreign key with Prisma P2003
    // — a code errorHandler does not map, so it surfaced as a bare
    // "Internal server error", and because it threw inside the transaction
    // nothing committed and the request stayed sitting in the queue.
    //
    // The operator is a real input to this decision, so a dead one is a 404
    // about that input, not a 500.
    if (operatorCompanyId) {
      const operatorExists = await prisma.company.findUnique({
        where: { id: operatorCompanyId },
        select: { id: true },
      });
      if (!operatorExists) {
        throw new AppError(
          404,
          `Operator company ${operatorCompanyId} no longer exists — it was probably merged into another customer. Pick the operator explicitly and retry.`,
        );
      }
    }

    // Merge mode short-circuits the DMR materialization path entirely.
    // Reuses the same migration logic as POST /pads/merge (kept inline
    // rather than refactored into a helper for now since the merge
    // endpoint is the only other caller).
    if (mergeIntoPadId) {
      if (mergeIntoPadId === padId) {
        throw new AppError(400, 'mergeIntoPadId must be a different pad');
      }
      const winner = await prisma.pad.findUnique({ where: { id: mergeIntoPadId } });
      if (!winner) throw new AppError(404, 'Merge target pad not found');
      if (!winner.isActive) throw new AppError(400, 'Merge target pad is inactive');

      const counts = await prisma.$transaction(async (tx) => {
        const c = { wells: 0, workPoints: 0, tickets: 0, facilities: 0, routeStops: 0, equipment: 0, operatorHistory: 0, rentals: 0, operatorMoved: false, wellsReoperated: 0 };
        const wellResult = await tx.well.updateMany({ where: { padId }, data: { padId: winner.id } });
        c.wells = wellResult.count;
        const wpResult = await tx.workPoint.updateMany({ where: { padId }, data: { padId: winner.id } });
        c.workPoints = wpResult.count;
        const ticketResult = await tx.serviceTicket.updateMany({ where: { padId }, data: { padId: winner.id } });
        c.tickets = ticketResult.count;
        const facResult = await tx.facility.updateMany({ where: { padId }, data: { padId: winner.id } });
        c.facilities = facResult.count;
        const rsResult = await tx.routeStop.updateMany({ where: { padId }, data: { padId: winner.id } });
        c.routeStops = rsResult.count;
        const eqResult = await tx.serializedEquipment.updateMany({ where: { currentPadId: padId }, data: { currentPadId: winner.id } });
        c.equipment = eqResult.count;
        const ohResult = await tx.operatorHistory.updateMany({ where: { padId }, data: { padId: winner.id } });
        c.operatorHistory = ohResult.count;
        const raResult = await tx.rentalAgreement.updateMany({ where: { padId }, data: { padId: winner.id } });
        c.rentals = raResult.count;

        // Buyout case: the request came in for a different operator than the
        // winner pad currently shows (e.g. pad still says XTO, the ticket is
        // for Chord because XTO was bought out). When the approver passes an
        // operatorCompanyId, flip the winner's operator and cascade to its
        // wells — with OperatorHistory — mirroring /transfer-operator. This is
        // what lets approval "pull the matching well AND move the operator" in
        // one step instead of leaving the pad stamped under the old operator.
        if (operatorCompanyId && operatorCompanyId !== winner.currentOperatorId) {
          // Existence already verified before the mode branches.
          const effDate = new Date();
          const note = `Operator moved on approval merge of pending pad "${pad.name}"`;
          await tx.operatorHistory.create({
            data: {
              padId: winner.id,
              previousOperatorId: winner.currentOperatorId || operatorCompanyId,
              newOperatorId: operatorCompanyId,
              effectiveDate: effDate,
              source: 'manual',
              notes: note,
            },
          });
          await tx.pad.update({ where: { id: winner.id }, data: { currentOperatorId: operatorCompanyId } });
          const winnerWells = await tx.well.findMany({
            where: { padId: winner.id, currentOperatorId: { not: operatorCompanyId } },
            select: { id: true, currentOperatorId: true },
          });
          if (winnerWells.length > 0) {
            await tx.operatorHistory.createMany({
              data: winnerWells.map(w => ({
                wellId: w.id,
                previousOperatorId: w.currentOperatorId || operatorCompanyId,
                newOperatorId: operatorCompanyId,
                effectiveDate: effDate,
                source: 'manual' as const,
                notes: note,
              })),
            });
            await tx.well.updateMany({ where: { id: { in: winnerWells.map(w => w.id) } }, data: { currentOperatorId: operatorCompanyId } });
          }
          c.operatorMoved = true;
          c.wellsReoperated = winnerWells.length;
        }

        // Flag the surviving pad as a floating asset (rig/truck/other) if the
        // approver recognized it as one — this is what makes it show up as a
        // dedup candidate for the NEXT request regardless of operator/field.
        if (assetCategory && assetCategory !== winner.assetCategory) {
          await tx.pad.update({ where: { id: winner.id }, data: { assetCategory } });
        }

        // Deactivate the loser; preserve customData with merge breadcrumb.
        await tx.pad.update({
          where: { id: padId },
          data: {
            isActive: false,
            pendingReview: false,
            customData: {
              ...((pad.customData as Record<string, unknown> | null) || {}),
              mergedInto: winner.id,
              mergedAt: new Date().toISOString(),
              mergedVia: 'requests/resolve',
            } as any,
          },
        });
        return c;
      });

      await createAuditLog({
        userId: req.user!.userId,
        entityType: 'pad',
        entityId: padId,
        action: 'approve',
        changes: { mergeIntoPadId, winnerId: winner.id, operatorCompanyId, moved: counts },
        ipAddress: req.ip,
      });

      // Tickets were moved off the loser onto winner.id; rescore those.
      void emitEvent('location.resolved', {
        padId: winner.id,
        resolution: 'merged',
        actorUserId: req.user!.userId,
        resolvedAt: new Date().toISOString(),
      });

      res.json({
        message: counts.operatorMoved
          ? `Merged pending pad into ${winner.name} and moved its operator (+${counts.wellsReoperated} wells)`
          : `Merged pending pad into ${winner.name}`,
        winner: { id: winner.id, name: winner.name },
        loserId: padId,
        moved: counts,
      });
      return;
    }

    const dmrIds = Array.isArray(dmrWellIds) ? dmrWellIds.filter(Boolean) : [];
    if (dmrIds.length === 0 && !keepAsManual) {
      throw new AppError(400, 'Provide dmrWellIds[], set keepAsManual=true, or supply mergeIntoPadId');
    }

    // Force DMR/API matching: "keep as manual" can't silently walk past a
    // plausible DMR/API hit. Recompute server-side (never trust the client's
    // copy of the pending queue — it may be stale) and require an explicit
    // overrideDmrMatch to proceed if anything turns up. A pad genuinely
    // outside DMR (a compressor station, a battery — not a well) still
    // resolves manual with zero friction since nothing matches.
    let overriddenMatches: any[] | undefined;
    if (keepAsManual && dmrIds.length === 0) {
      const cd = (pad.customData as Record<string, unknown> | null) || {};
      const wellNames = Array.isArray(cd.wellNames) ? (cd.wellNames as string[]) : [];
      const matches = await computeDmrMatchesForPad(pad, wellNames, pad.wells.map(w => w.apiNumber));
      if (matches.length > 0 && !overrideDmrMatch) {
        res.status(409).json({
          error: `${matches.length} DMR/API match${matches.length === 1 ? '' : 'es'} found for this location — confirm you want to keep it manual anyway (pass overrideDmrMatch: true), or pick one of the matches instead.`,
          dmrMatches: matches,
        });
        return;
      }
      if (matches.length > 0) overriddenMatches = matches;
    }

    const result = await prisma.$transaction(async (tx) => {
      // Materialize wells from DMR rows
      const createdWells: any[] = [];
      // Wells that already existed and were attached to this pad rather than
      // created. Reported separately so "approved and nothing happened" is not
      // representable in the response.
      const linkedWells: any[] = [];
      if (dmrIds.length > 0) {
        const dmrWells = await tx.dmrReferenceWell.findMany({
          where: { id: { in: dmrIds } },
        });
        if (dmrWells.length !== dmrIds.length) {
          throw new AppError(400, 'One or more DMR well IDs not found');
        }

        for (const d of dmrWells) {
          // The wellbore may ALREADY exist as a Well row before anybody
          // approves this request — either because the DMR row was
          // materialized by an earlier import/activation (matchedWellId is
          // set) or because some other path created a Well carrying the same
          // API number without ever stamping the DMR row. Both used to end
          // badly, and neither was visible to the approver:
          //
          //   - matchedWellId set → the loop `continue`d, so the pad was
          //     stamped resolved with NOTHING attached to it and the existing
          //     well stayed orphaned (pad_id NULL). The approval looked like
          //     it worked and accomplished nothing.
          //   - only the api_number matched → tx.well.create hit the
          //     wells_api_number_key unique index and took the whole approval
          //     down with a bare "already exists".
          //
          // Picking a DMR match means "this pad IS that wellbore", so the job
          // is to ATTACH the wellbore. Adopt the row that already exists
          // instead of trying to make a second one.
          const identity = [
            ...(d.matchedWellId ? [{ id: d.matchedWellId }] : []),
            ...(d.apiNumber ? [{ apiNumber: d.apiNumber }] : []),
          ];
          // Built and checked rather than handed to Prisma as a possibly-empty
          // OR: a DMR row with neither a stamp nor an API number has no
          // identity to look up, and "match anything" is the one answer that
          // must never come back from this query.
          const existing = identity.length > 0
            ? await tx.well.findFirst({ where: { OR: identity } })
            : null;

          if (existing) {
            // ...unless it already lives on a DIFFERENT pad. Silently
            // re-parenting it would move a wellbore out from under whatever
            // tickets, routes and history hang off that pad. What this
            // actually means is that the pending pad is a duplicate of the
            // one holding the well, and there is already a mode for that —
            // so say so and point at it rather than guessing.
            if (existing.padId && existing.padId !== pad.id) {
              const holder = await tx.pad.findUnique({
                where: { id: existing.padId },
                select: { id: true, name: true },
              });
              throw new AppError(
                409,
                `${existing.wellName || d.wellName || d.apiNumber} already belongs to the location "${holder?.name ?? existing.padId}". ` +
                  'Merge this request into that location instead of matching the well twice.',
              );
            }

            const adopted = await tx.well.update({
              where: { id: existing.id },
              data: {
                padId: pad.id,
                // Only fill gaps — an existing well's own field/operator is
                // better evidence than a pending pad's, which is usually blank.
                ...(existing.fieldId ? {} : { fieldId: pad.fieldId }),
                ...(operatorCompanyId ? { currentOperatorId: operatorCompanyId } : {}),
                ...(existing.dmrReferenceId ? {} : { dmrReferenceId: d.id }),
              },
            });

            await tx.dmrReferenceWell.update({
              where: { id: d.id },
              data: {
                matchedWellId: adopted.id,
                matchedCompanyId: operatorCompanyId ?? d.matchedCompanyId ?? undefined,
              },
            });

            linkedWells.push(adopted);
            continue;
          }

          const well = await tx.well.create({
            data: {
              padId: pad.id,
              fieldId: pad.fieldId,
              currentOperatorId: operatorCompanyId ?? pad.currentOperatorId,
              dmrFileNumber: d.dmrFileNumber,
              apiNumber: d.apiNumber,
              apiShort: d.apiShort,
              wellName: normalizeWellName(d.wellName),
              wellNameBase: wellNameBase(normalizeWellName(d.wellName)),
              totalDepth: d.totalDepth,
              spudDate: d.spudDate,
              quarterQuarter: d.quarterQuarter,
              section: d.section,
              township: d.township,
              range: d.range,
              feetNs: d.feetNs,
              nsLine: d.nsLine,
              feetEw: d.feetEw,
              ewLine: d.ewLine,
              latitude: d.latitude,
              longitude: d.longitude,
              wellType: (WELL_TYPE_MAP[d.wellType || ''] || 'other') as any,
              wellStatus: (WELL_STATUS_MAP[d.wellStatus || ''] || 'other') as any,
              county: d.county,
              dmrReferenceId: d.id,
              dmrImportDate: d.importBatchDate,
              dmrRawData: d.rawData as any,
            },
          });

          await tx.dmrReferenceWell.update({
            where: { id: d.id },
            data: { matchedWellId: well.id, matchedCompanyId: operatorCompanyId ?? undefined },
          });

          createdWells.push(well);
        }
      }

      // Clear pending flag, stamp operator, mark verified
      const updatedPad = await tx.pad.update({
        where: { id: pad.id },
        data: {
          pendingReview: false,
          manuallyVerified: true,
          ...(operatorCompanyId ? { currentOperatorId: operatorCompanyId } : {}),
          ...(assetCategory ? { assetCategory } : {}),
          ...(overriddenMatches ? {
            customData: {
              ...((pad.customData as Record<string, unknown> | null) || {}),
              dmrMatchOverridden: true,
              dmrMatchOverriddenBy: req.user!.userId,
              dmrMatchOverriddenAt: new Date().toISOString(),
              dmrMatchOverriddenCount: overriddenMatches.length,
            } as any,
          } : {}),
        },
        include: {
          field: true,
          currentOperator: { select: { id: true, name: true } },
          wells: true,
        },
      });

      return { pad: updatedPad, createdWells, linkedWells };
    });

    await createAuditLog({
      userId: req.user!.userId,
      entityType: 'pad',
      entityId: pad.id,
      action: 'approve',
      changes: {
        dmrWellIds: dmrIds, operatorCompanyId, keepAsManual, wellsCreated: result.createdWells.length,
        wellsLinked: result.linkedWells.length,
        dmrMatchOverridden: !!overriddenMatches, dmrMatchOverriddenCount: overriddenMatches?.length ?? 0,
      },
      ipAddress: req.ip,
    });

    void emitEvent('location.resolved', {
      padId: pad.id,
      resolution: 'resolved',
      actorUserId: req.user!.userId,
      resolvedAt: new Date().toISOString(),
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/locations/requests/:padId/reject
 * Reject a pending location request (pad → isActive=false). Any non-terminal
 * tickets attached to the pending pad are DETACHED (location FKs cleared) and
 * flagged needsLocation rather than left pointing at a dead pad — they stay
 * alive in the dispatch queue with a "needs location" badge and must be given a
 * real location before they can be dispatched.
 */
locationsRouter.post('/requests/:padId/reject', requirePermission('locations:approve'), async (req: Request, res: Response, next) => {
  try {
    const padId = req.params.padId as string;
    const { reason } = req.body as { reason?: string };

    const pad = await prisma.pad.findUnique({ where: { id: padId } });
    if (!pad) throw new AppError(404, 'Pad not found');
    if (!pad.pendingReview) throw new AppError(400, 'Pad is not pending review');

    // Tickets still in play that point at this pending pad. Closed/invoiced
    // tickets are left untouched.
    //
    // TYPED, and no `as any`. This list used to read
    // ['invoiced', 'paid', 'cancelled', 'closed'] — but TicketStatus has no
    // `paid` and no `cancelled` (money lives on the Invoice; a dead ticket is
    // `void`). The cast hid that from tsc, and Prisma validates enum values at
    // RUNTIME, so this findMany threw PrismaClientValidationError on every
    // single call and rejecting a location request was a guaranteed
    // "Internal server error" — before it wrote anything, hence the request
    // just sitting there afterwards. Let the compiler own this list.
    const TERMINAL: TicketStatus[] = ['invoiced', 'closed', 'void'];
    const attached = await prisma.serviceTicket.findMany({
      where: { padId, status: { notIn: TERMINAL } },
      select: { id: true, customData: true },
    });

    const detachedTickets = await prisma.$transaction(async (tx) => {
      for (const t of attached) {
        await tx.serviceTicket.update({
          where: { id: t.id },
          data: {
            padId: null,
            fieldId: null,
            wellId: null,
            facilityId: null,
            workPointId: null,
            locationDisplay: '⚠ Needs location — request rejected',
            customData: {
              ...((t.customData as Record<string, unknown> | null) || {}),
              needsLocation: true,
              needsLocationReason: reason || 'Location request rejected',
              rejectedRequestPadId: pad.id,
              rejectedRequestPadName: pad.name,
            } as any,
          },
        });
      }
      await tx.pad.update({
        where: { id: padId },
        data: {
          isActive: false,
          pendingReview: false,
          customData: {
            ...((pad.customData as Record<string, unknown>) || {}),
            rejectedAt: new Date().toISOString(),
            rejectedBy: req.user!.userId,
            rejectReason: reason || null,
            detachedTicketIds: attached.map(t => t.id),
          },
        },
      });
      return attached.length;
    });

    await createAuditLog({
      userId: req.user!.userId,
      entityType: 'pad',
      entityId: pad.id,
      action: 'delete',
      changes: { reason, detachedTickets },
      ipAddress: req.ip,
    });

    res.json({ ok: true, detachedTickets });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// PAD DUPLICATE DETECTION & MERGE
// ============================================================

/** Normalize a pad name for fuzzy duplicate grouping */
function normalizePadName(name: string): string {
  let n = name.toUpperCase();
  n = n.replace(/\([^)]*\)/g, '');                          // strip parentheticals
  n = n.replace(/\b(CTB|DUAL|PAD|BATTERY|FACILITY|LW)\b/g, ''); // strip common suffixes
  n = n.replace(/\s*H\d+[-,]?\d*\s*$/g, '');                // strip well IDs at end
  n = n.replace(/\s*\d+H\s*$/g, '');
  n = n.replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  return n;
}

/**
 * GET /locations/pad-duplicates
 * Returns groups of pads with similar names under the same operator.
 */
locationsRouter.get('/pad-duplicates', requirePermission('locations:manage'), async (_req: Request, res: Response, next) => {
  try {
    const pads = await prisma.pad.findMany({
      where: { isActive: true },
      select: {
        id: true,
        name: true,
        fieldId: true,
        currentOperatorId: true,
        customData: true,
        currentOperator: { select: { name: true } },
        field: { select: { name: true } },
        _count: { select: { wells: true, workPoints: true, serviceTickets: true, serializedEquipment: true } },
      },
    });

    // Group by operator + normalized name
    const groups = new Map<string, typeof pads>();
    for (const pad of pads) {
      const key = (pad.currentOperatorId || 'none') + '::' + normalizePadName(pad.name);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(pad);
    }

    // Filter to groups with 2+ pads, sort by total data descending
    const dupeGroups = Array.from(groups.entries())
      .filter(([, g]) => g.length > 1)
      .map(([key, g]) => {
        const totalWells = g.reduce((s, p) => s + p._count.wells, 0);
        const totalWPs = g.reduce((s, p) => s + p._count.workPoints, 0);
        return {
          groupKey: key,
          operator: g[0].currentOperator?.name || 'Unknown',
          operatorId: g[0].currentOperatorId,
          pads: g.map(p => ({
            id: p.id,
            name: p.name,
            fieldName: p.field?.name || null,
            azureLocationId: (p.customData as any)?.azureLocationId || null,
            wells: p._count.wells,
            workPoints: p._count.workPoints,
            tickets: p._count.serviceTickets,
            equipment: p._count.serializedEquipment,
          })),
          totalWells,
          totalWorkPoints: totalWPs,
        };
      })
      .sort((a, b) => (b.totalWells + b.totalWorkPoints) - (a.totalWells + a.totalWorkPoints));

    res.json({ data: dupeGroups, total: dupeGroups.length });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /locations/pads/merge
 * Merge multiple pads into a single winner.
 * Moves all child records (wells, work points, tickets, equipment, etc.) to the winner,
 * then deactivates the losers.
 *
 * Body: { winnerId: string, loserIds: string[] }
 */
locationsRouter.post('/pads/merge', requirePermission('locations:manage'), async (req: Request, res: Response, next) => {
  try {
    const { winnerId, loserIds } = req.body as { winnerId: string; loserIds: string[] };

    if (!winnerId || !loserIds || loserIds.length === 0) {
      throw new AppError(400, 'winnerId and loserIds[] are required');
    }
    if (loserIds.includes(winnerId)) {
      throw new AppError(400, 'winnerId cannot be in loserIds');
    }

    // Verify all pads exist
    const winner = await prisma.pad.findUnique({ where: { id: winnerId } });
    if (!winner) throw new AppError(404, 'Winner pad not found');

    const losers = await prisma.pad.findMany({ where: { id: { in: loserIds } } });
    if (losers.length !== loserIds.length) {
      const found = losers.map(l => l.id);
      const missing = loserIds.filter(id => !found.includes(id));
      throw new AppError(404, 'Loser pads not found: ' + missing.join(', '));
    }

    // Move all child records from losers to winner in a transaction
    const result = await prisma.$transaction(async (tx) => {
      const counts = { wells: 0, workPoints: 0, tickets: 0, facilities: 0, routeStops: 0, equipment: 0, operatorHistory: 0, rentals: 0 };

      for (const loserId of loserIds) {
        // Wells
        const wellResult = await tx.well.updateMany({ where: { padId: loserId }, data: { padId: winnerId } });
        counts.wells += wellResult.count;

        // Work Points
        const wpResult = await tx.workPoint.updateMany({ where: { padId: loserId }, data: { padId: winnerId } });
        counts.workPoints += wpResult.count;

        // Service Tickets
        const ticketResult = await tx.serviceTicket.updateMany({ where: { padId: loserId }, data: { padId: winnerId } });
        counts.tickets += ticketResult.count;

        // Facilities
        const facResult = await tx.facility.updateMany({ where: { padId: loserId }, data: { padId: winnerId } });
        counts.facilities += facResult.count;

        // Route Stops
        const rsResult = await tx.routeStop.updateMany({ where: { padId: loserId }, data: { padId: winnerId } });
        counts.routeStops += rsResult.count;

        // Serialized Equipment
        const eqResult = await tx.serializedEquipment.updateMany({ where: { currentPadId: loserId }, data: { currentPadId: winnerId } });
        counts.equipment += eqResult.count;

        // Operator History
        const ohResult = await tx.operatorHistory.updateMany({ where: { padId: loserId }, data: { padId: winnerId } });
        counts.operatorHistory += ohResult.count;

        // Rental Agreements
        const raResult = await tx.rentalAgreement.updateMany({ where: { padId: loserId }, data: { padId: winnerId } });
        counts.rentals += raResult.count;

        // Deactivate the loser
        await tx.pad.update({
          where: { id: loserId },
          data: {
            isActive: false,
            customData: {
              ...(losers.find(l => l.id === loserId)?.customData as any || {}),
              mergedInto: winnerId,
              mergedAt: new Date().toISOString(),
            },
          },
        });
      }

      return counts;
    });

    // Log the merge
    await createAuditLog({
      userId: req.user!.userId,
      action: 'update' as any,
      entityType: 'pad',
      entityId: winnerId,
      changes: { action: 'pad_merge', winnerId, loserIds, moved: result } as any,
    });

    res.json({
      message: `Merged ${loserIds.length} pad(s) into ${winner.name}`,
      winner: { id: winnerId, name: winner.name },
      moved: result,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /locations/transfer-operator
 * Transfer pads+wells from one operator to another (buyout / acquisition).
 * Creates OperatorHistory records for audit trail.
 *
 * Body: { fromOperatorId: string, toOperatorId: string, effectiveDate?: string, notes?: string }
 *   OR: { padIds: string[], toOperatorId: string, effectiveDate?: string, notes?: string }
 *
 * If fromOperatorId is given → bulk transfer ALL pads+wells.
 * If padIds is given → transfer only those specific pads + their wells.
 */
locationsRouter.post('/transfer-operator', requirePermission('locations:manage'), async (req: Request, res: Response, next) => {
  try {
    const { fromOperatorId, toOperatorId, padIds, effectiveDate, notes } = req.body as {
      fromOperatorId?: string;
      toOperatorId: string;
      padIds?: string[];
      effectiveDate?: string;
      notes?: string;
    };

    if (!toOperatorId) throw new AppError(400, 'toOperatorId is required');
    if (fromOperatorId === toOperatorId) throw new AppError(400, 'Source and destination operators must differ');
    if (fromOperatorId && !await prisma.company.findUnique({ where: { id: fromOperatorId }, select: { id: true } })) throw new AppError(400, 'Source operator not found');
    if (!fromOperatorId && (!padIds || padIds.length === 0)) {
      throw new AppError(400, 'Provide either fromOperatorId (bulk) or padIds[] (selective)');
    }

    // Verify target company exists
    const toCo = await prisma.company.findUnique({ where: { id: toOperatorId }, select: { id: true, name: true } });
    if (!toCo) throw new AppError(404, 'Target operator not found');

    const effDate = effectiveDate ? new Date(effectiveDate) : new Date();

    const result = await prisma.$transaction(async (tx) => {
      let padsToTransfer: { id: string; currentOperatorId: string | null }[];

      if (padIds && padIds.length > 0) {
        // Selective: specific pads
        padsToTransfer = await tx.pad.findMany({
          where: { id: { in: padIds } },
          select: { id: true, currentOperatorId: true },
        });
      } else {
        // Bulk: all pads from source operator
        padsToTransfer = await tx.pad.findMany({
          where: { currentOperatorId: fromOperatorId },
          select: { id: true, currentOperatorId: true },
        });
      }

      // Skip pads already owned by target
      const transferable = padsToTransfer.filter(p => p.currentOperatorId !== toOperatorId);
      const padIdsToTransfer = transferable.map(p => p.id);

      if (padIdsToTransfer.length === 0) {
        return { pads: 0, wells: 0, history: 0 };
      }

      // Create operator history for each pad
      const historyRecords = transferable.map(p => ({
        padId: p.id,
        previousOperatorId: p.currentOperatorId || toOperatorId,
        newOperatorId: toOperatorId,
        effectiveDate: effDate,
        source: 'manual' as const,
        notes: notes || null,
      }));
      await tx.operatorHistory.createMany({ data: historyRecords });

      // Update pads
      const padResult = await tx.pad.updateMany({
        where: { id: { in: padIdsToTransfer } },
        data: { currentOperatorId: toOperatorId },
      });

      // Find and transfer wells on those pads + any standalone wells from the source operator
      const wellsOnPads = await tx.well.findMany({
        where: { padId: { in: padIdsToTransfer }, currentOperatorId: { not: toOperatorId } },
        select: { id: true, currentOperatorId: true },
      });

      // Also get standalone wells (no pad) from the source operator if doing bulk transfer
      let standaloneWells: { id: string; currentOperatorId: string | null }[] = [];
      if (fromOperatorId) {
        standaloneWells = await tx.well.findMany({
          where: { currentOperatorId: fromOperatorId, padId: null },
          select: { id: true, currentOperatorId: true },
        });
      }

      const allWells = [...wellsOnPads, ...standaloneWells];
      if (allWells.length > 0) {
        // Create history for wells
        const wellHistory = allWells.map(w => ({
          wellId: w.id,
          previousOperatorId: w.currentOperatorId || toOperatorId,
          newOperatorId: toOperatorId,
          effectiveDate: effDate,
          source: 'manual' as const,
          notes: notes || null,
        }));
        await tx.operatorHistory.createMany({ data: wellHistory });

        // Update wells
        await tx.well.updateMany({
          where: { id: { in: allWells.map(w => w.id) } },
          data: { currentOperatorId: toOperatorId },
        });
      }

      return {
        pads: padResult.count,
        wells: allWells.length,
        history: historyRecords.length + allWells.length,
      };
    });

    await createAuditLog({
      userId: req.user!.userId,
      action: 'update' as any,
      entityType: 'company',
      entityId: toOperatorId,
      changes: {
        action: 'operator_transfer',
        fromOperatorId: fromOperatorId || `${padIds?.length} specific pads`,
        toOperatorId,
        effectiveDate: effDate.toISOString(),
        ...result,
      } as any,
    });

    res.json({
      ok: true,
      message: `Transferred ${result.pads} pad(s) and ${result.wells} well(s) to ${toCo.name}`,
      ...result,
    });
  } catch (err) {
    if (err instanceof AppError) return next(err);
    next(err);
  }
});
