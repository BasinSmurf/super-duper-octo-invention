import { closerFieldsFor } from './shopSoftClose.js';
/**
 * inspectionRouting.ts — ShopWork refactor, Wave 1d
 *
 * The inspection is the spine. When an inspection on a SHOP item locks (initial
 * inspection on the bench, or a re-test/final inspection), its outcome + the
 * cascade rules that fired ROUTE the unit to its next state:
 *
 *   CONDEMN cascade  OR outcome 'condemn'        → condemned   (terminal-billable)
 *   FACTORY_RETURN cascade                       → outside_service (AtVendor)
 *   outcome 'pass'                               → shop_complete   (ReadyVisualOnly)
 *   outcome 'fail' | 'requires_parts'            → in_work         (InRepair)
 *   outcome 'cannot_service'                     → (no auto-route; manual disposition)
 *
 * FORCE_PARTS cascades pre-seed the forced part numbers onto the item's
 * partsUsed when it lands in_work. REQUIRE_ACK is enforced earlier (at lock,
 * before this runs) — the tech must have acknowledged the verbatim snippet.
 *
 * Routing is a no-op for field inspections (ticketId) — the field pass→bill /
 * fail→spawn-WO flow is Wave 4. It is also a no-op when the target transition is
 * illegal for the item's current state (logged, not thrown — never break a lock).
 */

import type { PrismaClient, ShopItemStatus } from '../db.js';
import {
  evaluateCascades,
  extractCheckpointResults,
  type InspectionCategory,
} from './inspectionChecklist.js';
import { canTransitionShopItem } from './shopStateMachine.js';
import { checkCondemnEvidence } from './condemnEvidence.js';
import { evaluateItemQa, resolveQaDivert } from './shopQaGate.js';
import { assertShopSerialsCollected } from './shopSerials.js';
import { AppError } from '../middleware/errorHandler.js';

export interface RoutingResult {
  routed: boolean;
  workOrderId?: string;
  fromStatus?: ShopItemStatus;
  toStatus?: ShopItemStatus;
  cascades?: { action: string; checkpointKey: string; ruleId: string }[];
  forcedParts?: string[];
  reason?: string;
}

interface RoutableInspection {
  id: string;
  shopItemId: string | null;
  category: string;
  outcome: string;
  data: unknown;
}

