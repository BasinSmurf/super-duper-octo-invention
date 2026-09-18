import { serviceQaMapping, normalizeServiceCharges, servicesFromBilling, linkedQaActions, validateVendorServiceLink } from '../services/shopServiceCharges.js';
import { applyReceiveBilling } from '../services/shopVendorReceiveBilling.js';
import type { ReceivePayload } from '../services/shopVendorReceive.js';
import { Router, Request, Response } from 'express';
import { prisma } from '../index.js';
import { Prisma } from '../db.js';
import { AppError } from '../middleware/errorHandler.js';
import { requirePermission } from '../middleware/rbac.js';
import { createAuditLog } from '../utils/auditLog.js';
import { generateShopWorkOrderNumber } from '../utils/ticketNumber.js';
import { resolvePrinter, getDefaultTemplate } from '../services/printService.js';
import { createShopWorkOrderWithItems, PREFERRED_CONTACT_VALUES } from '../services/shopWoCreate.js';
import { assertShopReturnAllowed } from '../utils/companyGuards.js';
import {
  canTransitionShopItem,
  getAvailableShopItemTransitions,
  canTransitionShopWO,
  getAvailableShopWOTransitions,
  holdReasonError,
} from '../services/shopStateMachine.js';
import { isHoldStatus, isSettableHoldReason } from '../services/shopHoldReason.js';
import { checkCondemnEvidence } from '../services/condemnEvidence.js';
import { parseContactEntry, isContactParty } from '../services/shopContactLog.js';
import { billingRoute, attribution, collectedCcFees, toNumber } from '../services/paidAtDrop.js';
import { priceShopCharges } from '../services/shopChargePreview.js';
import {
  isBillableShopItem,
  isChargeableShopItem,
  toBillingItem,
} from '../services/shopBillingLines.js';
import {
  SENT_OUT_STATUSES,
  parseReceivePayload,
  receiveLogNote,
  receiveUpdateData,
  vendorReturnDocumentError,
} from '../services/shopVendorReceive.js';
import {
  findIdentityCandidates,
  autoCreateMissingIdentities,
  resolveIdentity,
} from '../services/unitIdentity.js';
import {
  canEditUnit,
  canUnlockUnit,
  closerFieldsFor,
  closeStateOf,
  msUntilHardClose,
  unlockStamp,
} from '../services/shopSoftClose.js';
import {
  mapShopCategoryToInspection,
  getRequiredShopKeys,
  labelsForKeys,
  checklistVersion,
  getShopChecklist,
} from '../services/inspectionChecklist.js';
import {
  QA_FAIL_STATUS,
  asChecklistResults,
  asStringArray,
  categoryConflict,
  deriveOutcome,
  effectiveChecklist,
  explainIncomplete,
} from '../services/shopBatchQa.js';
import { evaluateItemQa, type QaGateItem } from '../services/shopQaGate.js';
import { enqueueInspectionRecord } from '../services/blueLionEnqueue.js';
import { autoLockPassedInspections, lockInspectionRecord } from '../services/inspectionLock.js';
import { emitEvent } from '../services/eventBus.js';
import { generateShopWorkOrderPdf } from '../services/shopWorkOrderPdfGenerator.js';
import { binLocationOf, getOccupiedBins } from '../services/shopBoard.js';
import type {
  ShopWorkOrderStatus,
  ShopItemStatus,
  ShopServiceType,
  EquipmentCategoryShop,
  ShipmentMethod,
} from '../db.js';

export const shopOrdersRouter = Router();

// ============================================================
// HELPER: Bin-location occupancy guard
// ============================================================

/**
 * Rejects (409) any candidate bin that's already held by a different active
 * item, or claimed twice within the same request. Call before persisting a
 * personal-monitor's customData.binLocation on create/update.
 */
async function assertBinsAvailable(candidates: Array<{ bin: string; excludeItemId?: string }>) {
  if (!candidates.length) return;
  const occupied = await getOccupiedBins();
  const claimedNow = new Set<string>();
  for (const { bin, excludeItemId } of candidates) {
    const hit = occupied.get(bin);
    if (hit && hit.itemId !== excludeItemId) {
      throw new AppError(409, `${bin} is already assigned on WO ${hit.workOrderNumber} — pick it up before reusing it.`);
    }
    if (claimedNow.has(bin)) {
      throw new AppError(409, `${bin} is picked for two units in this request — choose different bins.`);
    }
    claimedNow.add(bin);
  }
}

// ============================================================
// HELPER: Recompute WO status from its item statuses
// ============================================================

/**
 * Looks at all item statuses on a WO and derives the correct WO-level status:
 *
 * - If ALL items are 'returned' → WO = 'closed'
 * - If ALL items are 'shop_complete' or 'returned' → WO = 'complete'
 * - If ANY item is warranty_out | outside_service | awaiting_parts | on_hold → WO = 'hold'
 * - If ANY item is in an active working state → WO = 'in_progress'
 * - Otherwise (all received) → WO = 'intake'
 */
export async function recomputeWOStatus(workOrderId: string) {
  const allItems = await prisma.shopWorkOrderItem.findMany({
    where: { workOrderId },
    select: { status: true },
  });

  if (allItems.length === 0) return;

  const counts: Record<string, number> = {};
  for (const it of allItems) {
    counts[it.status] = (counts[it.status] || 0) + 1;
  }
  const total = allItems.length;

  // 'condemned' is a terminal, settled state (the unit is dead — DEAD record
  // written, inspection labor billable). It counts toward "done" like returned.
  const terminalCount = (counts['returned'] || 0) + (counts['condemned'] || 0);
  const completedCount = (counts['shop_complete'] || 0) + terminalCount;

  // Derive WO status
  let derivedStatus: ShopWorkOrderStatus = 'intake';

  if (terminalCount === total) {
    // Every item has reached a terminal disposition (picked up or condemned)
    derivedStatus = 'closed';
  } else if (completedCount === total) {
    // All done but not all picked up yet → waiting for pickup
    derivedStatus = 'complete';
  } else if (
    (counts['warranty_out'] || 0) > 0 ||
    (counts['outside_service'] || 0) > 0 ||
    (counts['awaiting_parts'] || 0) > 0 ||
    (counts['on_hold'] || 0) > 0
  ) {
    // Something is blocking
    derivedStatus = 'hold';
  } else if (
    (counts['diagnosing'] || 0) > 0 ||
    (counts['in_work'] || 0) > 0 ||
    (counts['awaiting_approval'] || 0) > 0 ||
    (counts['qc_testing'] || 0) > 0
  ) {
    // Active work happening
    derivedStatus = 'in_progress';
  } else {
    // All received — still intake
    derivedStatus = 'intake';
  }

  const updateData: any = {
    completedItems: completedCount,
  };

  // Only update status if it changed (don't fight manual overrides for closed)
  const currentWO = await prisma.shopWorkOrder.findUnique({
    where: { id: workOrderId },
    select: { status: true },
  });

  if (currentWO && currentWO.status !== 'closed') {
    updateData.status = derivedStatus;
    if (derivedStatus === 'complete' && currentWO.status !== 'complete') {
      updateData.completedDate = new Date();
    }
  }

  await prisma.shopWorkOrder.update({
    where: { id: workOrderId },
    data: updateData,
  });
}

// ============================================================
// HELPER: QA gate — block shop_complete until inspection is done
// ============================================================

/**
 * Life-safety / equipment QA gate. An item cannot reach `shop_complete` (which
 * flips the WO to "Ready for Pickup") until a QA-complete EquipmentInspection
 * exists for it — i.e. every required shop checklist item for the category is
 * affirmatively checked.
 *
 * The predicate itself now lives in services/shopQaGate.ts, because the offline
 * paths need the same answer without an exception (a thrown sync error strands
 * the tech's work in the mutation queue). This is the throwing presentation of
 * it, for the two online routes that can afford to say no to a caller who is
 * standing right there and can fix it.
 *
 * Sub-components (parentItemId set) inherit the parent assembly's QA and are
 * not independently gated — they cascade with the parent.
 *
 * Throws AppError(409) with a clear message if the gate is not satisfied.
 */
async function assertItemQaSatisfied(item: QaGateItem): Promise<void> {
  const verdict = await evaluateItemQa(prisma, item);
  if (verdict.satisfied) return;
  throw new AppError(
    409,
    `Cannot mark "Ready for Pickup" until the QA inspection is complete. ${verdict.reason}`,
  );
}

/**
 * The 'condemned' transition previously had NO BlueLion-ledger gate at all: the
 * shop board's plain status button PATCHes straight to 'condemned' without
 * ever touching the inspection editor/lock route, so condemned units never
 * produced a ledger record. Rather than blocking that button (it's the only
 * path some techs use), ensure a LOCKED condemn inspection exists before the
 * transition proceeds:
 *   - already locked            → nothing to do.
 *   - exists but unlocked (tech started the inspection editor's condemn flow
 *     but used the raw status button instead of submitting) → lock it via the
 *     shared path, which also fires the BlueLion enqueue.
 *   - none at all → synthesize a minimal, already-locked one (same pattern as
 *     the bulk-clear "batch visual pass" inspections) so the button keeps
 *     working exactly as before, just with a ledger record behind it now.
 */
async function ensureLockedCondemnInspection(
  item: { id: string; equipmentCategory: string; serialNumber: string; serializedEquipmentId: string | null },
  userId: string,
): Promise<void> {
  const already = await prisma.equipmentInspection.findFirst({
    where: { shopItemId: item.id, outcome: 'condemn', lockedAt: { not: null } },
    select: { id: true },
  });
  if (already) return;

  const unlocked = await prisma.equipmentInspection.findFirst({
    where: { shopItemId: item.id, outcome: 'condemn', lockedAt: null },
    select: { id: true },
  });
  if (unlocked) {
    await lockInspectionRecord(prisma, unlocked.id, userId);
    return;
  }

  const category = mapShopCategoryToInspection(item.equipmentCategory);
  const insp = await prisma.equipmentInspection.create({
    data: {
      shopItemId: item.id,
      serializedEquipmentId: item.serializedEquipmentId,
      serialNumber: item.serialNumber,
      category: category as never,
      outcome: 'condemn',
      serviceActions: ['condemn'],
      data: { autoCreatedFromStatusButton: true },
      inspectedById: userId,
      inspectedAt: new Date(),
      lockedAt: new Date(),
    },
    select: { id: true },
  });
  await enqueueInspectionRecord(insp.id).catch((e) =>
    console.warn('[BlueLion] enqueue condemn inspection failed (non-fatal):', e),
  );
}

// ============================================================
// PARTS CATALOG (for shop work)
// ============================================================

// GET /api/shop-orders/parts-catalog?catalogCategory=shop%20%3E%20D6
// Serves the shop billing parts catalog. Filters by the free-form
// `catalogCategory` (populated from the QB price-list work) when passed, so a D6
// ticket can pull "shop > D6" parts. Always returns `categories` = the distinct
// catalogCategory values available, for the picker dropdown.
shopOrdersRouter.get('/service-billing/:itemId', async (req: Request, res: Response, next) => {
  try {
    const item = await prisma.shopWorkOrderItem.findUnique({ where: { id: req.params.itemId as string }, select: { billing: true } });
    if (!item) throw new AppError(404, 'Shop unit not found');
    res.json({ services: servicesFromBilling(item.billing) });
  } catch (err) { next(err); }
});

shopOrdersRouter.get('/parts-catalog', async (req: Request, res: Response, next) => {
  try {
    const catalogCategory = typeof req.query.catalogCategory === 'string' ? req.query.catalogCategory.trim() : '';

    const SHOP_CATS: Prisma.ProductWhereInput['category'] = {
      in: ['sensor', 'calibration_gas', 'accessory', 'consumable', 'labor', 'misc'],
    };
    const where: Prisma.ProductWhereInput = { isActive: true, OR: [{ category: SHOP_CATS }, { productType: 'service' }] };
    if (catalogCategory) where.catalogCategory = catalogCategory;

    const [parts, distinct] = await Promise.all([
      prisma.product.findMany({
        where,
        select: {
          id: true,
          partNumber: true,
          name: true,
          category: true,
          catalogCategory: true,
          productType: true,
          unitOfMeasure: true,
          defaultSellPrice: true,
          // The key the customer's contract pricebook matches on — the picker
          // quotes what THIS customer pays, not list.
          qbItemListId: true,
        },
        orderBy: [{ category: 'asc' }, { name: 'asc' }],
      }),
      // Distinct non-null catalog categories across the shop-eligible catalog
      // (ignores the catalogCategory filter so the dropdown stays stable).
      prisma.product.findMany({
        where: { isActive: true, category: SHOP_CATS, catalogCategory: { not: null } },
        select: { catalogCategory: true },
        distinct: ['catalogCategory'],
        orderBy: { catalogCategory: 'asc' },
      }),
    ]);

    res.json({
      data: parts.map(p => ({
        ...p,
        serviceActions: p.productType === 'service' ? serviceQaMapping(p.partNumber)?.actions ?? ['other'] : [],
        qaCategory: serviceQaMapping(p.partNumber)?.category ?? null,
        defaultSellPrice: p.defaultSellPrice != null ? Number(p.defaultSellPrice) : null,
      })),
      categories: distinct.map(d => d.catalogCategory).filter((c): c is string => !!c),
    });
  } catch (err) { next(err); }
});

// ============================================================
// COMMON INCLUDES
// ============================================================

const ITEM_INCLUDE = {
  serializedEquipment: { select: { id: true, serialNumber: true, status: true } },
  product: { select: { id: true, name: true, partNumber: true, category: true } },
  diagnosedBy: { select: { id: true, name: true } },
  assignedTo: { select: { id: true, name: true } },
  qcTestedBy: { select: { id: true, name: true } },
  childComponents: {
    include: {
      serializedEquipment: { select: { id: true, serialNumber: true } },
    },
    orderBy: { itemNumber: 'asc' as const },
  },
};

