import { rentalVisitEquipment } from '../services/rentalVisitEquipment.js';
import { appendRentalEventLog } from '../services/rentalEventLog.js';
import { validateRentalInput } from '../services/writeValidation.js';
import { Router, Request, Response } from 'express';
import { prisma } from '../db.js';
import { Prisma } from '../db.js';
import { AppError } from '../middleware/errorHandler.js';
import { requirePermission } from '../middleware/rbac.js';
import { roleHasCapability } from '../services/permissions.js';
import { listRentalsForRelease, recallReleases, releaseRentals, summarizeReleases } from '../services/rentalBillingRelease.js';
import { createAuditLog } from '../utils/auditLog.js';
import { CREDIT_HOLD_MESSAGE } from '../utils/companyGuards.js';
import { generateRentalAgreementNumber, generateTicketNumber } from '../utils/ticketNumber.js';
import { deriveRentalFlags, correctBomExtras, bomExtraKey, type BomExtraCorrection } from '../services/rentalComposition.js';
import type { RentalComposition } from '../services/rentalComposition.js';
import { generateRentalAgreementPdf } from '../services/rentalAgreementPdfGenerator.js';
import { emitEvent } from '../services/eventBus.js';
import { WEBHOOK_CHANNELS, resolveWebhook, type RingCentralChannel } from '../services/webhookSettings.js';
import { computeRentalBillingState } from '../services/rentalBilling.js';
import { parseRentalBillingPolicy } from '../services/rentalBillingPolicy.js';
import { validateLineInput } from '../services/ticketWritePolicy.js';
import { numberValue } from '../services/writeValidation.js';
import { runAndCacheReviewSignal } from '../services/ticketReviewRules.js';
import { saveManualRentalVisit } from '../services/manualRentalVisit.js';

import { withRental, deployRentalItem, returnRentalItem, closeRental, rentalDate, rentalToday } from '../services/rentalLifecycle.js';

export const rentalsRouter = Router();

rentalsRouter.post('/:id/equipment-visit', requirePermission('tickets:create'), async (req: Request, res: Response, next) => {
  try {
    res.status(201).json(await saveManualRentalVisit(req.params.id as string, req.body, req.user!.userId, req.ip));
  } catch (err) { next(err); }
});

// ============================================================
// SEND FOR BILLING (services/rentalBillingRelease.ts)
// Declared before '/:id' so "billing-release" is never read as an id.
// ============================================================

function selectedIds(body: any): string[] {
  const ids = Array.isArray(body?.ids) ? body.ids.filter((v: unknown): v is string => typeof v === 'string' && !!v) : [];
  if (!ids.length) throw new AppError(400, 'Select at least one rental');
  if (ids.length > 500) throw new AppError(400, 'Too many rentals selected at once');
  return ids;
}

// GET /api/rentals/billing-release/summary — counts for the dashboard banner
// and the tab badge. Each side sees only its own numbers: the field's (unsent,
// waiting on approvals) need rentals:release_billing, AR's (sent, not invoiced)
// need page:billing. Anyone else gets null rather than a 403, since the
// dashboard asks on every load.
rentalsRouter.get('/billing-release/summary', async (req: Request, res: Response, next) => {
  try {
    const field = roleHasCapability(req.user?.role, 'rentals:release_billing');
    const billing = roleHasCapability(req.user?.role, 'page:billing');
    if (!field && !billing) { res.json({ data: null }); return; }
    const s = summarizeReleases(await listRentalsForRelease());
    res.json({ data: {
      unsent: field ? s.unsent : 0,
      closedBlocked: field ? s.closedBlocked : 0,
      needsSending: field ? s.needsSending : 0,
      awaitingInvoice: billing ? s.awaitingInvoice : 0,
    } });
  } catch (err) { next(err); }
});

// GET /api/rentals/billing-release — every rental that owes billing and where
// it sits (not sent / sent / closed waiting on approvals / closed ready).
rentalsRouter.get('/billing-release', requirePermission('rentals:release_billing'), async (_req: Request, res: Response, next) => {
  try { res.json({ data: await listRentalsForRelease() }); } catch (err) { next(err); }
});

// POST /api/rentals/billing-release  { ids, force?, reason? }
// A normal send needs rentals:release_billing and passes the approval gate.
// { force: true } needs rentals:force_billing_release plus a reason, and skips it.
rentalsRouter.post('/billing-release',
  (req, res, next) => requirePermission(req.body?.force === true ? 'rentals:force_billing_release' : 'rentals:release_billing')(req, res, next),
  async (req: Request, res: Response, next) => {
    try {
      const ids = selectedIds(req.body);
      const force = req.body.force === true;
      const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
      if (force && !reason) throw new AppError(400, 'A reason is required to force a rental into billing');
      const results = await releaseRentals({ ids, userId: req.user!.userId, force: force ? { reason } : undefined });
      for (const r of results) {
        if (!r.success) continue;
        await createAuditLog({ userId: req.user!.userId, entityType: 'rental_agreement', entityId: r.id, action: 'status_change',
          changes: { billingReleasedThrough: r.releasedThrough, ...(force ? { forced: true, reason } : {}) }, ipAddress: req.ip });
      }
      res.json({ results });
    } catch (err) { next(err); }
  });

// POST /api/rentals/billing-release/recall  { ids } — take back a send AR has
// not invoiced yet. Either release capability may recall.
rentalsRouter.post('/billing-release/recall',
  (req, res, next) => requirePermission(roleHasCapability(req.user?.role, 'rentals:release_billing') ? 'rentals:release_billing' : 'rentals:force_billing_release')(req, res, next),
  async (req: Request, res: Response, next) => {
    try {
      const results = await recallReleases(selectedIds(req.body));
      for (const r of results) {
        if (!r.success) continue;
        await createAuditLog({ userId: req.user!.userId, entityType: 'rental_agreement', entityId: r.id, action: 'status_change',
          changes: { billingReleasedThrough: null, recalled: true }, ipAddress: req.ip });
      }
      res.json({ results });
    } catch (err) { next(err); }
  });