export async function routeShopItemFromInspection(
  prisma: PrismaClient,
  inspection: RoutableInspection,
  userId: string | null,
): Promise<RoutingResult> {
  if (!inspection.shopItemId) return { routed: false, reason: 'not a shop inspection' };

  const item = await prisma.shopWorkOrderItem.findUnique({
    where: { id: inspection.shopItemId },
    select: {
      id: true,
      status: true,
      workOrderId: true,
      equipmentCategory: true,
      parentItemId: true,
      equipmentDescription: true,
      fexBrand: true,
      partsUsed: true,
      hardClosesAt: true,
      softClosedAt: true,
      billedAt: true,
    },
  });
  if (!item) return { routed: false, reason: 'shop item not found' };

  const category = inspection.category as InspectionCategory;
  const results = extractCheckpointResults(inspection.data);
  const unitAttrs = {
    model: item.equipmentDescription ?? '',
    brand: item.fexBrand ?? '',
  };
  const cascades = evaluateCascades(category, results, unitAttrs);

  const hasCondemn =
    inspection.outcome === 'condemn' || cascades.some((c) => c.action === 'CONDEMN');
  const hasFactoryReturn = cascades.some((c) => c.action === 'FACTORY_RETURN');
  const forcedParts = cascades
    .filter((c) => c.action === 'FORCE_PARTS')
    .flatMap((c) => c.parts ?? []);

  let target: ShopItemStatus | null = null;
  if (hasCondemn) target = 'condemned';
  else if (hasFactoryReturn) target = 'outside_service';
  else if (inspection.outcome === 'pass') target = 'shop_complete';
  else if (inspection.outcome === 'fail' || inspection.outcome === 'requires_parts') target = 'in_work';
  // cannot_service → leave for manual disposition (equipment already → out_of_service via lifecycle)

  const cascadeSummary = cascades.map((c) => ({
    action: c.action,
    checkpointKey: c.checkpointKey,
    ruleId: c.ruleId,
  }));

  if (!target) {
    return { routed: false, reason: `no route for outcome '${inspection.outcome}'`, cascades: cascadeSummary, forcedParts };
  }
  if (target === 'shop_complete' || target === 'condemned') {
    try {
      await assertShopSerialsCollected(prisma, item.workOrderId, [item.id]);
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      return { routed: false, reason: error.message, cascades: cascadeSummary, forcedParts };
    }
  }
  const fromStatus = item.status as ShopItemStatus;
  if (fromStatus === target) {
    return { routed: false, reason: 'already at target status', cascades: cascadeSummary, forcedParts };
  }
  if (fromStatus === 'shop_complete' &&
      (item.billedAt || !item.hardClosesAt || item.hardClosesAt.getTime() <= Date.now())) {
    return { routed: false, reason: 'Closed unit must be explicitly reopened before correcting its status', cascades: cascadeSummary, forcedParts };
  }
  // CONDEMN EVIDENCE backstop (WI-04). The lock path already gates this, but
  // the OFFLINE path does not go through lock -- sync.ts calls this function
  // directly when a device's inspection lands. Routing must never throw (it
  // would break the lock it is called from), so an unevidenced condemn declines
  // to route and says why: the inspection is still recorded, the unit simply
  // stays where it is until someone attaches the photo.
  if (target === 'condemned') {
    const evidence = await checkCondemnEvidence(prisma, item.id);
    if (!evidence.satisfied) {
      console.log(
        `[inspection→route] skip: condemn without evidence for item ${item.id} (inspection ${inspection.id})`,
      );
      return {
        routed: false,
        reason: 'condemn blocked — no attachment on the unit (WI-04 evidence gate)',
        cascades: cascadeSummary,
        forcedParts,
      };
    }
  }

  // QA GATE backstop, exactly the shape of the condemn-evidence one above and
  // for exactly the same reason: this function is the ONLY thing standing
  // between an offline lock replay and a released unit.
  //
  // lockInspectionRecord checks the QA checklist before it routes -- but the
  // offline path never reaches it. sync.ts replays an offline lock as a plain
  // field write that sets lockedAt, then calls THIS function directly. So a
  // `pass` outcome with an empty checklist walked straight through to
  // shop_complete on the strength of the outcome dropdown alone.
  //
  // Routing must never throw (it would break the lock it is called from), so an
  // ungated release is DIVERTED rather than refused: the unit goes to the
  // re-test lane, the inspection is still recorded, and the reason lands in the
  // status log the board already renders. Declining to route outright was the
  // other option and is worse -- the unit would sit silently at its old status
  // with a locked "pass" inspection on it, which reads as a system that lost
  // the tech's work.
  let qaDivertReason: string | null = null;
  if (target === 'shop_complete') {
    const verdict = await evaluateItemQa(prisma, {
      id: item.id,
      equipmentCategory: item.equipmentCategory,
      parentItemId: item.parentItemId,
    });
    if (!verdict.satisfied) {
      const divert = resolveQaDivert(fromStatus);
      console.log(
        `[inspection→route] QA gate: ${item.id} asked for shop_complete on inspection ${inspection.id} — ${verdict.reason}`,
      );
      if (!divert) {
        return {
          routed: false,
          reason: `QA gate — ${verdict.reason}`,
          cascades: cascadeSummary,
          forcedParts,
        };
      }
      target = divert;
      qaDivertReason = verdict.reason ?? 'QA checklist incomplete';
    }
  }

  if (!canTransitionShopItem(fromStatus, target)) {
    console.log(
      `[inspection→route] skip: illegal transition ${fromStatus} → ${target} for item ${item.id} (inspection ${inspection.id})`,
    );
    return { routed: false, reason: `illegal transition ${fromStatus} → ${target}`, cascades: cascadeSummary, forcedParts };
  }

  // Pre-seed forced parts onto the repair (only meaningful when heading in_work).
  let partsUpdate: unknown[] | undefined;
  if (forcedParts.length > 0 && target === 'in_work') {
    const existingParts = Array.isArray(item.partsUsed) ? (item.partsUsed as unknown[]) : [];
    const have = new Set(
      existingParts
        .map((p) => (p && typeof p === 'object' ? String((p as Record<string, unknown>).partNumber) : ''))
        .filter(Boolean),
    );
    const additions = forcedParts
      .filter((pn) => !have.has(pn))
      .map((pn) => ({ partNumber: pn, quantity: 1, forcedByCascade: true }));
    if (additions.length) partsUpdate = [...existingParts, ...additions];
  }

  await prisma.$transaction(async (tx) => {
    await tx.shopWorkOrderItem.update({
      where: { id: item.id },
      data: {
        status: target as ShopItemStatus,
        ...(userId ? closerFieldsFor(item, target, userId) : !['shop_complete', 'returned', 'condemned'].includes(target) ? { softClosedAt: null, hardClosesAt: null, closedById: null } : {}),
        ...(partsUpdate ? { partsUsed: partsUpdate as never } : {}),
      },
    });
    await tx.shopItemStatusLog.create({
      data: {
        itemId: item.id,
        fromStatus,
        toStatus: target as ShopItemStatus,
        changedById: userId,
        notes:
          (qaDivertReason
            ? `"Ready for Pickup" withheld — ${qaDivertReason} Sent to QC / re-test instead. `
            : '') +
          `Auto-routed by inspection ${inspection.id} (outcome=${inspection.outcome}` +
          (cascades.length ? `, cascades: ${cascades.map((c) => c.action).join('/')}` : '') +
          ')',
      },
    });
  });

  return {
    routed: true,
    workOrderId: item.workOrderId,
    fromStatus,
    toStatus: target,
    cascades: cascadeSummary,
    forcedParts,
  };
}
