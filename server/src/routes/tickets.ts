import { Router, Request, Response } from 'express';
import { prisma } from '../index.js';
import { AppError } from '../middleware/errorHandler.js';
import { requirePermission } from '../middleware/rbac.js';
import { createAuditLog } from '../utils/auditLog.js';
import { assertCompanyActive, assertCompanyNotOnCreditHold } from '../utils/companyGuards.js';
import { generateTicketNumber } from '../utils/ticketNumber.js';
import { enrichCustomData } from '../utils/notesExtraction.js';
import { computeBillingGroupKey } from '../utils/billingGroupKey.js';
import { flatOverridesFromPayload } from '../services/billingRefs.js';
import { setBillingReadiness } from '../services/billingReadiness.js';
import { selectBillingProfile } from '../services/billingProfileSelector.js';
import { defaultDivisionForWork } from '../utils/qbClass.js';
import { needsRental, DEPLOYED_PREBILLING_STATUSES, isBillingWardStatus } from '../services/deploymentGate.js';
import { shouldRecordOnly, recordTicketAsRentalLog } from '../services/rentalTicketRecord.js';
import { randomUUID } from 'crypto';
import { canTransition, getAvailableTransitions } from '../services/ticketStateMachine.js';
import { runAndCacheReviewSignal, ENGINE_VERSION } from '../services/ticketReviewRules.js';
import { emitEvent } from '../services/eventBus.js';
import { generateTicketPdf } from '../services/ticketPdfGenerator.js';
import { generateOccHealthPdf } from '../services/occHealthPdfGenerator.js';
import { buildLocationDisplay } from '../utils/locationDisplay.js';
import { pdfToBuffer } from '../utils/pdfToBuffer.js';
import { getFileStore, ticketKey } from '../services/fileStore.js';
import type { TicketStatus, UserRole } from '../db.js';

export const ticketsRouter = Router();

function siteCustomerMismatchBlocksApproval(customData: unknown): boolean {
  const cd = (customData as Record<string, any> | null) || {};
  const mismatch = cd.customerLocationMismatch as Record<string, any> | undefined;
  if (!mismatch) return false;
  if (mismatch.status === 'pending') return true;
  if (mismatch.status === 'left' && !String(mismatch.reason || '').trim()) return true;
  return false;
}

// GET /api/tickets — list with filters
ticketsRouter.get('/', async (req: Request, res: Response, next) => {
  try {
    const { status, type, companyId, techId, fieldId, dateFrom, dateTo, search, excludeVoid, limit = '50', offset = '0' } = req.query;
    const where: any = {};

    // Role-based visibility
    const role = req.user!.role as UserRole;
    if (role === 'field_tech') {
      where.assignedTechId = req.user!.userId;
    }
    // dispatch, field_super, billing_ar, boss, platform_admin see all

    if (status) {
      where.status = status as string;
    } else if (excludeVoid === 'true') {
      // Date-scoped "active work" views (Today/This Week) don't want dead
      // tickets cluttering counts/pagination — All Tickets keeps them.
      where.status = { not: 'void' };
    }
    if (type) where.ticketType = type as string;
    if (companyId) where.companyId = companyId as string;
    if (techId) where.assignedTechId = techId as string;
    if (fieldId) where.fieldId = fieldId as string;
    if (dateFrom || dateTo) {
      where.serviceDate = {};
      if (dateFrom) where.serviceDate.gte = new Date(dateFrom as string);
      if (dateTo) {
        // dateTo is a date-only string (e.g. "2026-07-15") — parsing it alone
        // truncates to UTC midnight, which excludes same-day tickets with a
        // later timestamp. Bump to the start of the next day and use `lt`.
        const dateToExclusive = new Date(dateTo as string);
        dateToExclusive.setDate(dateToExclusive.getDate() + 1);
        where.serviceDate.lt = dateToExclusive;
      }
    }

    // Free-text search: match ticket number, location, company name,
    // assigned technician, or the user who created the ticket.
    if (search) {
      const q = String(search).trim();
      where.OR = [
        { ticketNumber: { contains: q, mode: 'insensitive' } },
        { locationDisplay: { contains: q, mode: 'insensitive' } },
        { company: { name: { contains: q, mode: 'insensitive' } } },
        { assignedTech: { name: { contains: q, mode: 'insensitive' } } },
        { createdBy: { name: { contains: q, mode: 'insensitive' } } },
      ];
    }

    const [tickets, total] = await Promise.all([
      prisma.serviceTicket.findMany({
        where,
        include: {
          company: {
            select: {
              id: true, name: true,
              billingProfiles: {
                where: { enverusEnabled: true, isActive: true },
                select: { id: true, enverusEnabled: true, buyerDuns: true, enverusReceiptMode: true },
                take: 1,
              },
            },
          },
          field: { select: { id: true, name: true } },
          pad: { select: { id: true, name: true } },
          well: { select: { id: true, wellName: true } },
          assignedTech: { select: { id: true, name: true } },
          billingProfile: { select: { id: true, enverusEnabled: true, buyerDuns: true, enverusReceiptMode: true } },
          _count: { select: { lineItems: true, attachments: true } },
        },
        orderBy: [{ serviceDate: 'desc' }, { createdAt: 'desc' }],
        take: parseInt(limit as string, 10),
        skip: parseInt(offset as string, 10),
      }),
      prisma.serviceTicket.count({ where }),
    ]);

    // Merge: if ticket has no direct billingProfile, fall back to company's active profile
    const enriched = tickets.map(t => {
      const { company, ...rest } = t as any;
      const companyProfiles = company?.billingProfiles || [];
      const { billingProfiles: _, ...companyClean } = company || {};
      return {
        ...rest,
        company: companyClean,
        billingProfile: rest.billingProfile || companyProfiles[0] || null,
      };
    });

    res.json({ data: enriched, total });
  } catch (err) {
    next(err);
  }
});

// GET /api/tickets/assigned-to-me — active tickets currently assigned to the
// caller, regardless of role. Used by /my-jobs (Field tab).
ticketsRouter.get('/assigned-to-me', async (req: Request, res: Response, next) => {
  try {
    const tickets = await prisma.serviceTicket.findMany({
      where: {
        assignedTechId: req.user!.userId,
        // #5: include the tech's own saved drafts so they surface on My Jobs.
        status: { in: ['draft', 'dispatched', 'in_progress'] },
      },
      include: {
        company: { select: { id: true, name: true } },
        pad: { select: { id: true, name: true } },
        well: { select: { id: true, wellName: true } },
        _count: { select: { lineItems: true } },
      },
      orderBy: [{ serviceDate: 'asc' }, { createdAt: 'asc' }],
    });

    res.json({ data: tickets });
  } catch (err) {
    next(err);
  }
});

// GET /api/tickets/my-recent — tech's tickets for the last 7 days + any active ones
// (legacy alias: /my-today still works)
ticketsRouter.get(['/my-today', '/my-recent'], async (req: Request, res: Response, next) => {
  try {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    sevenDaysAgo.setHours(0, 0, 0, 0);

    // Techs see only their own tickets; admins/dispatch/billing see all
    const techOnlyRoles = ['field_tech'];
    const isTechOnly = techOnlyRoles.includes(req.user!.role);

    const tickets = await prisma.serviceTicket.findMany({
      where: {
        ...(isTechOnly ? { assignedTechId: req.user!.userId } : {}),
        status: { not: 'void' }, // voided tickets are dead — keep them out of active views
        OR: [
          // Any ticket from the last 7 days
          { serviceDate: { gte: sevenDaysAgo } },
          // Any still-active ticket regardless of age
          { status: { in: ['draft', 'dispatched', 'in_progress'] } },
        ],
      },
      include: {
        company: { select: { id: true, name: true } },
        pad: { select: { id: true, name: true } },
        well: { select: { id: true, wellName: true } },
        _count: { select: { lineItems: true } },
      },
      orderBy: [{ serviceDate: 'desc' }, { createdAt: 'desc' }],
    });

    res.json(tickets);
  } catch (err) {
    next(err);
  }
});

