import { cycleLength, validDate } from '../services/writeValidation.js';
import { defaultDivisionForWork } from '../utils/qbClass.js';
import { Router, Request, Response } from 'express';
import { prisma } from '../db.js';
import { AppError } from '../middleware/errorHandler.js';
import { requirePermission } from '../middleware/rbac.js';
import { generateTicketNumbers } from '../utils/ticketNumber.js';
import { buildLocationDisplay } from '../utils/locationDisplay.js';
import { computeBillingGroupKey } from '../utils/billingGroupKey.js';
import { createAuditLog } from '../utils/auditLog.js';

export const coverageRouter = Router();

// ============================================================
// Calendar Period Helpers
//
// Coverage uses calendar-aligned periods, not rolling windows.
// "Quarterly" means Q1 (Jan-Mar), Q2 (Apr-Jun), etc.
// This answers "did a service event happen in Q1?" rather than
// "in the last 90 days from now."
// ============================================================

interface CalendarPeriod {
  startDate: Date;
  endDate: Date;
  cycleName: string;
}

/**
 * Compute the calendar-aligned period for a given cycleMonths.
 *
 *   1  → Monthly:       Jan, Feb, Mar, ...
 *   2  → Bi-monthly:    Jan-Feb, Mar-Apr, ...
 *   3  → Quarterly:     Q1 (Jan-Mar), Q2 (Apr-Jun), Q3 (Jul-Sep), Q4 (Oct-Dec)
 *   6  → Semi-annual:   H1 (Jan-Jun), H2 (Jul-Dec)
 *  12  → Annual:        Full year
 *
 * @param cycleMonths - Route's cycle length in months
 * @param refDate     - Reference date (defaults to now)
 */
function getCalendarPeriod(cycleMonths: number, refDate?: Date): CalendarPeriod {
  if (![1, 2, 3, 6, 12].includes(cycleMonths)) cycleMonths = 6;
  const ref = refDate || new Date();
  const year = ref.getFullYear();
  const month = ref.getMonth(); // 0-indexed

  const periodIndex = Math.floor(month / cycleMonths);
  const startMonth = periodIndex * cycleMonths;
  const endMonth = startMonth + cycleMonths; // exclusive

  const startDate = new Date(year, startMonth, 1);
  // End date = last moment of last day of period
  // endMonth is the first month of NEXT period, day 0 = last day of prev month
  const endDate = new Date(year, endMonth, 0, 23, 59, 59, 999);

  // Human-readable cycle name
  let cycleName: string;
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  if (cycleMonths === 1) {
    cycleName = `${monthNames[startMonth]} ${year}`;
  } else if (cycleMonths === 2) {
    cycleName = `${monthNames[startMonth]}-${monthNames[startMonth + 1]} ${year}`;
  } else if (cycleMonths === 3) {
    cycleName = `Q${periodIndex + 1} ${year}`;
  } else if (cycleMonths === 6) {
    cycleName = `H${periodIndex + 1} ${year}`;
  } else if (cycleMonths === 12) {
    cycleName = `${year}`;
  } else {
    cycleName = `${monthNames[startMonth]}-${monthNames[Math.min(endMonth - 1, 11)]} ${year}`;
  }

  return { startDate, endDate, cycleName };
}

/**
 * Find or auto-create a RouteCycle for the given route and period.
 * This ensures every route+period combo has a RouteCycle record.
 */
async function findOrCreateCycle(routeId: string, period: CalendarPeriod, totalStops: number, db: Pick<typeof prisma, 'routeCycle'>): Promise<string> {
  // Look for an existing cycle overlapping this period
  const existing = await db.routeCycle.findFirst({
    where: {
      routeId,
      startDate: period.startDate,
    },
  });

  if (existing) return existing.id;

  // Auto-create
  const cycle = await db.routeCycle.create({
    data: {
      routeId,
      cycleName: period.cycleName,
      startDate: period.startDate,
      endDate: period.endDate,
      status: 'active',
      totalStops,
      completedStops: 0,
    },
  });

  return cycle.id;
}

// ============================================================
// GET /routes — All active routes with completion stats
// Uses calendar-aligned periods based on each route's cycleMonths
// ============================================================