rentalsRouter.get('/dispatch-options', async (_req, res, next) => {
  try {
    const channels = await Promise.all(WEBHOOK_CHANNELS.filter(channel => channel === 'rentals').map(async channel => {
      const destination = await resolveWebhook(channel);
      return { channel, available: destination.enabled && !!destination.url };
    }));
    res.json({ channels: channels.filter(row => row.available) });
  } catch (err) { next(err); }
});



// Swap keeps the billable rental item in place; serial history belongs to the
// linked ticket. Splitting the item would restart weekly/monthly billing.
rentalsRouter.post('/:id/swap', requirePermission('tickets:create'), async (req: Request, res: Response, next) => {
  try {
    const rentalId = req.params.id as string;
    const { requestId, swaps, reason, lineItems = [], serviceDate } = req.body;
    const swapDate = serviceDate === undefined ? rentalToday() : rentalDate(serviceDate, 'serviceDate');
    if (swapDate > rentalToday()) throw new AppError(400, 'Swap date cannot be in the future');
    if (typeof requestId !== 'string' || !/^[0-9a-f-]{36}$/i.test(requestId)
      || (reason != null && (typeof reason !== 'string' || reason.length > 10000))
      || !Array.isArray(swaps) || !swaps.length || swaps.length > 100) {
      throw new AppError(400, 'A request ID and equipment swaps are required; reason must be text if provided');
    }
    const swapReason = reason?.trim() || '';
    if (!Array.isArray(lineItems) || lineItems.length > 100) throw new AppError(400, 'Invalid billing lines');
    const itemIds = new Set<string>();
    const replacementIds = new Set<string>();
    for (const swap of swaps) {
      if (!swap || typeof swap.itemId !== 'string' || typeof swap.replacementEquipmentId !== 'string'
        || !['available', 'repair'].includes(swap.returnStatus)
        || itemIds.has(swap.itemId) || replacementIds.has(swap.replacementEquipmentId)) {
        throw new AppError(400, 'Each deployed item and replacement must be unique; choose a return condition');
      }
      itemIds.add(swap.itemId);
      replacementIds.add(swap.replacementEquipmentId);
    }
    const ticketNumber = await generateTicketNumber('field_service');
    const ticket = await prisma.$transaction(async tx => {
      // Serialize swaps and agreement closure on the same rental.
      await tx.$queryRaw`SELECT id FROM rental_agreements WHERE id = ${rentalId} FOR UPDATE`;
      const prior = await tx.serviceTicket.findUnique({ where: { id: requestId } });
      if (prior) {
        if (prior.linkedRentalAgreementId !== rentalId || prior.createdById !== req.user!.userId
          || (prior.customData as any)?.workType !== 'rental_swap') throw new AppError(409, 'Request ID already used');
        return prior;
      }
      const billingLines = [];
      for (const line of lineItems) {
        if (!line || typeof line !== 'object' || Array.isArray(line) || line.rate == null) throw new AppError(400, 'Enter a rate on each billing line (zero is allowed)');
        billingLines.push(await validateLineInput({
          lineType: line.lineType, productId: line.productId || undefined, partNumber: line.partNumber,
          description: line.description, quantity: line.quantity, rate: line.rate,
          unitOfMeasure: line.unitOfMeasure, notes: line.notes,
          ...(line.priceLevelName ? { customData: { priceLevel: { name: line.priceLevelName,
            listRate: line.listRate ?? null, contractRate: line.contractRate ?? line.rate } } } : {}),
        }));
      }
      const subtotal = billingLines.reduce((sum, line) => sum.add(line.total), new Prisma.Decimal(0));
      numberValue(subtotal.toNumber(), 'ticket total');
      const recordOnly = subtotal.isZero();
      const rental = await tx.rentalAgreement.findUnique({ where: { id: rentalId } });
      if (!rental) throw new AppError(404, 'Rental agreement not found');
      if (rental.status !== 'active') throw new AppError(409, 'Only an open, active rental can be swapped');
      const records = [];
      for (const swap of swaps) {
        const item = await tx.rentalAgreementItem.findUnique({ where: { id: swap.itemId }, include: { serializedEquipment: true, product: true } });
        if (!item || item.rentalAgreementId !== rentalId || item.status !== 'deployed') throw new AppError(409, 'Selected item is no longer deployed on this rental');
        if (swapDate < item.deployedDate) throw new AppError(400, 'Swap date cannot precede deployment');
        const replacement = await tx.serializedEquipment.findUnique({ where: { id: swap.replacementEquipmentId } });
        if (!replacement || replacement.productId !== item.productId) throw new AppError(400, 'Replacement must be the same catalog product (like-for-like)');
        const claimed = await tx.serializedEquipment.updateMany({
          where: { id: replacement.id, status: 'available', currentRentalId: null },
          data: { status: 'rented', currentRentalId: rentalId, currentCustomerId: rental.companyId },
        });
        if (claimed.count !== 1) throw new AppError(409, 'Replacement equipment is no longer available');
        const released = await tx.serializedEquipment.updateMany({
          where: { id: item.serializedEquipmentId, currentRentalId: rentalId, status: { in: ['rented', 'deployed'] } },
          data: { status: swap.returnStatus, currentRentalId: null, currentCustomerId: null },
        });
        if (released.count !== 1) throw new AppError(409, 'Outgoing equipment is no longer deployed on this rental');
        const changed = await tx.rentalAgreementItem.updateMany({
          where: { id: item.id, status: 'deployed', serializedEquipmentId: item.serializedEquipmentId },
          data: { serializedEquipmentId: replacement.id, deployInspection: swap.deployInspection ?? Prisma.JsonNull },
        });
        if (changed.count !== 1) throw new AppError(409, 'Rental item changed; reload before swapping');
        records.push({ itemId: item.id, productId: item.productId, productName: item.product.name,
          outgoingEquipmentId: item.serializedEquipmentId, outgoingSerial: item.serializedEquipment.serialNumber,
          replacementEquipmentId: replacement.id, replacementSerial: replacement.serialNumber, returnStatus: swap.returnStatus });
      }
      const now = new Date();
      const description = `Equipment swap${swapReason ? ` — ${swapReason}` : ''}\n${records.map(r => `${r.productName}: ${r.outgoingSerial} → ${r.replacementSerial} (returned ${r.returnStatus})`).join('\n')}`;
      const created = await tx.serviceTicket.create({ data: {
        id: requestId, ticketNumber, ticketType: 'field_service', serviceSubtype: 'general', division: 'D4',
        status: recordOnly ? 'closed' : 'supervisor_review', companyId: rental.companyId, fieldId: rental.fieldId, padId: rental.padId,
        wellId: rental.wellId, facilityId: rental.facilityId, linkedRentalAgreementId: rentalId,
        serviceDate: swapDate, completedAt: now, assignedTechId: req.user!.userId, createdById: req.user!.userId,
        poNumber: rental.poNumber, afeNumber: rental.afeNumber, workDescription: description,
        subtotal, total: subtotal,
        lineItems: { create: billingLines.map((line, index) => ({ ...line, lineNumber: index + 1, sortOrder: index,
          notes: line.notes?.trim() || (line.lineType === 'labor' || line.partNumber === '406' || /^0[0-9]00002$/.test(line.partNumber || '') ? description : undefined),
        })) },
        customData: { workType: 'rental_swap', recordOnly, swaps: records, reason: swapReason },
      } });
      await appendRentalEventLog(tx, created);
      await tx.auditLog.create({ data: { userId: req.user!.userId, entityType: 'rental_agreement', entityId: rentalId,
        action: 'update', changes: { ticketId: created.id, swaps: records, serviceDate: swapDate.toISOString().slice(0, 10) }, ipAddress: req.ip } });
      return created;
    }, { maxWait: 10000, timeout: 30000 });
    if (ticket.status === 'supervisor_review') {
      try { await runAndCacheReviewSignal(ticket.id); }
      catch (err) { console.error(`[rentals/swap] Failed to cache review signal for ${ticket.id}:`, err); }
    }
    res.status(201).json(ticket);
  } catch (err) { next(err); }
});