// GET /api/tickets/training/pending-cards — dashboard widget: training records awaiting official card issuance
ticketsRouter.get('/training/pending-cards', async (req: Request, res: Response, next) => {
  try {
    const records = await prisma.trainingRosterRecord.findMany({
      where: {
        cardIssuedOnSite: false,
        cardIssuedOfficial: false,
      },
      include: {
        ticket: {
          select: {
            id: true,
            ticketNumber: true,
            serviceDate: true,
            customData: true,
          },
        },
      },
      orderBy: { trainedAt: 'asc' },
    });

    // Group by ticket
    const grouped = new Map<string, {
      ticketId: string;
      ticketNumber: string | null;
      courseName: string;
      serviceDate: string;
      pendingCount: number;
      trainees: Array<{
        id: string;
        employeeName: string;
        employerName: string | null;
        contactEmail: string | null;
      }>;
    }>();

    for (const rec of records) {
      if (!grouped.has(rec.ticketId)) {
        const cd = rec.ticket.customData as any;
        grouped.set(rec.ticketId, {
          ticketId: rec.ticketId,
          ticketNumber: rec.ticket.ticketNumber,
          courseName: cd?.courseName === 'Other'
            ? (cd?.courseOther || 'Other')
            : (cd?.courseName || rec.courseName),
          serviceDate: rec.ticket.serviceDate.toISOString(),
          pendingCount: 0,
          trainees: [],
        });
      }
      const group = grouped.get(rec.ticketId)!;
      group.pendingCount++;
      group.trainees.push({
        id: rec.id,
        employeeName: rec.employeeName,
        employerName: rec.employerName,
        contactEmail: rec.contactEmail,
      });
    }

    res.json({
      data: Array.from(grouped.values()),
      totalPending: records.length,
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/tickets/training/roster/:id/card-issued — mark official card as issued
ticketsRouter.patch('/training/roster/:id/card-issued', async (req: Request, res: Response, next) => {
  try {
    const { cardNumber, cardExpiryDate } = req.body;
    const record = await prisma.trainingRosterRecord.update({
      where: { id: req.params.id as string },
      data: {
        cardIssuedOfficial: true,
        cardNumber: cardNumber || undefined,
        cardExpiryDate: cardExpiryDate ? new Date(cardExpiryDate) : undefined,
      },
    });
    res.json(record);
  } catch (err) {
    next(err);
  }
});

// GET /api/tickets/dispatch-queue — tickets for the dispatch board
ticketsRouter.get('/dispatch-queue', requirePermission('dispatch:manage'), async (req: Request, res: Response, next) => {
  try {
    const section = (req.query.section as string) || 'queue';
    const search = req.query.search as string | undefined;

    const include = {
      company: { select: { id: true, name: true } },
      field: { select: { id: true, name: true } },
      pad: { select: { id: true, name: true } },
      well: { select: { id: true, wellName: true } },
      assignedTech: { select: { id: true, name: true } },
      dispatchedBy: { select: { id: true, name: true } },
      createdBy: { select: { id: true, name: true } },
      _count: { select: { lineItems: true } },
    };

    const searchFilter = search ? {
      OR: [
        { ticketNumber: { contains: search, mode: 'insensitive' as const } },
        { locationDisplay: { contains: search, mode: 'insensitive' as const } },
        { company: { name: { contains: search, mode: 'insensitive' as const } } },
        { assignedTech: { name: { contains: search, mode: 'insensitive' as const } } },
        { createdBy: { name: { contains: search, mode: 'insensitive' as const } } },
      ],
    } : {};

    // The queue shows draft tickets PLUS any non-terminal ticket flagged
    // needsLocation (detached when its location request was rejected) so they
    // surface for re-location regardless of their current status.
    const queueWhere = {
      AND: [
        { OR: [
          { status: 'draft' as const },
          { customData: { path: ['needsLocation'], equals: true } },
        ] },
        searchFilter,
      ],
    };

    if (section === 'queue') {
      const tickets = await prisma.serviceTicket.findMany({
        where: queueWhere,
        include,
        orderBy: [{ serviceDate: 'asc' }, { createdAt: 'asc' }],
      });
      res.json({ data: tickets, section: 'queue' });
    } else if (section === 'dispatched') {
      const tickets = await prisma.serviceTicket.findMany({
        where: { status: 'dispatched', ...searchFilter },
        include,
        orderBy: [{ serviceDate: 'asc' }, { dispatchedAt: 'desc' }],
      });
      res.json({ data: tickets, section: 'dispatched' });
    } else {
      // all — both sections
      const [queue, dispatched] = await Promise.all([
        prisma.serviceTicket.findMany({
          where: queueWhere,
          include,
          orderBy: [{ serviceDate: 'asc' }, { createdAt: 'asc' }],
        }),
        prisma.serviceTicket.findMany({
          where: { status: 'dispatched', ...searchFilter },
          include,
          orderBy: [{ serviceDate: 'asc' }, { dispatchedAt: 'desc' }],
        }),
      ]);
      res.json({
        queue: { data: queue, count: queue.length },
        dispatched: { data: dispatched, count: dispatched.length },
      });
    }
  } catch (err) {
    next(err);
  }
});

// GET /api/tickets/review-queue — feed for the Approvals dashboard
// Returns tickets in supervisor_review with cached review signal +
// summary counts by verdict for the top-of-page cards.
// Query params: tech?, companyId?, verdict? (green/yellow/red), from?, to?
// NOTE: must be registered BEFORE any `/:id` route or Express will match it
// as an ID wildcard.
ticketsRouter.get('/review-queue', async (req: Request, res: Response, next) => {
  try {
    const role = req.user!.role as UserRole;
    const canReview =
      role === 'field_super' || role === 'billing_ar' || role === 'boss' || role === 'platform_admin';
    if (!canReview) throw new AppError(403, 'Insufficient permissions to view review queue');

    const { tech, companyId, verdict, from, to } = req.query;

    const where: any = { status: 'supervisor_review' };
    if (tech) where.assignedTechId = tech as string;
    if (companyId) where.companyId = companyId as string;
    if (from || to) {
      where.serviceDate = {};
      if (from) where.serviceDate.gte = new Date(from as string);
      if (to) where.serviceDate.lte = new Date(to as string);
    }

    const tickets = await prisma.serviceTicket.findMany({
      where,
      include: {
        company: { select: { id: true, name: true } },
        field: { select: { id: true, name: true } },
        pad: { select: { id: true, name: true } },
        well: { select: { id: true, wellName: true } },
        assignedTech: { select: { id: true, name: true } },
        createdBy: { select: { id: true, name: true } },
        _count: { select: { lineItems: true, attachments: true } },
        // Flagged lines only (the MISC/override keyword sniff that drives
        // the misc_line_items review rule) — surfaced inline in the
        // Approvals UI so supervisors can spot-check description + amount
        // without opening each ticket. Most tickets return zero rows, so
        // payload stays small.
        lineItems: {
          where: {
            OR: [
              { description: { contains: 'misc', mode: 'insensitive' } },
              { description: { contains: 'override', mode: 'insensitive' } },
              { description: { startsWith: 'custom', mode: 'insensitive' } },
            ],
          },
          select: {
            id: true,
            description: true,
            lineType: true,
            quantity: true,
            rate: true,
            total: true,
            notes: true,
          },
          orderBy: { sortOrder: 'asc' },
        },
      },
      orderBy: [{ serviceDate: 'desc' }, { updatedAt: 'desc' }],
      take: 500,
    });

    // Score any unscored tickets OR tickets with stale signals (older
    // engine version) on the fly. Catches pre-existing tickets that landed
    // in supervisor_review before the rules engine was deployed, and
    // refreshes cached verdicts after rule logic changes.
    const stale = tickets.filter(t => {
      const sig = t.reviewSignal as { engineVersion?: number } | null;
      return !sig || (sig.engineVersion ?? 0) < ENGINE_VERSION;
    });
    if (stale.length > 0) {
      await Promise.allSettled(
        stale.map(async t => {
          try {
            const signal = await runAndCacheReviewSignal(t.id);
            // Patch the in-memory ticket so the response includes the fresh signal
            (t as any).reviewSignal = signal;
            (t as any).reviewSignalRanAt = new Date(signal.ranAt);
          } catch (err) {
            console.error(`[review-queue] Failed to score ${t.ticketNumber}:`, err);
          }
        }),
      );
    }

    // Rename lineItems → flaggedLines on the way out so the client
    // doesn't think it's the full line-item list (it's only MISC/override
    // lines per the include filter above).
    const enriched = tickets.map(t => {
      const { lineItems, ...rest } = t;
      return { ...rest, flaggedLines: lineItems };
    });

    // In-memory verdict filter (avoids a cross-db jsonb index)
    const filtered = verdict
      ? enriched.filter(t => {
          const sig = t.reviewSignal as { verdict?: string } | null;
          return sig?.verdict === verdict;
        })
      : enriched;

    // Summary counts computed from the UNFILTERED result so the header
    // totals stay stable while the supervisor toggles verdict filters.
    const summary = { green: 0, yellow: 0, red: 0, unscored: 0, totalAmount: 0 };
    for (const t of tickets) {
      const sig = t.reviewSignal as { verdict?: string } | null;
      if (sig?.verdict === 'green') summary.green++;
      else if (sig?.verdict === 'yellow') summary.yellow++;
      else if (sig?.verdict === 'red') summary.red++;
      else summary.unscored++;
      if (t.total) summary.totalAmount += Number(t.total);
    }

    res.json({ tickets: filtered, total: filtered.length, summary });
  } catch (err) {
    next(err);
  }
});

// GET /api/tickets/deployments-queue — feed for the Approvals → Deployments tab.
// Rental/on-site jobs that were dispatched/worked WITHOUT a rental agreement
// attached. They sit here (and are blocked from billing by the transition gate
// below) until someone attaches a rental. Manned-rental work tickets never land
// here — they're already linked to their rental.
// NOTE: must be registered BEFORE any `/:id` route or Express matches it as an ID.
ticketsRouter.get('/deployments-queue', async (req: Request, res: Response, next) => {
  try {
    const role = req.user!.role as UserRole;
    const canView =
      role === 'field_super' || role === 'dispatch' || role === 'billing_ar' ||
      role === 'boss' || role === 'platform_admin';
    if (!canView) throw new AppError(403, 'Insufficient permissions to view deployments queue');

    const { tech, companyId } = req.query;

    const where: any = {
      linkedRentalAgreementId: null,
      status: { in: [...DEPLOYED_PREBILLING_STATUSES] },
      // "Expected to ride on a rental" — keep routine field/training/shop work out.
      OR: [
        { ticketType: 'rental' },
        { serviceSubtype: 'on_site_services' },
        { division: 'D4' },
      ],
    };
    if (tech) where.assignedTechId = tech as string;
    if (companyId) where.companyId = companyId as string;

    const tickets = await prisma.serviceTicket.findMany({
      where,
      include: {
        company: { select: { id: true, name: true } },
        field: { select: { id: true, name: true } },
        pad: { select: { id: true, name: true } },
        well: { select: { id: true, wellName: true } },
        assignedTech: { select: { id: true, name: true } },
        createdBy: { select: { id: true, name: true } },
        _count: { select: { lineItems: true, attachments: true } },
      },
      orderBy: [{ serviceDate: 'desc' }, { updatedAt: 'desc' }],
      take: 500,
    });

    const summary = {
      total: tickets.length,
      totalAmount: tickets.reduce((s, t) => s + Number(t.total ?? 0), 0),
    };

    res.json({ tickets, total: tickets.length, summary });
  } catch (err) {
    next(err);
  }
});

// GET /api/tickets/:id/pdf — download ticket as PDF
ticketsRouter.get('/:id/pdf', async (req: Request, res: Response, next) => {
  try {
    const ticket = await prisma.serviceTicket.findUnique({
      where: { id: req.params.id as string },
      include: {
        company: true,
        field: true,
        pad: true,
        well: true,
        assignedTech: { select: { id: true, name: true, email: true } },
        lineItems: {
          include: {
            product: { select: { id: true, partNumber: true, name: true } },
          },
          orderBy: { sortOrder: 'asc' },
        },
        fitTestRecords: true,
      },
    });

    if (!ticket) throw new AppError(404, 'Ticket not found');

    const fileName = `ticket-${ticket.ticketNumber || ticket.id}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);

    const pdfDoc = generateTicketPdf(ticket as any);
    pdfDoc.pipe(res);
    pdfDoc.end();
  } catch (err) {
    next(err);
  }
});

// GET /api/tickets/:id/occ-health-pdf — the Occ Health report: full per-person
// fit test + audiometric detail (the generated counterpart to the machine
// printouts attached as fit_test_report files)
ticketsRouter.get('/:id/occ-health-pdf', async (req: Request, res: Response, next) => {
  try {
    const ticket = await prisma.serviceTicket.findUnique({
      where: { id: req.params.id as string },
      include: {
        company: true,
        field: true,
        pad: true,
        well: true,
        assignedTech: { select: { id: true, name: true, email: true } },
        fitTestRecords: { orderBy: { employeeName: 'asc' } },
      },
    });

    if (!ticket) throw new AppError(404, 'Ticket not found');
    if (ticket.fitTestRecords.length === 0) {
      throw new AppError(400, 'Ticket has no occupational health records');
    }

    const fileName = `occ-health-${ticket.ticketNumber || ticket.id}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);

    const pdfDoc = generateOccHealthPdf(ticket as any);
    pdfDoc.pipe(res);
    pdfDoc.end();
  } catch (err) {
    next(err);
  }
});

// POST /api/tickets/:id/pdf/store — generate PDF and save to file storage
// Returns the storage key + creates a TicketAttachment record
ticketsRouter.post('/:id/pdf/store', requirePermission('tickets:create'), async (req: Request, res: Response, next) => {
  try {
    const ticket = await prisma.serviceTicket.findUnique({
      where: { id: req.params.id as string },
      include: {
        company: true,
        field: true,
        pad: true,
        well: true,
        assignedTech: { select: { id: true, name: true, email: true } },
        lineItems: {
          include: {
            product: { select: { id: true, partNumber: true, name: true } },
          },
          orderBy: { sortOrder: 'asc' },
        },
        fitTestRecords: true,
      },
    });

    if (!ticket) throw new AppError(404, 'Ticket not found');

    const pdfDoc = generateTicketPdf(ticket as any);
    const buffer = await pdfToBuffer(pdfDoc);

    const fileName = `ticket-${ticket.ticketNumber || ticket.id}.pdf`;
    const store = getFileStore();
    const key = ticketKey(ticket.id, fileName);
    await store.write(key, buffer, 'application/pdf');

    // Create or update the TicketAttachment record
    const existing = await prisma.ticketAttachment.findFirst({
      where: { ticketId: ticket.id, fileType: 'document', fileName },
    });

    let attachment;
    if (existing) {
      attachment = await prisma.ticketAttachment.update({
        where: { id: existing.id },
        data: { filePath: key, fileSizeBytes: buffer.length, uploadedAt: new Date() },
      });
    } else {
      attachment = await prisma.ticketAttachment.create({
        data: {
          ticketId: ticket.id,
          fileName,
          fileType: 'document',
          filePath: key,
          fileSizeBytes: buffer.length,
          mimeType: 'application/pdf',
          uploadedById: req.user!.userId,
        },
      });
    }

    res.status(201).json({
      key,
      fileName,
      size: buffer.length,
      attachmentId: attachment.id,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/tickets/:id — full ticket detail
ticketsRouter.get('/:id', async (req: Request, res: Response, next) => {
  try {
    const ticket = await prisma.serviceTicket.findUnique({
      where: { id: req.params.id as string },
      include: {
        company: true,
        field: true,
        pad: true,
        well: true,
        facility: true,
        workPoint: true,
        presentRig: true,
        billingProfile: true,
        assignedTech: { select: { id: true, name: true, email: true } },
        dispatchedBy: { select: { id: true, name: true } },
        customerContact: true,
        lineItems: {
          include: {
            product: { select: { id: true, partNumber: true, name: true } },
            assemblyPartsUsed: {
              include: { product: { select: { id: true, partNumber: true, name: true } } },
            },
          },
          orderBy: { sortOrder: 'asc' },
        },
        attachments: { orderBy: { uploadedAt: 'desc' } },
        fitTestRecords: true,
        airSystemInspections: true,
        ihTestRecords: true,
        trainingRosterRecords: true,
        signatureRequest: {
          select: {
            id: true,
            status: true,
            sentToEmail: true,
            sentToName: true,
            sendCount: true,
            firstSentAt: true,
            lastSentAt: true,
          },
        },
        createdBy: { select: { id: true, name: true } },
      },
    });

    if (!ticket) throw new AppError(404, 'Ticket not found');

    // Add available transitions for the current user
    const transitions = getAvailableTransitions(
      ticket.status,
      req.user!.role as UserRole,
    );

    res.json({ ...ticket, availableTransitions: transitions });
  } catch (err) {
    next(err);
  }
});

// POST /api/tickets — create a new ticket
ticketsRouter.post('/', requirePermission('tickets:create'), async (req: Request, res: Response, next) => {
  try {
    // Arrival + departure required on any non-draft submit (systemwide rule).
    const submittingStatus = req.body.status || 'draft';
    if (submittingStatus !== 'draft' && (!req.body.arrivalTime || !req.body.departureTime)) {
      throw new AppError(400, 'Arrival and departure times are required before submit');
    }

    // Can't book new work against a deactivated customer.
    await assertCompanyActive(req.body.companyId);
    // ...nor against one AR has put on credit hold.
    await assertCompanyNotOnCreditHold(req.body.companyId);

    const ticketNumber = await generateTicketNumber(req.body.ticketType || 'field_service', req.body.serviceSubtype);

    // Build location display string
    const locationDisplay = await buildLocationDisplay({
      companyId: req.body.companyId,
      fieldId: req.body.fieldId,
      padId: req.body.padId,
      wellId: req.body.wellId,
    });

    // Extract structured gas/cylinder data from notes
    const enrichedCustomData = enrichCustomData(
      req.body.workDescription,
      req.body.customData,
    );

    // #3 Derive flat po/afe/cost from billingRefs when present (server wins).
    const flatRefs = flatOverridesFromPayload(req.body);

    // Compute billing group key for stacked field-service billing
    const resolvedServiceDate = req.body.serviceDate ? new Date(req.body.serviceDate) : new Date();

    // #4 Auto-select the billing profile by job type when one wasn't passed.
    let resolvedBillingProfileId: string | undefined = req.body.billingProfileId || undefined;
    if (!resolvedBillingProfileId && req.body.companyId) {
      const profiles = await prisma.customerBillingProfile.findMany({
        where: { companyId: req.body.companyId, isActive: true },
        select: { id: true, isActive: true, effectiveFrom: true, effectiveTo: true, appliesToTicketTypes: true, appliesToDivisions: true },
      });
      const picked = selectBillingProfile(profiles, {
        ticketType: req.body.ticketType || 'field_service',
        division: req.body.division ?? null,
        serviceDate: resolvedServiceDate,
      });
      resolvedBillingProfileId = picked?.id;
    }
    const billingGroupKey = computeBillingGroupKey({
      ticketType: req.body.ticketType || 'field_service',
      companyId: req.body.companyId,
      fieldId: req.body.fieldId,
      serviceDate: resolvedServiceDate,
    });

    const ticket = await prisma.serviceTicket.create({
      data: {
        ticketNumber,
        ticketType: req.body.ticketType || 'field_service',
        serviceSubtype: req.body.serviceSubtype || undefined,
        status: req.body.status || 'draft',
        companyId: req.body.companyId,
        fieldId: req.body.fieldId || undefined,
        padId: req.body.padId || undefined,
        wellId: req.body.wellId || undefined,
        facilityId: req.body.facilityId || undefined,
        workPointId: req.body.workPointId || undefined,
        billingProfileId: resolvedBillingProfileId,
        billingGroupKey: billingGroupKey || undefined,
        locationDisplay,
        assignedTechId: req.body.assignedTechId || req.user!.userId,
        serviceDate: resolvedServiceDate,
        arrivalTime: req.body.arrivalTime ? new Date(req.body.arrivalTime) : undefined,
        departureTime: req.body.departureTime ? new Date(req.body.departureTime) : undefined,
        poNumber: flatRefs.poNumber !== undefined ? (flatRefs.poNumber ?? undefined) : (req.body.poNumber || undefined),
        afeNumber: flatRefs.afeNumber !== undefined ? (flatRefs.afeNumber ?? undefined) : (req.body.afeNumber || undefined),
        costCenter: flatRefs.costCenter !== undefined ? (flatRefs.costCenter ?? undefined) : (req.body.costCenter || undefined),
        billingRefs: req.body.billingRefs ?? undefined,
        // QB Class. The wizard only asks for a division on the field-service
        // step, so every other flow arrives without one — derive it from the
        // work type (shop = D6, rental = D4, IH = D3) instead of leaving the
        // class blank on the QB invoice.
        division: req.body.division
          || defaultDivisionForWork({
            ticketType: req.body.ticketType || 'field_service',
            serviceSubtype: req.body.serviceSubtype,
          })
          || undefined,
        isDickinson: req.body.isDickinson ?? undefined,
        dispatchNotes: req.body.dispatchNotes || undefined,
        workDescription: req.body.workDescription || undefined,
        internalNotes: req.body.internalNotes || undefined,
        linkedRentalAgreementId: req.body.linkedRentalAgreementId || undefined,
        customData: enrichedCustomData,
        createdById: req.user!.userId,
      },
    });

    await createAuditLog({
      userId: req.user!.userId,
      entityType: 'service_ticket',
      entityId: ticket.id,
      action: 'create',
      changes: { ticketNumber, ticketType: ticket.ticketType, status: ticket.status },
      ipAddress: req.ip,
    });

    res.status(201).json(ticket);
  } catch (err) {
    next(err);
  }
});

// PUT /api/tickets/:id — update ticket fields
ticketsRouter.put('/:id', async (req: Request, res: Response, next) => {
  try {
    const existing = await prisma.serviceTicket.findUnique({ where: { id: req.params.id as string } });
    if (!existing) throw new AppError(404, 'Ticket not found');

    // Enforce edit permissions based on role
    const role = req.user!.role as UserRole;
    if (role === 'field_tech' && existing.assignedTechId !== req.user!.userId) {
      throw new AppError(403, 'Can only edit your own tickets');
    }
    if (role === 'field_tech' && !['draft', 'in_progress'].includes(existing.status)) {
      throw new AppError(403, 'Can only edit draft or in-progress tickets');
    }

    // Only dispatch, field_super, platform_admin can reassign tickets
    if (req.body.assignedTechId && req.body.assignedTechId !== existing.assignedTechId) {
      const canReassign: UserRole[] = ['dispatch', 'field_super', 'platform_admin'];
      if (!canReassign.includes(role)) {
        throw new AppError(403, 'Only dispatchers and supervisors can reassign tickets');
      }
    }

    // Don't allow status change via PUT — use POST /:id/transition.
    // Same treatment for billingReadiness: it has its own guards
    // (services/billingReadiness.ts) and must never go through a raw update —
    // reasonCode is accepted from the body, but setById/setAt are always
    // server-resolved, never client-supplied.
    const {
      status,
      billingReadiness,
      billingReadinessReasonCode,
      billingReadinessSetById: _ignoredSetById,
      billingReadinessSetAt: _ignoredSetAt,
      ...updateData
    } = req.body;

    // Coerce date-ish fields: the client sends date-only strings ("2026-06-15")
    // which Prisma's DateTime rejects (it requires full ISO-8601). The create
    // path wraps these in new Date(); the PUT path must do the same or it 500s.
    for (const dateField of ['serviceDate', 'arrivalTime', 'departureTime'] as const) {
      if (typeof updateData[dateField] === 'string' && updateData[dateField]) {
        updateData[dateField] = new Date(updateData[dateField]);
      }
    }

    // Re-extract gas/cylinder data when notes change
    if (updateData.workDescription !== undefined) {
      const enriched = enrichCustomData(
        updateData.workDescription,
        updateData.customData ?? (existing.customData as Record<string, any> | null),
      );
      if (enriched) updateData.customData = enriched;
    }

    // #3 Keep flat po/afe/cost in sync when billingRefs is updated (server wins).
    const flatRefs = flatOverridesFromPayload(updateData);
    if (flatRefs.poNumber !== undefined) updateData.poNumber = flatRefs.poNumber;
    if (flatRefs.afeNumber !== undefined) updateData.afeNumber = flatRefs.afeNumber;
    if (flatRefs.costCenter !== undefined) updateData.costCenter = flatRefs.costCenter;

    // Clear the needsLocation flag once a real location is assigned (the ticket
    // was detached when its location request got rejected). This lets it leave
    // the "needs location" state in the dispatch queue.
    const existingCd = (existing.customData as Record<string, any> | null) || {};
    if (existingCd.needsLocation && (updateData.padId || updateData.fieldId || updateData.wellId)) {
      const mergedCd = { ...existingCd, ...(updateData.customData as Record<string, any> | null || {}) };
      delete mergedCd.needsLocation;
      delete mergedCd.needsLocationReason;
      updateData.customData = mergedCd;
    }

    let ticket = await prisma.serviceTicket.update({
      where: { id: req.params.id as string },
      data: updateData,
    });

    // billingReadiness goes through its own guard, not the raw update above —
    // see services/billingReadiness.ts for why (Rule 1 of the billing lineage
    // handoff: this is the one billing field ServicePRO owns, and the guards
    // are load-bearing).
    if (billingReadiness !== undefined) {
      ticket = await setBillingReadiness(ticket.id, {
        next: billingReadiness,
        actorUserId: req.user!.userId,
        reasonCode: billingReadinessReasonCode,
      });
    }

    await createAuditLog({
      userId: req.user!.userId,
      entityType: 'service_ticket',
      entityId: ticket.id,
      action: 'update',
      changes: { fields: [...Object.keys(updateData), ...(billingReadiness !== undefined ? ['billingReadiness'] : [])] },
      ipAddress: req.ip,
    });

    res.json(ticket);
  } catch (err) {
    next(err);
  }
});

// POST /api/tickets/:id/site-customer-mismatch — resolve the approval-time
// prompt created when the field tech selected a site currently assigned to a
// different customer. Reviewers must either assign the site to the ticket's
// customer or leave it mismatched with a reason.
ticketsRouter.post('/:id/site-customer-mismatch', async (req: Request, res: Response, next) => {
  try {
    const role = req.user!.role as UserRole;
    const canReview =
      role === 'field_super' || role === 'billing_ar' || role === 'boss' || role === 'platform_admin';
    if (!canReview) throw new AppError(403, 'Insufficient permissions to resolve site/customer mismatch');

    const action = String(req.body.action || '').trim();
    const reason = String(req.body.reason || '').trim();
    if (action !== 'assign' && action !== 'leave') {
      throw new AppError(400, 'action must be assign or leave');
    }
    if (action === 'leave' && !reason) {
      throw new AppError(400, 'Reason is required when leaving the customer/site mismatch');
    }

    const ticket = await prisma.serviceTicket.findUnique({
      where: { id: req.params.id as string },
      select: {
        id: true,
        companyId: true,
        padId: true,
        wellId: true,
        customData: true,
      },
    });
    if (!ticket) throw new AppError(404, 'Ticket not found');

    const cd = (ticket.customData as Record<string, any> | null) || {};
    const mismatch = cd.customerLocationMismatch as Record<string, any> | undefined;
    if (!mismatch) throw new AppError(400, 'Ticket has no customer/site mismatch to resolve');
    if (mismatch.status && mismatch.status !== 'pending') {
      throw new AppError(400, 'Customer/site mismatch is already resolved');
    }

    const resolvedMismatch = {
      ...mismatch,
      status: action === 'assign' ? 'assigned' : 'left',
      reason: action === 'leave' ? reason : null,
      resolvedById: req.user!.userId,
      resolvedAt: new Date().toISOString(),
    };
    const customData = { ...cd, customerLocationMismatch: resolvedMismatch };

    const updated = await prisma.$transaction(async tx => {
      if (action === 'assign') {
        const source = mismatch.source;
        const locationId = typeof mismatch.locationId === 'string' ? mismatch.locationId : null;
        if (source === 'pad' && (locationId || ticket.padId)) {
          await tx.pad.update({
            where: { id: locationId || ticket.padId! },
            data: { currentOperatorId: ticket.companyId },
          });
        } else if (source === 'well' && (locationId || ticket.wellId)) {
          await tx.well.update({
            where: { id: locationId || ticket.wellId! },
            data: { currentOperatorId: ticket.companyId },
          });
        } else if (ticket.padId) {
          await tx.pad.update({
            where: { id: ticket.padId },
            data: { currentOperatorId: ticket.companyId },
          });
        } else if (ticket.wellId) {
          await tx.well.update({
            where: { id: ticket.wellId },
            data: { currentOperatorId: ticket.companyId },
          });
        } else {
          throw new AppError(400, 'Ticket has no pad or well to assign');
        }
      }

      return tx.serviceTicket.update({
        where: { id: ticket.id },
        data: { customData },
      });
    });

    await runAndCacheReviewSignal(ticket.id);
    await createAuditLog({
      userId: req.user!.userId,
      entityType: 'service_ticket',
      entityId: ticket.id,
      action: 'update',
      changes: {
        customerLocationMismatch: {
          from: mismatch.status || 'pending',
          to: resolvedMismatch.status,
          reason: resolvedMismatch.reason || undefined,
        },
      },
      ipAddress: req.ip,
    });

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// POST /api/tickets/:id/transition — change ticket status
ticketsRouter.post('/:id/transition', async (req: Request, res: Response, next) => {
  try {
    const { targetStatus, reason } = req.body as { targetStatus?: string; reason?: string };
    if (!targetStatus) throw new AppError(400, 'targetStatus required');

    const ticket = await prisma.serviceTicket.findUnique({ where: { id: req.params.id as string } });
    if (!ticket) throw new AppError(404, 'Ticket not found');

    const role = req.user!.role as UserRole;

    // Field tech can only transition their own tickets
    if (role === 'field_tech' && ticket.assignedTechId !== req.user!.userId) {
      throw new AppError(403, 'Can only transition your own tickets');
    }

    if (!canTransition(ticket.status, targetStatus as TicketStatus, role)) {
      throw new AppError(403, `Cannot transition from ${ticket.status} to ${targetStatus}`);
    }

    // ── Deployment-rental gate ──────────────────────────────────────────
    // A rental/on-site job that was deployed without a rental can't move to
    // billing until one is attached (Approvals → Deployments tab handles that).
    // Deploy / in-progress / complete stay allowed so work isn't blocked.
    if (isBillingWardStatus(targetStatus) && !ticket.linkedRentalAgreementId && needsRental(ticket)) {
      throw new AppError(400, 'Attach a rental agreement before this deployment can go to billing.');
    }

    // ── Rental-linked log-only disposition ──────────────────────────────
    // A rental-linked ticket with nothing to charge is a record of a shift, not
    // a bill: append it to the rental's daily log and close it, rather than
    // sending it into review or the billing queue. One with billable lines does
    // continue — it rolls onto the rental's invoice. See rentalTicketRecord.ts
    // for why billability rather than rental.isManned is the test.
    if (
      (targetStatus === 'supervisor_review' || targetStatus === 'billing_queue') &&
      (await shouldRecordOnly(ticket))
    ) {
      const closed = await recordTicketAsRentalLog(
        ticket,
        ticket.linkedRentalAgreementId!,
        req.user!.userId,
        req.ip,
      );
      return res.json(closed);
    }

    // A ticket detached from a rejected location request can't be dispatched
    // until it's given a real location again.
    if (targetStatus === 'dispatched') {
      const cd = (ticket.customData as Record<string, any> | null) || {};
      if (cd.needsLocation && !ticket.padId && !ticket.fieldId && !ticket.wellId) {
        throw new AppError(400, 'Assign a location before dispatching — this ticket lost its location when the request was rejected.');
      }
    }

    // Supervisor approval requires every labor-rate line (legacy 406 or
    // new-scheme [DIV]00002) to carry a reason in notes.
    if (targetStatus === 'billing_queue' && ticket.status === 'supervisor_review') {
      if (siteCustomerMismatchBlocksApproval(ticket.customData)) {
        throw new AppError(400, 'Resolve the customer/site mismatch before approval: assign the site or leave it with a reason.');
      }
      const unreasoned = await prisma.ticketLineItem.findMany({
        where: {
          ticketId: ticket.id,
          OR: [{ partNumber: '406' }, { partNumber: { endsWith: '00002' } }],
        },
        select: { id: true, lineNumber: true, partNumber: true, notes: true },
      });
      const missing = unreasoned.filter(li =>
        (li.partNumber === '406' || /^0[0-9]00002$/.test(li.partNumber ?? '')) && !li.notes?.trim(),
      );
      if (missing.length > 0) {
        throw new AppError(400, `Reason required on labor line(s) ${missing.map(m => `#${m.lineNumber}`).join(', ')} before approval`);
      }
    }

    const updateData: any = { status: targetStatus };

    // Auto-fill timestamps based on transition
    if (targetStatus === 'dispatched' && !ticket.dispatchedAt) {
      updateData.dispatchedAt = new Date();
      updateData.dispatchedById = req.user!.userId;
    }

    // Approval transitions track who approved and when.
    if (targetStatus === 'billing_queue' && ticket.status === 'supervisor_review') {
      updateData.reviewedById = req.user!.userId;
      updateData.reviewedAt = new Date();
      updateData.autoApproved = false;
      updateData.rejectionReason = null; // clear any prior rejection note
      // Clear a stale "returned by billing" banner once the ticket is re-approved.
      const cd = (ticket.customData as Record<string, any> | null) || {};
      if (cd.returnedForReview) {
        const { returnedForReview, ...rest } = cd;
        updateData.customData = rest;
      }
    }

    // Rejection back to in_progress from supervisor_review captures the reason.
    if (targetStatus === 'in_progress' && ticket.status === 'supervisor_review') {
      updateData.rejectionReason = reason || null;
    }

    // Billing/AR returning a ticket from the Ready queue (billing_queue) back to
    // the Approvals queue (supervisor_review). Capture the note so the reviewer
    // sees why it bounced — surfaced as a banner in the Approvals UI.
    if (targetStatus === 'supervisor_review' && ticket.status === 'billing_queue') {
      const note = (reason || '').trim();
      const actor = await prisma.user.findUnique({
        where: { id: req.user!.userId },
        select: { name: true },
      });
      const cd = (ticket.customData as Record<string, any> | null) || {};
      updateData.customData = {
        ...cd,
        returnedForReview: {
          note: note || null,
          byId: req.user!.userId,
          byName: actor?.name || null,
          at: new Date().toISOString(),
        },
      };
    }

    const updated = await prisma.serviceTicket.update({
      where: { id: ticket.id },
      data: updateData,
    });

    // Side effect: when a ticket lands in supervisor_review, run the
    // deterministic rules engine and cache the signal on the row.
    if (targetStatus === 'supervisor_review') {
      try {
        await runAndCacheReviewSignal(updated.id);
      } catch (err) {
        console.error(
          `[tickets/transition] Failed to run review rules for ${updated.id}:`,
          err instanceof Error ? err.message : err,
        );
        // Non-fatal — the ticket still transitions. Dashboard will show a
        // grey "pending check" badge until the next rules run.
      }
    }

    await createAuditLog({
      userId: req.user!.userId,
      entityType: 'service_ticket',
      entityId: ticket.id,
      action: 'status_change',
      changes: { from: ticket.status, to: targetStatus, reason: reason || undefined },
      ipAddress: req.ip,
    });

    // Fire-and-forget: future listeners (approvals engine, signature trigger,
    // QB queue, Enverus queue) will subscribe to this. No await — the HTTP
    // response should not block on side effects, and listeners must catch
    // their own errors (eventBus already swallows + logs them).
    void emitEvent('ticket.transitioned', {
      ticketId: ticket.id,
      fromStatus: ticket.status,
      toStatus: targetStatus,
      actorUserId: req.user!.userId,
      reason,
    });

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// POST /api/tickets/bulk-transition — move multiple tickets in one call
// Used by the Approvals dashboard for bulk approve / bulk reject.
// Per-ticket permission + state machine checks; does NOT abort the batch
// on a single failure — returns per-ticket success/error in the response.
ticketsRouter.post('/bulk-transition', async (req: Request, res: Response, next) => {
  try {
    const { ticketIds, targetStatus, reason } = req.body as {
      ticketIds?: string[];
      targetStatus?: string;
      reason?: string;
    };

    if (!Array.isArray(ticketIds) || ticketIds.length === 0) {
      throw new AppError(400, 'ticketIds array required');
    }
    if (!targetStatus) throw new AppError(400, 'targetStatus required');
    if (ticketIds.length > 500) {
      throw new AppError(400, 'Bulk transition limited to 500 tickets per call');
    }

    const role = req.user!.role as UserRole;
    const userId = req.user!.userId;

    const tickets = await prisma.serviceTicket.findMany({
      where: { id: { in: ticketIds } },
      select: {
        id: true, status: true, assignedTechId: true,
        ticketType: true, serviceSubtype: true, division: true, linkedRentalAgreementId: true,
        // Needed by the rental log-only disposition below.
        ticketNumber: true, workDescription: true, customData: true, serviceDate: true,
      },
    });

    const ticketMap = new Map(tickets.map(t => [t.id, t]));
    const results: Array<{ ticketId: string; success: boolean; error?: string; recordOnly?: boolean }> = [];

    for (const ticketId of ticketIds) {
      const ticket = ticketMap.get(ticketId);
      if (!ticket) {
        results.push({ ticketId, success: false, error: 'Ticket not found' });
        continue;
      }

      if (role === 'field_tech' && ticket.assignedTechId !== userId) {
        results.push({ ticketId, success: false, error: 'Can only transition your own tickets' });
        continue;
      }

      if (!canTransition(ticket.status, targetStatus as TicketStatus, role)) {
        results.push({
          ticketId,
          success: false,
          error: `Cannot transition from ${ticket.status} to ${targetStatus}`,
        });
        continue;
      }

      // Deployment-rental gate (same rule as the single transition): a rental/
      // on-site job can't be bulk-approved into billing without a rental attached.
      if (isBillingWardStatus(targetStatus) && !ticket.linkedRentalAgreementId && needsRental(ticket)) {
        results.push({
          ticketId,
          success: false,
          error: 'Attach a rental agreement before this deployment can go to billing.',
        });
        continue;
      }

      if (
        targetStatus === 'billing_queue' &&
        ticket.status === 'supervisor_review' &&
        siteCustomerMismatchBlocksApproval(ticket.customData)
      ) {
        results.push({
          ticketId,
          success: false,
          error: 'Resolve the customer/site mismatch before approval: assign the site or leave it with a reason.',
        });
        continue;
      }

      // Rental-linked log-only disposition (same rule as the single transition).
      // Missing here is what parked manned dailies in `billing_queue`, a status
      // that renders nowhere for a rental-linked ticket — approving a batch from
      // the Approvals UI took this path and skipped the rule entirely.
      if (
        (targetStatus === 'supervisor_review' || targetStatus === 'billing_queue') &&
        (await shouldRecordOnly(ticket))
      ) {
        try {
          await recordTicketAsRentalLog(
            ticket,
            ticket.linkedRentalAgreementId!,
            userId,
            req.ip,
          );
          results.push({ ticketId, success: true, recordOnly: true });
        } catch (err) {
          results.push({
            ticketId,
            success: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        continue;
      }

      try {
        const updateData: any = { status: targetStatus };

        if (targetStatus === 'billing_queue' && ticket.status === 'supervisor_review') {
          updateData.reviewedById = userId;
          updateData.reviewedAt = new Date();
          updateData.autoApproved = false;
          updateData.rejectionReason = null;
        }

        if (targetStatus === 'in_progress' && ticket.status === 'supervisor_review') {
          updateData.rejectionReason = reason || null;
        }

        await prisma.serviceTicket.update({ where: { id: ticketId }, data: updateData });

        await createAuditLog({
          userId,
          entityType: 'service_ticket',
          entityId: ticketId,
          action: 'status_change',
          changes: {
            from: ticket.status,
            to: targetStatus,
            bulk: true,
            reason: reason || undefined,
          },
          ipAddress: req.ip,
        });

        // If we're sending tickets INTO supervisor_review via bulk (rare but
        // valid), recompute the signal. Not expected via the Approvals UI.
        if (targetStatus === 'supervisor_review') {
          try {
            await runAndCacheReviewSignal(ticketId);
          } catch (err) {
            console.error(`[bulk-transition] rules engine failed for ${ticketId}:`, err);
          }
        }

        void emitEvent('ticket.transitioned', {
          ticketId,
          fromStatus: ticket.status,
          toStatus: targetStatus,
          actorUserId: userId,
          reason,
          bulk: true,
        });

        results.push({ ticketId, success: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        results.push({ ticketId, success: false, error: message });
      }
    }

    const succeeded = results.filter(r => r.success).length;
    console.log(
      `[tickets/bulk-transition] User ${userId} moved ${succeeded}/${ticketIds.length} tickets to ${targetStatus}`,
    );

    res.json({ results, succeeded, failed: ticketIds.length - succeeded });
  } catch (err) {
    next(err);
  }
});

// POST /api/tickets/:id/attach-rental — link a rental agreement to a deployment
// that was dispatched before one existed. Clears it from the Deployments queue
// and unblocks the billing path.
ticketsRouter.post('/:id/attach-rental', async (req: Request, res: Response, next) => {
  try {
    const role = req.user!.role as UserRole;
    const canAttach =
      role === 'field_super' || role === 'dispatch' || role === 'billing_ar' ||
      role === 'boss' || role === 'platform_admin';
    if (!canAttach) throw new AppError(403, 'Insufficient permissions to attach a rental');

    const { rentalAgreementId } = req.body as { rentalAgreementId?: string };
    if (!rentalAgreementId) throw new AppError(400, 'rentalAgreementId required');

    const ticket = await prisma.serviceTicket.findUnique({ where: { id: req.params.id as string } });
    if (!ticket) throw new AppError(404, 'Ticket not found');

    const rental = await prisma.rentalAgreement.findUnique({
      where: { id: rentalAgreementId },
      select: { id: true, companyId: true, agreementNumber: true },
    });
    if (!rental) throw new AppError(404, 'Rental agreement not found');

    // Guard against linking a rental from a different customer — almost always a mistake.
    if (rental.companyId !== ticket.companyId) {
      throw new AppError(400, 'Rental agreement belongs to a different customer than this ticket');
    }

    const updated = await prisma.serviceTicket.update({
      where: { id: ticket.id },
      data: { linkedRentalAgreementId: rentalAgreementId },
    });

    await createAuditLog({
      userId: req.user!.userId,
      entityType: 'service_ticket',
      entityId: ticket.id,
      action: 'update',
      changes: { linkedRentalAgreementId: rentalAgreementId, attachedRental: rental.agreementNumber },
      ipAddress: req.ip,
    });

    // Work already done and nothing to charge → convert now: log it to the
    // rental and close recordOnly. The submit-time disposition can't have run
    // for these (there was no rental attached yet), so attaching is where it
    // happens. `billing_queue` is included deliberately: that's the recovery
    // path for a ticket already parked there before this rule existed. For a
    // still-active job we just link — the disposition fires on submit.
    if (
      (ticket.status === 'completed' ||
        ticket.status === 'supervisor_review' ||
        ticket.status === 'billing_queue') &&
      (await shouldRecordOnly(updated))
    ) {
      const closed = await recordTicketAsRentalLog(ticket, rental.id, req.user!.userId, req.ip);
      return res.json(closed);
    }

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// ============================================================
// LINE ITEMS
// ============================================================

// GET /api/tickets/:id/line-items
ticketsRouter.get('/:id/line-items', async (req: Request, res: Response, next) => {
  try {
    const items = await prisma.ticketLineItem.findMany({
      where: { ticketId: req.params.id as string },
      include: {
        product: { select: { id: true, partNumber: true, name: true, category: true } },
        equipmentInstalled: { select: { id: true, serialNumber: true, status: true } },
        equipmentRemoved: { select: { id: true, serialNumber: true, status: true } },
        assemblyPartsUsed: true,
      },
      orderBy: { sortOrder: 'asc' },
    });
    res.json(items);
  } catch (err) {
    next(err);
  }
});

// POST /api/tickets/:id/line-items
ticketsRouter.post('/:id/line-items', requirePermission('tickets:create'), async (req: Request, res: Response, next) => {
  try {
    // Auto-assign line number
    const lastItem = await prisma.ticketLineItem.findFirst({
      where: { ticketId: req.params.id as string },
      orderBy: { lineNumber: 'desc' },
      select: { lineNumber: true },
    });
    const lineNumber = (lastItem?.lineNumber ?? 0) + 1;

    const item = await prisma.ticketLineItem.create({
      data: {
        ...req.body,
        ticketId: req.params.id as string,
        lineNumber,
        sortOrder: req.body.sortOrder ?? lineNumber,
      },
    });

    // Recalculate ticket totals
    await recalcTicketTotals(req.params.id as string);

    res.status(201).json(item);
  } catch (err) {
    next(err);
  }
});

// PUT /api/tickets/:ticketId/line-items/:id
ticketsRouter.put('/:ticketId/line-items/:id', async (req: Request, res: Response, next) => {
  try {
    const item = await prisma.ticketLineItem.update({
      where: { id: req.params.id as string },
      data: req.body,
    });

    await recalcTicketTotals(req.params.ticketId as string);

    res.json(item);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/tickets/:ticketId/line-items/:id
ticketsRouter.delete('/:ticketId/line-items/:id', async (req: Request, res: Response, next) => {
  try {
    await prisma.ticketLineItem.delete({ where: { id: req.params.id as string } });
    await recalcTicketTotals(req.params.ticketId as string);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// ============================================================
// DELETE /:id — Permanently delete a single ticket + all children.
// Allowed for field_super + platform_admin. This is a true hard delete: the
// ticket is gone to the ether, NOT kept or tracked (use POST /:id/void for the
// billing "tombstone" path that stays visible). Intended for scrubbing test /
// junk tickets without surgical SQL.
// ============================================================

ticketsRouter.delete('/:id',
  requirePermission('tickets:delete'),
  async (req: Request, res: Response, next) => {
    try {
      const ticketId = req.params.id as string;
      const reason = (req.body?.reason || '').trim();
      if (!reason) throw new AppError(400, 'A reason is required to delete a ticket');

      const ticket = await prisma.serviceTicket.findUnique({
        where: { id: ticketId },
        select: { id: true, ticketNumber: true, status: true },
      });
      if (!ticket) throw new AppError(404, 'Ticket not found');

      // Delete all children in dependency order
      // Assembly parts link through lineItems, not directly to ticket
      const lineItemIds = (await prisma.ticketLineItem.findMany({
        where: { ticketId },
        select: { id: true },
      })).map(li => li.id);
      if (lineItemIds.length > 0) {
        await prisma.ticketAssemblyPartsUsed.deleteMany({
          where: { ticketLineItemId: { in: lineItemIds } },
        });
      }
      await prisma.fitTestRecord.deleteMany({ where: { ticketId } });
      await prisma.ihTestRecord.deleteMany({ where: { ticketId } });
      await prisma.trainingRosterRecord.deleteMany({ where: { ticketId } });
      await prisma.airSystemInspection.deleteMany({ where: { ticketId } });
      await prisma.ticketAttachment.deleteMany({ where: { ticketId } });
      await prisma.ticketLineItem.deleteMany({ where: { ticketId } });

      // Clear any invoice line items referencing this ticket
      await prisma.invoiceLineItem.updateMany({
        where: { sourceTicketId: ticketId },
        data: { sourceTicketId: null, sourceTicketNumber: null },
      });

      // Delete the ticket itself
      await prisma.serviceTicket.delete({ where: { id: ticketId } });

      console.log(`[DELETE] ${req.user!.role} hard-deleted ticket ${ticket.ticketNumber || ticketId}`);

      await createAuditLog({
        userId: req.user!.userId,
        entityType: 'ticket',
        entityId: ticketId,
        action: 'delete',
        changes: { ticketNumber: ticket.ticketNumber, status: ticket.status, reason },
        ipAddress: req.ip,
      });

      res.json({ ok: true, ticketNumber: ticket.ticketNumber });
    } catch (err) {
      next(err);
    }
  },
);

// ============================================================
// POST /:id/void — billing/AR (and platform_admin) "nullify" a ticket.
// Soft-kill: status flips to `void`, the row stays as a tombstone and shows in
// the All view as "dead". The pre-void status is stashed in customData.voidedFrom.
// Allowed from ANY status (the "scrap this, it was a mistake" escape hatch),
// so it intentionally bypasses the state machine. Distinct from DELETE /:id,
// which is an unrecoverable hard delete.
//
// Billing retraction: voiding also retracts any invoice this ticket landed on
// — UNLESS that invoice has already crossed into QuickBooks (we can't un-bork
// it across QBWC). A linked invoice is retracted (voided + its other tickets
// reset to billing_queue + any not-yet-sent QBWC queue entry skipped) only if
// it's still pre-QB. Anything that's hit QB is left alone and reported back so
// the user knows to handle it on the QB side.
// ============================================================

// Invoice statuses that mean "already in QuickBooks" — never auto-retract these.
const INVOICE_IN_QB_STATUSES = ['so_created', 'invoiced', 'sent', 'paid'];

ticketsRouter.post('/:id/void',
  requirePermission('tickets:cancel'),
  async (req: Request, res: Response, next) => {
    try {
      const ticketId = req.params.id as string;
      const { reason } = req.body as { reason?: string };
      const voidReason = (reason || '').trim() || null;

      const ticket = await prisma.serviceTicket.findUnique({
        where: { id: ticketId },
        select: { id: true, ticketNumber: true, status: true, customData: true, billingGroupId: true },
      });
      if (!ticket) throw new AppError(404, 'Ticket not found');
      if (ticket.status === 'void') {
        res.json({ ok: true, alreadyVoid: true });
        return;
      }

      // Gather every invoice this ticket touches: line-item source link (the
      // path field/training invoices use) + the billing-group link (defensive).
      const candidateInvoiceIds = new Set<string>();
      const sourceLines = await prisma.invoiceLineItem.findMany({
        where: { sourceTicketId: ticketId },
        select: { invoiceId: true },
      });
      for (const li of sourceLines) if (li.invoiceId) candidateInvoiceIds.add(li.invoiceId);
      if (ticket.billingGroupId) {
        const grpInvoices = await prisma.invoice.findMany({
          where: { billingGroupId: ticket.billingGroupId },
          select: { id: true },
        });
        for (const inv of grpInvoices) candidateInvoiceIds.add(inv.id);
      }

      const candidates = candidateInvoiceIds.size
        ? await prisma.invoice.findMany({
            where: { id: { in: [...candidateInvoiceIds] } },
            select: {
              id: true, invoiceNumber: true, status: true,
              qbSalesOrderTxnId: true, qbSalesOrderNumber: true,
              qbInvoiceTxnId: true, qbInvoiceNumber: true,
              internalNotes: true, billingGroupId: true,
              lineItems: { select: { sourceTicketId: true }, distinct: ['sourceTicketId'] },
            },
          })
        : [];

      const retracted: Array<{ invoiceNumber: string }> = [];
      const locked: Array<{ invoiceNumber: string; status: string; qbNumber: string | null }> = [];

      await prisma.$transaction(async (tx) => {
        for (const inv of candidates) {
          if (inv.status === 'void') continue; // already gone

          const hitQb =
            !!inv.qbSalesOrderTxnId ||
            !!inv.qbInvoiceTxnId ||
            INVOICE_IN_QB_STATUSES.includes(inv.status);

          // A `queued` invoice has a QBWC sync entry — only safe to pull back if
          // QBWC hasn't transmitted it yet (entry still pending/error).
          let qbwcInFlight = false;
          if (!hitQb && inv.status === 'queued') {
            const transmitted = await tx.qbSyncQueue.count({
              where: { entityId: inv.id, status: { in: ['sent', 'success'] } },
            });
            qbwcInFlight = transmitted > 0;
          }

          if (hitQb || qbwcInFlight) {
            locked.push({
              invoiceNumber: inv.invoiceNumber,
              status: inv.status,
              qbNumber: inv.qbInvoiceNumber || inv.qbSalesOrderNumber || null,
            });
            continue;
          }

          // Retract: void the invoice, append the reason, skip any un-sent QBWC
          // queue entry, and free the OTHER tickets back into the Ready queue so
          // their billing isn't lost with the scrapped ticket.
          await tx.invoice.update({
            where: { id: inv.id },
            data: {
              status: 'void',
              internalNotes: inv.internalNotes
                ? `${inv.internalNotes}\n\nRetracted: ticket ${ticket.ticketNumber} voided${voidReason ? ` (${voidReason})` : ''}`
                : `Retracted: ticket ${ticket.ticketNumber} voided${voidReason ? ` (${voidReason})` : ''}`,
            },
          });
          await tx.qbSyncQueue.updateMany({
            where: { entityId: inv.id, status: { in: ['pending', 'error'] } },
            data: { status: 'skipped' },
          });

          const otherTicketIds = inv.lineItems
            .map(li => li.sourceTicketId)
            .filter((id): id is string => !!id && id !== ticketId);
          if (otherTicketIds.length) {
            await tx.serviceTicket.updateMany({
              where: { id: { in: otherTicketIds }, status: 'invoiced' },
              data: { status: 'billing_queue' },
            });
          }

          retracted.push({ invoiceNumber: inv.invoiceNumber });
        }

        const cd = (ticket.customData as Record<string, any> | null) || {};
        await tx.serviceTicket.update({
          where: { id: ticketId },
          data: {
            status: 'void',
            voidedAt: new Date(),
            voidedById: req.user!.userId,
            voidReason,
            customData: { ...cd, voidedFrom: ticket.status },
          },
        });
      });

      await createAuditLog({
        userId: req.user!.userId,
        entityType: 'service_ticket',
        entityId: ticketId,
        action: 'status_change',
        changes: {
          ticketNumber: ticket.ticketNumber,
          from: ticket.status,
          to: 'void',
          reason: reason || undefined,
          retractedInvoices: retracted.map(r => r.invoiceNumber),
          lockedInvoices: locked.map(l => l.invoiceNumber),
        },
        ipAddress: req.ip,
      });

      res.json({ ok: true, ticketNumber: ticket.ticketNumber, retracted, locked });
    } catch (err) {
      next(err);
    }
  },
);

// #5 POST /api/tickets/:id/discard-draft — hard-delete a DRAFT ticket. Lets a
// tech kill a stray/duplicate draft ("ope, not that one"). Draft-only and
// owner-scoped: field_tech may discard only their own draft; field_super /
// dispatch / platform_admin may discard any draft. Separate from the admin
// DELETE /:id (which is platform_admin-only and not draft-restricted) so that
// guard stays load-bearing.
ticketsRouter.post('/:id/discard-draft',
  requirePermission('tickets:edit_own'),
  async (req: Request, res: Response, next) => {
    try {
      const ticketId = req.params.id as string;

      const ticket = await prisma.serviceTicket.findUnique({
        where: { id: ticketId },
        select: { id: true, ticketNumber: true, status: true, assignedTechId: true },
      });
      if (!ticket) throw new AppError(404, 'Ticket not found');
      if (ticket.status !== 'draft') {
        throw new AppError(409, 'Only draft tickets can be discarded');
      }
      const elevated = ['field_super', 'dispatch', 'platform_admin'].includes(req.user!.role);
      if (!elevated && ticket.assignedTechId !== req.user!.userId) {
        throw new AppError(403, 'You can only discard your own drafts');
      }

      // Child cleanup in dependency order (same shape as the admin delete).
      await prisma.$transaction(async (tx) => {
        const lineItemIds = (await tx.ticketLineItem.findMany({
          where: { ticketId },
          select: { id: true },
        })).map(li => li.id);
        if (lineItemIds.length > 0) {
          await tx.ticketAssemblyPartsUsed.deleteMany({
            where: { ticketLineItemId: { in: lineItemIds } },
          });
        }
        await tx.fitTestRecord.deleteMany({ where: { ticketId } });
        await tx.ihTestRecord.deleteMany({ where: { ticketId } });
        await tx.trainingRosterRecord.deleteMany({ where: { ticketId } });
        await tx.airSystemInspection.deleteMany({ where: { ticketId } });
        await tx.ticketAttachment.deleteMany({ where: { ticketId } });
        await tx.ticketLineItem.deleteMany({ where: { ticketId } });
        await tx.serviceTicket.delete({ where: { id: ticketId } });
      });

      await createAuditLog({
        userId: req.user!.userId,
        entityType: 'ticket',
        entityId: ticketId,
        action: 'delete',
        changes: { ticketNumber: ticket.ticketNumber, status: 'draft', reason: 'discard_draft' },
        ipAddress: req.ip,
      });

      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);

// PUT /:id/reassign-location — move a ticket to a different pad/well/facility
// after the fact, regardless of ticket status. The normal edit path only
// allows changing location while a ticket is still a mutable draft on a
// tech's device (see sync.ts's 'update' case) — once submitted/closed/
// invoiced there's no other way to correct it. Built specifically for
// historical-data-cleanup mistakes (e.g. a fake "pad-as-well" record that
// got promoted to a real pad, whose tickets landed on the pad rather than
// a guessed sub-wellbore) — admin-only via the permission matrix, not a
// general ticket-editing feature.
ticketsRouter.put('/:id/reassign-location', requirePermission('tickets:reassign_location'), async (req: Request, res: Response, next) => {
  try {
    const { id } = req.params;
    const { padId, wellId, facilityId } = req.body as {
      padId?: string | null; wellId?: string | null; facilityId?: string | null;
    };
    if (padId === undefined && wellId === undefined && facilityId === undefined) {
      throw new AppError(400, 'Provide at least one of padId, wellId, facilityId');
    }

    const ticket = await prisma.serviceTicket.findUnique({
      where: { id: id as string },
      select: { id: true, companyId: true, fieldId: true, padId: true, wellId: true, facilityId: true },
    });
    if (!ticket) throw new AppError(404, 'Ticket not found');

    // undefined = "leave as-is"; null = "explicitly clear"; a string = "set to this."
    const nextPadId = padId !== undefined ? padId : ticket.padId;
    const nextWellId = wellId !== undefined ? wellId : ticket.wellId;
    const nextFacilityId = facilityId !== undefined ? facilityId : ticket.facilityId;

    const locationDisplay = await buildLocationDisplay({
      companyId: ticket.companyId,
      fieldId: ticket.fieldId,
      padId: nextPadId,
      wellId: nextWellId,
    });

    const updated = await prisma.serviceTicket.update({
      where: { id: id as string },
      data: { padId: nextPadId, wellId: nextWellId, facilityId: nextFacilityId, locationDisplay },
    });

    await createAuditLog({
      userId: req.user!.userId,
      entityType: 'ticket',
      entityId: id as string,
      action: 'update',
      changes: {
        reassignLocation: true,
        from: { padId: ticket.padId, wellId: ticket.wellId, facilityId: ticket.facilityId },
        to: { padId: nextPadId, wellId: nextWellId, facilityId: nextFacilityId },
      },
      ipAddress: req.ip,
    });

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// DEV ONLY: Override ticket status — skips state machine. Gated by NODE_ENV + platform_admin.
ticketsRouter.patch('/:id/dev-override-status', async (req: Request, res: Response) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({ error: 'Dev override not available in production' });
  }
  if (req.user?.role !== 'platform_admin') {
    return res.status(403).json({ error: 'Dev override requires platform_admin' });
  }

  const { id } = req.params;
  const { status } = req.body as { status: TicketStatus };

  if (!status) {
    return res.status(400).json({ error: 'status is required' });
  }

  const ticket = await prisma.serviceTicket.findUnique({ where: { id: id as string } });
  if (!ticket) {
    return res.status(404).json({ error: 'Ticket not found' });
  }

  const updated = await prisma.serviceTicket.update({
    where: { id: id as string },
    data: { status },
  });

  await createAuditLog({
    userId: req.user!.userId,
    entityType: 'ticket',
    entityId: id as string,
    action: 'update',
    changes: { devOverride: true, from: ticket.status, to: status },
    ipAddress: req.ip,
  });

  res.json(updated);
});

// Recalculate ticket subtotal/total from line items
async function recalcTicketTotals(ticketId: string) {
  const items = await prisma.ticketLineItem.findMany({
    where: { ticketId },
    select: { total: true },
  });

  const subtotal = items.reduce((sum, item) => {
    return sum + (item.total ? Number(item.total) : 0);
  }, 0);

  await prisma.serviceTicket.update({
    where: { id: ticketId },
    data: { subtotal, total: subtotal }, // tax added later by QB
  });
}