const WO_LIST_INCLUDE = {
  company: { select: { id: true, name: true } },
  intakeBy: { select: { id: true, name: true } },
  _count: { select: { items: true } },
};

const WO_DETAIL_INCLUDE = {
  company: { select: { id: true, name: true, cashCcOnly: true, creditHold: true } },
  intakeBy: { select: { id: true, name: true } },
  createdBy: { select: { id: true, name: true } },
  items: {
    where: { parentItemId: null }, // Top-level items only (children nested via include)
    include: ITEM_INCLUDE,
    orderBy: { itemNumber: 'asc' as const },
  },
  // WI-10. Deleted entries are excluded from the default read: a supervisor
  // removed it, and the row surviving is for the audit trail, not for the card.
  contactEntries: {
    where: { deletedAt: null },
    orderBy: { contactedAt: 'desc' as const },
  },
};

// ============================================================
// LIST WORK ORDERS
// ============================================================

// GET /api/shop-orders
shopOrdersRouter.get('/', async (req: Request, res: Response, next) => {
  try {
    const { status, companyId, search, category, siteId, limit = '50', offset = '0' } = req.query;
    const where: any = {};

    if (status && status !== 'all') {
      where.status = status as string;
    }
    if (companyId) {
      where.companyId = companyId as string;
    }
    if (category) {
      where.primaryCategory = category as string;
    }
    if (siteId) {
      // Location truth is per-item: a WO "is at" a site when any top-level item
      // currently lives there. A split job legitimately matches multiple sites.
      where.items = { some: { siteId: siteId as string, parentItemId: null } };
    }
    if (search) {
      where.OR = [
        { workOrderNumber: { contains: search as string, mode: 'insensitive' } },
        { company: { name: { contains: search as string, mode: 'insensitive' } } },
        { items: { some: { serialNumber: { contains: search as string, mode: 'insensitive' } } } },
      ];
    }

    const [orders, total] = await Promise.all([
      prisma.shopWorkOrder.findMany({
        where,
        include: {
          ...WO_LIST_INCLUDE,
          items: { where: { parentItemId: null }, select: { siteId: true, equipmentCategory: true, customData: true } },
        },
        orderBy: [{ createdAt: 'desc' }],
        take: parseInt(limit as string, 10),
        skip: parseInt(offset as string, 10),
      }),
      prisma.shopWorkOrder.count({ where }),
    ]);

    // Collapse the item rows into the distinct set of sites the WO occupies, so
    // the client can scope its (offline-cached) list by site without per-item data.
    const data = orders.map(({ items, ...wo }) => ({
      ...wo,
      itemSiteIds: [...new Set(items.map(i => i.siteId))],
      // Personal-monitor storage bins on this WO — so the list can show where
      // units are parked without per-item fetches.
      bins: [...new Set(
        items
          .filter(i => i.equipmentCategory === 'personal_monitor')
          .map(i => binLocationOf(i.customData))
          .filter((b): b is string => !!b),
      )],
    }));

    res.json({ data, total });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// OCCUPIED BINS (personal-monitor storage bin picker)
// ============================================================

// GET /api/shop-orders/occupied-bins
shopOrdersRouter.get('/occupied-bins', async (req: Request, res: Response, next) => {
  try {
    const occupied = await getOccupiedBins();
    const data = Array.from(occupied.entries()).map(([bin, hit]) => ({ bin, ...hit }));
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// GET SINGLE WORK ORDER
// ============================================================

// GET /api/shop-orders/:id
shopOrdersRouter.get('/:id', async (req: Request, res: Response, next) => {
  try {
    const order = await prisma.shopWorkOrder.findUnique({
      where: { id: req.params.id as string },
      include: WO_DETAIL_INCLUDE,
    });

    if (!order) throw new AppError(404, 'Shop work order not found');

    // §3.2 documentation-pending indicator: attachments captured against this
    // WO's units that the object store does not have a verified copy of yet.
    //
    // It is an INDICATOR, deliberately, not a gate. Billing and close proceed
    // regardless -- a technician is never blocked because a photo is still
    // queued behind someone else's outage. It exists so nobody believes the
    // paperwork is filed when it is still sitting in a buffer.
    const documentationPending = await prisma.attachment.count({
      where: {
        storageState: { in: ['buffered', 'failed'] },
        shopItem: { workOrderId: order.id },
      },
    });

    // WI-05: the close state each unit is in, so the UI can show the countdown
    // and grey out what it must. Derived from the deadline rather than stored,
    // so it can never be stale.
    const now = new Date();
    const closeStates = Object.fromEntries(
      order.items.map((it) => [
        it.id,
        {
          state: closeStateOf(it),
          hardClosesAt: it.hardClosesAt?.toISOString() ?? null,
          msRemaining: msUntilHardClose(it, now),
          closedById: it.closedById,
          unlockCount: it.unlockCount,
          unlockReason: it.unlockReason,
          canEdit: canEditUnit(it, { userId: req.user!.userId, role: req.user!.role }, now).allowed,
        },
      ]),
    );

    // Units whose identity a human still has to settle (WI-05). Only the
    // ambiguous ones — a serial with no existing record is created silently and
    // never appears here.
    const identityCandidates = await findIdentityCandidates(prisma, order.id);

    res.json({ ...order, documentationPending, closeStates, identityCandidates });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// EXPORT WORK ORDER AS PDF
// ============================================================

// GET /api/shop-orders/:id/pdf — download the work order document as PDF
shopOrdersRouter.get('/:id/pdf', async (req: Request, res: Response, next) => {
  try {
    const order = await prisma.shopWorkOrder.findUnique({
      where: { id: req.params.id as string },
      include: WO_DETAIL_INCLUDE,
    });

    if (!order) throw new AppError(404, 'Shop work order not found');

    const fileName = `work-order-${order.workOrderNumber}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);

    const pdfDoc = generateShopWorkOrderPdf(order as any);
    pdfDoc.pipe(res);
    pdfDoc.end();
  } catch (err) {
    next(err);
  }
});

// ============================================================
// CREATE WORK ORDER (BATCH INTAKE)
// ============================================================

// POST /api/shop-orders
shopOrdersRouter.post('/', async (req: Request, res: Response, next) => {
  try {
    const { companyId, items } = req.body;

    if (!companyId) throw new AppError(400, 'companyId is required');
    if (!items || !Array.isArray(items) || items.length === 0) {
      throw new AppError(400, 'At least one item is required');
    }

    await assertBinsAvailable(
      items
        .filter((it: any) => it.equipmentCategory === 'personal_monitor')
        .map((it: any) => ({ bin: binLocationOf(it.customData) }))
        .filter((c: any): c is { bin: string } => !!c.bin),
    );

    // Validate company exists
    const company = await prisma.company.findUnique({
      where: { id: companyId },
      select: { id: true },
    });
    if (!company) throw new AppError(404, 'Company not found');

    const workOrderNumber = await generateShopWorkOrderNumber();
    const userId = req.user!.userId;

    const order = await prisma.$transaction((tx) =>
      createShopWorkOrderWithItems(tx, {
        workOrderNumber,
        userId,
        payload: req.body,
      }),
    );

    await createAuditLog({
      userId,
      action: 'create',
      entityType: 'ShopWorkOrder',
      entityId: order.id,
      changes: { workOrderNumber, companyId, itemCount: order.totalItems },
    });

    // Intake no longer auto-prints. The operator confirms printer + count via
    // the intake print dialog, which calls POST /:id/labels (below).

    // Fetch full record for response
    const full = await prisma.shopWorkOrder.findUnique({
      where: { id: order.id },
      include: WO_DETAIL_INCLUDE,
    });

    if (full) {
      void emitEvent('shopwo.intake.created', {
        workOrderId: order.id,
        workOrderNumber: order.workOrderNumber,
        companyId,
        companyName: full.company.name,
        itemCount: order.totalItems,
        createdByUserId: userId,
      });
    }

    // A destination short code that didn't resolve doesn't fail the intake —
    // the WO and its items are real and already committed. It rides back on
    // the 201 so a caller can say so, and it's durable on the WO itself
    // (transitFailed*) for the Ops Dashboard count. Same warn-not-fail rule as
    // the offline replay in /sync/push, deliberately: one behavior, so a bad
    // short code doesn't depend on whether the device happened to be online.
    if (order.transitWarning) {
      console.warn(
        `[shop-orders] transit not created for ${order.workOrderNumber}: ${order.transitWarning.message}`,
      );
    }

    res.status(201).json(
      order.transitWarning ? { ...full, transitWarning: order.transitWarning } : full,
    );
  } catch (err) {
    next(err);
  }
});

// ============================================================
// UPDATE WORK ORDER HEADER
// ============================================================

// PUT /api/shop-orders/:id
shopOrdersRouter.put('/:id', async (req: Request, res: Response, next) => {
  try {
    const woId = req.params.id as string;
    const {
      poNumber, afeNumber, notes, promisedDate, priority, primaryCategory,
      isInternal, intakeNotes, billingExtras,
      dropOffContactName, dropOffContactPhone, dropOffContactEmail, dropOffContactPreferred,
      pickupContactName, pickupContactPhone, pickupContactEmail, pickupContactPreferred,
    } = req.body;

    const existing = await prisma.shopWorkOrder.findUnique({
      where: { id: woId },
      select: { id: true, status: true, billingExtras: true },
    });
    if (!existing) throw new AppError(404, 'Shop work order not found');

    // WO-level billing extras (mileage/trip + order misc). Preserve the
    // billed-once ledger: once the sweep stamps billedTicketId, edits can't
    // clear it (would let the trip charge re-bill on the next sweep).
    let billingExtrasData: Prisma.InputJsonValue | undefined;
    if (billingExtras !== undefined) {
      const prior = (existing.billingExtras as Record<string, unknown> | null) ?? {};
      billingExtrasData = {
        ...(billingExtras && typeof billingExtras === 'object' ? billingExtras : {}),
        ...(prior.billedTicketId ? { billedTicketId: prior.billedTicketId } : {}),
      } as Prisma.InputJsonValue;
    }

    // Edit-time preferred-contact validation (only if a value was sent)
    for (const [field, val] of Object.entries({ dropOffContactPreferred, pickupContactPreferred })) {
      if (val !== undefined && val !== null && !PREFERRED_CONTACT_VALUES.includes(val)) {
        throw new AppError(400, `${field} must be call|text|email`);
      }
    }

    const updated = await prisma.shopWorkOrder.update({
      where: { id: woId },
      data: {
        ...(poNumber !== undefined && { poNumber }),
        ...(afeNumber !== undefined && { afeNumber }),
        ...(notes !== undefined && { notes }),
        ...(promisedDate !== undefined && { promisedDate: promisedDate ? new Date(promisedDate) : null }),
        ...(priority !== undefined && { priority }),
        ...(primaryCategory !== undefined && { primaryCategory }),
        ...(isInternal !== undefined && { isInternal }),
        ...(intakeNotes !== undefined && { intakeNotes }),
        ...(billingExtrasData !== undefined && { billingExtras: billingExtrasData }),
        ...(dropOffContactName !== undefined && { dropOffContactName }),
        ...(dropOffContactPhone !== undefined && { dropOffContactPhone }),
        ...(dropOffContactEmail !== undefined && { dropOffContactEmail }),
        ...(dropOffContactPreferred !== undefined && { dropOffContactPreferred }),
        ...(pickupContactName !== undefined && { pickupContactName }),
        ...(pickupContactPhone !== undefined && { pickupContactPhone }),
        ...(pickupContactEmail !== undefined && { pickupContactEmail }),
        ...(pickupContactPreferred !== undefined && { pickupContactPreferred }),
      },
      include: WO_DETAIL_INCLUDE,
    });

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// ============================================================
// PAID AT DROP (WI-08)
// ============================================================
//
// Monitor calibration is paid when the customer hands the unit over, and the
// order must not reach billing as an unpaid job afterwards.
//
// This route records only WHICH counter path was used. It deliberately does not
// record an amount: for Stripe the Payment rows are the amount, and for
// Lightspeed ServicePRO genuinely does not know it -- the money moved through a
// POS this system cannot see. Storing a number here would be ServicePRO
// asserting a settlement it never witnessed, which §2 forbids and which would
// go stale the moment work is added.

// PATCH /api/shop-orders/:id/paid-at-drop
shopOrdersRouter.patch(
  '/:id/paid-at-drop',
  requirePermission('shop_orders:edit'),
  async (req: Request, res: Response, next) => {
    try {
      const woId = req.params.id as string;
      const { via, lightspeedTxnNumber } = req.body ?? {};

      if (via !== null && via !== 'stripe' && via !== 'lightspeed') {
        throw new AppError(400, "via must be 'stripe', 'lightspeed', or null to clear");
      }

      const txn = typeof lightspeedTxnNumber === 'string' && lightspeedTxnNumber.trim()
        ? lightspeedTxnNumber.trim().slice(0, 100)
        : null;

      // A Lightspeed claim with no reference is not a claim -- it is a
      // half-filled form that would silently exempt the order from billing.
      // The reference IS the evidence, so it is required with the method.
      if (via === 'lightspeed' && !txn) {
        throw new AppError(
          400,
          'A Lightspeed transaction number is required — it is the only record ServicePRO has that the money moved.',
        );
      }

      const existing = await prisma.shopWorkOrder.findUnique({
        where: { id: woId },
        select: { id: true, paidAtDropVia: true, lightspeedTxnNumber: true },
      });
      if (!existing) throw new AppError(404, 'Shop work order not found');

      const updated = await prisma.shopWorkOrder.update({
        where: { id: woId },
        data: {
          paidAtDropVia: via,
          // Clearing the method clears its reference with it, so a stale
          // Lightspeed number cannot outlive the claim it belonged to.
          lightspeedTxnNumber: via === 'lightspeed' ? txn : null,
        },
        include: WO_DETAIL_INCLUDE,
      });

      await createAuditLog({
        userId: req.user!.userId,
        entityType: 'shop_work_order',
        entityId: woId,
        action: 'update',
        changes: {
          paidAtDrop: {
            from: existing.paidAtDropVia, to: via,
            lightspeedTxnNumber: via === 'lightspeed' ? txn : null,
          },
        },
        ipAddress: req.ip,
      });

      res.json(updated);
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/shop-orders/:id/billing-route
shopOrdersRouter.get('/:id/charge-preview', async (req: Request, res: Response, next) => {
  try {
    const order = await prisma.shopWorkOrder.findUnique({
      where: { id: req.params.id as string },
      include: { company: true, items: { include: { product: true }, orderBy: { itemNumber: 'asc' } } },
    });
    if (!order) throw new AppError(404, 'Shop work order not found');
    const projected = order.items.map(i => toBillingItem(i as unknown as Record<string, unknown>));
    const { lines } = await priceShopCharges(order, projected.filter(isChargeableShopItem));
    res.json({ lines, subtotal: round2(lines.reduce((sum, l) => sum + l.amount, 0)),
      taxableSubtotal: round2(lines.filter(l => l.isTaxable).reduce((sum, l) => sum + l.amount, 0)),
      vendorCosts: order.items.flatMap(i => {
        const b = i.billing as { vendor?: { mode?: string; cost?: number; serviceProductId?: string } } | null;
        if (b?.vendor?.mode !== 'catalog_service') return [];
        return [{ serialNumber: i.serialNumber, invoiceNumber: i.vendorInvoiceNumber,
          cost: Number(i.vendorInvoiceTotal ?? b.vendor.cost ?? 0),
          partNumber: servicesFromBilling(i.billing).find(s => s.productId === b.vendor?.serviceProductId)?.partNumber ?? null }];
      }),
      excluded: order.items.filter(i => !isChargeableShopItem(toBillingItem(i as unknown as Record<string, unknown>)) && !i.parentItemId)
        .map(i => ({ serialNumber: i.serialNumber, reason: i.isWarranty ? 'Warranty' : i.vendorDisposition })),
    });
  } catch (err) { next(err); }
});

//
// What this order owes, and what has already been collected against it. Read by
// the payment panel and the billing card so both show the same number -- the
// derivation lives on the server precisely so two surfaces cannot disagree
// about whether a customer still owes money.
shopOrdersRouter.get('/:id/billing-route', async (req: Request, res: Response, next) => {
  try {
    const woId = req.params.id as string;
    const order = await prisma.shopWorkOrder.findUnique({
      where: { id: woId },
      select: {
        id: true, workOrderNumber: true, companyId: true, tier1: true, company: true, billingExtras: true,
        paidAtDropVia: true, lightspeedTxnNumber: true,
        dropOffContactEmail: true, pickupContactEmail: true,
        payments: {
          select: {
            amount: true, ccFeeAmount: true, status: true, paymentMethod: true, stripeChargeId: true,
            stripeReceiptUrl: true, cardLast4: true, cardBrand: true, createdAt: true,
          },
          orderBy: { createdAt: 'asc' },
        },
        items: { include: { product: { select: { id: true, partNumber: true, name: true, defaultSellPrice: true } } } },
      },
    });
    if (!order) throw new AppError(404, 'Shop work order not found');

    // A shop WO stores no total -- billing is derived from its units. Derive the
    // same figure the invoice would use, so the panel is not quoting an estimate.
    const now = new Date();
    const projected = order.items.map((i) => toBillingItem(i as unknown as Record<string, unknown>));
    const billable = projected.filter((i) => isBillableShopItem(i, now));
    const { lines } = await priceShopCharges(order, billable);
    const total = round2(lines.reduce((sum, l) => sum + l.amount, 0));

    const route = billingRoute({ ...order, total }, order.payments);
    // Settled card payments, newest first, with the hosted Stripe receipt. The
    // URL was already being stored and never shown; the counter needs it to
    // re-send or read out a receipt without opening the Stripe dashboard.
    const receipts = order.payments
      .filter((p) => p.status === 'succeeded' && p.stripeReceiptUrl)
      .map((p) => ({
        url: p.stripeReceiptUrl as string,
        amount: toNumber(p.amount),
        ccFee: toNumber(p.ccFeeAmount),
        cardBrand: p.cardBrand,
        cardLast4: p.cardLast4,
        paidAt: p.createdAt,
      }))
      .reverse();
    res.json({
      ...route,
      total,
      paidAtDropVia: order.paidAtDropVia,
      lightspeedTxnNumber: order.lightspeedTxnNumber,
      attribution: attribution(order, order.payments),
      receipts,
      // Surcharge collected, reported separately from `collected` because it is
      // deliberately NOT credited against the work.
      ccFeesCollected: round2(collectedCcFees(order.payments)),
      // Where Stripe would send a receipt for the next payment taken here.
      receiptEmail: order.dropOffContactEmail || order.pickupContactEmail || null,
      // Units still inside their 48h window are not billable yet (WI-05), so
      // the total can still move. Say so rather than letting the panel imply a
      // settled figure.
      unitsPending: projected.filter((i) => !isBillableShopItem(i, now) && !i.parentItemId).length,
    });
  } catch (err) {
    next(err);
  }
});

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ============================================================
// CONTACT LOG (WI-10) — append-only, two parties, one table
// ============================================================
//
// Replaces the JSONB-append endpoint that lived here. The path and the response
// shape are UNCHANGED on purpose: the existing pickup-contact card keeps
// working through the switch, which is WI-10's first acceptance criterion, and
// a client that has not been updated yet still gets a whole work order back.
//
// `party` defaults to 'customer' for exactly that reason. The old caller never
// sent one — it could not, the concept did not exist — and defaulting it means
// the old request body is still a valid request.

// POST /api/shop-orders/:id/contact-log
shopOrdersRouter.post('/:id/contact-log', async (req: Request, res: Response, next) => {
  try {
    const woId = req.params.id as string;
    const userId = req.user!.userId;

    const wo = await prisma.shopWorkOrder.findUnique({ where: { id: woId }, select: { id: true } });
    if (!wo) throw new AppError(404, 'Shop work order not found');

    const parsed = parseContactEntry({
      ...(req.body ?? {}),
      party: isContactParty((req.body ?? {}).party) ? req.body.party : 'customer',
    });
    if (!parsed.ok) throw new AppError(400, parsed.error!);
    const entry = parsed.value!;

    const u = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });

    await prisma.shopContactLogEntry.create({
      data: {
        workOrderId: woId,
        party: entry.party,
        method: entry.method,
        note: entry.note,
        contactedAt: entry.contactedAt,
        followUpAt: entry.followUpAt,
        entererById: userId,
        // Snapshotted, not joined: the entry has to stay readable after the
        // account that wrote it is renamed or deactivated.
        enteredByName: u?.name ?? null,
      },
    });

    await createAuditLog({
      userId,
      entityType: 'shop_work_order',
      entityId: woId,
      action: 'update',
      changes: { contactLog: 'appended', party: entry.party, method: entry.method },
      ipAddress: req.ip,
    });

    const updated = await prisma.shopWorkOrder.findUnique({
      where: { id: woId },
      include: WO_DETAIL_INCLUDE,
    });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/shop-orders/:id/contact-log/:entryId
//
// A SOFT delete, and supervisors only. The row stays, marked with who removed
// it and why — a "delete with a logged reason" that loses the entry keeps the
// reason and throws away the evidence, which is the half anybody reviewing an
// audit trail actually wants.
//
// The reason requirement and the append-only rule are both enforced at the
// database (a CHECK constraint and a BEFORE UPDATE trigger); this route is the
// permission check and the audit row.
shopOrdersRouter.delete(
  '/:id/contact-log/:entryId',
  requirePermission('shop_orders:delete'),
  async (req: Request, res: Response, next) => {
    try {
      const { id: woId, entryId } = req.params;
      const userId = req.user!.userId;
      const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
      if (!reason) {
        throw new AppError(400, 'A reason is required to remove a contact-log entry.');
      }

      const entry = await prisma.shopContactLogEntry.findUnique({
        where: { id: entryId as string },
        select: { id: true, workOrderId: true, deletedAt: true, note: true, party: true },
      });
      if (!entry || entry.workOrderId !== woId) {
        throw new AppError(404, 'Contact-log entry not found on this work order');
      }
      if (entry.deletedAt) {
        throw new AppError(409, 'That entry has already been removed.');
      }

      await prisma.shopContactLogEntry.update({
        where: { id: entryId as string },
        data: { deletedAt: new Date(), deletedById: userId, deleteReason: reason.slice(0, 500) },
      });

      await createAuditLog({
        userId,
        entityType: 'shop_work_order',
        entityId: woId,
        action: 'delete',
        // The removed text is captured in the audit row as well as left on the
        // (soft-deleted) entry, so the trail survives even a later hard purge.
        changes: { contactLogEntry: entryId, party: entry.party, note: entry.note, reason },
        ipAddress: req.ip,
      });

      const updated = await prisma.shopWorkOrder.findUnique({
        where: { id: woId },
        include: WO_DETAIL_INCLUDE,
      });
      res.json(updated);
    } catch (err) {
      next(err);
    }
  },
);

// ============================================================
// CHANGE WORK ORDER STATUS
// ============================================================

// PATCH /api/shop-orders/:id/status
shopOrdersRouter.patch('/:id/status', async (req: Request, res: Response, next) => {
  try {
    const woId = req.params.id as string;
    const { status: newStatus } = req.body;

    if (!newStatus) throw new AppError(400, 'status is required');

    const existing = await prisma.shopWorkOrder.findUnique({
      where: { id: woId },
      select: { id: true, status: true },
    });
    if (!existing) throw new AppError(404, 'Shop work order not found');

    if (!canTransitionShopWO(existing.status, newStatus as ShopWorkOrderStatus)) {
      throw new AppError(400, `Cannot transition from '${existing.status}' to '${newStatus}'`);
    }

    // QA gate: manually flipping the WO to "Ready for Pickup" must not bypass the
    // per-item equipment inspection requirement.
    if (newStatus === 'complete') {
      const items = await prisma.shopWorkOrderItem.findMany({
        where: { workOrderId: woId },
        select: { id: true, equipmentCategory: true, parentItemId: true, status: true },
      });
      for (const it of items) {
        await assertItemQaSatisfied(it);
      }
      // Same BlueLion gap as the per-item route: QA-satisfied doesn't mean
      // locked. Auto-lock now so bulk-completing a WO doesn't skip the ledger.
      for (const it of items) {
        await autoLockPassedInspections(prisma, it.id, req.user!.userId);
      }
    }

    const updateData: any = { status: newStatus };

    // Auto-set dates on certain transitions
    if (newStatus === 'complete') {
      updateData.completedDate = new Date();
    }

    const updated = await prisma.shopWorkOrder.update({
      where: { id: woId },
      data: updateData,
      include: WO_DETAIL_INCLUDE,
    });

    await createAuditLog({
      userId: req.user!.userId,
      action: 'status_change',
      entityType: 'ShopWorkOrder',
      entityId: woId,
      changes: { from: existing.status, to: newStatus },
    });

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// ============================================================
// ADD ITEMS TO EXISTING WORK ORDER
// ============================================================

// POST /api/shop-orders/:id/items
shopOrdersRouter.post('/:id/items', requirePermission('shop_orders:edit'), async (req: Request, res: Response, next) => {
  try {
    const woId = req.params.id as string;
    const { items } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      throw new AppError(400, 'At least one item is required');
    }

    await assertBinsAvailable(
      items
        .filter((it: any) => it.equipmentCategory === 'personal_monitor')
        .map((it: any) => ({ bin: binLocationOf(it.customData) }))
        .filter((c: any): c is { bin: string } => !!c.bin),
    );

    const existing = await prisma.shopWorkOrder.findUnique({
      where: { id: woId },
      select: { id: true, status: true, totalItems: true, intakeSiteId: true },
    });
    if (!existing) throw new AppError(404, 'Shop work order not found');

    // 'closed' is terminal (billing has already swept it) — quietly growing a
    // closed order is a double-bill landmine. Start a new intake instead.
    if (existing.status === 'closed') {
      throw new AppError(409, 'This work order is closed. Start a new intake for the additional equipment.');
    }

    // Get current max itemNumber
    const lastItem = await prisma.shopWorkOrderItem.findFirst({
      where: { workOrderId: woId },
      orderBy: { itemNumber: 'desc' },
      select: { itemNumber: true },
    });
    let itemNumber = (lastItem?.itemNumber ?? 0) + 1;

    const userId = req.user!.userId;
    const createdItems: any[] = [];

    await prisma.$transaction(async (tx) => {
      for (const item of items) {
        const {
          serialNumber, serializedEquipmentId, equipmentCategory,
          serviceType, productId, equipmentDescription, reportedIssue,
          fexBrand, fexSize, fexType, customData,
          components,
        } = item;

        if (!serialNumber) continue;

        const parentItem = await tx.shopWorkOrderItem.create({
          data: {
            workOrderId: woId,
            siteId: existing.intakeSiteId,
            itemNumber: itemNumber++,
            serializedEquipmentId: serializedEquipmentId || null,
            serialNumber,
            equipmentCategory: (equipmentCategory || 'other') as EquipmentCategoryShop,
            serviceType: (serviceType || 'general') as ShopServiceType,
            productId: productId || null,
            equipmentDescription: equipmentDescription || null,
            reportedIssue: reportedIssue || null,
            fexBrand: fexBrand || null,
            fexSize: fexSize || null,
            fexType: fexType || null,
            customData: customData || undefined,
            status: 'received',
          },
        });

        await tx.shopItemStatusLog.create({
          data: {
            itemId: parentItem.id,
            fromStatus: null,
            toStatus: 'received',
            changedById: userId,
            notes: 'Added to existing work order',
            location: 'Basin Shop',
          },
        });

        createdItems.push(parentItem);

        // SCBA sub-components
        if (Array.isArray(components) && components.length > 0) {
          for (const comp of components) {
            if (!comp.serialNumber) continue;
            const child = await tx.shopWorkOrderItem.create({
              data: {
                workOrderId: woId,
                siteId: existing.intakeSiteId,
                itemNumber: itemNumber++,
                serializedEquipmentId: comp.serializedEquipmentId || null,
                serialNumber: comp.serialNumber,
                equipmentCategory: (comp.equipmentCategory || 'scba') as EquipmentCategoryShop,
                serviceType: (comp.serviceType || serviceType || 'inspection') as ShopServiceType,
                productId: comp.productId || null,
                equipmentDescription: comp.type ? `SCBA ${comp.type}` : null,
                status: 'received',
                parentItemId: parentItem.id,
              },
            });

            await tx.shopItemStatusLog.create({
              data: {
                itemId: child.id,
                fromStatus: null,
                toStatus: 'received',
                changedById: userId,
                notes: `Added — component of ${serialNumber}`,
                location: 'Basin Shop',
              },
            });

            createdItems.push(child);
          }
        }
      }

      // Update totalItems count
      await tx.shopWorkOrder.update({
        where: { id: woId },
        data: { totalItems: existing.totalItems + createdItems.length },
      });
    });

    // Re-derive WO status: adding gear to a 'complete' (Ready for Pickup)
    // order pulls it back into an open state until the new units are serviced.
    await recomputeWOStatus(woId);

    await createAuditLog({
      userId,
      action: 'update',
      entityType: 'ShopWorkOrder',
      entityId: woId,
      changes: {
        itemsAdded: createdItems.length,
        serials: createdItems.map((it) => it.serialNumber),
      },
    });

    // Fetch updated WO
    const updated = await prisma.shopWorkOrder.findUnique({
      where: { id: woId },
      include: WO_DETAIL_INCLUDE,
    });

    res.status(201).json(updated);
  } catch (err) {
    next(err);
  }
});

// ============================================================
// INTAKE LABELS (operator-confirmed, replaces the old auto-fire)
// ============================================================

// POST /api/shop-orders/:id/labels — enqueue intake labels. Two shapes, and
// the intake print dialog sends both together:
//   itemIds: string[]  → one per-unit label per selected item (parents AND
//                        SCBA sub-components — each child label carries its
//                        own serial + "PART OF <parent serial>")
//   copies: number     → N identical order-level "<N> PCS" packet/bin labels
// Printer + selection come from the operator; nothing auto-fires.
shopOrdersRouter.post('/:id/labels', async (req: Request, res: Response, next) => {
  try {
    const woId = req.params.id as string;
    const { printerId, copies, itemIds } = req.body;

    const wo = await prisma.shopWorkOrder.findUnique({
      where: { id: woId },
      select: { id: true, intakeSiteId: true },
    });
    if (!wo) throw new AppError(404, 'Shop work order not found');

    const requestedItemIds: string[] = Array.isArray(itemIds)
      ? [...new Set(itemIds.filter((v): v is string => typeof v === 'string'))]
      : [];
    const orderCopies = Math.max(0, Math.min(Number(copies) || 0, 50));
    if (requestedItemIds.length === 0 && orderCopies === 0) {
      throw new AppError(400, 'Nothing to print — select items or a label count');
    }

    if (requestedItemIds.length > 0) {
      const owned = await prisma.shopWorkOrderItem.count({
        where: { id: { in: requestedItemIds }, workOrderId: woId },
      });
      if (owned !== requestedItemIds.length) {
        throw new AppError(400, 'One or more items do not belong to this work order');
      }
    }

    // Printer: explicit override, else routing precedence (master doc §9.6).
    let resolvedPrinterId = printerId as string | undefined;
    if (resolvedPrinterId) {
      const exists = await prisma.printer.findUnique({
        where: { id: resolvedPrinterId },
        select: { id: true, active: true },
      });
      if (!exists) throw new AppError(400, 'printerId does not match a known printer');
      if (!exists.active) throw new AppError(400, 'That printer is inactive');
    } else {
      const printer = await resolvePrinter(wo.intakeSiteId, 'intake');
      if (!printer) throw new AppError(409, 'No printer configured for this location');
      resolvedPrinterId = printer.id;
    }

    const template = await getDefaultTemplate();
    if (!template) throw new AppError(409, 'No active label template configured');

    const base = {
      shopWorkOrderId: woId,
      printerId: resolvedPrinterId,
      templateId: template.id,
      reason: 'initial',
      triggeredByUserId: req.user!.userId,
    };
    const jobs = [
      ...requestedItemIds.map((itemId) => ({ ...base, shopWorkOrderItemId: itemId, copies: 1 })),
      ...(orderCopies > 0 ? [{ ...base, shopWorkOrderItemId: null, copies: orderCopies }] : []),
    ];
    await prisma.printJob.createMany({ data: jobs });
    res.status(201).json({ queued: jobs.length });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// REPRINT LABEL
// ============================================================

// POST /api/shop-orders/:id/reprint
shopOrdersRouter.post('/:id/reprint', async (req: Request, res: Response, next) => {
  try {
    const woId = req.params.id as string;
    const { itemId, printerId, copies, reprintReason } = req.body;

    const wo = await prisma.shopWorkOrder.findUnique({
      where: { id: woId },
      select: { id: true, intakeSiteId: true },
    });
    if (!wo) throw new AppError(404, 'Shop work order not found');

    // Routing site: the item's current site when reprinting an item label,
    // otherwise the work order's intake site.
    let routingSiteId = wo.intakeSiteId;
    if (itemId) {
      const item = await prisma.shopWorkOrderItem.findUnique({
        where: { id: itemId as string },
        select: { id: true, workOrderId: true, siteId: true },
      });
      if (!item || item.workOrderId !== woId) {
        throw new AppError(404, 'Item not found on this work order');
      }
      routingSiteId = item.siteId;
    }

    // Printer: explicit override, else routing precedence (master doc §9.6).
    let resolvedPrinterId = printerId as string | undefined;
    if (resolvedPrinterId) {
      const exists = await prisma.printer.findUnique({
        where: { id: resolvedPrinterId },
        select: { id: true, active: true },
      });
      if (!exists) throw new AppError(400, 'printerId does not match a known printer');
      if (!exists.active) throw new AppError(400, 'That printer is inactive');
    } else {
      const printer = await resolvePrinter(routingSiteId);
      if (!printer) throw new AppError(409, 'No printer configured for this location');
      resolvedPrinterId = printer.id;
    }

    const template = await getDefaultTemplate();
    if (!template) throw new AppError(409, 'No active label template configured');

    const job = await prisma.printJob.create({
      data: {
        shopWorkOrderId: woId,
        shopWorkOrderItemId: (itemId as string) || null,
        printerId: resolvedPrinterId,
        templateId: template.id,
        copies: Math.max(1, Math.min(Number(copies) || 1, 20)),
        reason: 'reprint',
        reprintReason: reprintReason || 'other',
        triggeredByUserId: req.user!.userId,
      },
    });
    res.status(201).json(job);
  } catch (err) {
    next(err);
  }
});

// ============================================================
// CHANGE ITEM STATUS
// ============================================================

// PATCH /api/shop-orders/:id/items/:itemId/status
shopOrdersRouter.patch('/:id/items/:itemId/status', async (req: Request, res: Response, next) => {
  try {
    const { itemId } = req.params;
    const { status: newStatus, notes, location, holdReason, holdNote } = req.body;

    if (!newStatus) throw new AppError(400, 'status is required');

    const item = await prisma.shopWorkOrderItem.findUnique({
      where: { id: itemId as string },
      select: {
        id: true, status: true, workOrderId: true, equipmentCategory: true, parentItemId: true,
        serialNumber: true, serializedEquipmentId: true,
        softClosedAt: true, hardClosesAt: true, closedById: true,
      },
    });
    if (!item) throw new AppError(404, 'Item not found');

    // WI-05: a hard-closed unit's record is final; a soft-closed one may only be
    // moved by the tech who closed it or a supervisor.
    const editVerdict = canEditUnit(item, { userId: req.user!.userId, role: req.user!.role });
    if (!editVerdict.allowed) throw new AppError(409, editVerdict.reason!);

    // Credit hold blocks handing equipment back to the customer. Every other
    // transition (diagnose, work, QC, shop_complete, condemn) stays open so the
    // shop can finish the job while AR sorts the account out.
    if (newStatus === 'returned') {
      await assertShopReturnAllowed(item.workOrderId);
    }

    if (!canTransitionShopItem(item.status, newStatus as ShopItemStatus)) {
      const available = getAvailableShopItemTransitions(item.status);
      throw new AppError(400, `Cannot transition from '${item.status}' to '${newStatus}'. Valid: ${available.join(', ')}`);
    }

    // WI-02: On Hold demands a reason. Enforced here via the state machine, so
    // no caller — UI, kiosk, script, future batch action — can park a unit
    // without one.
    const holdErr = holdReasonError(newStatus as ShopItemStatus, holdReason);
    if (holdErr) throw new AppError(400, holdErr);

    const userId = req.user!.userId;

    // QA gate: block "Ready for Pickup" until the equipment inspection is complete.
    if (newStatus === 'shop_complete') {
      await assertItemQaSatisfied(item);
    } else if (newStatus === 'condemned') {
      // WI-04: evidence before the irreversible bit. Checked BEFORE the ledger
      // record is synthesised below -- otherwise a rejected condemn would still
      // leave a locked condemn inspection behind, and the second attempt would
      // find the unit already half-condemned.
      const evidence = await checkCondemnEvidence(prisma, item.id);
      if (!evidence.satisfied) throw new AppError(409, evidence.message!);

      // Ensure a locked condemn inspection backs this transition so the
      // BlueLion ledger always gets a record, even via the raw status button.
      await ensureLockedCondemnInspection(item, userId);
    }

    // ── WI-09: coming back from a vendor is a receive, wherever it is done ──
    //
    // THIS is the path the UI actually uses. The dedicated
    // /items/:itemId/receive-back endpoint exists and no client calls it — the
    // detail page moves the unit with the ordinary status dropdown, so a gate
    // that lived only on the dedicated endpoint would guard a door nobody walks
    // through. Same lesson as WI-04's four routes to `condemned`.
    //
    // The capture is therefore attached to the TRANSITION, not to an endpoint,
    // and both paths call the same parse + write.
    let receiveFields: Record<string, unknown> = {};
    let receivePayload: ReceivePayload | undefined;
    let receiveNote: string | null = null;
    if (newStatus === 'received' && SENT_OUT_STATUSES.includes(item.status)) {
      const parsed = parseReceivePayload(req.body);
      if (!parsed.ok) throw new AppError(400, parsed.error!);
      const documentError = await vendorReturnDocumentError(prisma, item.id, parsed.payload!.disposition);
      if (documentError) throw new AppError(409, documentError);
      const { status: _ignored, ...rest } = receiveUpdateData(parsed.payload!);
      receiveFields = rest;
      receivePayload = parsed.payload!;
      receiveNote = receiveLogNote(parsed.payload!);
    }

    // Update item + create status log in one transaction
    const updatedItem = await prisma.$transaction(async (tx) => {
      if (receivePayload) await applyReceiveBilling(tx, itemId as string, receivePayload);
      const updated = await tx.shopWorkOrderItem.update({
        where: { id: itemId as string },
        data: {
          status: newStatus as ShopItemStatus,
          ...receiveFields,
          ...closerFieldsFor(item, newStatus as string, userId),
          // Reason travels with the hold and is cleared the moment the unit
          // comes off it, so a stale "waiting internal" can't linger on a unit
          // that's back on the bench. The derived holds (parts/approval/vendor)
          // never store a reason at all.
          holdReason: newStatus === 'on_hold' && isSettableHoldReason(holdReason) ? holdReason : null,
          holdNote: isHoldStatus(newStatus as ShopItemStatus)
            ? (typeof holdNote === 'string' && holdNote.trim() ? holdNote.trim().slice(0, 200) : null)
            : null,
        },
        include: ITEM_INCLUDE,
      });
      await tx.shopItemStatusLog.create({
        data: {
          itemId: itemId as string,
          fromStatus: item.status,
          toStatus: newStatus as ShopItemStatus,
          changedById: userId,
          // The receive summary wins over a bare note: six weeks later the
          // useful line is "warranty, invoice total $0", not "ok".
          notes: receiveNote || notes || null,
          location: location || null,
        },
      });

      // ── Assembly cascade: when a parent item advances, auto-advance children ──
      // SCBA assemblies have child components (regulator, mask, harness, bottles)
      // that are tracked for serial purposes but serviced as one unit.
      // When the parent reaches shop_complete, returned, or condemned, children follow.
      const cascadeStatuses: ShopItemStatus[] = ['shop_complete', 'returned', 'condemned'];
      if (cascadeStatuses.includes(newStatus as ShopItemStatus)) {
        const childItems = await tx.shopWorkOrderItem.findMany({
          where: {
            parentItemId: itemId as string,
            status: { not: newStatus as ShopItemStatus },
          },
          select: { id: true, status: true },
        });

        for (const child of childItems) {
          await tx.shopWorkOrderItem.update({
            where: { id: child.id },
            data: {
              status: newStatus as ShopItemStatus,
              ...(newStatus === 'returned' ? { returnedAt: new Date(), returnMethod: 'picked_up' } : {}),
            },
          });
          await tx.shopItemStatusLog.create({
            data: {
              itemId: child.id,
              fromStatus: child.status,
              toStatus: newStatus as ShopItemStatus,
              changedById: userId,
              notes: `Auto-cascaded from parent assembly`,
              location: location || null,
            },
          });
        }

        if (childItems.length > 0) {
          console.log(`[Shop] Cascaded ${newStatus} to ${childItems.length} child component(s) of item ${itemId}`);
        }
      }

      return updated;
    });

    // Reaching shop_complete only required the QA checklist filled in above, not
    // the inspection actually locked — but locking is what triggers the BlueLion
    // ledger push. Auto-lock now so a completed Shop Order can't silently skip
    // BlueLion just because the tech never clicked the separate Lock button.
    // Best-effort: never blocks this response.
    if (newStatus === 'shop_complete') {
      await autoLockPassedInspections(prisma, itemId as string, userId);
    }

    // Recompute WO denormalized counts + auto-derive WO status from items
    await recomputeWOStatus(item.workOrderId);

    res.json(updatedItem);
  } catch (err) {
    next(err);
  }
});

// ============================================================
// UPDATE ITEM DETAILS
// ============================================================

// PUT /api/shop-orders/:id/items/:itemId
shopOrdersRouter.put('/:id/items/:itemId', async (req: Request, res: Response, next) => {
  try {
    const { itemId } = req.params;
    const {
      serviceType, reportedIssue, equipmentDescription, equipmentCategory,
      serialNumber,
      fexBrand, fexSize, fexType,
      diagnosisNotes, diagnosedById,
      estimatedCost,
      assignedToId, workNotes,
      isWarranty, warrantyVendor,
      qcResult, qcNotes,
      partsUsed, billing,
      customData,
    } = req.body;

    const item = await prisma.shopWorkOrderItem.findUnique({
      where: { id: itemId as string },
      select: {
        id: true, status: true, equipmentCategory: true, parentItemId: true, serialNumber: true, billing: true,
        softClosedAt: true, hardClosesAt: true, closedById: true,
      },
    });
    if (!item) throw new AppError(404, 'Item not found');

    // WI-05: this is the route WI-05's "all fields editable, including unit
    // serial" flows through, so it is also where the window is enforced.
    const editVerdict = canEditUnit(item, { userId: req.user!.userId, role: req.user!.role });
    if (!editVerdict.allowed) throw new AppError(409, editVerdict.reason!);

    if (customData !== undefined) {
      const newBin = binLocationOf(customData);
      if (newBin) await assertBinsAvailable([{ bin: newBin, excludeItemId: item.id }]);
    }

    // Service type and equipment category are intake details — locked once the
    // unit hits QA so a finished item can't have its identity changed.
    const TYPE_LOCKED: ShopItemStatus[] = ['qc_testing', 'shop_complete', 'returned'];
    const typeChangeRequested =
      (serviceType !== undefined && serviceType !== null) ||
      (equipmentCategory !== undefined && equipmentCategory !== null);
    if (typeChangeRequested && TYPE_LOCKED.includes(item.status)) {
      throw new AppError(409, 'Service type / category are locked once the item reaches QA');
    }

    const data: any = {};

    // WI-07: a serial mistyped at intake (the classic being a test date pasted
    // into a serial field) has to be fixable in place. Correcting it must NOT
    // mean re-doing intake -- the unit is physically here and the intake record
    // is a historical fact about its arrival, not a place to relitigate.
    //
    // Audited with the prior value below, because a serial is the unit's
    // identity: everything downstream (the Vault record, its service history,
    // the label on the shelf) keys on it, so a silent change would be the
    // hardest kind of edit to trace.
    let serialCorrection: { from: string; to: string } | null = null;
    if (typeof serialNumber === 'string' && serialNumber.trim()) {
      const next = serialNumber.trim();
      if (next !== item.serialNumber) {
        serialCorrection = { from: item.serialNumber, to: next };
        data.serialNumber = next;
      }
    }

    if (serviceType !== undefined) data.serviceType = serviceType;
    if (reportedIssue !== undefined) data.reportedIssue = reportedIssue;
    if (equipmentDescription !== undefined) data.equipmentDescription = equipmentDescription;
    if (equipmentCategory !== undefined) data.equipmentCategory = equipmentCategory;
    if (fexBrand !== undefined) data.fexBrand = fexBrand;
    if (fexSize !== undefined) data.fexSize = fexSize;
    if (fexType !== undefined) data.fexType = fexType;

    // Diagnosis
    if (diagnosisNotes !== undefined) data.diagnosisNotes = diagnosisNotes;
    if (diagnosedById !== undefined) {
      data.diagnosedById = diagnosedById;
      if (diagnosedById && !data.diagnosedAt) data.diagnosedAt = new Date();
    }

    // Quote
    if (estimatedCost !== undefined) data.estimatedCost = estimatedCost;

    // Assignment
    if (assignedToId !== undefined) data.assignedToId = assignedToId;
    if (workNotes !== undefined) data.workNotes = workNotes;

    // Warranty
    if (isWarranty !== undefined) data.isWarranty = isWarranty;
    if (warrantyVendor !== undefined) data.warrantyVendor = warrantyVendor;

    // QC
    if (qcResult !== undefined) data.qcResult = qcResult;
    if (qcNotes !== undefined) data.qcNotes = qcNotes;

    // Parts (materials) + the structured billing chunk (labor time, per-unit
    // misc, outside-vendor passthrough + invoice attachment, roll-up flag).
    if (partsUsed !== undefined) data.partsUsed = partsUsed;
    if (billing !== undefined) {
      if (billing?.services !== undefined) {
        billing.services = await normalizeServiceCharges(billing.services);
      }
      validateVendorServiceLink(billing);
      data.billing = billing;
    }

    // Custom
    if (customData !== undefined) data.customData = customData;

    // Category change on a parent item: its SCBA sub-components no longer
    // apply. Wipe them so the board reflects the corrected unit.
    const categoryChanged =
      equipmentCategory !== undefined &&
      equipmentCategory !== null &&
      equipmentCategory !== item.equipmentCategory &&
      !item.parentItemId;

    const updated = await prisma.$transaction(async (tx) => {
      if (categoryChanged) {
        await tx.shopWorkOrderItem.deleteMany({ where: { parentItemId: itemId as string } });
      }
      const saved = await tx.shopWorkOrderItem.update({ where: { id: itemId as string }, data, include: ITEM_INCLUDE });
      if (billing?.services !== undefined) {
        const draft = await tx.equipmentInspection.findFirst({ where: { shopItemId: itemId as string, lockedAt: null }, orderBy: { inspectedAt: 'desc' } });
        if (draft) await tx.equipmentInspection.update({ where: { id: draft.id }, data: {
          serviceActions: linkedQaActions(asStringArray(draft.serviceActions).filter(a => !servicesFromBilling(item.billing).some(old => serviceQaMapping(old.partNumber)?.actions.includes(a))), servicesFromBilling(saved.billing), draft.category),
        } });
      }
      return saved;
    });

    if (serialCorrection) {
      await createAuditLog({
        userId: req.user!.userId,
        action: 'update',
        entityType: 'shop_work_order_item',
        entityId: itemId as string,
        changes: { serialNumber: serialCorrection },
      });
    }

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// ============================================================
// SEND ITEM OUT (Warranty / Outside Service)
// ============================================================

// POST /api/shop-orders/:id/items/:itemId/send-out
shopOrdersRouter.post('/:id/items/:itemId/send-out', async (req: Request, res: Response, next) => {
  try {
    const { itemId } = req.params;
    const {
      sentOutTo, sentOutMethod, sentOutTracking,
      isWarranty, warrantyVendor, notes, sentOutDate,
    } = req.body;

    const item = await prisma.shopWorkOrderItem.findUnique({
      where: { id: itemId as string },
      select: { id: true, status: true, workOrderId: true },
    });
    if (!item) throw new AppError(404, 'Item not found');

    // Decoupled: send-out always lands in 'outside_service' ("someone offsite
    // has it"); isWarranty is an orthogonal flag (drives billing suppression,
    // not status). 'warranty_out' is retired.
    const targetStatus: ShopItemStatus = 'outside_service';

    if (!canTransitionShopItem(item.status, targetStatus)) {
      throw new AppError(400, `Cannot send out from status '${item.status}'`);
    }

    // Shipping date — default now, but backdatable ("it shipped yesterday").
    let shippedDate = new Date();
    if (sentOutDate) {
      const parsed = new Date(sentOutDate);
      if (isNaN(parsed.getTime())) throw new AppError(400, 'Invalid sentOutDate');
      shippedDate = parsed;
    }

    const userId = req.user!.userId;

    await prisma.$transaction([
      prisma.shopWorkOrderItem.update({
        where: { id: itemId as string },
        data: {
          status: targetStatus,
          sentOutDate: shippedDate,
          sentOutTo: sentOutTo || null,
          sentOutMethod: (sentOutMethod || null) as ShipmentMethod | null,
          sentOutTracking: sentOutTracking || null,
          isWarranty: !!isWarranty,
          warrantyVendor: warrantyVendor || null,
        },
      }),
      prisma.shopItemStatusLog.create({
        data: {
          itemId: itemId as string,
          fromStatus: item.status,
          toStatus: targetStatus,
          changedById: userId,
          notes: notes || `Sent to ${sentOutTo || 'vendor'}`,
          location: sentOutTo || null,
        },
      }),
    ]);

    // Recompute WO status (warranty_out / outside_service → hold)
    await recomputeWOStatus(item.workOrderId);

    const updated = await prisma.shopWorkOrderItem.findUnique({
      where: { id: itemId as string },
      include: ITEM_INCLUDE,
    });

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// ============================================================
// RECEIVE ITEM BACK (from Warranty / Outside Service)
// ============================================================

// POST /api/shop-orders/:id/items/:itemId/receive-back
shopOrdersRouter.post('/:id/items/:itemId/receive-back', async (req: Request, res: Response, next) => {
  try {
    const { itemId } = req.params;

    const item = await prisma.shopWorkOrderItem.findUnique({
      where: { id: itemId as string },
      select: { id: true, status: true, workOrderId: true },
    });
    if (!item) throw new AppError(404, 'Item not found');

    if (item.status !== 'warranty_out' && item.status !== 'outside_service') {
      throw new AppError(400, `Item is not sent out (current status: ${item.status})`);
    }

    const userId = req.user!.userId;

    // WI-09: same parse, same write, same required disposition as the status
    // transition above. Two endpoints reaching one state must not be two
    // opinions about what that state requires.
    const parsed = parseReceivePayload(req.body);
    if (!parsed.ok) throw new AppError(400, parsed.error!);
    const documentError = await vendorReturnDocumentError(prisma, item.id, parsed.payload!.disposition);
    if (documentError) throw new AppError(409, documentError);

    await prisma.$transaction(async tx => {
      await applyReceiveBilling(tx, itemId as string, parsed.payload!);
      await tx.shopWorkOrderItem.update({
        where: { id: itemId as string },
        data: receiveUpdateData(parsed.payload!),
      });
      await tx.shopItemStatusLog.create({
        data: {
          itemId: itemId as string,
          fromStatus: item.status,
          toStatus: 'received',
          changedById: userId,
          notes: receiveLogNote(parsed.payload!),
          location: 'Basin Shop',
        },
      });
    });

    // Recompute WO status
    await recomputeWOStatus(item.workOrderId);

    const updated = await prisma.shopWorkOrderItem.findUnique({
      where: { id: itemId as string },
      include: ITEM_INCLUDE,
    });

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// ============================================================
// ITEM STATUS HISTORY (Chain of Custody)
// ============================================================

// GET /api/shop-orders/:id/items/:itemId/history
shopOrdersRouter.get('/:id/items/:itemId/history', async (req: Request, res: Response, next) => {
  try {
    const { itemId } = req.params;

    const item = await prisma.shopWorkOrderItem.findUnique({
      where: { id: itemId as string },
      select: { id: true },
    });
    if (!item) throw new AppError(404, 'Item not found');

    const history = await prisma.shopItemStatusLog.findMany({
      where: { itemId: itemId as string },
      include: {
        changedBy: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    res.json({ data: history });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// APPROVE / DECLINE QUOTE
// ============================================================

// POST /api/shop-orders/:id/items/:itemId/approve-quote
shopOrdersRouter.post('/:id/items/:itemId/approve-quote', async (req: Request, res: Response, next) => {
  try {
    const { itemId } = req.params;

    const item = await prisma.shopWorkOrderItem.findUnique({
      where: { id: itemId as string },
      select: { id: true, status: true, workOrderId: true },
    });
    if (!item) throw new AppError(404, 'Item not found');

    if (item.status !== 'awaiting_approval') {
      throw new AppError(400, `Item is not awaiting approval (current: ${item.status})`);
    }

    await prisma.shopWorkOrderItem.update({
      where: { id: itemId as string },
      data: {
        quoteApprovedAt: new Date(),
        status: 'in_work',
      },
    });

    await prisma.shopItemStatusLog.create({
      data: {
        itemId: itemId as string,
        fromStatus: 'awaiting_approval',
        toStatus: 'in_work',
        changedById: req.user!.userId,
        notes: 'Quote approved',
      },
    });

    await recomputeWOStatus(item.workOrderId);

    const updated = await prisma.shopWorkOrderItem.findUnique({
      where: { id: itemId as string },
      include: ITEM_INCLUDE,
    });

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// POST /api/shop-orders/:id/items/:itemId/decline-quote
shopOrdersRouter.post('/:id/items/:itemId/decline-quote', async (req: Request, res: Response, next) => {
  try {
    const { itemId } = req.params;

    const item = await prisma.shopWorkOrderItem.findUnique({
      where: { id: itemId as string },
      select: { id: true, status: true, workOrderId: true },
    });
    if (!item) throw new AppError(404, 'Item not found');

    if (item.status !== 'awaiting_approval') {
      throw new AppError(400, `Item is not awaiting approval (current: ${item.status})`);
    }

    await prisma.shopWorkOrderItem.update({
      where: { id: itemId as string },
      data: {
        quoteDeclinedAt: new Date(),
        status: 'returned',
      },
    });

    await prisma.shopItemStatusLog.create({
      data: {
        itemId: itemId as string,
        fromStatus: 'awaiting_approval',
        toStatus: 'returned',
        changedById: req.user!.userId,
        notes: 'Quote declined — returning to customer',
      },
    });

    await recomputeWOStatus(item.workOrderId);

    const updated = await prisma.shopWorkOrderItem.findUnique({
      where: { id: itemId as string },
      include: ITEM_INCLUDE,
    });

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// ============================================================
// AVAILABLE TRANSITIONS (for UI state machine buttons)
// ============================================================

// GET /api/shop-orders/:id/transitions
shopOrdersRouter.get('/:id/transitions', async (req: Request, res: Response, next) => {
  try {
    const order = await prisma.shopWorkOrder.findUnique({
      where: { id: req.params.id as string },
      select: { id: true, status: true },
    });
    if (!order) throw new AppError(404, 'Shop work order not found');

    res.json({ current: order.status, available: getAvailableShopWOTransitions(order.status) });
  } catch (err) {
    next(err);
  }
});

// GET /api/shop-orders/:id/items/:itemId/transitions
shopOrdersRouter.get('/:id/items/:itemId/transitions', async (req: Request, res: Response, next) => {
  try {
    const item = await prisma.shopWorkOrderItem.findUnique({
      where: { id: req.params.itemId as string },
      select: { id: true, status: true },
    });
    if (!item) throw new AppError(404, 'Item not found');

    res.json({ current: item.status, available: getAvailableShopItemTransitions(item.status) });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// BATCH CLEAR / RETURN (intake fan-out at scale — Wave 5)
// ============================================================

// POST /api/shop-orders/:id/bulk-clear
// Checkbox-select N units and clear them in one batch "visual pass" attestation.
// For a big intake (e.g. 20 in, 10 clear) this is the at-scale version of
// inspecting each unit. Each selected, non-terminal, non-warranty top-level unit
// gets a LOCKED visual-only PASS inspection (for the BlueLion ledger + the
// rolled-up visual-only billing line) and moves to shop_complete (Ready). The
// single batch attestation bypasses the per-unit QA checklist by design.
shopOrdersRouter.post('/:id/bulk-clear', async (req: Request, res: Response, next) => {
  try {
    const woId = req.params.id as string;
    const userId = req.user!.userId;
    const { itemIds, attestedBy } = req.body ?? {};
    if (!Array.isArray(itemIds) || itemIds.length === 0) {
      throw new AppError(400, 'itemIds (non-empty array) is required');
    }

    const wo = await prisma.shopWorkOrder.findUnique({ where: { id: woId }, select: { id: true } });
    if (!wo) throw new AppError(404, 'Shop work order not found');

    // Eligible = on this WO, top-level, not warranty, not already terminal.
    const TERMINAL = ['shop_complete', 'returned', 'condemned'];
    const items = await prisma.shopWorkOrderItem.findMany({
      where: { id: { in: itemIds as string[] }, workOrderId: woId },
      select: { id: true, status: true, parentItemId: true, isWarranty: true, serialNumber: true, equipmentCategory: true, serializedEquipmentId: true },
    });

    const now = new Date();
    let cleared = 0;
    const skipped: string[] = [];

    for (const item of items) {
      if (item.parentItemId || item.isWarranty || TERMINAL.includes(item.status)) {
        skipped.push(item.id);
        continue;
      }
      const category = mapShopCategoryToInspection(item.equipmentCategory);
      // Attestation = "all checks pass": fill the required shop keys true so the
      // record reads QA-complete, and flag it as a batch visual clear for audit.
      const qaChecklist: Record<string, boolean> = {};
      for (const k of getRequiredShopKeys(category)) qaChecklist[k] = true;

      const inspId = await prisma.$transaction(async (tx) => {
        const insp = await tx.equipmentInspection.create({
          data: {
            shopItemId: item.id,
            serializedEquipmentId: item.serializedEquipmentId,
            serialNumber: item.serialNumber,
            category: category as never,
            outcome: 'pass',
            serviceActions: ['visual_only'],
            data: { batchVisualClear: true, attestedBy: attestedBy || null, attestedAt: now.toISOString(), qaChecklist },
            inspectedById: userId,
            inspectedAt: now,
            lockedAt: now,
          },
          select: { id: true },
        });
        await tx.shopWorkOrderItem.update({
          where: { id: item.id },
          // closedById so the tech who cleared it can still correct it inside
          // the 48h window; the timestamps come from the DB trigger.
          data: { status: 'shop_complete', closedById: userId },
        });
        await tx.shopItemStatusLog.create({
          data: {
            itemId: item.id,
            fromStatus: item.status as ShopItemStatus,
            toStatus: 'shop_complete',
            changedById: userId,
            notes: `Batch visual clear${attestedBy ? ` — attested by ${attestedBy}` : ''} (inspection ${insp.id})`,
          },
        });
        return insp.id;
      });
      // BlueLion ledger record for the visual-only pass — after commit so the
      // enqueue (which reads via the global client) sees the locked inspection.
      // No-op when BlueLion is unconfigured.
      await enqueueInspectionRecord(inspId).catch(() => {});
      cleared++;
    }

    await recomputeWOStatus(woId);
    await createAuditLog({
      userId,
      action: 'status_change',
      entityType: 'ShopWorkOrder',
      entityId: woId,
      changes: { batchClear: cleared, skipped: skipped.length },
    });

    res.json({ cleared, skipped: skipped.length });
  } catch (err) {
    next(err);
  }
});

// POST /api/shop-orders/:id/bulk-status
// Apply ONE status move + a shared note to a checkbox selection — the "did the
// same thing to 12 units" case (e.g. set In Repair + note "changed O2 sensor").
// Targets are the mid-workflow stages only; the QA-gated terminal states go
// through bulk-clear (Ready) / bulk-return (Returned). Per-item state-machine
// validity is enforced; ineligible units are skipped and counted.
shopOrdersRouter.post('/:id/bulk-status', async (req: Request, res: Response, next) => {
  try {
    const woId = req.params.id as string;
    const userId = req.user!.userId;
    const { itemIds, status, note, holdReason, holdNote } = req.body ?? {};
    if (!Array.isArray(itemIds) || itemIds.length === 0) {
      throw new AppError(400, 'itemIds (non-empty array) is required');
    }
    const ALLOWED = ['diagnosing', 'in_work', 'qc_testing', 'awaiting_parts', 'awaiting_approval', 'outside_service', 'on_hold'];
    if (!ALLOWED.includes(status)) {
      throw new AppError(400, `status must be one of: ${ALLOWED.join(', ')} (use bulk-clear / bulk-return for terminal states)`);
    }
    const target = status as ShopItemStatus;
    const trimmedNote = typeof note === 'string' && note.trim() ? note.trim() : null;

    // Same hold-reason gate as the single-item path — checked once for the
    // whole batch, before anything moves, so a missing reason fails the request
    // instead of half-parking the selection.
    const holdErr = holdReasonError(target, holdReason);
    if (holdErr) throw new AppError(400, holdErr);
    const trimmedHoldNote =
      typeof holdNote === 'string' && holdNote.trim() ? holdNote.trim().slice(0, 200) : null;

    const items = await prisma.shopWorkOrderItem.findMany({
      where: { id: { in: itemIds as string[] }, workOrderId: woId },
      select: { id: true, status: true, parentItemId: true, workNotes: true },
    });

    let changed = 0;
    const skipped: string[] = [];
    for (const item of items) {
      if (item.parentItemId || !canTransitionShopItem(item.status, target)) {
        skipped.push(item.id);
        continue;
      }
      const nextNotes = trimmedNote
        ? (item.workNotes ? `${item.workNotes}\n${trimmedNote}` : trimmedNote)
        : item.workNotes;
      await prisma.$transaction(async (tx) => {
        await tx.shopWorkOrderItem.update({
          where: { id: item.id },
          data: {
            status: target,
            ...(trimmedNote ? { workNotes: nextNotes } : {}),
            holdReason: target === 'on_hold' && isSettableHoldReason(holdReason) ? holdReason : null,
            holdNote: isHoldStatus(target) ? trimmedHoldNote : null,
          },
        });
        await tx.shopItemStatusLog.create({
          data: {
            itemId: item.id,
            fromStatus: item.status as ShopItemStatus,
            toStatus: target,
            changedById: userId,
            notes: trimmedNote ? `Batch: ${trimmedNote}` : 'Batch status change',
          },
        });
      });
      changed++;
    }

    await recomputeWOStatus(woId);
    res.json({ changed, skipped: skipped.length });
  } catch (err) {
    next(err);
  }
});

// POST /api/shop-orders/:id/bulk-return
// Bulk "release" the selected Ready units (shop_complete → returned), leaving the
// rest of the WO live. The companion to bulk-clear (Clear → Ready, then Return).
shopOrdersRouter.post('/:id/bulk-return', async (req: Request, res: Response, next) => {
  try {
    const woId = req.params.id as string;
    const userId = req.user!.userId;
    const { itemIds } = req.body ?? {};
    if (!Array.isArray(itemIds) || itemIds.length === 0) {
      throw new AppError(400, 'itemIds (non-empty array) is required');
    }
    await assertShopReturnAllowed(woId);
    const items = await prisma.shopWorkOrderItem.findMany({
      where: { id: { in: itemIds as string[] }, workOrderId: woId, status: 'shop_complete' },
      select: { id: true, status: true },
    });
    const now = new Date();
    let returned = 0;
    for (const item of items) {
      await prisma.$transaction(async (tx) => {
        await tx.shopWorkOrderItem.update({
          where: { id: item.id },
          data: { status: 'returned', returnedAt: now, returnMethod: 'picked_up', closedById: userId },
        });
        await tx.shopItemStatusLog.create({
          data: {
            itemId: item.id,
            fromStatus: 'shop_complete',
            toStatus: 'returned',
            changedById: userId,
            notes: 'Batch return / release',
          },
        });
      });
      returned++;
    }
    await recomputeWOStatus(woId);
    res.json({ returned });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// BATCH QA (WI-06)
// ============================================================
//
// "QA a batch in one action, then handle the exceptions individually." Both
// halves are this one endpoint: a batch of four and a single unit differ only
// in how many ids are in `itemIds`, so the per-unit exception path is not a
// second code path that can drift from the batch one.
//
// ANYONE CAN QA ANY JOB, including the tech who did the work — explicitly, per
// the spec. There is no separation-of-duties check here and that is deliberate,
// not an oversight: a two-tech shop cannot honour one, and a rule that is
// routinely waived teaches people the rules are negotiable.

/** Units eligible to be QA'd: on this WO, top-level, not already terminal. */
const QA_INELIGIBLE_STATUSES = new Set(['shop_complete', 'returned', 'condemned']);

/** The per-unit shape returned to the client for both QA endpoints. */
const QA_EVENT_INCLUDE = {
  performedBy: { select: { id: true, name: true } },
  correctedBy: { select: { id: true, name: true } },
  results: {
    select: {
      id: true, itemId: true, outcome: true, checklistOverrides: true,
      failedKeys: true, notes: true, vaultSnapshotAt: true, inspectionId: true,
      item: { select: { serialNumber: true, status: true, equipmentCategory: true } },
    },
  },
} as const;

// GET /api/shop-orders/:id/qa-events
// The QA history for a work order, plus the catalog the UI renders checkboxes
// from — one round trip, because the panel is useless without both.
shopOrdersRouter.get('/:id/qa-events', async (req: Request, res: Response, next) => {
  try {
    const events = await prisma.shopQaEvent.findMany({
      where: { workOrderId: req.params.id as string },
      include: QA_EVENT_INCLUDE,
      orderBy: { performedAt: 'desc' },
    });
    res.json({
      events: events.map((e) => ({
        ...e,
        // Frozen the moment ANY unit in the batch has snapshotted: the batch is
        // one record, and half a corrected batch is worse than none.
        locked: e.results.some((r) => r.vaultSnapshotAt !== null),
      })),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/shop-orders/:id/qa-checklist?itemIds=a,b,c
// The checklist to run against a selection — resolved server-side so the client
// cannot QA against a different list than the gate will check.
shopOrdersRouter.get('/:id/qa-checklist', async (req: Request, res: Response, next) => {
  try {
    const ids = String(req.query.itemIds || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (ids.length === 0) throw new AppError(400, 'itemIds is required');

    const items = await prisma.shopWorkOrderItem.findMany({
      where: { id: { in: ids }, workOrderId: req.params.id as string, parentItemId: null },
      select: { id: true, serialNumber: true, equipmentCategory: true, status: true },
    });
    const eligible = items.filter((i) => !QA_INELIGIBLE_STATUSES.has(i.status));
    const { category, error } = categoryConflict(eligible);
    if (error || !category) {
      res.json({ category: null, error, checkpoints: [], eligible: [], skipped: [] });
      return;
    }

    res.json({
      category,
      error: null,
      checklistVersion: checklistVersion(category),
      // Full shop catalog with a `required` flag, rather than only the required
      // ones: a tech recording an optional observation is worth capturing, and
      // hiding the optional checks makes the batch panel disagree with the
      // per-unit inspection editor about what the checklist even is.
      checkpoints: getShopChecklist(category).map((c) => ({
        key: c.key,
        label: c.label,
        required: c.requiredInShop,
      })),
      eligible: eligible.map((i) => ({ id: i.id, serialNumber: i.serialNumber })),
      skipped: items
        .filter((i) => QA_INELIGIBLE_STATUSES.has(i.status))
        .map((i) => ({ id: i.id, serialNumber: i.serialNumber, reason: i.status })),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/shop-orders/:id/batch-qa
//
// Body: { itemIds[], checklistResults{}, serviceActions[]?, notes?,
//         perUnit?: { [itemId]: { overrides?, notes?, fail? } },
//         advanceOnPass?: boolean }
//
// Writes ONE ShopQaEvent and N ShopQaUnitResults, in one transaction. The
// whole batch commits or none of it does — a batch that half-applied is the
// exact state the normalized shape exists to prevent, so it must not be
// reachable by a network blip either.
shopOrdersRouter.post(
  '/:id/batch-qa',
  requirePermission('shop_orders:edit'),
  async (req: Request, res: Response, next) => {
    try {
      const woId = req.params.id as string;
      const userId = req.user!.userId;
      const {
        itemIds, checklistResults, serviceActions, notes, perUnit, advanceOnPass = true,
      } = req.body ?? {};

      if (!Array.isArray(itemIds) || itemIds.length === 0) {
        throw new AppError(400, 'itemIds (non-empty array) is required');
      }

      const wo = await prisma.shopWorkOrder.findUnique({
        where: { id: woId },
        select: { id: true, status: true },
      });
      if (!wo) throw new AppError(404, 'Shop work order not found');

      const items = await prisma.shopWorkOrderItem.findMany({
        where: { id: { in: itemIds as string[] }, workOrderId: woId, parentItemId: null },
        select: {
          id: true, serialNumber: true, equipmentCategory: true, status: true,
          softClosedAt: true, hardClosesAt: true, closedById: true,
        },
      });
      if (items.length === 0) {
        throw new AppError(400, 'None of those units belong to this work order.');
      }

      const skipped = items.filter((i) => QA_INELIGIBLE_STATUSES.has(i.status));
      const eligible = items.filter((i) => !QA_INELIGIBLE_STATUSES.has(i.status));

      // Category coherence is checked BEFORE anything is written. A mixed
      // selection is a mistake to refuse, not a batch to partially apply.
      const { category, error: catError } = categoryConflict(eligible);
      if (catError || !category) throw new AppError(400, catError || 'No eligible units.');

      const batch = asChecklistResults(checklistResults);
      const actions = asStringArray(serviceActions);
      const perUnitIn = (perUnit && typeof perUnit === 'object' ? perUnit : {}) as Record<
        string,
        { overrides?: unknown; notes?: unknown; fail?: unknown }
      >;

      const now = new Date();
      const rows = eligible.map((item) => {
        const extra = perUnitIn[item.id] ?? {};
        const overrides = asChecklistResults(extra.overrides);
        const { outcome, failedKeys } = deriveOutcome(
          category, batch, overrides, actions, extra.fail === true,
        );
        return {
          item,
          overrides,
          outcome,
          failedKeys,
          notes: typeof extra.notes === 'string' && extra.notes.trim()
            ? extra.notes.trim().slice(0, 500)
            : null,
        };
      });

      const created = await prisma.$transaction(async (tx) => {
        const event = await tx.shopQaEvent.create({
          data: {
            workOrderId: woId,
            category: category as never,
            checklistVersion: checklistVersion(category),
            checklistResults: batch,
            serviceActions: actions,
            notes: typeof notes === 'string' && notes.trim() ? notes.trim().slice(0, 1000) : null,
            performedById: userId,
            performedAt: now,
          },
          select: { id: true },
        });

        for (const row of rows) {
          await tx.shopQaUnitResult.create({
            data: {
              qaEventId: event.id,
              itemId: row.item.id,
              outcome: row.outcome,
              checklistOverrides: row.overrides,
              failedKeys: row.failedKeys,
              notes: row.notes,
            },
          });

          // The unit's own QC fields mirror the result. These columns already
          // exist and are already rendered (the detail-page badge and the work
          // order PDF), so mirroring lights the feature up on both surfaces
          // with no new UI. The QA result row stays authoritative — this is a
          // display copy, and a correction rewrites it.
          const itemData: Prisma.ShopWorkOrderItemUpdateInput = {
            qcResult: row.outcome as never,
            qcNotes: row.notes,
            qcTestedBy: { connect: { id: userId } },
            qcCompletedAt: now,
          };

          // WI-01: a failed unit is not in a "re-test" state, it is simply back
          // in service. Only move it if the state machine agrees — a unit
          // already in_work stays where it is rather than logging a no-op.
          const target = row.outcome === 'fail'
            ? QA_FAIL_STATUS
            : (advanceOnPass ? 'shop_complete' : null);

          let moved: string | null = null;
          if (target && target !== row.item.status && canTransitionShopItem(row.item.status, target)) {
            moved = target;
            Object.assign(itemData, {
              status: target,
              ...closerFieldsFor(row.item, target, userId),
            });
          }

          await tx.shopWorkOrderItem.update({ where: { id: row.item.id }, data: itemData });

          if (moved) {
            await tx.shopItemStatusLog.create({
              data: {
                itemId: row.item.id,
                fromStatus: row.item.status as ShopItemStatus,
                toStatus: moved as ShopItemStatus,
                changedById: userId,
                notes: row.outcome === 'fail'
                  ? `QA FAIL — back in service${
                      row.failedKeys.length
                        ? ` (${labelsForKeys(category, row.failedKeys).join('; ')})`
                        : ''
                    }`
                  : `QA pass (batch of ${rows.length}, checklist ${checklistVersion(category)})`,
              },
            });
          }
        }
        return event.id;
      });

      await recomputeWOStatus(woId);

      // §3.3: every QA result is an audited mutation.
      await createAuditLog({
        userId,
        action: 'update',
        entityType: 'ShopWorkOrder',
        entityId: woId,
        changes: {
          batchQa: {
            eventId: created,
            category,
            checklistVersion: checklistVersion(category),
            passed: rows.filter((r) => r.outcome === 'pass').map((r) => r.item.serialNumber),
            failed: rows.filter((r) => r.outcome === 'fail').map((r) => r.item.serialNumber),
            skipped: skipped.map((i) => i.serialNumber),
          },
        },
      });

      res.status(201).json({
        eventId: created,
        passed: rows.filter((r) => r.outcome === 'pass').length,
        failed: rows.filter((r) => r.outcome === 'fail').length,
        skipped: skipped.map((i) => ({ serialNumber: i.serialNumber, reason: i.status })),
        incomplete: explainIncomplete(category, batch, {}, actions) || null,
      });
    } catch (err) {
      next(err);
    }
  },
);

// PATCH /api/shop-orders/:id/qa-events/:eventId
//
// Correct a mis-entered batch. ONE row updates and every unit in the batch sees
// it, because no unit ever held a copy — WI-06's fourth acceptance criterion is
// a property of the schema here rather than a loop that has to succeed N times.
//
// REFUSED ONCE ANY UNIT HAS SNAPSHOTTED. Correcting some of a batch whose other
// units are already immutable would leave one QA event described two different
// ways in two different systems.
shopOrdersRouter.patch(
  '/:id/qa-events/:eventId',
  requirePermission('shop_orders:edit'),
  async (req: Request, res: Response, next) => {
    try {
      const { eventId } = req.params;
      const userId = req.user!.userId;

      const event = await prisma.shopQaEvent.findUnique({
        where: { id: eventId as string },
        include: {
          results: {
            select: {
              id: true, itemId: true, checklistOverrides: true, vaultSnapshotAt: true,
              item: { select: { id: true, status: true, serialNumber: true, closedById: true,
                                softClosedAt: true, hardClosesAt: true } },
            },
          },
        },
      });
      if (!event || event.workOrderId !== req.params.id) {
        throw new AppError(404, 'QA event not found on this work order');
      }
      const frozen = event.results.filter((r) => r.vaultSnapshotAt !== null);
      if (frozen.length > 0) {
        throw new AppError(
          409,
          `This QA is final — ${frozen.length} of its ${event.results.length} unit(s) closed `
          + 'more than 48 hours ago and their records are locked. Record a new inspection on the '
          + 'affected unit instead.',
        );
      }

      const category = event.category as never as Parameters<typeof deriveOutcome>[0];
      const batch = req.body?.checklistResults !== undefined
        ? asChecklistResults(req.body.checklistResults)
        : asChecklistResults(event.checklistResults);
      const actions = req.body?.serviceActions !== undefined
        ? asStringArray(req.body.serviceActions)
        : asStringArray(event.serviceActions);
      const notes = req.body?.notes !== undefined
        ? (typeof req.body.notes === 'string' && req.body.notes.trim()
            ? req.body.notes.trim().slice(0, 1000)
            : null)
        : event.notes;

      const now = new Date();
      const bounced: string[] = [];
      const stuck: string[] = [];

      await prisma.$transaction(async (tx) => {
        await tx.shopQaEvent.update({
          where: { id: eventId as string },
          data: {
            checklistResults: batch,
            serviceActions: actions,
            notes,
            correctedAt: now,
            correctedById: userId,
          },
        });

        // Re-derive every unit's outcome against the corrected checklist. A
        // correction that turns a pass into a fail has to move the unit, or the
        // correction is cosmetic and the unit ships anyway.
        for (const result of event.results) {
          const { outcome, failedKeys } = deriveOutcome(
            category, batch, result.checklistOverrides, actions,
          );
          await tx.shopQaUnitResult.update({
            where: { id: result.id },
            data: { outcome, failedKeys },
          });
          await tx.shopWorkOrderItem.update({
            where: { id: result.itemId },
            data: { qcResult: outcome as never },
          });

          if (outcome !== 'fail' || result.item.status === QA_FAIL_STATUS) continue;

          // A correction that turns a pass into a fail HAS to move the unit.
          // If it does not, the correction is cosmetic: the record says "failed"
          // and the unit ships anyway, which is worse than not offering the
          // correction at all.
          //
          // Two ways back, because there are two situations:
          //
          //   still open       an ordinary transition. The state machine
          //                    decides, same as any other move.
          //
          //   already closed   NOT a transition — `shop_complete` legally leads
          //                    only to `returned`, and rightly so; nobody should
          //                    be able to drag a released unit backwards from
          //                    the board. This is the RETRACTION of a close, and
          //                    WI-05 already says when that is allowed: inside
          //                    the soft window. We are guaranteed to be inside
          //                    it, because a snapshotted (hard-closed) batch was
          //                    refused above.
          //
          // Retracting clears the close stamps as well as the status. Leaving
          // softClosedAt set on a unit that is back on the bench would leave it
          // counting down to a hard close it is no longer heading for — and the
          // DB trigger re-stamps a fresh 48 hours when it genuinely closes
          // again, which is right: the work restarted, so the window should.
          const closeState = closeStateOf(result.item);
          const isClosed = closeState !== 'open';

          if (!isClosed && !canTransitionShopItem(result.item.status, QA_FAIL_STATUS)) {
            stuck.push(result.item.serialNumber);
            continue;
          }

          await tx.shopWorkOrderItem.update({
            where: { id: result.itemId },
            data: {
              status: QA_FAIL_STATUS,
              ...(isClosed
                ? { softClosedAt: null, hardClosesAt: null, closedById: null }
                : {}),
            },
          });
          await tx.shopItemStatusLog.create({
            data: {
              itemId: result.itemId,
              fromStatus: result.item.status as ShopItemStatus,
              toStatus: QA_FAIL_STATUS as ShopItemStatus,
              changedById: userId,
              notes: isClosed
                ? 'Batch QA corrected — this unit no longer passes; close retracted '
                  + 'inside the 48-hour window and the unit is back in service'
                : 'Batch QA corrected — this unit no longer passes, back in service',
            },
          });
          bounced.push(result.item.serialNumber);
        }
      });

      await recomputeWOStatus(event.workOrderId);
      await createAuditLog({
        userId,
        action: 'update',
        entityType: 'ShopWorkOrder',
        entityId: event.workOrderId,
        changes: {
          batchQaCorrection: {
            eventId,
            unitCount: event.results.length,
            before: event.checklistResults,
            after: batch,
            bounced,
            stuck,
          },
        },
      });

      // `stuck` is reported rather than swallowed: a unit the correction could
      // not move is the one case where the record and the unit disagree, and
      // the caller has to be told which one.
      res.json({ eventId, unitsAffected: event.results.length, bounced, stuck });
    } catch (err) {
      next(err);
    }
  },
);

// ============================================================
// FORCE CLOSE (supervisor override)
// ============================================================

// POST /api/shop-orders/:id/items/:itemId/unlock
//
// WI-05 — Platform Admin reopens a hard-closed unit for a fresh 48 hours.
//
// Reason is REQUIRED and stored, not just logged: reopening a final record is
// the kind of thing that gets asked about later, and "an admin unlocked it" is
// not an answer. unlockCount increments rather than a boolean flipping, so a
// unit reopened four times says four.
shopOrdersRouter.post('/:id/items/:itemId/unlock', async (req: Request, res: Response, next) => {
  try {
    const { itemId } = req.params;
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';

    if (!canUnlockUnit(req.user!.role)) {
      throw new AppError(403, 'Only a Platform Admin can reopen a closed unit');
    }
    if (!reason) {
      throw new AppError(400, 'A reason is required to reopen a closed unit');
    }

    const item = await prisma.shopWorkOrderItem.findUnique({
      where: { id: itemId as string },
      select: {
        id: true, status: true, workOrderId: true, serialNumber: true,
        softClosedAt: true, hardClosesAt: true, closedById: true, unlockCount: true,
        billedAt: true,
      },
    });
    if (!item) throw new AppError(404, 'Item not found');

    const state = closeStateOf(item);
    if (state !== 'hard') {
      throw new AppError(
        409,
        state === 'open'
          ? 'That unit is not closed, so there is nothing to reopen.'
          : 'That unit is still inside its correction window — it is already editable.',
      );
    }

    const stamp = unlockStamp(req.user!.userId, reason);
    const updated = await prisma.shopWorkOrderItem.update({
      where: { id: itemId as string },
      data: { ...stamp, unlockCount: { increment: 1 } },
      include: ITEM_INCLUDE,
    });

    await createAuditLog({
      userId: req.user!.userId,
      action: 'update',
      entityType: 'shop_work_order_item',
      entityId: itemId as string,
      changes: {
        unlock: {
          reason,
          serialNumber: item.serialNumber,
          previousHardClosesAt: item.hardClosesAt?.toISOString() ?? null,
          newHardClosesAt: stamp.hardClosesAt.toISOString(),
          unlockNumber: item.unlockCount + 1,
          // Worth capturing: reopening a unit that already billed means the
          // invoice and the record can now disagree.
          alreadyBilled: !!item.billedAt,
        },
      },
    });

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// POST /api/shop-orders/:id/items/:itemId/resolve-identity
//
// WI-05 — the tech's answer to "you've worked on this unit before, is this the
// same one?". Only ever called for the ambiguous case; a serial with no
// existing record was already created silently at close.
shopOrdersRouter.post('/:id/items/:itemId/resolve-identity', async (req: Request, res: Response, next) => {
  try {
    const { itemId } = req.params;
    const sameUnit = req.body?.sameUnit;
    if (typeof sameUnit !== 'boolean') {
      throw new AppError(400, 'sameUnit (boolean) is required');
    }

    const result = await resolveIdentity(prisma, itemId as string, sameUnit, req.user!.userId);

    await createAuditLog({
      userId: req.user!.userId,
      action: 'update',
      entityType: 'shop_work_order_item',
      entityId: itemId as string,
      changes: { identityResolution: result.resolution, equipmentId: result.equipmentId },
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/shop-orders/:id/force-close
// Supervisor-only: force-closes a WO regardless of item statuses.
// All open items get marked returned with an audit trail.
shopOrdersRouter.post('/:id/force-close', requirePermission('shop_orders:force_close'), async (req: Request, res: Response, next) => {
  try {
    const woId = req.params.id as string;
    const { reason } = req.body;
    const userId = req.user!.userId;

    if (!reason || typeof reason !== 'string' || !reason.trim()) {
      throw new AppError(400, 'A reason is required for force-close');
    }

    const existing = await prisma.shopWorkOrder.findUnique({
      where: { id: woId },
      select: { id: true, status: true, workOrderNumber: true },
    });
    if (!existing) throw new AppError(404, 'Shop work order not found');

    if (existing.status === 'closed') {
      throw new AppError(400, 'Work order is already closed');
    }

    await prisma.$transaction(async (tx) => {
      // Force all non-returned items to returned
      const openItems = await tx.shopWorkOrderItem.findMany({
        where: { workOrderId: woId, status: { not: 'returned' } },
        select: { id: true, status: true, serialNumber: true },
      });

      for (const item of openItems) {
        await tx.shopWorkOrderItem.update({
          where: { id: item.id },
          data: { status: 'returned', returnedAt: new Date(), returnMethod: 'picked_up', closedById: userId },
        });
        await tx.shopItemStatusLog.create({
          data: {
            itemId: item.id,
            fromStatus: item.status,
            toStatus: 'returned',
            changedById: userId,
            notes: `Force-closed by supervisor: ${reason.trim()}`,
            location: 'Basin Shop',
          },
        });
      }

      await tx.shopWorkOrder.update({
        where: { id: woId },
        data: {
          status: 'closed',
          completedDate: new Date(),
          returnedDate: new Date(),
          pickupNotes: `[FORCE CLOSED] ${reason.trim()}`,
        },
      });
    });

    await recomputeWOStatus(woId);

    await createAuditLog({
      userId,
      action: 'status_change',
      entityType: 'ShopWorkOrder',
      entityId: woId,
      changes: {
        from: existing.status,
        to: 'closed',
        forceClose: true,
        reason: reason.trim(),
        itemsForced: 'all open items → returned',
      },
    });

    console.log(`[Shop] Force-closed ${existing.workOrderNumber} by user ${userId}: ${reason.trim()}`);

    // Billing is WO-direct now: once the WO is closed it surfaces in the billing
    // queue (GET /invoices/uninvoiced/shop-wos) for AR to invoice via
    // /invoices/generate/from-shop-wo. No ticket is spawned here.

    const updated = await prisma.shopWorkOrder.findUnique({
      where: { id: woId },
      include: WO_DETAIL_INCLUDE,
    });

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// ============================================================
// POST /:id/void — close a WO with NO work done and NO billing.
// Parity with ticket-void: the WO is closed as a tombstone (status `closed`
// + customData.voided flag), all open items are returned to inventory, and —
// unlike force-close — it does NOT auto-generate a billing ticket. Requires a
// reason. Gated by shop_orders:cancel.
// ============================================================
shopOrdersRouter.post('/:id/void', requirePermission('shop_orders:cancel'), async (req: Request, res: Response, next) => {
  try {
    const woId = req.params.id as string;
    const userId = req.user!.userId;
    const reason = (req.body?.reason || '').trim();
    if (!reason) throw new AppError(400, 'A reason is required to void a work order');

    const existing = await prisma.shopWorkOrder.findUnique({
      where: { id: woId },
      select: { id: true, status: true, workOrderNumber: true, customData: true },
    });
    if (!existing) throw new AppError(404, 'Shop work order not found');
    if (existing.status === 'closed') throw new AppError(400, 'Work order is already closed');

    await prisma.$transaction(async (tx) => {
      const openItems = await tx.shopWorkOrderItem.findMany({
        where: { workOrderId: woId, status: { not: 'returned' } },
        select: { id: true, status: true },
      });
      for (const item of openItems) {
        await tx.shopWorkOrderItem.update({
          where: { id: item.id },
          data: { status: 'returned', returnedAt: new Date(), returnMethod: 'picked_up', closedById: userId },
        });
        await tx.shopItemStatusLog.create({
          data: {
            itemId: item.id,
            fromStatus: item.status,
            toStatus: 'returned',
            changedById: userId,
            notes: `Voided (no work): ${reason}`,
            location: 'Basin Shop',
          },
        });
      }

      const prevCustom = (existing.customData && typeof existing.customData === 'object' ? existing.customData : {}) as Record<string, unknown>;
      await tx.shopWorkOrder.update({
        where: { id: woId },
        data: {
          status: 'closed',
          completedDate: new Date(),
          returnedDate: new Date(),
          pickupNotes: `[VOIDED — NO WORK] ${reason}`,
          customData: { ...prevCustom, voided: true, voidReason: reason },
        },
      });
    });

    await recomputeWOStatus(woId);

    await createAuditLog({
      userId,
      action: 'status_change',
      entityType: 'ShopWorkOrder',
      entityId: woId,
      changes: { from: existing.status, to: 'closed', voided: true, reason },
    });

    // NOTE: intentionally NO autoGenerateTicketFromShopWO — a void produces no billing.

    const updated = await prisma.shopWorkOrder.findUnique({ where: { id: woId }, include: WO_DETAIL_INCLUDE });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// ============================================================
// DELETE /:id — permanently delete a WO + children (items, status logs, ledger,
// transfers cascade via FK). Detaches financial records (invoices/payments) and
// removes ephemeral print jobs. Unrecoverable; requires a reason. A WO with
// payments or a linked invoice is normally locked; { override: true } detaches
// and proceeds, leaving the financial records in place for manual cleanup.
// ============================================================
shopOrdersRouter.delete('/:id', requirePermission('shop_orders:delete'), async (req: Request, res: Response, next) => {
  try {
    const woId = req.params.id as string;
    const reason = (req.body?.reason || '').trim();
    const override = !!req.body?.override;
    if (!reason) throw new AppError(400, 'A reason is required to delete a work order');

    const existing = await prisma.shopWorkOrder.findUnique({
      where: { id: woId },
      select: { id: true, status: true, workOrderNumber: true },
    });
    if (!existing) throw new AppError(404, 'Shop work order not found');

    const [paymentCount, invoiceCount] = await Promise.all([
      prisma.payment.count({ where: { shopWorkOrderId: woId } }),
      prisma.invoice.count({ where: { shopWorkOrderId: woId } }),
    ]);
    if ((paymentCount > 0 || invoiceCount > 0) && !override) {
      throw new AppError(409, 'Work order has payments or a linked invoice — deletion requires override');
    }

    const warnings: string[] = [];
    if (paymentCount > 0) warnings.push(`${paymentCount} payment(s) were detached, not deleted — reconcile manually.`);
    if (invoiceCount > 0) warnings.push(`${invoiceCount} linked invoice(s) were detached — review manually.`);

    await prisma.$transaction(async (tx) => {
      // Detach financial records (keep them; just sever the FK).
      await tx.invoice.updateMany({ where: { shopWorkOrderId: woId }, data: { shopWorkOrderId: null } });
      await tx.payment.updateMany({ where: { shopWorkOrderId: woId }, data: { shopWorkOrderId: null } });
      // Print jobs FK the WO with a required column → delete them first.
      await tx.printJob.deleteMany({ where: { shopWorkOrderId: woId } });
      // Items, status logs, ledger and transfers cascade off the WO delete.
      await tx.shopWorkOrder.delete({ where: { id: woId } });
    });

    await createAuditLog({
      userId: req.user!.userId,
      action: 'delete',
      entityType: 'ShopWorkOrder',
      entityId: woId,
      changes: { workOrderNumber: existing.workOrderNumber, status: existing.status, reason, override },
    });

    res.json({ ok: true, workOrderNumber: existing.workOrderNumber, warnings });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// RELEASE / PICKUP (complete WO + sign off)
// ============================================================

// POST /api/shop-orders/:id/release
shopOrdersRouter.post('/:id/release', async (req: Request, res: Response, next) => {
  try {
    const woId = req.params.id as string;
    const { pickupSignedByName, pickupSignature, pickupNotes } = req.body;

    if (!pickupSignedByName) throw new AppError(400, 'Pickup name is required');

    const existing = await prisma.shopWorkOrder.findUnique({
      where: { id: woId },
      select: { id: true, status: true },
    });
    if (!existing) throw new AppError(404, 'Shop work order not found');

    if (existing.status === 'closed') {
      throw new AppError(400, 'Work order is already closed');
    }

    // Releasing IS the equipment going back to the customer — the exact thing a
    // credit hold stops. force-close remains the supervisor override.
    await assertShopReturnAllowed(woId);

    const userId = req.user!.userId;

    await prisma.$transaction(async (tx) => {
      // Advance ALL non-returned items to 'returned'.
      // For items still in early states (received, in_work, etc.) this acts as
      // "close with no work done" — e.g. air fills, simple inspections, refused service.
      const openItems = await tx.shopWorkOrderItem.findMany({
        where: { workOrderId: woId, status: { not: 'returned' } },
        select: { id: true, status: true },
      });

      for (const item of openItems) {
        await tx.shopWorkOrderItem.update({
          where: { id: item.id },
          data: { status: 'returned', returnedAt: new Date(), returnMethod: 'picked_up', closedById: userId },
        });
        await tx.shopItemStatusLog.create({
          data: {
            itemId: item.id,
            fromStatus: item.status,
            toStatus: 'returned',
            changedById: userId,
            notes: item.status === 'shop_complete'
              ? `Released to ${pickupSignedByName}`
              : `Closed without full work cycle — released to ${pickupSignedByName}`,
            location: 'Basin Shop',
          },
        });
      }

      // Update WO to closed
      await tx.shopWorkOrder.update({
        where: { id: woId },
        data: {
          status: 'closed',
          completedDate: existing.status !== 'complete' ? new Date() : undefined,
          returnedDate: new Date(),
          pickupSignedByName,
          pickupSignature: pickupSignature || null,
          pickupSignedAt: new Date(),
          pickupNotes: pickupNotes || null,
        },
      });
    });

    // Recompute counts
    await recomputeWOStatus(woId);

    await createAuditLog({
      userId,
      action: 'status_change',
      entityType: 'ShopWorkOrder',
      entityId: woId,
      changes: { from: 'complete', to: 'closed', releasedTo: pickupSignedByName },
    });

    // Billing is WO-direct now: releasing the equipment closes the WO, which
    // then surfaces in the billing queue (GET /invoices/uninvoiced/shop-wos)
    // for AR to invoice via /invoices/generate/from-shop-wo. The pickup
    // signature + signer name are carried on the WO and rendered on that
    // invoice. No ticket is spawned here.

    const updated = await prisma.shopWorkOrder.findUnique({
      where: { id: woId },
      include: WO_DETAIL_INCLUDE,
    });

    res.json(updated);
  } catch (err) {
    next(err);
  }
});
