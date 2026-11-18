import { assertShopBinsAvailable } from './shopBins.js';
import { EquipmentCategoryShop as CategoryValues, ShopServiceType as ServiceValues } from '../db.js';
import { objectBody, enumValue, validDate, numberValue } from './writeValidation.js';
import { Prisma } from '../db.js';
import type { EquipmentCategoryShop, ShopServiceType, ShopTransitFailureReason } from '../db.js';
import { AppError } from '../middleware/errorHandler.js';
import { assertCompanyActive } from '../utils/companyGuards.js';
import { assertNewShopUnits } from './shopUnitIdentity.js';
import { classifySerial } from './serialQuality.js';

// Shared shop-work-order creation logic. Used by:
//   - POST /api/shop-orders (online path, routes/shopOrders.ts)
//   - sync push processShopWorkOrderMutation (offline replay, routes/sync.ts)
//
// Extracted because the two paths drifted: the online path was flattening
// dropOffContact / pickupContact and creating items in a loop; the sync push
// processor was just spreading payload into prisma.shopWorkOrder.create, which
// rejected the nested contact objects and never created items at all. One
// implementation now feeds both paths.

export const PREFERRED_CONTACT_VALUES = ['call', 'text', 'email'] as const;

/**
 * A requested auto-transit that could not be honored. The WO still exists —
 * this says the gear is sitting at the intake site rather than heading where
 * the tech said it was heading, which is otherwise invisible to everyone.
 *
 * Callers surface it (sync push echoes it on the mutation result, the online
 * route returns it on the 201); the durable copy lives on the WO itself, in
 * transitFailed*, so the Ops Dashboard can count it long after the response is
 * gone and regardless of whether anyone was watching when it happened.
 */
export type TransitWarning = {
  shortCode: string;
  reason: ShopTransitFailureReason;
  message: string;
};

export type ContactInput = {
  name?: string;
  phone?: string;
  email?: string;
  preferred?: 'call' | 'text' | 'email';
};

export type FlatContact = {
  name: string;
  phone: string | null;
  email: string | null;
  preferred: 'call' | 'text' | 'email';
};

/**
 * Lenient contact resolver for WOs created without a real intake counter
 * interaction (field-inspection auto-spawns). Never throws: keeps whatever
 * was provided, normalizes the preferred-channel value, and nulls the rest.
 * The strict {@link validateContact} still guards the manned intake paths.
 */
export function resolveOptionalContact(c: any): {
  name: string | null;
  phone: string | null;
  email: string | null;
  preferred: 'call' | 'text' | 'email' | null;
} {
  if (!c || typeof c !== 'object') {
    return { name: null, phone: null, email: null, preferred: null };
  }
  const name = typeof c.name === 'string' && c.name.trim() ? c.name.trim() : null;
  const phone = typeof c.phone === 'string' && c.phone.trim() ? c.phone.trim() : null;
  const email = typeof c.email === 'string' && c.email.trim() ? c.email.trim() : null;
  const preferred = PREFERRED_CONTACT_VALUES.includes(c.preferred) ? c.preferred : null;
  return { name, phone, email, preferred };
}

export function validateContact(label: 'dropOff' | 'pickup', c: any): FlatContact {
  if (!c || typeof c !== 'object') {
    throw new AppError(400, `${label} contact is required`);
  }
  const name = typeof c.name === 'string' ? c.name.trim() : '';
  const phone = typeof c.phone === 'string' ? c.phone.trim() : '';
  const email = typeof c.email === 'string' ? c.email.trim() : '';
  const preferred = c.preferred;

  if (!name) throw new AppError(400, `${label} contact name is required`);
  if (!PREFERRED_CONTACT_VALUES.includes(preferred)) {
    throw new AppError(400, `${label} contact preferred must be call|text|email`);
  }
  if ((preferred === 'call' || preferred === 'text') && !phone) {
    throw new AppError(400, `${label} contact phone is required when preferred is ${preferred}`);
  }
  if (preferred === 'email' && !email) {
    throw new AppError(400, `${label} contact email is required when preferred is email`);
  }

  return { name, phone: phone || null, email: email || null, preferred };
}

export interface CreateShopWoArgs {
  /** When provided (offline sync replay), the WO is created with this id; otherwise auto-generated. */
  id?: string;
  workOrderNumber: string;
  payload: any;
  userId: string;
}

/**
 * Resolve the Basin Site a new work order is received at. Honors an explicit
 * intakeSiteId from the client (the active-site switcher); otherwise falls
 * back to the oldest active Site so intake keeps working before the client
 * starts sending it.
 */