coverageRouter.get('/routes', async (req: Request, res: Response) => {
  const { months = 'auto' } = req.query;
  const usePerRoute = months === 'auto';
  const globalPeriodMonths = usePerRoute ? 12 : (parseInt(months as string, 10) || 6);

  // When using per-route cycles, we need tickets from the widest possible period
  // (12mo = full year). When using a global override, use that period's start date.
  const maxPeriod = usePerRoute
    ? getCalendarPeriod(12) // full year covers all possible sub-periods
    : getCalendarPeriod(globalPeriodMonths);

  // Get all active routes with their stops
  const routes = await prisma.serviceRoute.findMany({
    where: { isActive: true },
    include: {
      company: { select: { id: true, name: true } },
      stops: {
        where: { isActive: true },
        select: {
          id: true,
          padId: true,
          wellId: true,
          stopIndex: true,
          clientName: true,
          pad: { select: { id: true, name: true, fieldId: true, field: { select: { name: true } } } },
          well: { select: { id: true, wellName: true, field: { select: { name: true } } } },
        },
      },
      _count: { select: { stops: true } },
    },
    orderBy: [{ company: { name: 'asc' } }, { name: 'asc' }],
  });

  // Get all completed tickets in the max window. Keyed by BOTH padId and
  // wellId — a stop can now be a well with no pad at all, and those used to
  // match nothing and sit permanently in "remaining".
  const completedTickets = await prisma.serviceTicket.findMany({
    where: {
      status: { in: ['completed', 'supervisor_review', 'billing_queue', 'invoiced', 'closed'] },
      serviceDate: { gte: maxPeriod.startDate },
      OR: [{ padId: { not: null } }, { wellId: { not: null } }],
    },
    select: {
      id: true,
      ticketNumber: true,
      padId: true,
      wellId: true,
      serviceDate: true,
      serviceSubtype: true,
      assignedTechId: true,
      assignedTech: { select: { id: true, name: true } },
    },
    orderBy: { serviceDate: 'desc' },
  });

  // Index ALL tickets by padId and by wellId
  const allTicketsByPad = new Map<string, typeof completedTickets>();
  const allTicketsByWell = new Map<string, typeof completedTickets>();
  for (const t of completedTickets) {
    if (t.padId) {
      if (!allTicketsByPad.has(t.padId)) allTicketsByPad.set(t.padId, []);
      allTicketsByPad.get(t.padId)!.push(t);
    }
    if (t.wellId) {
      if (!allTicketsByWell.has(t.wellId)) allTicketsByWell.set(t.wellId, []);
      allTicketsByWell.get(t.wellId)!.push(t);
    }
  }

  // Build per-route summary
  const routeSummaries = routes.map(route => {
    // Determine this route's calendar period
    const routePeriod = usePerRoute ? route.cycleMonths : globalPeriodMonths;
    const period = getCalendarPeriod(routePeriod);

    const totalStops = route.stops.length;
    let servicedStops = 0;
    let lastServiceDate: Date | null = null;

    const stops = route.stops.map(stop => {
      // Which tickets count as servicing THIS stop, within the route's period.
      // A well stop is satisfied only by a ticket for that well — deliberately
      // NOT by a pad-level ticket, since a route that lists three wells on one
      // pad as three stops would otherwise mark all three done off one visit.
      // Pad stops keep their existing behavior (any ticket at the pad, well-
      // level ones included).
      const candidateTickets = stop.wellId
        ? (allTicketsByWell.get(stop.wellId) || [])
        : stop.padId ? (allTicketsByPad.get(stop.padId) || []) : [];
      const ticket = candidateTickets.find(t => {
        const sd = new Date(t.serviceDate);
        return sd >= period.startDate && sd <= period.endDate;
      }) || null;
      const isServiced = !!ticket;
      if (isServiced) {
        servicedStops++;
        const d = new Date(ticket!.serviceDate);
        if (!lastServiceDate || d > lastServiceDate) lastServiceDate = d;
      }

      return {
        stopId: stop.id,
        stopIndex: stop.stopIndex,
        padId: stop.padId,
        wellId: stop.wellId,
        wellName: stop.well?.wellName || null,
        // What to show for this stop. Well wins — that's the point of a well
        // stop. `padName` is kept as-is for older clients reading that field.
        locationName: stop.well?.wellName || stop.pad?.name || stop.clientName || `Stop ${stop.stopIndex}`,
        padName: stop.pad?.name || stop.clientName || `Stop ${stop.stopIndex}`,
        fieldName: stop.pad?.field?.name || stop.well?.field?.name || null,
        clientName: stop.clientName,
        isServiced,
        lastServiceDate: ticket?.serviceDate || null,
        lastTicketNumber: ticket?.ticketNumber || null,
        lastTechName: ticket?.assignedTech?.name || null,
      };
    });

    // Sort: undone first, then by stop index
    stops.sort((a, b) => {
      if (a.isServiced !== b.isServiced) return a.isServiced ? 1 : -1;
      return a.stopIndex - b.stopIndex;
    });

    const pct = totalStops > 0 ? Math.round((servicedStops / totalStops) * 100) : 0;

    return {
      routeId: route.id,
      routeName: route.name,
      routeNumber: route.routeNumber,
      area: route.area,
      companyId: route.companyId,
      companyName: route.company.name,
      cycleMonths: route.cycleMonths,
      cycleName: period.cycleName,
      cycleStart: period.startDate.toISOString(),
      cycleEnd: period.endDate.toISOString(),
      totalStops,
      servicedStops,
      remainingStops: totalStops - servicedStops,
      percentComplete: pct,
      lastServiceDate,
      stops,
    };
  });

  // Global totals
  const totalStops = routeSummaries.reduce((s, r) => s + r.totalStops, 0);
  const totalServiced = routeSummaries.reduce((s, r) => s + r.servicedStops, 0);
  const totalRemaining = totalStops - totalServiced;

  // Pace: compute from the period that's furthest along
  // Use the most common cycleMonths for global pace
  const avgCycleMonths = routes.length > 0
    ? Math.round(routes.reduce((s, r) => s + r.cycleMonths, 0) / routes.length)
    : globalPeriodMonths;
  const effectivePeriod = usePerRoute ? avgCycleMonths : globalPeriodMonths;
  const globalPeriod = getCalendarPeriod(effectivePeriod);

  const msElapsed = Math.max(1, Date.now() - globalPeriod.startDate.getTime());
  const msTotal = globalPeriod.endDate.getTime() - globalPeriod.startDate.getTime();
  const weeksElapsed = Math.max(1, Math.ceil(msElapsed / (7 * 24 * 60 * 60 * 1000)));
  const weeksRemaining = Math.max(0, Math.ceil((msTotal - msElapsed) / (7 * 24 * 60 * 60 * 1000)));

  const avgPerWeek = Math.round((totalServiced / weeksElapsed) * 10) / 10;
  const weeksToFinish = avgPerWeek > 0 ? Math.ceil(totalRemaining / avgPerWeek) : null;

  // Sort routes: most remaining first (who needs attention)
  routeSummaries.sort((a, b) => b.remainingStops - a.remainingStops);

  res.json({
    periodMonths: usePerRoute ? 'auto' : globalPeriodMonths,
    cycleName: globalPeriod.cycleName,
    cycleStart: globalPeriod.startDate.toISOString(),
    cycleEnd: globalPeriod.endDate.toISOString(),
    totals: {
      routes: routeSummaries.length,
      stops: totalStops,
      serviced: totalServiced,
      remaining: totalRemaining,
      percentComplete: totalStops > 0 ? Math.round((totalServiced / totalStops) * 100) : 0,
    },
    pace: {
      weeksElapsed,
      weeksRemaining,
      avgPerWeek,
      weeksToFinishAtCurrentPace: weeksToFinish,
      needsMoreGuys: weeksToFinish !== null && weeksToFinish > weeksRemaining,
    },
    routes: routeSummaries,
  });
});

