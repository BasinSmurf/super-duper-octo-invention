import { rentalToday } from '../services/rentalLifecycle.js';
import { internalShopValue } from '../services/internalShopValue.js';
import { requirePermission } from '../middleware/rbac.js';
import { excludedShopTicketIds, getBilledShopWorkOrderIds } from '../services/shopBillingQueue.js';
import { Router, Request, Response } from 'express';
import { prisma } from '../db.js';
import { Prisma } from '../db.js';
import type { TicketType } from '../db.js';
import { AppError } from '../middleware/errorHandler.js';
import {
  catalogForRole,
  baselineForRole,
  validateWidgets,
} from '../services/widgetCatalog.js';
import { computeH2sAnalytics } from '../services/h2sAnalytics.js';
import { getPeriodActivity, resolvePeriod, type PeriodKey } from '../services/opsStats.js';
import { getOperationsReport } from '../services/operationsReport.js';
import { getTicketVolume } from '../services/ticketVolume.js';
import { REPORT_TYPES, canReceiveReport, selectReport, type ReportType } from '../services/reportSubscriptions.js';
import {
  getShopAging,
  isAgingBucket,
  normalizeThreshold,
  AGING_BUCKETS,
} from '../services/shopAging.js';
import { roleHasCapability } from '../services/permissions.js';
import { isFollowUpDue, describeOverdue, activeFollowUp } from '../services/shopContactLog.js';

export const dashboardRouter = Router();

dashboardRouter.get('/ticket-volume', requirePermission('tickets:view_all'), async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(await getTicketVolume(prisma, rentalToday()));
});

dashboardRouter.get('/operations-report', requirePermission('tickets:view_all'), async (req, res) => {
  const financial = roleHasCapability(req.user!.role, 'reports:financial');
  const type = req.query.type;
  if (type !== undefined && !REPORT_TYPES.some(r => r.id === type)) throw new AppError(400, 'Unknown report type');
  if (type ? !canReceiveReport(req.user!.role, type as ReportType) : !financial && !roleHasCapability(req.user!.role, 'reports:ops')) throw new AppError(403, 'Report permission required');
  res.set('Cache-Control', 'no-store');
  const report = await getOperationsReport(prisma, new Date(), financial);
  res.json(type ? selectReport(report, type as ReportType) : report);
});

dashboardRouter.get('/internal-shop-value', requirePermission('reports:financial'), async (req: Request, res: Response) => {
  const { from, to } = req.query;
  const parse = (value: unknown) => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new AppError(400, 'Use YYYY-MM-DD dates');
    const date = new Date(value + 'T00:00:00.000Z');
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new AppError(400, 'Invalid date');
    return date;
  };
  const start = parse(from), end = parse(to);
  if (end < start || end.getTime() - start.getTime() > 366 * 86400000) throw new AppError(400, 'Choose a date range of at most one year');
  end.setUTCDate(end.getUTCDate() + 1);
  res.json(await internalShopValue(start, end));
});

// ============================================================
// GET /catalog — Widget types available to the current role
// ============================================================
//
// Returns the subset of the widget registry that the caller is
// allowed to add. Used to populate the "Add widget" picker.

dashboardRouter.get('/catalog', (req: Request, res: Response) => {
  const role = req.user?.role || '';
  res.json({ widgets: catalogForRole(role) });
});

// ============================================================
// GET /widgets — Current user's dashboard layout
// ============================================================
//
// If the user has never saved a layout, we synthesize the role
// baseline on the fly and flag `isDefault: true`. We deliberately
// do NOT persist it — this lets us evolve baselines later without
// clobbering anyone's custom layout.

