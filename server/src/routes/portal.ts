import { Router, Request, Response } from 'express';
import { prisma } from '../db.js';
import { AppError } from '../middleware/errorHandler.js';
import { requireRole } from '../middleware/rbac.js';
import { computeH2sAnalytics } from '../services/h2sAnalytics.js';
import type { TicketStatus, TicketType } from '../db.js';

// Customer-facing portal API. Every route here is read-only and hard-scoped
// to one Company. Customer accounts resolve that company from their own user
// record; platform admins may provide an explicit preview company id.
export const portalRouter = Router();

portalRouter.use(requireRole('customer', 'platform_admin'));

async function resolveCompanyId(req: Request): Promise<string> {
  const account = await prisma.user.findUnique({
    where: { id: req.user!.userId },
    select: { companyId: true, isActive: true, role: true },
  });
  if (!account || !account.isActive) {
    throw new AppError(401, 'Portal account is not active');
  }

  if (account.role === 'platform_admin') {
    const previewCompanyId = String(
      req.get('x-portal-preview-company-id') || req.query.previewCompanyId || '',
    ).trim();
    if (!previewCompanyId) {
      throw new AppError(400, 'Select a customer to preview the portal');
    }
    const company = await prisma.company.findUnique({
      where: { id: previewCompanyId },
      select: { id: true, isActive: true },
    });
    if (!company || !company.isActive) {
      throw new AppError(404, 'Preview customer not found');
    }
    return company.id;
  }

  if (account.role !== 'customer') {
    throw new AppError(403, 'This account cannot access the customer portal');
  }
  if (!account.companyId) {
    throw new AppError(403, 'Portal account is not linked to a company');
  }
  return account.companyId;
}

const VISIBLE_STATUSES: TicketStatus[] = [
  'dispatched', 'in_progress', 'completed', 'supervisor_review',
  'awaiting_signature', 'billing_queue', 'invoiced', 'closed',
];

const ACTIVE_TICKET_STATUSES: TicketStatus[] = ['dispatched', 'in_progress'];

const TICKET_TYPES: TicketType[] = [
  'field_service', 'sale', 'rental', 'repair', 'inspection', 'training',
];

function intParam(value: unknown, fallback: number, max: number): number {
  const parsed = parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(parsed, max);
}

function ticketWhere(companyId: string, query: Request['query'], options: { testingOnly?: boolean } = {}) {
  const { status, type, search, dateFrom, dateTo } = query;
  const where: any = { companyId };

  if (status && VISIBLE_STATUSES.includes(status as TicketStatus)) {
    where.status = status as TicketStatus;
  } else {
    where.status = { in: VISIBLE_STATUSES };
  }

  if (type && TICKET_TYPES.includes(type as TicketType)) {
    where.ticketType = type as TicketType;
  }

  if (dateFrom || dateTo) {
    where.serviceDate = {};
    if (dateFrom) where.serviceDate.gte = new Date(dateFrom as string);
    if (dateTo) where.serviceDate.lte = new Date(dateTo as string);
  }

  if (search) {
    const q = String(search).trim();
    if (q) {
      where.OR = [
        { ticketNumber: { contains: q, mode: 'insensitive' } },
        { locationDisplay: { contains: q, mode: 'insensitive' } },
        { field: { name: { contains: q, mode: 'insensitive' } } },
        { pad: { name: { contains: q, mode: 'insensitive' } } },
        { well: { wellName: { contains: q, mode: 'insensitive' } } },
      ];
    }
  }

  if (options.testingOnly) {
    const testingOr = [
      { ihTestRecords: { some: {} } },
      { serviceSubtype: { in: ['ih_h2s', 'ih_o2_voc', 'ih_sampling'] } },
      { customData: { path: ['gasReadings'], not: null } },
    ];
    where.AND = [...(where.AND ?? []), { OR: testingOr }];
  }

  return where;
}

function locationText(t: any): string {
  return t.locationDisplay || [t.field?.name, t.pad?.name, t.well?.wellName].filter(Boolean).join(' > ') || 'Location not specified';
}