// ============================================================
// GET /routes/:routeId — Detailed view for one route
// Uses calendar-aligned period based on route's cycleMonths
// ============================================================

coverageRouter.get('/routes/:routeId', async (req: Request, res: Response) => {
  const { routeId } = req.params;
  const { months } = req.query;

  const route = await prisma.serviceRoute.findUnique({
    where: { id: routeId as string },
    include: {
      company: { select: { id: true, name: true } },
      stops: {
        where: { isActive: true },
        include: {
          pad: {
            select: {
              id: true,
              name: true,
              fieldId: true,
              field: { select: { name: true } },
              latitude: true,
              longitude: true,
            },
          },
          well: {
            select: {
              id: true, wellName: true, apiNumber: true,
              field: { select: { name: true } },
            },
          },
        },
        orderBy: { stopIndex: 'asc' },
      },
    },
  });

  if (!route) throw new AppError(404, 'Route not found');

  // Determine period: use override if given, else route's own cycleMonths
  const periodMonths = months !== undefined
    ? (parseInt(months as string, 10) || route.cycleMonths)
    : route.cycleMonths;
  const period = getCalendarPeriod(periodMonths);

  // Locations on this route — pads AND wells (a well stop may have no pad).
  const padIds = route.stops.map(s => s.padId).filter(Boolean) as string[];
  const wellIds = route.stops.map(s => s.wellId).filter(Boolean) as string[];

  // Get all completed tickets at those locations in the calendar period
  const tickets = (padIds.length > 0 || wellIds.length > 0) ? await prisma.serviceTicket.findMany({
    where: {
      OR: [
        ...(padIds.length > 0 ? [{ padId: { in: padIds } }] : []),
        ...(wellIds.length > 0 ? [{ wellId: { in: wellIds } }] : []),
      ],
      status: { in: ['completed', 'supervisor_review', 'billing_queue', 'invoiced', 'closed'] },
      serviceDate: { gte: period.startDate, lte: period.endDate },
    },
    select: {
      id: true,
      ticketNumber: true,
      ticketType: true,
      serviceSubtype: true,
      padId: true,
      wellId: true,
      serviceDate: true,
      assignedTechId: true,
      assignedTech: { select: { id: true, name: true } },
      status: true,
    },
    orderBy: { serviceDate: 'desc' },
  }) : [];

  // Index by padId and by wellId
  const ticketsByPad = new Map<string, typeof tickets>();
  const ticketsByWell = new Map<string, typeof tickets>();
  for (const t of tickets) {
    if (t.padId) {
      if (!ticketsByPad.has(t.padId)) ticketsByPad.set(t.padId, []);
      ticketsByPad.get(t.padId)!.push(t);
    }
    if (t.wellId) {
      if (!ticketsByWell.has(t.wellId)) ticketsByWell.set(t.wellId, []);
      ticketsByWell.get(t.wellId)!.push(t);
    }
  }

  // Build stop detail
  const stops = route.stops.map(stop => {
    // Well stops match on the well only — same rule as GET /routes above.
    const stopTickets = stop.wellId
      ? (ticketsByWell.get(stop.wellId) || [])
      : stop.padId ? (ticketsByPad.get(stop.padId) || []) : [];
    const latest = stopTickets[0] || null;

    return {
      stopId: stop.id,
      stopIndex: stop.stopIndex,
      padId: stop.padId,
      wellId: stop.wellId,
      wellName: stop.well?.wellName || null,
      locationName: stop.well?.wellName || stop.pad?.name || stop.clientName || `Stop ${stop.stopIndex}`,
      padName: stop.pad?.name || stop.clientName || `Stop ${stop.stopIndex}`,
      fieldName: stop.pad?.field?.name || stop.well?.field?.name || null,
      clientName: stop.clientName,
      notes: stop.notes,
      afeNumber: stop.afeNumber,
      isServiced: !!latest,
      serviceCount: stopTickets.length,
      lastServiceDate: latest?.serviceDate || null,
      lastTicketNumber: latest?.ticketNumber || null,
      lastTechName: latest?.assignedTech?.name || null,
      lastServiceType: latest?.serviceSubtype || null,
      tickets: stopTickets.map(t => ({
        id: t.id,
        ticketNumber: t.ticketNumber,
        serviceDate: t.serviceDate,
        serviceSubtype: t.serviceSubtype,
        techName: t.assignedTech?.name || null,
      })),
    };
  });

  const servicedCount = stops.filter(s => s.isServiced).length;

  // Tech breakdown
  const techMap = new Map<string, { name: string; count: number }>();
  for (const t of tickets) {
    const key = t.assignedTechId || 'unassigned';
    const name = t.assignedTech?.name || 'Unassigned';
    if (!techMap.has(key)) techMap.set(key, { name, count: 0 });
    techMap.get(key)!.count++;
  }
  const techBreakdown = Array.from(techMap.values()).sort((a, b) => b.count - a.count);

  res.json({
    route: {
      id: route.id,
      name: route.name,
      routeNumber: route.routeNumber,
      area: route.area,
      description: route.description,
      companyId: route.companyId,
      companyName: route.company.name,
      cycleMonths: route.cycleMonths,
    },
    periodMonths,
    cycleName: period.cycleName,
    cycleStart: period.startDate.toISOString(),
    cycleEnd: period.endDate.toISOString(),
    totalStops: stops.length,
    servicedStops: servicedCount,
    remainingStops: stops.length - servicedCount,
    percentComplete: stops.length > 0 ? Math.round((servicedCount / stops.length) * 100) : 0,
    techBreakdown,
    stops,
  });
});

