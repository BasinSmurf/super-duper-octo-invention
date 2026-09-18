/**
 * inspectionLock.ts
 *
 * Shared "lock an equipment inspection" logic — the QA/REQUIRE_ACK gates, the
 * lockedAt snapshot, the outcome flow-back, the shop routing, and the BlueLion
 * ledger enqueue. Extracted from POST /equipment-inspections/:id/lock so the
 * SAME logic can also auto-fire when a shop item is marked shop_complete
 * without the tech ever clicking "Lock" directly.
 *
 * Why this exists (2026-07-16): locking is what triggers the BlueLion push
 * (enqueueInspectionRecord), but a shop item only needed its QA checklist
 * filled in — not its inspection locked — to reach shop_complete and close
 * the WO. Techs routinely never clicked the separate, "this is permanent"
 * Lock button, so completed Shop Orders never showed up in BlueLion. Callers
 * that auto-lock (shopOrders.ts) treat failures here as non-fatal — an
 * unacknowledged REQUIRE_ACK cascade or an incomplete checklist should not
 * block the item transition, it just leaves the inspection unlocked for a
 * human to resolve, same as before this fix existed.
 */
import type { PrismaClient } from '../db.js';
import { AppError } from '../middleware/errorHandler.js';
import {
  categoryHasShopGate,
  isQaChecklistComplete,
  getMissingRequiredShopKeys,
  labelsForKeys,
  evaluateCascades,
  extractCheckpointResults,
  manualRefsForCategory,
  type InspectionCategory,
} from './inspectionChecklist.js';
import { applyInspectionOutcome, type OutcomeFlowResult } from './equipmentLifecycle.js';
import { routeShopItemFromInspection, type RoutingResult } from './inspectionRouting.js';
import { enqueueInspectionRecord } from './blueLionEnqueue.js';
import { checkCondemnEvidence } from './condemnEvidence.js';
import { createAuditLog } from '../utils/auditLog.js';

export interface LockInspectionResult {
  locked: { id: string; lockedAt: Date | null; [key: string]: unknown };
  flow: OutcomeFlowResult | null;
  routing: RoutingResult;
}

/**
 * Lock an inspection: validate the QA + REQUIRE_ACK gates, stamp lockedAt with
 * an audit snapshot, flow the outcome back to the unit's lifecycle status,
 * route the shop item, and enqueue the BlueLion ledger push. Throws AppError
 * (404/409/422) on any gate failure — callers that want a non-fatal auto-lock
 * should catch and log rather than propagate.
 */