/** Coerce a client-sent wellIds payload into a clean string[] for JSONB. */
function normalizeWellIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === 'string' && v.length > 0);
}

// ============================================================
// LIST RENTAL AGREEMENTS
// ============================================================

// GET /api/rentals
rentalsRouter.get('/', async (req: Request, res: Response, next) => {
  try {

    const { status, companyId, search, limit = '50', offset = '0' } = req.query;
    const where: any = {};

    if (status && status !== 'all') {
      where.status = status as string;
    }
    if (companyId) {
      where.companyId = companyId as string;
    }
    if (search) {
      where.OR = [
        { agreementNumber: { contains: search as string, mode: 'insensitive' } },
        { company: { name: { contains: search as string, mode: 'insensitive' } } },
      ];
    }

    const [agreements, total] = await Promise.all([
      prisma.rentalAgreement.findMany({
        where,
        include: {
          company: { select: { id: true, name: true } },
          field: { select: { id: true, name: true } },
          pad: { select: { id: true, name: true } },
          well: { select: { id: true, wellName: true } },
          _count: { select: { items: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: parseInt(limit as string, 10),
        skip: parseInt(offset as string, 10),
      }),
      prisma.rentalAgreement.count({ where }),
    ]);

    res.json({ data: agreements, total });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// GET SINGLE AGREEMENT
// ============================================================

// GET /api/rentals/:id
rentalsRouter.get('/:id', async (req: Request, res: Response, next) => {
  try {
    const agreement = await prisma.rentalAgreement.findUnique({
      where: { id: req.params.id as string },
      include: {
        company: { select: { id: true, name: true } },
        field: { select: { id: true, name: true } },
        pad: { select: { id: true, name: true } },
        well: { select: { id: true, wellName: true } },
        items: {
          include: {
            product: { select: { id: true, name: true, partNumber: true, category: true } },
            serializedEquipment: { select: { id: true, serialNumber: true, status: true, conditionNotes: true, customData: true } },
          },
          orderBy: { deployedDate: 'asc' },
        },
        linkedServiceTickets: {
          select: {
            id: true,
            ticketNumber: true,
            ticketType: true,
            serviceSubtype: true,
            status: true,
            serviceDate: true,
            dispatchNotes: true,
            workDescription: true,
            internalNotes: true,
            assignedTech: { select: { id: true, name: true } },
          },
          orderBy: { serviceDate: 'desc' },
        },
      },
    });

    if (!agreement) throw new AppError(404, 'Rental agreement not found');

    const invoices = await prisma.invoice.findMany({
      where: { rentalAgreementId: agreement.id, status: { not: 'void' } },
      select: { periodEnd: true },
    });
    const billingState = computeRentalBillingState(agreement, invoices);

    res.json({ ...agreement, ...billingState, visitEquipment: rentalVisitEquipment(agreement) });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// EXPORT AGREEMENT AS PDF
// ============================================================

// GET /api/rentals/:id/pdf — download the rental agreement document as PDF
rentalsRouter.get('/:id/pdf', async (req: Request, res: Response, next) => {
  try {
    const agreement = await prisma.rentalAgreement.findUnique({
      where: { id: req.params.id as string },
      include: {
        company: { select: { id: true, name: true } },
        field: { select: { id: true, name: true } },
        pad: { select: { id: true, name: true } },
        well: { select: { id: true, wellName: true } },
        items: {
          include: {
            product: { select: { id: true, name: true, partNumber: true, category: true } },
            serializedEquipment: { select: { id: true, serialNumber: true } },
          },
          orderBy: { deployedDate: 'asc' },
        },
      },
    });

    if (!agreement) throw new AppError(404, 'Rental agreement not found');

    const fileName = `rental-${agreement.agreementNumber}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);

    const pdfDoc = await generateRentalAgreementPdf(agreement as any);
    pdfDoc.pipe(res);
    pdfDoc.end();
  } catch (err) {
    next(err);
  }
});

// ============================================================
// CREATE AGREEMENT
// ============================================================

// POST /api/rentals
rentalsRouter.post('/', async (req: Request, res: Response, next) => {
  try {
    validateRentalInput(req.body, true);
    const {
      companyId, fieldId, padId, wellId, wellIds,
      billingRateType, startDate, poNumber, afeNumber, notes,
      isManned, isRigJob, monitorsIncluded,
      composition, // #C dispatch-time spec/BOM; derives the booleans below
      pics, // #1 PIC roster — seeded at dispatch from the on-site contact
      status, // Phase C: 'scheduled' for dispatch, 'active' for legacy/full create
      pickupType, // 'dispatch' (default) | 'walk_in' — counter rental w/ signature at pickup
      siteId, // the shop running this rental; falls back to the dispatcher's home site
      items,  // Array of { serializedEquipmentId, productId, rate, rateType }
      // Liability waiver + site contact (legacy — Phase C dispatch path doesn't capture)
      liabilityAcknowledged, liabilitySignedByName, liabilitySignature, liabilitySignedAt,
      siteContactName, siteContactPhone, siteContactEmail,
      // Phase C dispatch capture
      personCallingName, personCallingPhone, personCallingEmail,
      assignedTechId, ringCentralChannel,
    } = req.body;

    if (!companyId || !billingRateType) {
      throw new AppError(400, 'companyId and billingRateType are required');
    }

    const resolvedPickupType: 'dispatch' | 'walk_in' =
      pickupType === 'walk_in' ? 'walk_in' : 'dispatch';

    // Walk-in invariants: signed liability waiver + at least one item must be deployed
    // immediately. Walk-ins always start active — there is no "scheduled" walk-in.
    if (resolvedPickupType === 'walk_in') {
      if (typeof personCallingName !== 'string' || !personCallingName.trim()) throw new AppError(400, 'Walk-in rentals require the renting person/contact');
      if (!liabilitySignedByName || !liabilitySignature || !liabilityAcknowledged) {
        throw new AppError(400, 'Walk-in rentals require a signed liability waiver');
      }
      if (!items || !Array.isArray(items) || items.length === 0) {
        throw new AppError(400, 'Walk-in rentals require at least one item');
      }
    }

    // Validate company — and block new work for deactivated customers.
    const company = await prisma.company.findUnique({ where: { id: companyId }, select: { id: true, isActive: true, creditHold: true, name: true } });
    if (!company) throw new AppError(404, 'Company not found');
    if (!company.isActive) {
      throw new AppError(409, `${company.name} is inactive — reactivate the customer to create new work.`);
    }
    // A rental is equipment leaving on credit — same block as a new ticket.
    if (company.creditHold) {
      throw new AppError(409, CREDIT_HOLD_MESSAGE);
    }

    if (assignedTechId != null) {
      if (typeof assignedTechId !== 'string') throw new AppError(400, 'Invalid assigned tech');
      const tech = await prisma.user.findUnique({ where: { id: assignedTechId }, select: { isActive: true } });
      if (!tech?.isActive) throw new AppError(400, 'Select an active assigned tech');
    }
    // Older clients selected Dispatch for rental creation. Route that selection
    // to the dedicated rental destination as well during the rollout.
    const rentalChannel = ringCentralChannel === 'dispatch' ? 'rentals' : ringCentralChannel;
    if (rentalChannel != null) {
      if (rentalChannel !== 'rentals') throw new AppError(400, 'Select the Rental creation channel');
      const destination = await resolveWebhook(rentalChannel);
      if (!destination.enabled || !destination.url) throw new AppError(400, 'Selected RingCentral channel is unavailable');
    }
    const deployTicketNumber = resolvedPickupType === 'dispatch' && assignedTechId ? await generateTicketNumber('field_service') : null;
    const agreementNumber = await generateRentalAgreementNumber();
    const resolvedStartDate = startDate ? rentalDate(startDate, 'startDate') : new Date();
    // If caller didn't pass status, infer: future start_date with no items = scheduled,
    // otherwise active. Lazy auto-flip on /rentals reads handles the date arrival.
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);
    // Walk-ins are never "scheduled" — they are signed-and-deployed at the counter.
    const inferredStatus: 'scheduled' | 'active' =
      resolvedPickupType === 'walk_in'
        ? 'active'
        : (status === 'scheduled' || status === 'active')
          ? status
          : (resolvedStartDate > todayEnd && (!items || items.length === 0) ? 'scheduled' : 'active');

    const userId = (req as any).user?.userId ?? null;

    // Which shop runs this rental. An explicit siteId wins (a Williston
    // dispatcher can write a Dickinson job); otherwise it's the dispatcher's
    // home site. Left null when neither is known rather than guessed — a wrong
    // site puts the card on the wrong wall board, which is worse than no card.
    const resolvedSiteId: string | null = siteId
      ? siteId
      : userId
        ? (await prisma.user.findUnique({
            where: { id: userId }, select: { homeSiteId: true },
          }))?.homeSiteId ?? null
        : null;

    // Create in transaction — agreement + items + equipment status updates
    const agreement = await prisma.$transaction(async (tx) => {
      const ra = await tx.rentalAgreement.create({
        data: {
          agreementNumber,
          companyId,
          fieldId: fieldId || undefined,
          padId: padId || undefined,
          // wellIds = full multi-select; wellId stays as the primary/legacy well.
          wellIds: normalizeWellIds(wellIds),
          wellId: wellId || (Array.isArray(wellIds) && wellIds.length ? wellIds[0] : undefined),
          billingRateType,
          startDate: resolvedStartDate,
          endDate: req.body.endDate ? new Date(req.body.endDate) : undefined,
          poNumber: poNumber || undefined,
          afeNumber: afeNumber || undefined,
          notes: notes || undefined,
          status: inferredStatus,
          pickupType: resolvedPickupType,
          createdById: userId,
          siteId: resolvedSiteId ?? undefined,
          // #C composition spec/BOM; booleans below derived from it when present
          composition: composition ?? undefined,
          // #1 PIC roster — seeded at dispatch (from the on-site contact) so the
          // manned-trailer ticket inherits a non-empty roster.
          pics: pics ?? undefined,
          // Billing classification — derived from composition when supplied,
          // else the legacy client-sent booleans.
          ...(deriveRentalFlags(composition) ?? {
            isManned: isManned ?? true,
            isRigJob: isRigJob ?? false,
            monitorsIncluded: monitorsIncluded ?? false,
          }),
          // Liability waiver
          liabilityAcknowledged: liabilityAcknowledged ?? false,
          liabilitySignedByName: liabilitySignedByName || undefined,
          liabilitySignature: liabilitySignature || undefined,
          liabilitySignedAt: liabilitySignedAt ? new Date(liabilitySignedAt) : undefined,
          // Site contact
          siteContactName: siteContactName || undefined,
          siteContactPhone: siteContactPhone || undefined,
          siteContactEmail: siteContactEmail || undefined,
          // Person calling (Phase C dispatch)
          personCallingName: personCallingName || undefined,
          personCallingPhone: personCallingPhone || undefined,
          personCallingEmail: personCallingEmail || undefined,
        },
      });

      if (Array.isArray(items)) {
        for (const item of [...items].sort((a, b) => a.serializedEquipmentId.localeCompare(b.serializedEquipmentId))) {
          await deployRentalItem(tx, ra, { ...item, deployedDate: item.deployedDate || startDate });
        }
      }
      if (deployTicketNumber) await tx.serviceTicket.create({ data: {
        ticketNumber: deployTicketNumber, ticketType: 'field_service', serviceSubtype: 'general', division: 'D4',
        status: 'dispatched', companyId, fieldId: ra.fieldId, padId: ra.padId, wellId: ra.wellId,
        linkedRentalAgreementId: ra.id, assignedTechId, createdById: userId,
        dispatchedById: userId, dispatchedAt: new Date(), serviceDate: resolvedStartDate,
        poNumber: ra.poNumber, afeNumber: ra.afeNumber, dispatchNotes: notes || undefined,
        workDescription: `Deploy rental ${ra.agreementNumber}`,
        customData: { workType: 'rental_deploy', dispatchNotificationDivision: 'D4' },
      } });
      return ra;
    });

    await createAuditLog({
      userId: req.user!.userId,
      entityType: 'rental_agreement',
      entityId: agreement.id,
      action: 'create',
      changes: { agreementNumber: agreement.agreementNumber, companyId, itemCount: items?.length ?? 0 },
      ipAddress: req.ip,
    });

    // Fetch full agreement with relations
    const full = await prisma.rentalAgreement.findUnique({
      where: { id: agreement.id },
      include: {
        company: { select: { id: true, name: true } },
        items: {
          include: {
            product: { select: { id: true, name: true, partNumber: true } },
            serializedEquipment: { select: { id: true, serialNumber: true } },
          },
        },
      },
    });

    void emitEvent('rental.agreement.created', {
      ringCentralChannel: 'rentals' as RingCentralChannel,
      agreementId: agreement.id,
      agreementNumber: agreement.agreementNumber,
      companyId,
      companyName: company.name,
      pickupType: resolvedPickupType,
      status: full?.status || inferredStatus,
      createdByUserId: userId,
      composition: (composition as RentalComposition | undefined) ?? null,
      items: (full?.items ?? []).map(i => ({ productName: i.product?.name ?? 'Equipment' })),
    });

    res.status(201).json(full);
  } catch (err) {
    next(err);
  }
});

// ============================================================
// UPDATE AGREEMENT
// ============================================================

// PUT /api/rentals/:id
// Sup+ can correct ANYTHING on an agreement (the UI requires a reason and
// appends it to notes). Status stays out — complete/cancel have their own
// routes with side effects (equipment returns, end dates).
rentalsRouter.put('/:id/billing-policy', requirePermission('rentals:edit'), async (req: Request, res: Response, next) => {
  try {
    const policy = parseRentalBillingPolicy({ pauses: req.body.pauses, ticketRates: req.body.ticketRates });
    const id = req.params.id as string;
    const { existing, updated } = await withRental(id, async (tx, existing) => {
      if (existing.status === 'cancelled') throw new AppError(400, 'Rental agreement is cancelled');
      const prior = parseRentalBillingPolicy(existing.billingPolicy);
      if (prior.compositionHistory?.length) policy.compositionHistory = prior.compositionHistory;
      const latest = prior.rateChanges?.at(-1) || prior.ticketRates;
      // The initial agreed rates remain the baseline. Subsequent edits are dated,
      // so a new unmanned price cannot rewrite earlier manned/unmanned days.
      if (latest && policy.ticketRates && (latest.manned !== policy.ticketRates.manned || latest.unmanned !== policy.ticketRates.unmanned)) {
        const effectiveDate = rentalDate(req.body.effectiveDate, 'rate effective date').toISOString().slice(0, 10);
        if (prior.rateChanges?.some(c => c.effectiveDate >= effectiveDate)) throw new AppError(409, 'Rate changes must follow existing rate history');
        const billed = await tx.invoice.findFirst({ where: { rentalAgreementId: id, status: { not: 'void' }, periodEnd: { gte: new Date(effectiveDate) } } });
        if (billed) throw new AppError(409, `Rate change overlaps ${billed.invoiceNumber}; void/correct it first`);
        policy.rateChanges = [...(prior.rateChanges || []), { effectiveDate, ...policy.ticketRates }];
        policy.ticketRates = prior.ticketRates;
      } else if (prior.rateChanges?.length) {
        if (!policy.ticketRates) throw new AppError(409, 'Cannot remove dated rate history; use a new agreement to change pricing models');
        policy.ticketRates = prior.ticketRates;
        policy.rateChanges = prior.rateChanges;
      }
      const updated = await tx.rentalAgreement.update({ where: { id }, data: { billingPolicy: policy } });
      return { existing, updated };
    });
    await createAuditLog({ userId: req.user?.userId, entityType: 'rental_agreement', entityId: id,
      action: 'update', changes: { billingPolicy: { before: existing.billingPolicy, after: policy } }, ipAddress: req.ip });
    res.json(updated);
  } catch (err) { next(err); }
});

// PUT /api/rentals/:id/bom-extras
// Price, recount, or drop the over-baseline extras deploy recorded. Without
// this an unpriced extra blocks every invoice on the rental with no way out:
// the general edit carries extras through untouched, and a composition edit
// only adds a dated window, leaving the earlier days still unpriced.
rentalsRouter.put('/:id/bom-extras', requirePermission('rentals:edit'), async (req: Request, res: Response, next) => {
  try {
    const id = req.params.id as string;
    const raw = req.body?.extras;
    if (!Array.isArray(raw) || raw.length > 100) throw new AppError(400, 'extras must be a list');
    const corrections: BomExtraCorrection[] = raw.map((e: any) => {
      if (!e || typeof e.key !== 'string' || !e.key) throw new AppError(400, 'Each extra needs its key');
      if (e.rate !== null && !(typeof e.rate === 'number' && Number.isFinite(e.rate) && e.rate >= 0)) throw new AppError(400, 'Rate must be zero or more, or blank');
      if (!Number.isInteger(e.qty) || e.qty < 1 || e.qty > 1000) throw new AppError(400, 'Quantity must be a whole number from 1 to 1000');
      return { key: e.key, rate: e.rate, qty: e.qty };
    });
    const { existing, updated } = await withRental(id, async (tx, existing) => {
      if (existing.status === 'cancelled') throw new AppError(400, 'Rental agreement is cancelled');
      const current = (existing.composition || {}) as RentalComposition;
      const known = new Set((current.bomExtras || []).map(bomExtraKey));
      if (corrections.some(c => !known.has(c.key))) throw new AppError(409, 'Extras changed; reload the rental');
      // Extras reprice every billed day, so nothing may already be invoiced.
      const billed = await tx.invoice.findFirst({ where: { rentalAgreementId: id, status: { not: 'void' } } });
      if (billed) throw new AppError(409, `Rental is already billed on ${billed.invoiceNumber}; void/correct it first`);
      const policy = parseRentalBillingPolicy(existing.billingPolicy);
      if (policy.compositionHistory?.length) {
        policy.compositionHistory = policy.compositionHistory.map(w => ({ ...w, composition: correctBomExtras(w.composition, corrections, known) }));
      }
      const updated = await tx.rentalAgreement.update({ where: { id }, data: {
        composition: correctBomExtras(current, corrections) as Prisma.InputJsonValue, billingPolicy: policy as Prisma.InputJsonValue,
      } });
      return { existing, updated };
    });
    await createAuditLog({ userId: req.user?.userId, entityType: 'rental_agreement', entityId: id, action: 'update',
      changes: { bomExtras: { before: (existing.composition as RentalComposition | null)?.bomExtras ?? [], after: (updated.composition as RentalComposition | null)?.bomExtras ?? [] } },
      ipAddress: req.ip });
    res.json(updated);
  } catch (err) { next(err); }
});

rentalsRouter.put('/:id', async (req: Request, res: Response, next) => {
  try {
    validateRentalInput(req.body, false);
    const {
      poNumber, afeNumber, notes, fieldId, padId, wellId, wellIds, pics, composition: requestedComposition,
      companyId, startDate, billingRateType, billingCadence,
      personCallingName, personCallingPhone, personCallingEmail,
      siteContactName, siteContactPhone, siteContactEmail,
    } = req.body;

    let correctedBillingPolicyBefore: Prisma.JsonValue | undefined;
    const updated = await withRental(req.params.id as string, async (tx, existing) => {

    const composition = requestedComposition !== undefined && (existing.composition as any)?.manualEquipment
      ? { ...requestedComposition, manualEquipment: (existing.composition as any).manualEquipment } : requestedComposition;

    // Reassigning the customer: validate the target, and force the caller to
    // send the location explicitly (old field/pad/well belong to the old
    // company — silently keeping them would cross-wire the location tree).
    if (companyId !== undefined && companyId !== existing.companyId) {
      const company = await tx.company.findUnique({ where: { id: companyId }, select: { id: true } });
      if (!company) throw new AppError(404, 'Target company not found');
      if (fieldId === undefined && padId === undefined && wellId === undefined) {
        throw new AppError(400, 'Changing the customer requires re-sending the location (fieldId/padId/wellId — null to clear)');
      }
    }

    if (billingRateType !== undefined && !['daily', 'weekly', 'monthly'].includes(billingRateType)) {
      throw new AppError(400, 'billingRateType must be daily, weekly, or monthly');
    }
    if (billingCadence !== undefined && !['daily', 'weekly', 'monthly'].includes(billingCadence)) {
      throw new AppError(400, 'billingCadence must be daily, weekly, or monthly');
    }
    if (startDate !== undefined && isNaN(new Date(startDate).getTime())) {
      throw new AppError(400, 'Invalid startDate');
    }

    let billingPolicy: ReturnType<typeof parseRentalBillingPolicy> | undefined;
    const correctComposition = req.body.compositionCorrection === true;
    if (correctComposition && (!composition || typeof composition !== 'object' || Array.isArray(composition))) throw new AppError(400, 'Send the corrected rental charges');
    if (correctComposition && (typeof req.body.reason !== 'string' || !req.body.reason.trim())) throw new AppError(400, 'A reason is required to correct rental billing');
    if (correctComposition) {
      const billed = await tx.invoice.findFirst({ where: { rentalAgreementId: existing.id, status: { not: 'void' } } });
      if (billed) throw new AppError(409, `Rental is already billed on ${billed.invoiceNumber}; void/correct it first`);
      billingPolicy = parseRentalBillingPolicy(existing.billingPolicy);
      correctedBillingPolicyBefore = existing.billingPolicy;
      // A correction describes what was ordered from day one. Rebuild the
      // billing baseline even when today's composition already looks correct.
      billingPolicy.compositionHistory = [{ effectiveDate: '0001-01-01', composition }];
    } else if (composition !== undefined && JSON.stringify(composition) !== JSON.stringify(existing.composition)) {
      const effectiveDate = rentalDate(req.body.effectiveDate, 'composition effective date').toISOString().slice(0, 10);
      billingPolicy = parseRentalBillingPolicy(existing.billingPolicy);
      if (!existing.composition || typeof existing.composition !== 'object' || Array.isArray(existing.composition)) throw new AppError(409, 'Use a new agreement to change from per-item to composition pricing');
      if (billingPolicy.compositionHistory?.some(c => c.effectiveDate >= effectiveDate)) throw new AppError(409, 'Composition changes must follow existing history');
      const billed = await tx.invoice.findFirst({where:{rentalAgreementId:existing.id,status:{not:'void'},periodEnd:{gte:new Date(effectiveDate)}}});
      if (billed) throw new AppError(409, `Composition change overlaps ${billed.invoiceNumber}; void/correct it first`);
      billingPolicy.compositionHistory = [...(billingPolicy.compositionHistory || [{effectiveDate:'0001-01-01',composition:existing.composition as Record<string, any>}]), {effectiveDate,composition}];
    }

    // #C re-derive the classification booleans when composition is edited.
    const derived = composition !== undefined ? deriveRentalFlags(composition) : null;

    const updated = await tx.rentalAgreement.update({
      where: { id: req.params.id as string },
      data: {
        poNumber: poNumber !== undefined ? poNumber : undefined,
        afeNumber: afeNumber !== undefined ? afeNumber : undefined,
        notes: notes !== undefined ? notes : undefined,
        companyId: companyId !== undefined ? companyId : undefined,
        fieldId: fieldId !== undefined ? fieldId : undefined,
        padId: padId !== undefined ? padId : undefined,
        wellId: wellId !== undefined ? wellId : undefined,
        // Multi-well: when the picker re-sends wellIds, keep wellId in sync as
        // the primary (first) well unless an explicit wellId came too.
        wellIds: wellIds !== undefined ? normalizeWellIds(wellIds) : undefined,
        startDate: startDate !== undefined ? new Date(startDate) : undefined,
        billingRateType: billingRateType !== undefined ? billingRateType : undefined,
        billingCadence: billingCadence !== undefined ? billingCadence : undefined,
        personCallingName: personCallingName !== undefined ? personCallingName : undefined,
        personCallingPhone: personCallingPhone !== undefined ? personCallingPhone : undefined,
        personCallingEmail: personCallingEmail !== undefined ? personCallingEmail : undefined,
        siteContactName: siteContactName !== undefined ? siteContactName : undefined,
        siteContactPhone: siteContactPhone !== undefined ? siteContactPhone : undefined,
        siteContactEmail: siteContactEmail !== undefined ? siteContactEmail : undefined,
        // PIC roster write-through. Pass the full array (it's the source of
        // truth on the client); null/[] clears it.
        pics: pics !== undefined ? pics : undefined,
        composition: composition !== undefined ? composition : undefined,
        ...(billingPolicy ? { billingPolicy } : {}),
        ...(derived ?? {}),
      },
    });

    return updated;
    });
    if (req.body.compositionCorrection === true) await createAuditLog({
      userId: req.user!.userId, entityType: 'rental_agreement', entityId: updated.id,
      action: 'update', changes: { compositionCorrection: true, reason: req.body.reason,
        composition: updated.composition, billingPolicy: { before: correctedBillingPolicyBefore!, after: updated.billingPolicy } }, ipAddress: req.ip,
    });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// ============================================================
// ADD EQUIPMENT ITEM TO AGREEMENT
// ============================================================

// POST /api/rentals/:id/items
rentalsRouter.post('/:id/items', async (req: Request, res: Response, next) => {
  try {
    const item = await withRental(req.params.id as string, (tx, rental) => deployRentalItem(tx, rental, req.body));
    res.status(201).json(item);
  } catch (err) { next(err); }
});

// ============================================================
// RETURN SINGLE ITEM
// ============================================================

// PATCH /api/rentals/:id/items/:itemId/return
rentalsRouter.patch('/:id/items/:itemId/return', async (req: Request, res: Response, next) => {
  try {
    await withRental(req.params.id as string, (tx) => returnRentalItem(tx, req.params.id as string, req.params.itemId as string, req.body));
    await createAuditLog({ userId: req.user!.userId, entityType: 'rental_agreement_item', entityId: req.params.itemId as string,
      action: 'update', changes: { status: 'returned' }, ipAddress: req.ip });
    res.json({ success: true, hasDamage: ['major_damage', 'needs_repair'].includes(req.body.inspectionData?.overallCondition) });
  } catch (err) { next(err); }
});

// ============================================================
// COMPLETE AGREEMENT (refused while any unit is still out — see closeRental)
// ============================================================

// PATCH /api/rentals/:id/complete
rentalsRouter.patch('/:id/complete', async (req: Request, res: Response, next) => {
  try {
    const result = await withRental(req.params.id as string, (tx, rental) => closeRental(tx, rental, 'completed', undefined, req.body.endDate));
    await createAuditLog({ userId: req.user!.userId, entityType: 'rental_agreement', entityId: req.params.id as string,
      action: 'update', changes: { status: 'completed', ...result }, ipAddress: req.ip });
    res.json(result);
  } catch (err) { next(err); }
});

rentalsRouter.patch('/:id/reopen', requirePermission('rentals:edit'), async (req: Request, res: Response, next) => {
  try {
    if (!req.body.reason?.trim()) throw new AppError(400, 'A reason is required to reopen a rental');
    const result = await withRental(req.params.id as string, async (tx, rental) => {
      if (rental.status === 'active') return rental;
      if (rental.status !== 'completed') throw new AppError(409, 'Only completed rentals can be reopened');
      return tx.rentalAgreement.update({ where: { id: rental.id }, data: { status: 'active', endDate: null } });
    });
    await createAuditLog({ userId: req.user!.userId, entityType: 'rental_agreement', entityId: result.id,
      action: 'status_change', changes: { status: 'active', reason: req.body.reason }, ipAddress: req.ip });
    res.json(result);
  } catch (err) { next(err); }
});

// PATCH /api/rentals/:id/cancel — close a rental as NOT-DONE. Distinct from
// /complete (which means "returned & done normally"): the agreement is kept as a
// `cancelled` tombstone, deployed items are returned to inventory, and a reason
// is required. Cancelled agreements are non-billable (billing queries only pick
// up active/completed rentals). Soft action — gated by rentals:cancel.
rentalsRouter.patch('/:id/cancel', requirePermission('rentals:cancel'), async (req: Request, res: Response, next) => {
  try {
    const reason = req.body.reason?.trim();
    if (!reason) throw new AppError(400, 'A reason is required to cancel a rental');
    const result = await withRental(req.params.id as string, (tx, rental) => closeRental(tx, rental, 'cancelled', reason));
    await createAuditLog({ userId: req.user!.userId, entityType: 'rental_agreement', entityId: req.params.id as string,
      action: 'status_change', changes: { status: 'cancelled', reason }, ipAddress: req.ip });
    res.json(result);
  } catch (err) { next(err); }
});

// DELETE /api/rentals/:id — permanently delete a rental agreement + children
// (items, daily logs) and detach equipment / linked tickets. Unrecoverable;
// requires a reason. An active agreement with deployed items is normally locked;
// { override: true } lets a permitted role delete it anyway (items are freed).
rentalsRouter.delete('/:id', requirePermission('rentals:delete'), async (req: Request, res: Response, next) => {
  try {
    const agreementId = req.params.id as string;
    const reason = (req.body?.reason || '').trim();
    const override = !!req.body?.override;
    if (!reason) throw new AppError(400, 'A reason is required to delete a rental');

    const agreement = await prisma.rentalAgreement.findUnique({
      where: { id: agreementId },
      include: { items: { select: { id: true, status: true, serializedEquipmentId: true } } },
    });
    if (!agreement) throw new AppError(404, 'Rental agreement not found');

    const deployed = agreement.items.filter(i => i.status === 'deployed');
    if (agreement.status === 'active' && deployed.length > 0 && !override) {
      throw new AppError(409, 'Rental is active with deployed items — deletion requires override');
    }

    const warnings: string[] = [];
    if (deployed.length > 0) warnings.push(`${deployed.length} deployed item(s) were freed back to inventory.`);

    await prisma.$transaction(async (tx) => {
      // Free any equipment still pointing at this rental.
      await tx.serializedEquipment.updateMany({
        where: { currentRentalId: agreementId },
        data: { status: 'available', currentRentalId: null, currentCustomerId: null },
      });
      // Detach linked service tickets so they aren't orphaned by the FK.
      await tx.serviceTicket.updateMany({
        where: { linkedRentalAgreementId: agreementId },
        data: { linkedRentalAgreementId: null },
      });
      await tx.rentalDailyLog.deleteMany({ where: { rentalAgreementId: agreementId } });
      await tx.rentalAgreementItem.deleteMany({ where: { rentalAgreementId: agreementId } });
      await tx.rentalAgreement.delete({ where: { id: agreementId } });
    });

    await createAuditLog({
      userId: req.user!.userId,
      entityType: 'rental_agreement',
      entityId: agreementId,
      action: 'delete',
      changes: { agreementNumber: agreement.agreementNumber, status: agreement.status, reason, override },
      ipAddress: req.ip,
    });

    res.json({ ok: true, agreementNumber: agreement.agreementNumber, warnings });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// DAILY LOGS (Site Log — manned trailer logbook)
// ============================================================

// GET /api/rentals/:id/daily-logs — list logs for a rental
rentalsRouter.get('/:id/daily-logs', async (req: Request, res: Response, next) => {
  try {
    const agreementId = req.params.id as string;
    const logs = await prisma.rentalDailyLog.findMany({
      where: { rentalAgreementId: agreementId },
      include: {
        loggedBy: { select: { id: true, name: true } },
      },
      orderBy: { logDate: 'desc' },
    });

    res.json({
      data: logs.map(log => ({
        ...log,
        entries: (log.entries as any[]) ?? [],
        loggedByName: log.loggedBy?.name ?? null,
        loggedBy: undefined,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/rentals/:id/daily-logs/today — get-or-create today's log
rentalsRouter.get('/:id/daily-logs/today', async (req: Request, res: Response, next) => {
  try {
    const agreementId = req.params.id as string;
    const userId = req.user!.userId;

    // Today in UTC (date-only)
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    const tomorrow = new Date(today);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);

    // Look for existing log
    let log = await prisma.rentalDailyLog.findFirst({
      where: {
        rentalAgreementId: agreementId,
        logDate: { gte: today, lt: tomorrow },
      },
    });

    // Create if not found
    if (!log) {
      // Verify rental exists and is active
      const agreement = await prisma.rentalAgreement.findUnique({
        where: { id: agreementId },
        select: { id: true, status: true },
      });
      if (!agreement) throw new AppError(404, 'Rental agreement not found');
      if (agreement.status !== 'active') throw new AppError(400, 'Rental is not active');

      log = await prisma.rentalDailyLog.create({
        data: {
          rentalAgreementId: agreementId,
          logDate: today,
          loggedById: userId,
          equipmentPresent: true,
          equipmentStatus: 'operational',
          entries: [],
        },
      });
    }

    res.json({
      ...log,
      entries: (log.entries as any[]) ?? [],
    });
  } catch (err) {
    next(err);
  }
});

// PUT /api/rentals/:id/daily-logs/:logId — update a daily log
rentalsRouter.put('/:id/daily-logs/:logId', async (req: Request, res: Response, next) => {
  try {
    const logId = req.params.logId as string;

    const existing = await prisma.rentalDailyLog.findUnique({ where: { id: logId } });
    if (!existing) throw new AppError(404, 'Daily log not found');

    const {
      equipmentPresent, equipmentStatus,
      cascadeStatus, bottlesFullCount, bottlesTotalCount,
      monitorsBumpTested, monitorsOperationalCount, monitorsTotalCount,
      notes, entries,
    } = req.body;

    const log = await prisma.rentalDailyLog.update({
      where: { id: logId },
      data: {
        ...(equipmentPresent !== undefined && { equipmentPresent }),
        ...(equipmentStatus !== undefined && { equipmentStatus }),
        ...(cascadeStatus !== undefined && { cascadeStatus }),
        ...(bottlesFullCount !== undefined && { bottlesFullCount }),
        ...(bottlesTotalCount !== undefined && { bottlesTotalCount }),
        ...(monitorsBumpTested !== undefined && { monitorsBumpTested }),
        ...(monitorsOperationalCount !== undefined && { monitorsOperationalCount }),
        ...(monitorsTotalCount !== undefined && { monitorsTotalCount }),
        ...(notes !== undefined && { notes }),
        ...(entries !== undefined && { entries }),
      },
    });

    res.json({
      ...log,
      entries: (log.entries as any[]) ?? [],
    });
  } catch (err) {
    next(err);
  }
});
