import { Router, Request, Response } from 'express';
import { prisma } from '../index.js';
import { AppError } from '../middleware/errorHandler.js';
import { requirePermission } from '../middleware/rbac.js';
import { createAuditLog } from '../utils/auditLog.js';

export const routesRouter = Router();

// ============================================================
// GET /techs — Search active techs for assignment
// ============================================================

routesRouter.get('/techs', async (req: Request, res: Response, next) => {
  try {
    const { search } = req.query;
    const where: any = { isActive: true };
    if (search) {
      where.name = { contains: search as string, mode: 'insensitive' };
    }
    // Include field techs and supers — the roles that actually run routes
    where.role = { in: ['field_tech', 'field_super'] };

    const users = await prisma.user.findMany({
      where,
      select: { id: true, name: true, role: true },
      orderBy: { name: 'asc' },
      // Type-ahead callers pass `search` and want a short list; the dispatch
      // board loads the full roster once and filters client-side, so return
      // them all when no search term is given.
      take: search ? 25 : 500,
    });

    res.json({ data: users });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// GET / — List all routes (with search, filters, pagination)
// ============================================================

routesRouter.get('/', async (req: Request, res: Response, next) => {
  try {
    const { search, companyId, active, limit = '50', offset = '0' } = req.query;

    const where: any = {};
    if (search) {
      where.OR = [
        { name: { contains: search as string, mode: 'insensitive' } },
        { routeNumber: { contains: search as string, mode: 'insensitive' } },
        { area: { contains: search as string, mode: 'insensitive' } },
        { company: { name: { contains: search as string, mode: 'insensitive' } } },
      ];
    }
    if (companyId) {
      where.companyId = companyId as string;
    }
    if (active !== undefined) {
      where.isActive = active === 'true';
    } else {
      where.isActive = true; // default to active only
    }

    const [routes, total] = await Promise.all([
      prisma.serviceRoute.findMany({
        where,
        include: {
          company: { select: { id: true, name: true } },
          assignments: {
            include: { user: { select: { id: true, name: true, role: true } } },
            orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
          },
          _count: { select: { stops: { where: { isActive: true } } } },
        },
        orderBy: [{ company: { name: 'asc' } }, { sortOrder: 'asc' }, { name: 'asc' }],
        take: parseInt(limit as string, 10),
        skip: parseInt(offset as string, 10),
      }),
      prisma.serviceRoute.count({ where }),
    ]);

    res.json({
      data: routes,
      total,
      limit: parseInt(limit as string, 10),
      offset: parseInt(offset as string, 10),
    });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// GET /:id — Single route with stops
// ============================================================

routesRouter.get('/:id', async (req: Request, res: Response, next) => {
  try {
    const route = await prisma.serviceRoute.findUnique({
      where: { id: req.params.id as string },
      include: {
        company: { select: { id: true, name: true } },
        assignments: {
          include: { user: { select: { id: true, name: true, role: true } } },
          orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
        },
        stops: {
          where: { isActive: true },
          orderBy: { stopIndex: 'asc' },
          include: {
            pad: {
              select: {
                id: true,
                name: true,
                fieldId: true,
                field: { select: { id: true, name: true } },
              },
            },
            well: {
              select: {
                id: true, wellName: true, apiNumber: true, padId: true, fieldId: true,
                field: { select: { id: true, name: true } },
                currentOperator: { select: { id: true, name: true } },
              },
            },
            facility: {
              select: { id: true, name: true },
            },
          },
        },
      },
    });

    if (!route) throw new AppError(404, 'Route not found');
    res.json(route);
  } catch (err) {
    next(err);
  }
});

// ============================================================
// POST / — Create a route
// ============================================================

routesRouter.post('/', requirePermission('routes:manage'), async (req: Request, res: Response, next) => {
  try {
    const { name, companyId, routeNumber, area, description, estimatedMiles, cycleMonths, sortOrder } = req.body;

    if (!name || !companyId) {
      throw new AppError(400, 'name and companyId are required');
    }

    const route = await prisma.serviceRoute.create({
      data: {
        name,
        companyId,
        routeNumber: routeNumber || null,
        area: area || null,
        description: description || null,
        estimatedMiles: estimatedMiles != null ? estimatedMiles : null,
        cycleMonths: cycleMonths != null ? parseInt(cycleMonths, 10) : 6,
        sortOrder: sortOrder != null ? parseInt(sortOrder, 10) : 0,
      },
      include: {
        company: { select: { id: true, name: true } },
      },
    });

    await createAuditLog({
      userId: req.user!.userId,
      entityType: 'service_route',
      entityId: route.id,
      action: 'create',
      changes: req.body,
      ipAddress: req.ip,
    });

    res.status(201).json(route);
  } catch (err) {
    next(err);
  }
});

// ============================================================
// PUT /:id — Update route metadata
// ============================================================

routesRouter.put('/:id', requirePermission('routes:manage'), async (req: Request, res: Response, next) => {
  try {
    const existing = await prisma.serviceRoute.findUnique({
      where: { id: req.params.id as string },
    });
    if (!existing) throw new AppError(404, 'Route not found');

    // Only allow updating safe fields
    const { name, routeNumber, area, description, estimatedMiles, cycleMonths, sortOrder, isActive } = req.body;
    const data: any = {};
    if (name !== undefined) data.name = name;
    if (routeNumber !== undefined) data.routeNumber = routeNumber || null;
    if (area !== undefined) data.area = area || null;
    if (description !== undefined) data.description = description || null;
    if (estimatedMiles !== undefined) data.estimatedMiles = estimatedMiles;
    if (cycleMonths !== undefined) data.cycleMonths = parseInt(cycleMonths, 10);
    if (sortOrder !== undefined) data.sortOrder = parseInt(sortOrder, 10);
    if (isActive !== undefined) data.isActive = isActive;

    const route = await prisma.serviceRoute.update({
      where: { id: req.params.id as string },
      data,
      include: {
        company: { select: { id: true, name: true } },
        _count: { select: { stops: { where: { isActive: true } } } },
      },
    });

    await createAuditLog({
      userId: req.user!.userId,
      entityType: 'service_route',
      entityId: route.id,
      action: 'update',
      changes: { before: existing, after: route },
      ipAddress: req.ip,
    });

    res.json(route);
  } catch (err) {
    next(err);
  }
});

// ============================================================
// DELETE /:id — Soft-delete a route (and its stops)
// ============================================================

routesRouter.delete('/:id', requirePermission('routes:manage'), async (req: Request, res: Response, next) => {
  try {
    const existing = await prisma.serviceRoute.findUnique({
      where: { id: req.params.id as string },
    });
    if (!existing) throw new AppError(404, 'Route not found');

    // Soft-delete route and all its stops
    await prisma.$transaction([
      prisma.routeStop.updateMany({
        where: { routeId: existing.id },
        data: { isActive: false },
      }),
      prisma.serviceRoute.update({
        where: { id: existing.id },
        data: { isActive: false },
      }),
    ]);

    await createAuditLog({
      userId: req.user!.userId,
      entityType: 'service_route',
      entityId: existing.id,
      action: 'delete',
      changes: { softDelete: true, routeName: existing.name },
      ipAddress: req.ip,
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// POST /:id/stops — Add a stop to a route
// ============================================================

routesRouter.post('/:id/stops', requirePermission('routes:manage'), async (req: Request, res: Response, next) => {
  try {
    const routeId = req.params.id as string;

    // Verify route exists
    const route = await prisma.serviceRoute.findUnique({ where: { id: routeId } });
    if (!route) throw new AppError(404, 'Route not found');

    const { padId, wellId, facilityId, clientName, notes, workOrderNumber, afeNumber, costCenter, salesTaxId, routeMileage, stopIndex } = req.body;

    if (!padId && !wellId && !facilityId) {
      throw new AppError(400, 'At least one of padId, wellId, or facilityId is required');
    }

    // A well IS a stop on its own — Well is first-class, and plenty of wells
    // have no pad at all. But when the well does sit on one, carry that padId
    // onto the stop: mileage, billing grouping and coverage all still key off
    // the pad, so a well stop that hides its pad would drop out of them.
    let resolvedPadId: string | null = padId || null;
    if (wellId) {
      const well = await prisma.well.findUnique({
        where: { id: wellId as string },
        select: { id: true, padId: true },
      });
      if (!well) throw new AppError(404, 'Well not found');
      if (!resolvedPadId && well.padId) resolvedPadId = well.padId;
    }

    // Auto-calculate stopIndex if not provided
    let idx = stopIndex;
    if (idx == null) {
      const maxStop = await prisma.routeStop.findFirst({
        where: { routeId },
        orderBy: { stopIndex: 'desc' },
        select: { stopIndex: true },
      });
      idx = (maxStop?.stopIndex ?? 0) + 1;
    }

    const stop = await prisma.routeStop.create({
      data: {
        routeId,
        padId: resolvedPadId,
        wellId: wellId || null,
        facilityId: facilityId || null,
        stopIndex: idx,
        clientName: clientName || null,
        notes: notes || null,
        workOrderNumber: workOrderNumber || null,
        afeNumber: afeNumber || null,
        costCenter: costCenter || null,
        salesTaxId: salesTaxId || null,
        routeMileage: routeMileage != null ? routeMileage : null,
      },
      include: {
        pad: {
          select: {
            id: true,
            name: true,
            fieldId: true,
            field: { select: { id: true, name: true } },
          },
        },
        well: {
          select: {
            id: true, wellName: true, apiNumber: true, padId: true, fieldId: true,
            field: { select: { id: true, name: true } },
            currentOperator: { select: { id: true, name: true } },
          },
        },
        facility: { select: { id: true, name: true } },
      },
    });

    await createAuditLog({
      userId: req.user!.userId,
      entityType: 'route_stop',
      entityId: stop.id,
      action: 'create',
      changes: req.body,
      ipAddress: req.ip,
    });

    res.status(201).json(stop);
  } catch (err) {
    next(err);
  }
});

// ============================================================
// PUT /:id/stops/:stopId — Update a stop
// ============================================================

routesRouter.put('/:id/stops/:stopId', requirePermission('routes:manage'), async (req: Request, res: Response, next) => {
  try {
    const existing = await prisma.routeStop.findUnique({
      where: { id: req.params.stopId as string },
    });
    if (!existing) throw new AppError(404, 'Stop not found');

    const { padId, wellId, facilityId, clientName, notes, workOrderNumber, afeNumber, costCenter, salesTaxId, routeMileage, stopIndex } = req.body;
    const data: any = {};
    if (padId !== undefined) data.padId = padId || null;
    if (wellId !== undefined) data.wellId = wellId || null;
    // Same pad inheritance as create: pointing a padless stop at a well that
    // lives on a pad picks the pad up, unless the caller set one explicitly.
    if (wellId && padId === undefined && !existing.padId) {
      const well = await prisma.well.findUnique({ where: { id: wellId as string }, select: { padId: true } });
      if (well?.padId) data.padId = well.padId;
    }
    if (facilityId !== undefined) data.facilityId = facilityId || null;
    if (clientName !== undefined) data.clientName = clientName || null;
    if (notes !== undefined) data.notes = notes || null;
    if (workOrderNumber !== undefined) data.workOrderNumber = workOrderNumber || null;
    if (afeNumber !== undefined) data.afeNumber = afeNumber || null;
    if (costCenter !== undefined) data.costCenter = costCenter || null;
    if (salesTaxId !== undefined) data.salesTaxId = salesTaxId || null;
    if (routeMileage !== undefined) data.routeMileage = routeMileage;
    if (stopIndex !== undefined) data.stopIndex = parseInt(stopIndex, 10);

    const stop = await prisma.routeStop.update({
      where: { id: req.params.stopId as string },
      data,
      include: {
        pad: {
          select: {
            id: true,
            name: true,
            fieldId: true,
            field: { select: { id: true, name: true } },
          },
        },
        well: {
          select: {
            id: true, wellName: true, apiNumber: true, padId: true, fieldId: true,
            field: { select: { id: true, name: true } },
            currentOperator: { select: { id: true, name: true } },
          },
        },
        facility: { select: { id: true, name: true } },
      },
    });

    await createAuditLog({
      userId: req.user!.userId,
      entityType: 'route_stop',
      entityId: stop.id,
      action: 'update',
      changes: { before: existing, after: stop },
      ipAddress: req.ip,
    });

    res.json(stop);
  } catch (err) {
    next(err);
  }
});

// ============================================================
// POST /:id/stops/reorder — Reset stopIndex for all stops based on new order
// ============================================================

routesRouter.post('/:id/stops/reorder', requirePermission('routes:manage'), async (req: Request, res: Response, next) => {
  try {
    const routeId = req.params.id as string;
    const { stopIds } = req.body as { stopIds: string[] };

    if (!Array.isArray(stopIds) || stopIds.length === 0) {
      throw new AppError(400, 'stopIds array is required');
    }

    const route = await prisma.serviceRoute.findUnique({ where: { id: routeId } });
    if (!route) throw new AppError(404, 'Route not found');

    // Verify every id belongs to this route and is active
    const existing = await prisma.routeStop.findMany({
      where: { routeId, isActive: true },
      select: { id: true },
    });
    const existingSet = new Set(existing.map(s => s.id));
    for (const id of stopIds) {
      if (!existingSet.has(id)) {
        throw new AppError(400, `Stop ${id} does not belong to this route`);
      }
    }

    // Two-pass update inside a transaction to dodge the (routeId, stopIndex) unique constraint.
    // Pass 1: move everyone to a negative offset. Pass 2: assign final 1..n indices.
    await prisma.$transaction([
      ...stopIds.map((id, i) =>
        prisma.routeStop.update({
          where: { id },
          data: { stopIndex: -(i + 1) },
        })
      ),
      ...stopIds.map((id, i) =>
        prisma.routeStop.update({
          where: { id },
          data: { stopIndex: i + 1 },
        })
      ),
    ]);

    await createAuditLog({
      userId: req.user!.userId,
      entityType: 'service_route',
      entityId: routeId,
      action: 'update',
      changes: { reorderedStops: stopIds },
      ipAddress: req.ip,
    });

    // Return the fresh stop list so the client can re-render without another round trip
    const stops = await prisma.routeStop.findMany({
      where: { routeId, isActive: true },
      orderBy: { stopIndex: 'asc' },
      include: {
        pad: {
          select: {
            id: true,
            name: true,
            fieldId: true,
            field: { select: { id: true, name: true } },
          },
        },
        well: {
          select: {
            id: true, wellName: true, apiNumber: true, padId: true, fieldId: true,
            field: { select: { id: true, name: true } },
            currentOperator: { select: { id: true, name: true } },
          },
        },
        facility: { select: { id: true, name: true } },
      },
    });

    res.json({ stops });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// DELETE /:id/stops/:stopId — Soft-delete a stop
// ============================================================

routesRouter.delete('/:id/stops/:stopId', requirePermission('routes:manage'), async (req: Request, res: Response, next) => {
  try {
    const existing = await prisma.routeStop.findUnique({
      where: { id: req.params.stopId as string },
    });
    if (!existing) throw new AppError(404, 'Stop not found');

    await prisma.routeStop.update({
      where: { id: req.params.stopId as string },
      data: { isActive: false },
    });

    await createAuditLog({
      userId: req.user!.userId,
      entityType: 'route_stop',
      entityId: existing.id,
      action: 'delete',
      changes: { softDelete: true },
      ipAddress: req.ip,
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// POST /:id/assign — Assign a tech to a route
// ============================================================

routesRouter.post('/:id/assign', requirePermission('routes:manage'), async (req: Request, res: Response, next) => {
  try {
    const routeId = req.params.id as string;
    const { userId, isPrimary } = req.body;

    if (!userId) throw new AppError(400, 'userId is required');

    // Verify route + user exist
    const [route, user] = await Promise.all([
      prisma.serviceRoute.findUnique({ where: { id: routeId } }),
      prisma.user.findUnique({ where: { id: userId }, select: { id: true, name: true, role: true } }),
    ]);
    if (!route) throw new AppError(404, 'Route not found');
    if (!user) throw new AppError(404, 'User not found');

    // If setting as primary, unset any existing primary
    if (isPrimary) {
      await prisma.routeAssignment.updateMany({
        where: { routeId, isPrimary: true },
        data: { isPrimary: false },
      });
    }

    const assignment = await prisma.routeAssignment.upsert({
      where: { routeId_userId: { routeId, userId } },
      create: { routeId, userId, isPrimary: isPrimary || false },
      update: { isPrimary: isPrimary || false },
      include: { user: { select: { id: true, name: true, role: true } } },
    });

    await createAuditLog({
      userId: req.user!.userId,
      entityType: 'route_assignment',
      entityId: assignment.id,
      action: 'create',
      changes: { routeId, userId, userName: user.name, isPrimary },
      ipAddress: req.ip,
    });

    res.status(201).json(assignment);
  } catch (err) {
    next(err);
  }
});

// ============================================================
// DELETE /:id/assign/:userId — Remove a tech from a route
// ============================================================

routesRouter.delete('/:id/assign/:userId', requirePermission('routes:manage'), async (req: Request, res: Response, next) => {
  try {
    const routeId = req.params.id as string;
    const userId = req.params.userId as string;

    const existing = await prisma.routeAssignment.findUnique({
      where: { routeId_userId: { routeId, userId } },
      include: { user: { select: { name: true } } },
    });
    if (!existing) throw new AppError(404, 'Assignment not found');

    await prisma.routeAssignment.delete({
      where: { routeId_userId: { routeId, userId } },
    });

    await createAuditLog({
      userId: req.user!.userId,
      entityType: 'route_assignment',
      entityId: existing.id,
      action: 'delete',
      changes: { routeId, userId, userName: existing.user.name },
      ipAddress: req.ip,
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});