async function resolveIntakeSiteId(tx: Prisma.TransactionClient, provided?: string): Promise<string> {
  if (provided) {
    const site = await tx.site.findUnique({
      where: { id: provided },
      select: { id: true, active: true },
    });
    if (!site) throw new AppError(400, 'intakeSiteId does not match a known site');
    if (!site.active) throw new AppError(400, 'Cannot intake at an inactive site');
    return site.id;
  }
  const fallback = await tx.site.findFirst({
    where: { active: true },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  if (!fallback) throw new AppError(500, 'No active site configured for intake');
  return fallback.id;
}

/**
 * Create a ShopWorkOrder with items + initial status logs atomically. Pass a
 * `Prisma.TransactionClient` so the caller controls transaction boundaries
 * (the online route wraps additional bookkeeping around the call).
 */
export async function createShopWorkOrderWithItems(
  tx: Prisma.TransactionClient,
  args: CreateShopWoArgs,
): Promise<{
  id: string;
  workOrderNumber: string;
  totalItems: number;
  transitWarning?: TransitWarning;
}> {
  const { id, workOrderNumber, payload, userId } = args;

  // Field-inspection auto-spawns carry no shop counter contact — the tech drove
  // the gear in. contactsOptional relaxes the requirement (and only then); every
  // manned intake path still goes through strict validation.
  const contactsOptional = !!payload.contactsOptional;
  const dropOff = contactsOptional
    ? resolveOptionalContact(payload.dropOffContact)
    : validateContact('dropOff', payload.dropOffContact);
  const pickup = contactsOptional
    ? resolveOptionalContact(payload.pickupContact)
    : validateContact('pickup', payload.pickupContact);

  const items = Array.isArray(payload.items) ? payload.items : [];
  if (items.length === 0) {
    throw new AppError(400, 'At least one item is required');
  }
  const massIntake = payload.massIntake === true;
  if (massIntake && (items.length <= 10 || items.length > 1000)) throw new AppError(400, 'Mass intake requires 11–1000 pieces');
  assertNewShopUnits(massIntake ? items.filter((item: any) => typeof item.serialNumber === 'string' && item.serialNumber.trim()) : items);

  objectBody(payload);
  if (payload.intakeDate) validDate(payload.intakeDate, 'intakeDate');
  if (payload.priority != null) numberValue(payload.priority, 'priority', 1, 10);
  await validateShopIntakeItems(tx, items, massIntake);
  await assertShopBinsAvailable(tx, items, id);

  // Can't book new work against a deactivated customer (internal WOs use an
  // active internal company, so this is a no-op for them).
  await assertCompanyActive(payload.companyId, tx);

  // Which Basin Site the WO + its items belong to.
  const intakeSiteId = await resolveIntakeSiteId(tx, payload.intakeSiteId);

  const wo = await tx.shopWorkOrder.create({
    data: {
      ...(id ? { id } : {}),
      workOrderNumber,
      companyId: payload.companyId,
      isInternal: !!payload.isInternal,
      status: 'intake',
      intakeDate: payload.intakeDate ? new Date(payload.intakeDate) : new Date(),
      intakeNotes: payload.intakeNotes || null,
      intakeById: payload.intakeById || userId,
      createdById: userId,
      poNumber: payload.poNumber || null,
      afeNumber: payload.afeNumber || null,
      // Tier 1 reservation billing (checkbox at intake). Drives the 5% fee +
      // Pale Horse QB customer override when this WO is invoiced.
      tier1: !!payload.tier1,
      primaryCategory: payload.primaryCategory || null,
      promisedDate: payload.promisedDate ? new Date(payload.promisedDate) : null,
      priority: payload.priority || 5,
      notes: payload.notes || null,
      // The Basin Site this WO was received at + optional Pad pointers.
      intakeSiteId,
      sourceLocationId: payload.sourceLocationId || null,
      returnLocationId: payload.returnLocationId || null,
      dropOffContactName: dropOff.name,
      dropOffContactPhone: dropOff.phone,
      dropOffContactEmail: dropOff.email,
      dropOffContactPreferred: dropOff.preferred,
      pickupContactName: pickup.name,
      pickupContactPhone: pickup.phone,
      pickupContactEmail: pickup.email,
      pickupContactPreferred: pickup.preferred,
      totalItems: 0,
      completedItems: 0,
    },
  });

  let itemNumber = 1;
  let totalItems = 0;
  const topLevelItemIds: string[] = [];

  for (const item of items) {

    const parentItem = await tx.shopWorkOrderItem.create({
      data: {
        workOrderId: wo.id,
        siteId: intakeSiteId,
        itemNumber: itemNumber++,
        serializedEquipmentId: item.serializedEquipmentId || null,
        serialNumber: item.serialNumber,
        equipmentCategory: (item.equipmentCategory || 'other') as EquipmentCategoryShop,
        serviceType: (item.serviceType || 'general') as ShopServiceType,
        productId: item.productId || null,
        equipmentDescription: item.equipmentDescription || null,
        reportedIssue: item.reportedIssue || null,
        fexBrand: item.fexBrand || null,
        fexSize: item.fexSize || null,
        fexType: item.fexType || null,
        customData: item.customData || undefined,
        status: 'received',
      },
    });

    await tx.shopItemStatusLog.create({
      data: {
        itemId: parentItem.id,
        fromStatus: null,
        toStatus: 'received',
        changedById: userId,
        notes: 'Intake',
        location: 'Basin Shop',
      },
    });

    totalItems++;
    topLevelItemIds.push(parentItem.id);

    if (Array.isArray(item.components) && item.components.length > 0) {
      for (const comp of item.components) {
        if (!comp.serialNumber) continue;
        const childItem = await tx.shopWorkOrderItem.create({
          data: {
            workOrderId: wo.id,
            siteId: intakeSiteId,
            itemNumber: itemNumber++,
            serializedEquipmentId: comp.serializedEquipmentId || null,
            serialNumber: comp.serialNumber,
            equipmentCategory: (comp.equipmentCategory || 'scba') as EquipmentCategoryShop,
            serviceType: (comp.serviceType || item.serviceType || 'inspection') as ShopServiceType,
            productId: comp.productId || null,
            equipmentDescription: comp.type ? `SCBA ${comp.type}` : null,
            reportedIssue: comp.reportedIssue || null,
            status: 'received',
            parentItemId: parentItem.id,
          },
        });

        await tx.shopItemStatusLog.create({
          data: {
            itemId: childItem.id,
            fromStatus: null,
            toStatus: 'received',
            changedById: userId,
            notes: `Intake — component of ${item.serialNumber}`,
            location: 'Basin Shop',
          },
        });
        totalItems++;
      }
    }
  }

  await tx.shopWorkOrder.update({
    where: { id: wo.id },
    data: { totalItems },
  });

  // Auto-transit (field-inspection spawns): mark the whole WO in transit to a
  // destination Site resolved by short code, with the inspecting tech as the
  // transporter. Mirrors POST /api/shop-transfers — items stay at the intake
  // Site until the destination confirms arrival.
  //
  // Three outcomes, and the whole point of this block's shape is that they are
  // no longer the same outcome:
  //   destination == intake Site  → silent no-op. Nothing is in transit; the
  //                                 tech is standing in the shop. An open
  //                                 transfer here would be a phantom inbound.
  //   destination resolves, active → the transfer event, i.e. the happy path.
  //   anything else                → RECORDED. Pre-fix this fell into the same
  //                                 branch as the no-op and vanished: no event,
  //                                 no error, and because the wall board's
  //                                 Incoming column is built only from open
  //                                 transfers, no inbound card either. The gear
  //                                 sat at the intake site and nobody knew.
  let transitWarning: TransitWarning | undefined;

  if (payload.transitToShortCode && topLevelItemIds.length > 0) {
    const shortCode = String(payload.transitToShortCode).trim();
    const dest = shortCode
      ? await tx.site.findUnique({
          where: { shortCode },
          select: { id: true, active: true },
        })
      : null;

    // resolveIntakeSiteId has already rejected an inactive intake Site, so a
    // destination equal to it is necessarily active — this arm can be checked
    // first without swallowing an inactive-Site failure.
    if (dest && dest.id === intakeSiteId) {
      // Already there. Legitimately nothing to do, and nothing to report.
    } else if (!dest || !dest.active) {
      const reason: ShopTransitFailureReason = dest ? 'site_inactive' : 'unknown_short_code';
      const failedAt = new Date();
      await tx.shopWorkOrder.update({
        where: { id: wo.id },
        data: {
          transitFailedShortCode: shortCode || '(blank)',
          transitFailedReason: reason,
          transitFailedAt: failedAt,
        },
      });
      transitWarning = {
        shortCode: shortCode || '(blank)',
        reason,
        message:
          reason === 'site_inactive'
            ? `Return shop "${shortCode}" is deactivated — work order ${wo.workOrderNumber} was created but the gear is NOT marked in transit and will not appear in that shop's Incoming column.`
            : `Return shop "${shortCode || '(blank)'}" does not match any site — work order ${wo.workOrderNumber} was created but the gear is NOT marked in transit and will not appear in any shop's Incoming column.`,
      };
    } else {
      let transportedById: string | null = null;
      if (payload.transportedById) {
        const transporter = await tx.user.findUnique({
          where: { id: String(payload.transportedById) },
          select: { id: true, isActive: true },
        });
        if (transporter?.isActive) transportedById = transporter.id;
      }
      const now = new Date();
      await tx.shopTransferEvent.create({
        data: {
          workOrderId: wo.id,
          fromSiteId: intakeSiteId,
          toSiteId: dest.id,
          transferredById: userId,
          transportedById,
          transferredAt: now,
          notes: 'Auto-transit on field-inspection intake',
          items: { create: topLevelItemIds.map((itemId) => ({ itemId })) },
        },
      });
      // Whole WO → one destination, so keep the WO-level transit cache coherent
      // (the same invariant syncWoTransitCache maintains for manual transfers).
      await tx.shopWorkOrder.update({
        where: { id: wo.id },
        data: { transitToSiteId: dest.id, transitInitiatedAt: now, transitInitiatedById: userId },
      });
    }
  }

  return { id: wo.id, workOrderNumber: wo.workOrderNumber, totalItems, transitWarning };
}

/**
 * A multipart assembly (SCBA today) often arrives incomplete: just a cylinder,
 * just a regulator. A part that was not received is NOT a unit — it gets no
 * child row, no label, no serial. It is recorded on the parent instead, as
 * customData.partsNotIncluded, so "we never got this" survives to QA and return.
 *
 * Placeholder serials ("N/A", "NONE", …) on a component mean the same thing and
 * are folded in here rather than rejected: stored as a serial, "N/A" became a
 * real child unit that collided with the next "N/A" — in the same intake, or on
 * any other open work order. Folding (not throwing) also keeps offline replays
 * from older clients out of the dead-letter queue.
 */
export function normalizeIntakeComponents(items: any[]): void {
  for (const item of items) {
    if (!item || !Array.isArray(item.components)) continue;
    const included: any[] = [];
    const missing = new Set<string>();
    for (const comp of item.components) {
      if (!comp || typeof comp !== 'object') continue;
      const verdict = classifySerial(typeof comp.serialNumber === 'string' ? comp.serialNumber : '');
      if (comp.notIncluded === true || (!verdict.usable && verdict.defect === 'placeholder')) {
        missing.add(typeof comp.type === 'string' && comp.type.trim() ? comp.type.trim().toLowerCase() : 'component');
      } else {
        included.push(comp);
      }
    }
    item.components = included;
    // Two bottles, one of them "N/A": a bottle did come in, so nothing is missing.
    const present = new Set(included.map((c) => (typeof c.type === 'string' ? c.type.trim().toLowerCase() : '')));
    const partsNotIncluded = [...missing].filter((type) => !present.has(type));
    if (partsNotIncluded.length > 0) {
      const customData = item.customData && typeof item.customData === 'object' && !Array.isArray(item.customData) ? item.customData : {};
      item.customData = { ...customData, partsNotIncluded };
    }
  }
}

/** Shared by intake, append-items, and offline intake. */
export async function validateShopIntakeItems(tx: Prisma.TransactionClient, items: any[], allowDeferredSerials = false): Promise<void> {
  normalizeIntakeComponents(items);
  const allUnits = items.flatMap((item: any) => [item, ...(item.components || [])]);
  const serials = new Set<string>();
  for (const item of allUnits) {
    enumValue(item.equipmentCategory, CategoryValues, 'equipmentCategory');
    enumValue(item.serviceType, ServiceValues, 'serviceType');
    if (allowDeferredSerials && typeof item.serialNumber === 'string' && !item.serialNumber.trim() && items.includes(item)) {
      if (item.serializedEquipmentId) throw new AppError(400, 'Linked equipment requires its serial number');
      item.serialNumber = '';
      continue;
    }
    if (typeof item.serialNumber !== 'string' || !item.serialNumber.trim()) throw new AppError(400, 'Every item requires a serial number');
    item.serialNumber = item.serialNumber.trim();
    const key = item.serialNumber.toLowerCase();
    if (serials.has(key)) throw new AppError(409, 'Duplicate serial number in this intake');
    serials.add(key);
    enumValue(item.equipmentCategory, CategoryValues, 'equipmentCategory');
    enumValue(item.serviceType, ServiceValues, 'serviceType');
  }
  // Serialize competing intakes for the same physical serial, across API and sync.
  for (const serial of [...serials].sort()) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'shop-serial:' + serial}))`;
    const open = await tx.shopWorkOrderItem.findFirst({ where: { serialNumber: { equals: serial, mode: 'insensitive' }, status: { not: 'returned' }, workOrder: { status: { not: 'closed' } } }, select: { id: true } });
    if (open) throw new AppError(409, 'Serial number already belongs to an open work order');
  }

}