function dateOnly(value: Date | string | null | undefined): string {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

function csvCell(value: unknown): string {
  const raw = value == null ? '' : String(value);
  if (/[",\r\n]/.test(raw)) return `"${raw.replace(/"/g, '""')}"`;
  return raw;
}

function csv(rows: Record<string, unknown>[]): string {
  const headers = [
    'serviceDate', 'ticketNumber', 'ticketType', 'serviceSubtype', 'location',
    'testType', 'point', 'value', 'unit', 'result', 'instrumentModel',
    'instrumentSerial', 'notes',
  ];
  return [
    headers.join(','),
    ...rows.map(row => headers.map(h => csvCell(row[h])).join(',')),
  ].join('\n');
}

function pushIhRows(rows: Record<string, unknown>[], ticket: any) {
  for (const rec of ticket.ihTestRecords ?? []) {
    const base = {
      serviceDate: dateOnly(ticket.serviceDate),
      ticketNumber: ticket.ticketNumber,
      ticketType: ticket.ticketType,
      serviceSubtype: ticket.serviceSubtype ?? '',
      location: rec.locationPoint || locationText(ticket),
      testType: rec.testType,
      instrumentModel: rec.instrumentModel || rec.testData?.instrumentModel || '',
      instrumentSerial: rec.instrumentSerial || rec.testData?.instrumentSerial || '',
      notes: rec.notes || '',
    };

    if (rec.testType === 'ih_h2s') {
      for (const [i, reading] of ((rec.testData as any)?.readings ?? []).entries()) {
        rows.push({
          ...base,
          point: reading.locationPoint || `Point ${i + 1}`,
          value: reading.ppmReading ?? '',
          unit: 'ppm',
          result: reading.result ?? '',
        });
      }
    } else if (rec.testType === 'ih_o2_voc') {
      for (const [i, point] of ((rec.testData as any)?.samplePoints ?? []).entries()) {
        if (point.o2Percent != null) {
          rows.push({ ...base, point: point.pointName || `Point ${i + 1}`, value: point.o2Percent, unit: '% O2', result: '', notes: point.notes || rec.notes || '' });
        }
        if (point.vocPpm != null) {
          rows.push({ ...base, point: point.pointName || `Point ${i + 1}`, value: point.vocPpm, unit: 'ppm VOC', result: '', notes: point.notes || rec.notes || '' });
        }
      }
    } else if (rec.testType === 'ih_sampling') {
      for (const [i, sample] of ((rec.testData as any)?.samples ?? []).entries()) {
        rows.push({
          ...base,
          point: sample.collectionPoint || `Sample ${i + 1}`,
          value: sample.labId || sample.sampleType || '',
          unit: 'sample',
          result: sample.sampleType || '',
          notes: sample.notes || rec.notes || '',
        });
      }
    }
  }
}

function pushLegacyGasRows(rows: Record<string, unknown>[], ticket: any) {
  const gasReadings = (ticket.customData as any)?.gasReadings;
  if (!Array.isArray(gasReadings)) return;
  for (const reading of gasReadings) {
    rows.push({
      serviceDate: dateOnly(ticket.serviceDate),
      ticketNumber: ticket.ticketNumber,
      ticketType: ticket.ticketType,
      serviceSubtype: ticket.serviceSubtype ?? '',
      location: locationText(ticket),
      testType: reading.type ?? 'gas',
      point: reading.context ?? 'general',
      value: reading.value ?? '',
      unit: reading.unit ?? '',
      result: reading.readingType ?? '',
      instrumentModel: '',
      instrumentSerial: '',
      notes: '',
    });
  }
}

async function testingRows(companyId: string, query: Request['query']): Promise<Record<string, unknown>[]> {
  const tickets = await prisma.serviceTicket.findMany({
    where: ticketWhere(companyId, query, { testingOnly: true }),
    select: {
      id: true,
      ticketNumber: true,
      ticketType: true,
      serviceSubtype: true,
      serviceDate: true,
      locationDisplay: true,
      customData: true,
      field: { select: { name: true } },
      pad: { select: { name: true } },
      well: { select: { wellName: true } },
      ihTestRecords: {
        select: {
          testType: true,
          locationPoint: true,
          instrumentModel: true,
          instrumentSerial: true,
          testData: true,
          notes: true,
        },
      },
    },
    orderBy: [{ serviceDate: 'desc' }, { createdAt: 'desc' }],
    take: 1000,
  });

  const rows: Record<string, unknown>[] = [];
  for (const ticket of tickets) {
    pushIhRows(rows, ticket);
    pushLegacyGasRows(rows, ticket);
  }
  return rows;
}

// GET /api/portal/me — identity for the portal header
portalRouter.get('/me', async (req: Request, res: Response, next) => {
  try {
    const companyId = await resolveCompanyId(req);
    const [account, company] = await Promise.all([
      prisma.user.findUnique({
        where: { id: req.user!.userId },
        select: { id: true, name: true, email: true },
      }),
      prisma.company.findUnique({
        where: { id: companyId },
        select: { id: true, name: true },
      }),
    ]);
    res.json({ user: account, company });
  } catch (err) {
    next(err);
  }
});

// GET /api/portal/summary — action-first customer portal home
portalRouter.get('/summary', async (req: Request, res: Response, next) => {
  try {
    const companyId = await resolveCompanyId(req);
    const [
      company,
      serviceTicketCount,
      testingTicketCount,
      activeTickets,
      shopActions,
      activeRentalCount,
      activeRentals,
    ] = await Promise.all([
      prisma.company.findUnique({ where: { id: companyId }, select: { id: true, name: true } }),
      prisma.serviceTicket.count({ where: { companyId, status: { in: VISIBLE_STATUSES } } }),
      prisma.serviceTicket.count({ where: ticketWhere(companyId, { } as any, { testingOnly: true }) }),
      prisma.serviceTicket.findMany({
        where: { companyId, status: { in: ACTIVE_TICKET_STATUSES } },
        select: {
          id: true, ticketNumber: true, ticketType: true, serviceSubtype: true, status: true,
          serviceDate: true, locationDisplay: true,
          field: { select: { name: true } },
          pad: { select: { name: true } },
          well: { select: { wellName: true } },
        },
        orderBy: [{ serviceDate: 'asc' }, { createdAt: 'desc' }],
        take: 4,
      }),
      prisma.shopWorkOrder.findMany({
        where: {
          companyId,
          isInternal: false,
          OR: [
            { items: { some: { status: 'awaiting_approval' } } },
            { status: 'complete' },
          ],
        },
        select: {
          id: true, workOrderNumber: true, status: true, intakeDate: true, promisedDate: true,
          totalItems: true, completedItems: true, updatedAt: true,
          intakeSite: { select: { name: true } },
          _count: { select: { items: true } },
          items: {
            select: { status: true, quoteSentAt: true },
            take: 8,
          },
        },
        orderBy: { updatedAt: 'desc' },
        take: 4,
      }),
      prisma.rentalAgreement.count({ where: { companyId, status: { in: ['scheduled', 'active'] } } }),
      prisma.rentalAgreement.findMany({
        where: { companyId, status: { in: ['scheduled', 'active'] } },
        select: {
          id: true, agreementNumber: true, status: true, startDate: true, endDate: true,
          field: { select: { name: true } },
          pad: { select: { name: true } },
          well: { select: { wellName: true } },
          _count: { select: { items: true, dailyLogs: true } },
        },
        orderBy: { updatedAt: 'desc' },
        take: 3,
      }),
    ]);

    const actions = [
      ...shopActions.map(wo => ({
        id: `shop:${wo.id}`,
        kind: wo.items.some(i => i.status === 'awaiting_approval') ? 'shop_approval' : 'shop_ready',
        title: wo.items.some(i => i.status === 'awaiting_approval') ? 'Shop quote awaiting approval' : 'Shop work ready for pickup',
        subject: wo.workOrderNumber,
        detail: `${wo._count.items} item${wo._count.items === 1 ? '' : 's'} / ${wo.intakeSite?.name ?? 'Shop'}`,
        href: `/portal/shop?workOrder=${wo.id}`,
        tone: wo.items.some(i => i.status === 'awaiting_approval') ? 'danger' : 'warning',
      })),
    ];

    res.json({
      company,
      stats: {
        activeWork: activeTickets.length + activeRentalCount + shopActions.length,
        actions: actions.length,
        serviceTickets: serviceTicketCount,
        testingTickets: testingTicketCount,
      },
      actions,
      activeWork: [
        ...activeTickets.map(t => ({
          id: `ticket:${t.id}`,
          kind: 'ticket',
          title: t.ticketNumber,
          status: t.status,
          detail: `${t.serviceSubtype ?? t.ticketType} / ${locationText(t)}`,
          date: dateOnly(t.serviceDate),
          href: `/portal/tickets/${t.id}`,
        })),
        ...activeRentals.map((r: any) => ({
          id: `rental:${r.id}`,
          kind: 'rental',
          title: r.agreementNumber,
          status: r.status,
          detail: `${[r.field?.name, r.pad?.name, r.well?.wellName].filter(Boolean).join(' > ') || 'Rental'} / ${r._count.items} item${r._count.items === 1 ? '' : 's'}`,
          date: dateOnly(r.startDate),
          href: '/portal/rentals',
        })),
      ].slice(0, 8),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/portal/tickets — this company's service history
portalRouter.get('/tickets', async (req: Request, res: Response, next) => {
  try {
    const companyId = await resolveCompanyId(req);
    const take = intParam(req.query.limit, 50, 100);
    const skip = intParam(req.query.offset, 0, 100000);
    const where = ticketWhere(companyId, req.query, { testingOnly: req.query.testing === 'true' });

    const [tickets, total] = await Promise.all([
      prisma.serviceTicket.findMany({
        where,
        select: {
          id: true,
          ticketNumber: true,
          ticketType: true,
          serviceSubtype: true,
          status: true,
          serviceDate: true,
          serviceDateTo: true,
          locationDisplay: true,
          poNumber: true,
          afeNumber: true,
          completedAt: true,
          createdAt: true,
          field: { select: { name: true } },
          pad: { select: { name: true } },
          well: { select: { wellName: true } },
          assignedTech: { select: { name: true } },
          _count: { select: { lineItems: true, ihTestRecords: true, gasDetectionRecords: true, airSystemInspections: true } },
        },
        orderBy: [{ serviceDate: 'desc' }, { createdAt: 'desc' }],
        take,
        skip,
      }),
      prisma.serviceTicket.count({ where }),
    ]);

    res.json({ data: tickets, total });
  } catch (err) {
    next(err);
  }
});

// GET /api/portal/testing-results — JSON rows for preview/export
portalRouter.get('/testing-results', async (req: Request, res: Response, next) => {
  try {
    const companyId = await resolveCompanyId(req);
    res.json({ data: await testingRows(companyId, req.query) });
  } catch (err) {
    next(err);
  }
});

// GET /api/portal/testing-results.csv — filtered CSV download
portalRouter.get('/testing-results.csv', async (req: Request, res: Response, next) => {
  try {
    const companyId = await resolveCompanyId(req);
    const rows = await testingRows(companyId, req.query);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="servicepro-testing-results-${dateOnly(new Date())}.csv"`);
    res.send(csv(rows));
  } catch (err) {
    next(err);
  }
});

// GET /api/portal/shop-orders — customer-visible shop work and approvals
portalRouter.get('/shop-orders', async (req: Request, res: Response, next) => {
  try {
    const companyId = await resolveCompanyId(req);
    const status = String(req.query.status ?? 'open');
    const where: any = { companyId, isInternal: false };
    if (status !== 'all') {
      where.status = status === 'closed' ? 'closed' : { not: 'closed' };
    }

    const orders = await prisma.shopWorkOrder.findMany({
      where,
      select: {
        id: true,
        workOrderNumber: true,
        status: true,
        intakeDate: true,
        promisedDate: true,
        completedDate: true,
        returnedDate: true,
        dropOffContactName: true,
        pickupContactName: true,
        pickupContactPhone: true,
        pickupContactEmail: true,
        totalItems: true,
        completedItems: true,
        intakeSite: { select: { name: true } },
        sourceLocation: { select: { name: true } },
        returnLocation: { select: { name: true } },
        items: {
          select: {
            id: true,
            itemNumber: true,
            serialNumber: true,
            equipmentDescription: true,
            equipmentCategory: true,
            serviceType: true,
            status: true,
            reportedIssue: true,
            diagnosisNotes: true,
            quoteSentAt: true,
            quoteApprovedAt: true,
            quoteDeclinedAt: true,
            workCompletedAt: true,
          },
          orderBy: { itemNumber: 'asc' },
        },
      },
      orderBy: { updatedAt: 'desc' },
      take: 100,
    });

    res.json({ data: orders });
  } catch (err) {
    next(err);
  }
});

// GET /api/portal/rentals — active/scheduled rental visibility, no rates
portalRouter.get('/rentals', async (req: Request, res: Response, next) => {
  try {
    const companyId = await resolveCompanyId(req);
    const status = String(req.query.status ?? 'active');
    const where: any = { companyId };
    if (status !== 'all') where.status = status === 'completed' ? 'completed' : { in: ['scheduled', 'active'] };

    const rentals = await prisma.rentalAgreement.findMany({
      where,
      select: {
        id: true,
        agreementNumber: true,
        status: true,
        pickupType: true,
        startDate: true,
        endDate: true,
        poNumber: true,
        afeNumber: true,
        siteContactName: true,
        siteContactPhone: true,
        personCallingName: true,
        field: { select: { name: true } },
        pad: { select: { name: true } },
        well: { select: { wellName: true } },
        items: {
          select: {
            id: true,
            status: true,
            deployedDate: true,
            returnedDate: true,
            product: { select: { name: true, category: true } },
            serializedEquipment: { select: { serialNumber: true } },
          },
          orderBy: { deployedDate: 'asc' },
        },
        dailyLogs: {
          select: { logDate: true, equipmentPresent: true, equipmentStatus: true, notes: true },
          orderBy: { logDate: 'desc' },
          take: 5,
        },
      },
      orderBy: { updatedAt: 'desc' },
      take: 100,
    });

    res.json({ data: rentals });
  } catch (err) {
    next(err);
  }
});

// GET /api/portal/tickets/:id — one ticket, scoped to the company
portalRouter.get('/tickets/:id', async (req: Request, res: Response, next) => {
  try {
    const companyId = await resolveCompanyId(req);

    const ticket = await prisma.serviceTicket.findFirst({
      where: { id: String(req.params.id), companyId, status: { in: VISIBLE_STATUSES } },
      select: {
        id: true,
        ticketNumber: true,
        ticketType: true,
        serviceSubtype: true,
        status: true,
        serviceDate: true,
        serviceDateTo: true,
        arrivalTime: true,
        departureTime: true,
        locationDisplay: true,
        workDescription: true,
        poNumber: true,
        afeNumber: true,
        customerRepName: true,
        completedAt: true,
        createdAt: true,
        company: { select: { id: true, name: true } },
        field: { select: { name: true } },
        pad: { select: { name: true } },
        well: { select: { wellName: true } },
        assignedTech: { select: { name: true } },
        ihTestRecords: {
          select: {
            id: true,
            testType: true,
            locationPoint: true,
            instrumentModel: true,
            instrumentSerial: true,
            testData: true,
            notes: true,
            testedAt: true,
          },
        },
        lineItems: {
          select: {
            id: true,
            lineNumber: true,
            lineType: true,
            description: true,
            quantity: true,
            unitOfMeasure: true,
          },
          orderBy: { lineNumber: 'asc' },
        },
      },
    });

    if (!ticket) throw new AppError(404, 'Ticket not found');
    res.json(ticket);
  } catch (err) {
    next(err);
  }
});

// GET /api/portal/h2s — customer-visible H2S test history.
portalRouter.get('/h2s', async (req: Request, res: Response, next) => {
  try {
    const companyId = await resolveCompanyId(req);
    const { dateFrom, dateTo } = req.query;
    for (const value of [dateFrom, dateTo]) {
      if (value === undefined) continue;
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)
        || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) {
        throw new AppError(400, 'Use a valid date in YYYY-MM-DD format');
      }
    }
    if (dateFrom && dateTo && String(dateFrom) > String(dateTo)) {
      throw new AppError(400, 'The end date must be on or after the start date');
    }
    res.json(await computeH2sAnalytics(companyId, {
      visibleStatuses: VISIBLE_STATUSES,
      dateFrom: dateFrom ? String(dateFrom) : undefined,
      dateTo: dateTo ? String(dateTo) : undefined,
    }));
  } catch (err) {
    next(err);
  }
});