dashboardRouter.get('/widgets', async (req: Request, res: Response, next) => {
  try {
    const userId = req.user!.userId;
    const role = req.user!.role;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { dashboardWidgets: true },
    });
    if (!user) throw new AppError(404, 'User not found');

    const saved = user.dashboardWidgets;
    if (saved == null) {
      return res.json({ widgets: baselineForRole(role), isDefault: true });
    }

    // Re-validate on read: catches stale widgets if role changed or
    // the catalog dropped a type since last save.
    const cleaned = validateWidgets(saved, role);
    res.json({ widgets: cleaned, isDefault: false });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// PUT /widgets — Replace current user's dashboard layout
// ============================================================
//
// Full-replace semantics — client sends the complete array.
// Server validates + normalizes before persisting. Send an empty
// array to clear the layout (user explicitly wants nothing);
// null is not accepted via API (use DELETE to reset to baseline).

dashboardRouter.put('/widgets', async (req: Request, res: Response, next) => {
  try {
    const userId = req.user!.userId;
    const role = req.user!.role;

    let cleaned;
    try {
      cleaned = validateWidgets(req.body?.widgets, role);
    } catch (e: any) {
      throw new AppError(400, e.message || 'Invalid widgets payload');
    }

    await prisma.user.update({
      where: { id: userId },
      data: { dashboardWidgets: cleaned as unknown as Prisma.InputJsonValue },
    });

    res.json({ widgets: cleaned, isDefault: false });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// DELETE /widgets — Reset to role baseline
// ============================================================
//
// Nulls the user's stored layout. Next GET returns the baseline.

dashboardRouter.delete('/widgets', async (req: Request, res: Response, next) => {
  try {
    const userId = req.user!.userId;
    const role = req.user!.role;

    await prisma.user.update({
      where: { id: userId },
      data: { dashboardWidgets: Prisma.JsonNull },
    });

    res.json({ widgets: baselineForRole(role), isDefault: true });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// GET /service-history — Per-customer service ticket history
// ============================================================
//
// Query params:
//   companyId  — optional, filter to one customer
//   dateFrom   — optional, ISO date string (default: 90 days ago)
//   dateTo     — optional, ISO date string (default: today)
//   ticketType — optional, filter to a specific ticket type
//
// Returns: customer summaries with ticket counts + revenue, and
//          optionally a ticket detail list when companyId is set.

dashboardRouter.get('/service-history', async (req: Request, res: Response, next) => {
  try {
    const companyId = req.query.companyId as string | undefined;
    const ticketType = req.query.ticketType as string | undefined;

    // Date range defaults to last 90 days
    const now = new Date();
    const defaultFrom = new Date(now);
    defaultFrom.setDate(defaultFrom.getDate() - 90);

    const dateFrom = req.query.dateFrom
      ? new Date(req.query.dateFrom as string)
      : defaultFrom;
    const dateTo = req.query.dateTo
      ? new Date(req.query.dateTo as string)
      : now;

    // Base where clause
    const baseWhere: any = {
      serviceDate: { gte: dateFrom, lte: dateTo },
      status: { notIn: ['draft'] },
    };
    if (companyId) baseWhere.companyId = companyId;
    if (ticketType) baseWhere.ticketType = ticketType as TicketType;

    // Run queries in parallel
    const [customerGroups, typeBreakdown, recentTickets, locationGroups] = await Promise.all([
      // 1. Per-customer summary
      prisma.serviceTicket.groupBy({
        by: ['companyId'],
        where: baseWhere,
        _count: { id: true },
        _sum: { total: true },
        orderBy: { _sum: { total: 'desc' } },
        take: 50,
      }),

      // 2. Per-customer per-type breakdown
      prisma.serviceTicket.groupBy({
        by: ['companyId', 'ticketType'],
        where: {
          serviceDate: { gte: dateFrom, lte: dateTo },
          status: { notIn: ['draft'] },
          ...(companyId ? { companyId } : {}),
        },
        _count: { id: true },
        _sum: { total: true },
      }),

      // 3. Recent tickets (only when a specific company is selected)
      companyId
        ? prisma.serviceTicket.findMany({
            where: baseWhere,
            select: {
              id: true,
              ticketNumber: true,
              ticketType: true,
              serviceSubtype: true,
              status: true,
              serviceDate: true,
              locationDisplay: true,
              total: true,
              assignedTech: { select: { name: true } },
              field: { select: { id: true, name: true } },
              pad: { select: { id: true, name: true } },
              well: { select: { id: true, wellName: true } },
              workPoint: { select: { id: true, name: true, workPointType: true } },
            },
            orderBy: { serviceDate: 'desc' },
            take: 200,
          })
        : Promise.resolve([]),

      // 4. Location breakdown (only when company is selected)
      companyId
        ? prisma.serviceTicket.groupBy({
            by: ['padId'],
            where: baseWhere,
            _count: { id: true },
            _sum: { total: true },
            orderBy: { _count: { id: 'desc' } },
            take: 50,
          })
        : Promise.resolve([]),
    ]);

    // Hydrate company names
    const companyIds = customerGroups.map(g => g.companyId);
    const companies = companyIds.length > 0
      ? await prisma.company.findMany({
          where: { id: { in: companyIds } },
          select: { id: true, name: true },
        })
      : [];
    const companyMap = new Map(companies.map(c => [c.id, c.name]));

    // Build type breakdown map: companyId → { ticketType → { count, revenue } }
    const typeMap = new Map<string, Record<string, { count: number; revenue: number }>>();
    for (const row of typeBreakdown) {
      if (!typeMap.has(row.companyId)) typeMap.set(row.companyId, {});
      const entry = typeMap.get(row.companyId)!;
      entry[row.ticketType] = {
        count: row._count.id,
        revenue: Number(row._sum.total || 0),
      };
    }

    // Assemble response
    const customers = customerGroups.map(g => ({
      companyId: g.companyId,
      companyName: companyMap.get(g.companyId) || 'Unknown',
      ticketCount: g._count.id,
      totalRevenue: Number(g._sum.total || 0),
      byType: typeMap.get(g.companyId) || {},
    }));

    const tickets = recentTickets.map((t: any) => ({
      id: t.id,
      ticketNumber: t.ticketNumber,
      ticketType: t.ticketType,
      serviceSubtype: t.serviceSubtype,
      status: t.status,
      serviceDate: t.serviceDate,
      locationDisplay: t.locationDisplay,
      total: Number(t.total || 0),
      techName: t.assignedTech?.name || null,
      fieldId: t.field?.id || null,
      fieldName: t.field?.name || null,
      padId: t.pad?.id || null,
      padName: t.pad?.name || null,
      wellName: t.well?.wellName || null,
      workPointName: t.workPoint?.name || null,
      workPointType: t.workPoint?.workPointType || null,
    }));

    // Build location breakdown (pad-level summary for drilldown)
    let locations: any[] = [];
    if (companyId && (locationGroups as any[]).length > 0) {
      const padIds = (locationGroups as any[]).map((g: any) => g.padId).filter(Boolean);
      const pads = padIds.length > 0
        ? await prisma.pad.findMany({
            where: { id: { in: padIds } },
            select: { id: true, name: true, field: { select: { id: true, name: true } } },
          })
        : [];
      const padMap = new Map(pads.map(p => [p.id, p]));

      locations = (locationGroups as any[])
        .filter((g: any) => g.padId)
        .map((g: any) => {
          const pad = padMap.get(g.padId);
          return {
            padId: g.padId,
            padName: pad?.name || 'Unknown',
            fieldId: pad?.field?.id || null,
            fieldName: pad?.field?.name || null,
            ticketCount: g._count.id,
            totalRevenue: Number(g._sum.total || 0),
          };
        });
    }

    res.json({
      dateRange: { from: dateFrom.toISOString().slice(0, 10), to: dateTo.toISOString().slice(0, 10) },
      customers,
      tickets,
      locations,
    });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// GET /billing-summary — Revenue pipeline + MTD breakdown
// ============================================================
//
// No params — always returns current month + pipeline.
// Requires billing:view permission (enforced in UI; server trusts authenticate).

dashboardRouter.get('/billing-summary', async (req: Request, res: Response, next) => {
  try {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const [
      mtdBySource,
      mtdByCustomer,
      mtdTotal,
      ticketQueueByCompany,
      draftCount,
      approvedCount,
      queuedCount,
      soCreatedCount,
    ] = await Promise.all([
      // 1. MTD revenue grouped by source type
      prisma.invoice.groupBy({
        by: ['sourceType'],
        where: { status: { not: 'void' }, invoiceDate: { gte: monthStart } },
        _sum: { total: true },
        _count: { id: true },
      }),

      // 2. MTD revenue top 15 customers
      prisma.invoice.groupBy({
        by: ['companyId', 'companyName'],
        where: { status: { not: 'void' }, invoiceDate: { gte: monthStart } },
        _sum: { total: true },
        _count: { id: true },
        orderBy: { _sum: { total: 'desc' } },
        take: 15,
      }),

      // 3. MTD total
      prisma.invoice.aggregate({
        where: { status: { not: 'void' }, invoiceDate: { gte: monthStart } },
        _sum: { total: true },
      }),

      // 4. Tickets in billing_queue grouped by company
      prisma.serviceTicket.groupBy({
        by: ['companyId'],
        where: { status: 'billing_queue', id: { notIn: await excludedShopTicketIds() } },
        _count: { id: true },
        _sum: { total: true },
      }),

      // 5–8. Invoice pipeline counts
      prisma.invoice.count({ where: { status: 'draft' } }),
      prisma.invoice.count({ where: { status: 'approved' } }),
      prisma.invoice.count({ where: { status: 'queued' } }),
      prisma.invoice.count({ where: { status: 'so_created' } }),
    ]);

    // Hydrate company names for ticket queue
    const tqCompanyIds = ticketQueueByCompany.map(g => g.companyId);
    const tqCompanies = tqCompanyIds.length > 0
      ? await prisma.company.findMany({
          where: { id: { in: tqCompanyIds } },
          select: { id: true, name: true },
        })
      : [];
    const tqMap = new Map(tqCompanies.map(c => [c.id, c.name]));

    // Uninvoiced shop WOs (same logic as invoices/stats)
    const invoicedWOIdSet = await getBilledShopWorkOrderIds();
    const allClosedWOs = await prisma.shopWorkOrder.findMany({
      where: { status: 'closed', isInternal: false },
      select: { id: true },
    });
    const shopWOsReadyToBill = allClosedWOs.filter(wo => !invoicedWOIdSet.has(wo.id)).length;

    // Active rentals
    const activeRentals = await prisma.rentalAgreement.count({
      where: { status: 'active', items: { some: { status: 'deployed' } } },
    });

    // Estimated monthly rental revenue (deployed items × rate)
    const deployedItems = await prisma.rentalAgreementItem.findMany({
      where: { status: 'deployed', rentalAgreement: { status: 'active' } },
      select: { rate: true, rateType: true },
    });
    let estMonthlyRental = 0;
    for (const item of deployedItems) {
      const rate = Number(item.rate || 0);
      if (item.rateType === 'daily') estMonthlyRental += rate * 30;
      else if (item.rateType === 'weekly') estMonthlyRental += rate * 4.33;
      else if (item.rateType === 'monthly') estMonthlyRental += rate;
    }

    // Total $ in ticket queue
    const ticketQueueTotal = ticketQueueByCompany.reduce(
      (sum, g) => sum + Number(g._sum.total || 0),
      0
    );

    res.json({
      monthToDate: {
        total: Number(mtdTotal._sum.total || 0),
        bySource: mtdBySource.map(s => ({
          sourceType: s.sourceType,
          total: Number(s._sum.total || 0),
          count: s._count.id,
        })),
        byCustomer: mtdByCustomer.map(c => ({
          companyId: c.companyId,
          companyName: c.companyName || 'Unknown',
          total: Number(c._sum.total || 0),
          invoiceCount: c._count.id,
        })),
      },
      pipeline: {
        ticketsReadyToBill: ticketQueueByCompany.reduce((sum, g) => sum + g._count.id, 0),
        ticketQueueTotal,
        ticketQueueByCompany: ticketQueueByCompany.map(g => ({
          companyId: g.companyId,
          companyName: tqMap.get(g.companyId) || 'Unknown',
          count: g._count.id,
          total: Number(g._sum.total || 0),
        })),
        shopWOsReadyToBill,
        activeRentals,
        activeRentalEstMonthly: Math.round(estMonthlyRental * 100) / 100,
        draftInvoices: draftCount,
        approvedInvoices: approvedCount,
        queuedInvoices: queuedCount,
        soCreatedInvoices: soCreatedCount,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// GET /period-activity — tickets closed + $ billed for today/week/month
// ============================================================
//
// The on-the-fly version of "how much did we get done" — no stored report,
// just a live count/sum over the requested window. Shared with the future
// notification digest via services/opsStats.ts so both compute it the same way.
dashboardRouter.get('/period-activity', async (req: Request, res: Response, next) => {
  try {
    const period = (req.query.period as string) || 'today';
    if (period !== 'today' && period !== 'week' && period !== 'month') {
      throw new AppError(400, `period must be one of: today, week, month`);
    }
    const { from, to } = resolvePeriod(period as PeriodKey);
    const activity = await getPeriodActivity(prisma, from, to);
    res.json(activity);
  } catch (err) {
    next(err);
  }
});

// ============================================================
// GET /shop-aging - one aging bucket, filtered and scoped (WI-03)
// ============================================================
//
// Query params:
//   bucket        open | on_hold | waiting          (required)
//   olderThanDays 0 | 7 | 30 | 60 | 90              (0 = unfiltered)
//   siteId        a Site id, or 'all'               (default: caller's home site)
//   mine          '1' to restrict to the caller's own assignments
//
// SCOPING IS ENFORCED HERE, not in the widget. A Field Tech is pinned to their
// home site; crossing branches (or asking for 'all') needs tickets:view_all,
// which is exactly the tech/supervisor split WI-03 describes and is already the
// capability every other cross-branch read is gated on. A tech who hand-crafts
// a siteId for another branch gets 403, not another branch's work list.
dashboardRouter.get('/shop-aging', async (req: Request, res: Response, next) => {
  try {
    const bucket = req.query.bucket;
    if (!isAgingBucket(bucket)) {
      throw new AppError(400, `bucket must be one of: ${AGING_BUCKETS.join(', ')}`);
    }
    const olderThanDays = normalizeThreshold(req.query.olderThanDays);

    const userId = req.user!.userId;
    const role = req.user!.role;
    const canSeeAllSites = roleHasCapability(role, 'tickets:view_all');

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { homeSiteId: true },
    });

    // Permission first, configuration second: asking for a branch you may not
    // see is a 403 whether or not your own branch is configured. Answering that
    // with "set your home site" would imply the request would otherwise work.
    const requested = typeof req.query.siteId === 'string' ? req.query.siteId : null;
    if (requested && !canSeeAllSites && requested !== user?.homeSiteId) {
      throw new AppError(
        403,
        requested === 'all'
          ? 'Not permitted to view all branches'
          : 'Not permitted to view another branch',
      );
    }

    // A branch-scoped user with no branch has no defensible default: showing
    // them everything breaks the scope rule, and silently showing them nothing
    // reads as "no backlog". Say so instead, so it gets fixed in admin.
    if (!canSeeAllSites && !user?.homeSiteId) {
      throw new AppError(
        409,
        'No home site is set on your account, so branch-scoped aging cannot be shown. Ask an admin to set it.',
      );
    }

    // Default view: your own branch. A supervisor with no home site set sees
    // every branch rather than none -- an empty widget reads as "no backlog".
    const siteId: string | null =
      !requested ? (user?.homeSiteId ?? null)
      : requested === 'all' ? null
      : requested;

    const result = await getShopAging({
      bucket,
      olderThanDays,
      siteId,
      assignedToId: req.query.mine === '1' ? userId : null,
    });

    res.json({ ...result, siteId: siteId ?? 'all', canSeeAllSites });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// GET /follow-ups-due — WI-10's supervisor widget
// ============================================================
//
// "Waiting more than 30 days" is a much smaller fire when the card carries an
// ETA. This lists the work orders whose follow-up commitment has come due.
//
// THE LATEST COMMITMENT WINS. A job is judged by its most recent entry that
// carries a follow-up date, not its earliest. Somebody who rang the vendor
// again this morning and got a new ETA has superseded the old one, and showing
// the stale date would put a job a person already chased today into the overdue
// list — which is exactly how a follow-up list stops being believed and starts
// being scrolled past.
//
// SCOPED THE SAME WAY THE AGING WIDGET IS, deliberately: a Field Tech sees
// their home branch, crossing branches needs `tickets:view_all`. Two adjacent
// widgets on the same dashboard answering "who may see this?" differently is
// how one of them ends up wrong.
//
// Query params:
//   siteId    a Site id, or 'all'   (default: caller's home site)
//   withinDays  optionally also include commitments coming due in N days
dashboardRouter.get('/follow-ups-due', async (req: Request, res: Response, next) => {
  try {
    const userId = req.user!.userId;
    const canSeeAllSites = roleHasCapability(req.user!.role, 'tickets:view_all');

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { homeSiteId: true },
    });

    const requested = typeof req.query.siteId === 'string' ? req.query.siteId : null;
    if (requested && !canSeeAllSites && requested !== user?.homeSiteId) {
      throw new AppError(
        403,
        requested === 'all'
          ? 'Not permitted to view all branches'
          : 'Not permitted to view another branch',
      );
    }
    if (!canSeeAllSites && !user?.homeSiteId) {
      throw new AppError(
        409,
        'No home site is set on your account, so branch-scoped follow-ups cannot be shown. Ask an admin to set it.',
      );
    }

    const siteId: string | null =
      !requested ? (user?.homeSiteId ?? null)
      : requested === 'all' ? null
      : requested;

    // Horizon: overdue by default, optionally "and the next N days" so a
    // supervisor can see what is about to land rather than only what already has.
    const withinDaysRaw = Number(req.query.withinDays);
    const withinDays = Number.isFinite(withinDaysRaw) ? Math.min(Math.max(withinDaysRaw, 0), 30) : 0;
    const now = new Date();
    const horizon = new Date(now.getTime() + withinDays * 86_400_000);

    // EVERY live commitment in scope, NOT just the ones already due.
    //
    // Filtering by date here would be the bug: the newest commitment for a job
    // is what counts, and a job whose vendor has just promised NEXT Friday
    // would have that entry excluded by the date filter, leaving the stale
    // overdue one as the newest thing the query could see. The job would sit in
    // the overdue list having been chased an hour ago.
    //
    // So the horizon is applied AFTER the per-work-order reduction, below. The
    // row count here is bounded by "jobs a shop currently has open", which is
    // tens, not by anything that grows with history.
    const entries = await prisma.shopContactLogEntry.findMany({
      where: {
        deletedAt: null,
        followUpAt: { not: null },
        workOrder: {
          // A closed job needs no chasing. Everything else does, including
          // `complete` — Ready for Pickup is exactly when the customer chasing
          // starts, and that is the log's original use case.
          status: { not: 'closed' },
          ...(siteId ? { intakeSiteId: siteId } : {}),
        },
      },
      select: {
        id: true,
        party: true,
        method: true,
        note: true,
        contactedAt: true,
        followUpAt: true,
        // Selected although the `where` already excludes deleted rows:
        // activeFollowUp re-checks it, and a helper that cannot see the field
        // it guards on is a helper that silently stops guarding.
        deletedAt: true,
        enteredByName: true,
        workOrder: {
          select: {
            id: true,
            workOrderNumber: true,
            status: true,
            company: { select: { id: true, name: true } },
            intakeSite: { select: { id: true, shortCode: true } },
          },
        },
      },
      orderBy: { contactedAt: 'desc' },
    });

    // One row per work order: the newest commitment. `activeFollowUp` is the
    // tested implementation of "the latest one wins" — used here rather than
    // re-derived, because a second copy of that rule is a second chance to get
    // it backwards.
    const byWorkOrder = new Map<string, typeof entries>();
    for (const e of entries) {
      const list = byWorkOrder.get(e.workOrder.id) ?? [];
      list.push(e);
      byWorkOrder.set(e.workOrder.id, list);
    }

    const current = [...byWorkOrder.values()]
      .map((list) => activeFollowUp(list))
      .filter((e): e is NonNullable<typeof e> => e !== null)
      // NOW apply the horizon: overdue by default, plus the next N days when asked.
      .filter((e) => e.followUpAt!.getTime() <= horizon.getTime());

    const rows = current
      .map((e) => ({
        workOrderId: e.workOrder.id,
        workOrderNumber: e.workOrder.workOrderNumber,
        status: e.workOrder.status,
        companyId: e.workOrder.company?.id ?? null,
        companyName: e.workOrder.company?.name ?? null,
        siteCode: e.workOrder.intakeSite?.shortCode ?? null,
        entryId: e.id,
        party: e.party,
        method: e.method,
        note: e.note,
        contactedAt: e.contactedAt,
        followUpAt: e.followUpAt!,
        enteredByName: e.enteredByName,
        overdue: isFollowUpDue(e.followUpAt, now),
        overdueLabel: describeOverdue(e.followUpAt!, now),
      }))
      // Most overdue first — the list is a work queue, not a calendar.
      .sort((a, b) => a.followUpAt.getTime() - b.followUpAt.getTime());

    res.json({
      rows,
      overdueCount: rows.filter((r) => r.overdue).length,
      siteId: siteId ?? 'all',
      canSeeAllSites,
      withinDays,
    });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// GET /h2s-analytics — H2S reading analysis by location
// ============================================================
//
// Query params:
//   companyId — required, filter to one customer
//
// Returns per-location H2S reading data for pie chart / timeline.

dashboardRouter.get('/h2s-analytics', async (req: Request, res: Response, next) => {
  try {
    const companyId = req.query.companyId as string | undefined;
    if (!companyId) {
      // Return list of companies that have H2S data
      const rows: Array<{ company_id: string; cnt: string }> = await prisma.$queryRaw`
        SELECT company_id, COUNT(*)::text as cnt
        FROM service_tickets
        WHERE custom_data->'gasReadings' IS NOT NULL
          AND jsonb_array_length(custom_data->'gasReadings') > 0
          AND status != 'draft'
        GROUP BY company_id
        ORDER BY cnt DESC
      `;
      const companyIds = rows.map(r => r.company_id);
      const companies = companyIds.length > 0
        ? await prisma.company.findMany({
            where: { id: { in: companyIds } },
            select: { id: true, name: true },
          })
        : [];
      const nameMap = new Map(companies.map(c => [c.id, c.name]));

      return res.json({
        companies: rows.map(r => ({
          companyId: r.company_id,
          companyName: nameMap.get(r.company_id) || 'Unknown',
          ticketCount: parseInt(r.cnt, 10),
        })),
      });
    }

    res.json(await computeH2sAnalytics(companyId));
  } catch (err) {
    next(err);
  }
});

// Today's team work is grouped by the responsible tech, using the Basin business calendar.
dashboardRouter.get('/team-activity', requirePermission('dispatch:manage'), async (_req: Request, res: Response, next) => {
  try {
    const start = rentalToday(), end = new Date(+start + 86400000);
    const tickets = await prisma.serviceTicket.findMany({ where: { serviceDate: { gte: start, lt: end }, status: { notIn: ['draft', 'void'] } },
      select: { status: true, assignedTech: { select: { id: true, name: true } } } });
    const groups = new Map<string, { id: string; name: string; total: number; working: number; review: number; done: number }>();
    for (const ticket of tickets) {
      const id = ticket.assignedTech?.id || 'unassigned';
      const row = groups.get(id) || { id, name: ticket.assignedTech?.name || 'Unassigned', total: 0, working: 0, review: 0, done: 0 };
      row.total++;
      if (['dispatched', 'in_progress'].includes(ticket.status)) row.working++;
      else if (ticket.status === 'supervisor_review') row.review++;
      else row.done++;
      groups.set(id, row);
    }
    res.json({ date: start.toISOString().slice(0, 10), rows: [...groups.values()].sort((a, b) => a.name.localeCompare(b.name)) });
  } catch (err) { next(err); }
});
