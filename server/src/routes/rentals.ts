import { Router, Request, Response } from 'express';
import { prisma } from '../index.js';
import { AppError } from '../middleware/errorHandler.js';
import { requirePermission } from '../middleware/rbac.js';
import { createAuditLog } from '../utils/auditLog.js';
import { CREDIT_HOLD_MESSAGE } from '../utils/companyGuards.js';
import { generateRentalAgreementNumber } from '../utils/ticketNumber.js';
import { deriveRentalFlags } from '../services/rentalComposition.js';
import type { RentalComposition } from '../services/rentalComposition.js';
import { generateRentalAgreementPdf } from '../services/rentalAgreementPdfGenerator.js';
import { emitEvent } from '../services/eventBus.js';
import { computeRentalBillingState } from '../services/rentalBilling.js';

export const rentalsRouter = Router();

/** Coerce a client-sent wellIds payload into a clean string[] for JSONB. */
function normalizeWellIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === 'string' && v.length > 0);
}

// ============================================================
// LIST RENTAL AGREEMENTS
// ============================================================

/**
 * Phase C lazy status flip: any rental with status='scheduled' and a
 * start_date that has arrived (≤ today, end-of-day in DB tz) gets bumped
 * to 'active' before the list query runs. Cheap because it's an indexed
 * updateMany; runs at most once per LIST call. Avoids a cron job.
 */
async function autoActivateScheduledRentals(): Promise<void> {
  const todayEnd = new Date();
  todayEnd.setHours(23, 59, 59, 999);
  await prisma.rentalAgreement.updateMany({
    where: { status: 'scheduled', startDate: { lte: todayEnd } },
    data: { status: 'active' },
  });
}