// ============================================================
// POST /routes/:routeId/generate-tickets — batch-create tickets for unserviced stops
// ============================================================

coverageRouter.post('/routes/:routeId/generate-tickets', requirePermission('dispatch:manage'), async (req: Request, res: Response, next) => {
  try {
    const { routeId } = req.params;
    const { assignedTechId, serviceDate, dispatchNotes, stopIds } = req.body;

    if (!assignedTechId) throw new AppError(400, 'assignedTechId is required');
    if (!serviceDate) throw new AppError(400, 'serviceDate is required');
    // stopIds is optional — if provided, only generate tickets for these specific stops
    const selectedStopIds: string[] | null = Array.isArray(stopIds) && stopIds.length > 0 ? stopIds : null;

    // Validate tech exists
    const tech = await prisma.user.findUnique({ where: { id: assignedTechId }, select: { id: true, name: true } });
    if (!tech) throw new AppError(404, 'Tech not found');

    validDate(serviceDate, 'serviceDate');
    const result = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM service_routes WHERE id = ${routeId as string} FOR UPDATE`;
      // Get route with active stops
      const route = await tx.serviceRoute.findUnique({
        where: { id: routeId as string },
        include: {
          company: { select: { id: true, name: true } },
          stops: {
            where: { isActive: true },
            include: {
              pad: {
                select: {
                  id: true,
                  name: true,
                  fieldId: true,
                  field: { select: { id: true, name: true } },
                },
              },
              well: { select: { id: true, wellName: true, fieldId: true } },
            },
            orderBy: { stopIndex: 'asc' },
          },
        },
      });

      if (!route) throw new AppError(404, 'Route not found');
      if (!route.isActive) throw new AppError(400, 'Route is inactive');

      cycleLength(route.cycleMonths);
      if (stopIds !== undefined && (!Array.isArray(stopIds) || stopIds.length === 0 || stopIds.some((id: string) => !route.stops.some(stop => stop.id === id)))) throw new AppError(400, 'stopIds must belong to this route');
      if (!route.stops.length) return { created: 0, message: 'This route has no active stops', tickets: [] };
      // Get current calendar period + cycle
      const period = getCalendarPeriod(route.cycleMonths, new Date(serviceDate));
      const cycleId = await findOrCreateCycle(route.id, period, route.stops.length, tx);

      // Find stops already serviced in this cycle (have a RouteCycleVisit with a ticketId)
      const existingVisits = await tx.routeCycleVisit.findMany({
        where: { cycleId, ticketId: { not: null }, ticket: { status: { not: 'void' } } },
        select: { stopId: true },
      });
      const servicedStopIds = new Set(existingVisits.map(v => v.stopId));

      // Also check for tickets already covering these locations in this period
      // (tickets created outside the route system). Wells are checked separately
      // from pads: a well stop with no pad matched nothing here before, so it got
      // a fresh duplicate ticket on every run.
      const padIds = route.stops.map(s => s.padId).filter(Boolean) as string[];
      const wellIds = route.stops.map(s => s.wellId).filter(Boolean) as string[];
      const existingTickets = (padIds.length > 0 || wellIds.length > 0) ? await tx.serviceTicket.findMany({
        where: {
          OR: [
            ...(padIds.length > 0 ? [{ padId: { in: padIds } }] : []),
            ...(wellIds.length > 0 ? [{ wellId: { in: wellIds } }] : []),
          ],
          status: { in: ['draft', 'dispatched', 'in_progress', 'completed', 'supervisor_review', 'billing_queue', 'invoiced', 'closed'] },
          serviceDate: { gte: period.startDate, lte: period.endDate },
        },
        select: { padId: true, wellId: true },
      }) : [];
      const padsWithTickets = new Set(existingTickets.map(t => t.padId).filter(Boolean));
      const wellsWithTickets = new Set(existingTickets.map(t => t.wellId).filter(Boolean));

      // Filter to unserviced stops (optionally limited to selected stop IDs).
      // A well stop is only suppressed by a ticket for THAT well — matching the
      // coverage rule, so the two screens can't disagree about what's left.
      const selectedLocations = new Set<string>();
      const unservicedStops = route.stops.filter(stop => {
        const key = stop.wellId ? `well:${stop.wellId}` : stop.padId ? `pad:${stop.padId}` : `facility:${stop.facilityId}`;
        if (selectedLocations.has(key)) return false;
        if (selectedStopIds && !selectedStopIds.includes(stop.id)) return false;
        selectedLocations.add(key);
        if (servicedStopIds.has(stop.id)) return false;
        if (stop.wellId) {
          if (wellsWithTickets.has(stop.wellId)) return false;
        } else if (stop.padId && padsWithTickets.has(stop.padId)) {
          return false;
        }
        if (selectedStopIds && !selectedStopIds.includes(stop.id)) return false;
        return true;
      });

      if (unservicedStops.length === 0) {
        return { created: 0, message: 'All selected stops are scheduled or serviced in this period', tickets: [] };
      }

      const resolvedServiceDate = new Date(serviceDate);
      const createdTickets: Array<{ id: string; ticketNumber: string; location: string }> = [];

      // Reserve every ticket number up front: generateTicketNumber reads the
      // highest COMMITTED number, so calling it per-stop inside the transaction
      // handed out the same number twice and the batch died on the unique index.
      const ticketNumbers = await generateTicketNumbers('field_service', unservicedStops.length);

      // Create tickets in a transaction
      {
        for (const [stopIdx, stop] of unservicedStops.entries()) {
          const ticketNumber = ticketNumbers[stopIdx];

          // A padless well stop still has a field of its own — without this
          // fallback its ticket lands field-less and drops out of the
          // field-scoped billing group.
          const stopFieldId = stop.pad?.fieldId || stop.well?.fieldId || undefined;

          const locationDisplay = await buildLocationDisplay({
            companyId: route.companyId,
            fieldId: stopFieldId,
            padId: stop.padId,
            wellId: stop.wellId,
          });

          const billingGroupKey = computeBillingGroupKey({
            ticketType: 'field_service',
            companyId: route.companyId,
            fieldId: stopFieldId,
            serviceDate: resolvedServiceDate,
          });

          const ticket = await tx.serviceTicket.create({
            data: {
              ticketNumber,
              ticketType: 'field_service',
              serviceSubtype: 'cascade_air',
              division: defaultDivisionForWork({ ticketType: 'field_service', serviceSubtype: 'cascade_air' }) || 'D3',
              status: 'dispatched',
              companyId: route.companyId,
              fieldId: stopFieldId,
              padId: stop.padId || undefined,
              wellId: stop.wellId || undefined,
              assignedTechId,
              serviceDate: resolvedServiceDate,
              locationDisplay,
              billingGroupKey: billingGroupKey || undefined,
              afeNumber: stop.afeNumber || undefined,
              costCenter: stop.costCenter || undefined,
              dispatchNotes: dispatchNotes || undefined,
              dispatchedAt: new Date(),
              dispatchedById: req.user!.userId,
              createdById: req.user!.userId,
            },
          });

          // Create RouteCycleVisit linking stop → ticket
          await tx.routeCycleVisit.upsert({
            where: { cycleId_stopId: { cycleId, stopId: stop.id } },
            update: { ticketId: ticket.id, visitedAt: null, visitedById: null, skipped: false },
            create: {
              cycleId,
              stopId: stop.id,
              ticketId: ticket.id,
            },
          });

          createdTickets.push({
            id: ticket.id,
            ticketNumber,
            location: locationDisplay || stop.well?.wellName || stop.clientName || stop.pad?.name || `Stop ${stop.stopIndex}`,
          });
        }

        // Update cycle completed count
        const totalVisits = await tx.routeCycleVisit.count({
          where: { cycleId, ticketId: { not: null } },
        });
        await tx.routeCycle.update({
          where: { id: cycleId },
          data: { completedStops: totalVisits },
        });
      }

      await createAuditLog({
        userId: req.user!.userId,
        entityType: 'coverage_batch',
        entityId: routeId as string,
        action: 'create',
        changes: {
          routeName: route.name,
          techName: tech.name,
          ticketCount: createdTickets.length,
          cycleName: period.cycleName,
        },
        ipAddress: req.ip,
      });

      return {
        created: createdTickets.length,
        cycleId,
        cycleName: period.cycleName,
        assignedTech: tech.name,
        tickets: createdTickets,
      };
    }, { timeout: 60000 });
    res.status(result.created ? 201 : 200).json(result);
  } catch (err) {
    next(err);
  }
});