export async function lockInspectionRecord(
  prisma: PrismaClient,
  inspectionId: string,
  userId: string,
): Promise<LockInspectionResult> {
  const existing = await prisma.equipmentInspection.findUnique({ where: { id: inspectionId } });
  if (!existing) throw new AppError(404, 'Inspection not found');
  if (existing.lockedAt) throw new AppError(409, 'Inspection is already locked');

  // QA gate: the checklist-complete requirement applies ONLY to a 'pass' outcome
  // (certifying the unit is ready for pickup). Any non-pass outcome — fail /
  // requires_parts (routes to In Repair), condemn / cannot_service (terminal/out)
  // — is recording a problem, not certifying readiness, so it bypasses the gate
  // and is free to lock. This is what lets the inspection-as-spine route a failed
  // initial inspection on lock.
  const category = existing.category as InspectionCategory;
  const waived = existing.outcome !== 'pass';
  if (!waived && categoryHasShopGate(category)) {
    const qaChecklist = (existing.data as Record<string, unknown> | null)?.qaChecklist;
    const serviceActions = existing.serviceActions;
    if (!isQaChecklistComplete(category, qaChecklist, serviceActions)) {
      const missing = labelsForKeys(
        category,
        getMissingRequiredShopKeys(category, qaChecklist, serviceActions),
      );
      throw new AppError(
        422,
        `QA checklist incomplete — cannot lock. Still required: ${missing.join('; ')}`,
      );
    }
  }

  // REQUIRE_ACK gate: any cascade that demands the tech acknowledge a verbatim
  // manual snippet must be acknowledged (data.checkpoints[key].ack truthy) before
  // the record can lock. (No-op until a REQUIRE_ACK rule is in CASCADE_RULES.)
  const results = extractCheckpointResults(existing.data);
  const firedCascades = evaluateCascades(category, results);
  const checkpoints =
    (existing.data as { checkpoints?: Record<string, { ack?: unknown }> } | null)?.checkpoints ?? {};
  const unacked = firedCascades.filter(
    (c) => c.action === 'REQUIRE_ACK' && !checkpoints[c.checkpointKey]?.ack,
  );
  if (unacked.length > 0) {
    throw new AppError(
      422,
      `Cannot lock — acknowledge the required manual instruction(s) first: ${unacked
        .map((c) => c.checkpointKey)
        .join(', ')}`,
    );
  }

  // CONDEMN EVIDENCE gate (WI-04). Locking a condemn inspection is what routes
  // the unit to `condemned` and mints the DEAD record, so this is the moment to
  // insist on evidence -- the tech is in the inspection editor with the unit in
  // front of them and can attach right here. Refusing later, at routing time,
  // would be invisible: the lock would succeed and the unit would silently fail
  // to route.
  //
  // Deliberately checked for a shop inspection only. A FIELD inspection
  // (ticketId) condemning a unit is a different flow with its own capture, and
  // WI-04 scopes this to shop units.
  const condemning =
    existing.outcome === 'condemn' ||
    firedCascades.some((c) => c.action === 'CONDEMN');
  if (condemning && existing.shopItemId) {
    const evidence = await checkCondemnEvidence(prisma, existing.shopItemId);
    if (!evidence.satisfied) {
      throw new AppError(422, evidence.message!);
    }
  }

  // Audit snapshot: capture the manual references the criteria came from so the
  // BlueLion ledger entry is defensible (which manual revision drove the checks).
  // Empty until the RAG extract populates manualRef on the catalog (§7/§8).
  const snapshotData = {
    ...(existing.data && typeof existing.data === 'object'
      ? (existing.data as Record<string, unknown>)
      : {}),
    auditSnapshot: {
      capturedAt: new Date().toISOString(),
      manualRefs: manualRefsForCategory(category),
    },
  };

  const locked = await prisma.equipmentInspection.update({
    where: { id: inspectionId },
    data: { lockedAt: new Date(), data: snapshotData as never },
  });

  await createAuditLog({
    userId,
    action: 'status_change',
    entityType: 'equipment_inspection',
    entityId: locked.id,
    changes: { lockedAt: locked.lockedAt },
  });

  // Outcome flow-back to the serialized unit's lifecycle status.
  //   condemn → condemned (+ decommission record); cannot_service → out_of_service.
  // Condemn stays BILLABLE — only warranty (isWarranty) suppresses billing.
  const flow = await applyInspectionOutcome(prisma, locked, userId);

  // Inspection-as-spine: route the SHOP item to its next state from the outcome +
  // cascades (pass → ready, fail → repair, FACTORY_RETURN → vendor, condemn →
  // condemned). No-op for field inspections (Wave 4) and illegal transitions.
  const routing = await routeShopItemFromInspection(prisma, locked, userId);

  // BlueLion inspection ledger: enqueue this terminal outcome for push. No-op
  // for non-terminal outcomes; the queue processor self-skips when BlueLion is
  // unconfigured. Non-fatal — a ledger hiccup must not fail the lock.
  await enqueueInspectionRecord(locked.id).catch((e) =>
    console.warn('[BlueLion] enqueue inspection failed (non-fatal):', e),
  );

  return { locked, flow, routing };
}

/**
 * Auto-lock every unlocked 'pass' inspection on a shop item, best-effort. Called
 * when an item transitions to shop_complete WITHOUT going through the explicit
 * lock route (the direct status-change button, the WO-level bulk complete, and
 * the offline sync replay all bypass it). Never throws — a gate failure here
 * (rare: an unacknowledged REQUIRE_ACK cascade) just leaves the inspection
 * unlocked, matching pre-fix behavior, rather than blocking the item transition.
 */
export async function autoLockPassedInspections(
  prisma: PrismaClient,
  shopItemId: string,
  userId: string,
): Promise<RoutingResult[]> {
  const candidates = await prisma.equipmentInspection.findMany({
    where: { shopItemId, outcome: 'pass', lockedAt: null },
    select: { id: true },
  });

  const routings: RoutingResult[] = [];
  for (const c of candidates) {
    try {
      const { routing } = await lockInspectionRecord(prisma, c.id, userId);
      routings.push(routing);
    } catch (e) {
      console.warn(`[BlueLion] auto-lock failed for inspection ${c.id} (non-fatal):`, e);
    }
  }
  return routings;
}