// GET /api/rentals
rentalsRouter.get('/', async (req: Request, res: Response, next) => {
  try {
    await autoActivateScheduledRentals();

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

    res.json({ ...agreement, ...billingState });
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

    const pdfDoc = generateRentalAgreementPdf(agreement as any);
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
    } = req.body;

    if (!companyId || !billingRateType) {
      throw new AppError(400, 'companyId and billingRateType are required');
    }

    const resolvedPickupType: 'dispatch' | 'walk_in' =
      pickupType === 'walk_in' ? 'walk_in' : 'dispatch';

    // Walk-in invariants: signed liability waiver + at least one item must be deployed
    // immediately. Walk-ins always start active — there is no "scheduled" walk-in.
    if (resolvedPickupType === 'walk_in') {
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

    const agreementNumber = await generateRentalAgreementNumber();
    const resolvedStartDate = startDate ? new Date(startDate) : new Date();
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

      // Create items + mark equipment rented
      if (items && Array.isArray(items)) {
        for (const item of items) {
          // Verify equipment is available
          const equip = await tx.serializedEquipment.findUnique({
            where: { id: item.serializedEquipmentId },
            select: { id: true, status: true },
          });
          if (!equip) throw new AppError(404, `Equipment ${item.serializedEquipmentId} not found`);
          if (equip.status !== 'available') {
            throw new AppError(409, `Equipment ${item.serializedEquipmentId} is not available (status: ${equip.status})`);
          }

          await tx.rentalAgreementItem.create({
            data: {
              rentalAgreementId: ra.id,
              productId: item.productId,
              serializedEquipmentId: item.serializedEquipmentId,
              rate: item.rate != null ? item.rate : undefined,
              rateType: item.rateType || billingRateType,
              deployedDate: startDate ? new Date(startDate) : new Date(),
              status: 'deployed',
            },
          });

          await tx.serializedEquipment.update({
            where: { id: item.serializedEquipmentId },
            data: {
              status: 'rented',
              currentRentalId: ra.id,
              currentCustomerId: companyId,
            },
          });
        }
      }

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
      agreementId: agreement.id,
      agreementNumber: agreement.agreementNumber,
      companyId,
      companyName: company.name,
      pickupType: resolvedPickupType,
      status: inferredStatus,
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
rentalsRouter.put('/:id', async (req: Request, res: Response, next) => {
  try {
    const {
      poNumber, afeNumber, notes, fieldId, padId, wellId, wellIds, pics, composition,
      companyId, startDate, billingRateType, billingCadence,
      personCallingName, personCallingPhone, personCallingEmail,
      siteContactName, siteContactPhone, siteContactEmail,
    } = req.body;

    const existing = await prisma.rentalAgreement.findUnique({ where: { id: req.params.id as string } });
    if (!existing) throw new AppError(404, 'Rental agreement not found');

    // Reassigning the customer: validate the target, and force the caller to
    // send the location explicitly (old field/pad/well belong to the old
    // company — silently keeping them would cross-wire the location tree).
    if (companyId !== undefined && companyId !== existing.companyId) {
      const company = await prisma.company.findUnique({ where: { id: companyId }, select: { id: true } });
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

    // #C re-derive the classification booleans when composition is edited.
    const derived = composition !== undefined ? deriveRentalFlags(composition) : null;

    const updated = await prisma.rentalAgreement.update({
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
        ...(derived ?? {}),
      },
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
    const agreementId = req.params.id as string;
    const { serializedEquipmentId, productId, rate, rateType, deployedDate, deployInspection } = req.body;

    const agreement = await prisma.rentalAgreement.findUnique({
      where: { id: agreementId },
      select: { id: true, status: true, billingRateType: true, companyId: true },
    });
    if (!agreement) throw new AppError(404, 'Rental agreement not found');
    if (agreement.status !== 'active') throw new AppError(409, 'Agreement is not active');

    // #2 Redeploy: each added item is a dated deployment event. Default to now,
    // but allow backdating ("the monitors were here the whole time, I just found
    // them"). Reject an unparseable date or one more than a day in the future.
    let resolvedDeployedDate = new Date();
    if (deployedDate !== undefined && deployedDate !== null && deployedDate !== '') {
      const parsed = new Date(deployedDate);
      if (isNaN(parsed.getTime())) throw new AppError(400, 'Invalid deployedDate');
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      if (parsed > tomorrow) throw new AppError(400, 'deployedDate cannot be in the future');
      resolvedDeployedDate = parsed;
    }

    // Verify equipment available
    const equip = await prisma.serializedEquipment.findUnique({
      where: { id: serializedEquipmentId },
      select: { id: true, status: true },
    });
    if (!equip) throw new AppError(404, 'Equipment not found');
    if (equip.status !== 'available') {
      throw new AppError(409, `Equipment is not available (status: ${equip.status})`);
    }

    const [item] = await prisma.$transaction([
      prisma.rentalAgreementItem.create({
        data: {
          rentalAgreementId: agreementId,
          productId,
          serializedEquipmentId,
          rate: rate != null ? rate : undefined,
          rateType: rateType || agreement.billingRateType,
          deployedDate: resolvedDeployedDate,
          status: 'deployed',
          deployInspection: deployInspection ?? undefined,
        },
        include: {
          product: { select: { id: true, name: true, partNumber: true } },
          serializedEquipment: { select: { id: true, serialNumber: true } },
        },
      }),
      prisma.serializedEquipment.update({
        where: { id: serializedEquipmentId },
        data: {
          status: 'rented',
          currentRentalId: agreementId,
          currentCustomerId: agreement.companyId,
        },
      }),
    ]);

    res.status(201).json(item);
  } catch (err) {
    next(err);
  }
});

// ============================================================
// RETURN SINGLE ITEM
// ============================================================

// PATCH /api/rentals/:id/items/:itemId/return
rentalsRouter.patch('/:id/items/:itemId/return', async (req: Request, res: Response, next) => {
  try {
    const { itemId } = req.params;
    const { inspectionData } = req.body; // Optional structured inspection data

    const item = await prisma.rentalAgreementItem.findUnique({
      where: { id: itemId as string },
      select: { id: true, status: true, serializedEquipmentId: true, rentalAgreementId: true },
    });
    if (!item) throw new AppError(404, 'Rental item not found');
    if (item.status !== 'deployed') throw new AppError(409, `Item is already ${item.status}`);

    await prisma.$transaction([
      prisma.rentalAgreementItem.update({
        where: { id: itemId as string },
        data: { status: 'returned', returnedDate: new Date() },
      }),
      prisma.serializedEquipment.update({
        where: { id: item.serializedEquipmentId },
        data: {
          status: 'available',
          currentRentalId: null,
          currentCustomerId: null,
          // Store inspection data if provided
          ...(inspectionData ? { customData: inspectionData } : {}),
        },
      }),
    ]);

    await createAuditLog({
      userId: req.user!.userId,
      entityType: 'rental_agreement_item',
      entityId: itemId as string,
      action: 'update',
      changes: { status: 'returned', hasInspection: !!inspectionData },
      ipAddress: req.ip,
    });

    const hasDamage = inspectionData?.overallCondition === 'major_damage' || inspectionData?.overallCondition === 'needs_repair';

    res.json({ success: true, hasDamage });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// COMPLETE AGREEMENT (return all items)
// ============================================================

// PATCH /api/rentals/:id/complete
rentalsRouter.patch('/:id/complete', async (req: Request, res: Response, next) => {
  try {
    const agreementId = req.params.id as string;

    const agreement = await prisma.rentalAgreement.findUnique({
      where: { id: agreementId },
      include: {
        items: { where: { status: 'deployed' }, select: { id: true, serializedEquipmentId: true } },
      },
    });
    if (!agreement) throw new AppError(404, 'Rental agreement not found');
    if (agreement.status !== 'active') throw new AppError(409, 'Agreement is not active');

    await prisma.$transaction(async (tx) => {
      // Return all deployed items
      for (const item of agreement.items) {
        await tx.rentalAgreementItem.update({
          where: { id: item.id },
          data: { status: 'returned', returnedDate: new Date() },
        });
        await tx.serializedEquipment.update({
          where: { id: item.serializedEquipmentId },
          data: {
            status: 'available',
            currentRentalId: null,
            currentCustomerId: null,
          },
        });
      }

      // Complete the agreement
      await tx.rentalAgreement.update({
        where: { id: agreementId },
        data: { status: 'completed', endDate: new Date() },
      });
    });

    await createAuditLog({
      userId: req.user!.userId,
      entityType: 'rental_agreement',
      entityId: agreementId,
      action: 'update',
      changes: { status: 'completed', returnedItems: agreement.items.length },
      ipAddress: req.ip,
    });

    res.json({ success: true, returnedItems: agreement.items.length });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/rentals/:id/cancel — close a rental as NOT-DONE. Distinct from
// /complete (which means "returned & done normally"): the agreement is kept as a
// `cancelled` tombstone, deployed items are returned to inventory, and a reason
// is required. Cancelled agreements are non-billable (billing queries only pick
// up active/completed rentals). Soft action — gated by rentals:cancel.
rentalsRouter.patch('/:id/cancel', requirePermission('rentals:cancel'), async (req: Request, res: Response, next) => {
  try {
    const agreementId = req.params.id as string;
    const reason = (req.body?.reason || '').trim();
    if (!reason) throw new AppError(400, 'A reason is required to cancel a rental');

    const agreement = await prisma.rentalAgreement.findUnique({
      where: { id: agreementId },
      include: {
        items: { where: { status: 'deployed' }, select: { id: true, serializedEquipmentId: true } },
      },
    });
    if (!agreement) throw new AppError(404, 'Rental agreement not found');
    if (agreement.status === 'cancelled') {
      res.json({ success: true, alreadyCancelled: true });
      return;
    }

    await prisma.$transaction(async (tx) => {
      for (const item of agreement.items) {
        await tx.rentalAgreementItem.update({
          where: { id: item.id },
          data: { status: 'returned', returnedDate: new Date() },
        });
        await tx.serializedEquipment.update({
          where: { id: item.serializedEquipmentId },
          data: { status: 'available', currentRentalId: null, currentCustomerId: null },
        });
      }
      await tx.rentalAgreement.update({
        where: { id: agreementId },
        data: {
          status: 'cancelled',
          endDate: new Date(),
          notes: agreement.notes ? `${agreement.notes}\n\nCancelled (not-done): ${reason}` : `Cancelled (not-done): ${reason}`,
        },
      });
    });

    await createAuditLog({
      userId: req.user!.userId,
      entityType: 'rental_agreement',
      entityId: agreementId,
      action: 'status_change',
      changes: { from: agreement.status, to: 'cancelled', reason, returnedItems: agreement.items.length },
      ipAddress: req.ip,
    });

    res.json({ success: true, returnedItems: agreement.items.length });
  } catch (err) {
    next(err);
  }
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
