/**
 * shopQaGate.ts — the one place that answers "has this unit passed QA?"
 *
 * A unit reaching `shop_complete` is a life-safety claim: the WO flips to
 * "Ready for Pickup", the Postgres soft-close trigger stamps the unit, and 48
 * hours later it is billable and pushed to the VaultPRO ledger. Nothing
 * downstream re-checks. So the claim has to be true at the moment it is made,
 * on EVERY path that can make it.
 *
 * A unit satisfies the gate two ways, on identical terms: a per-unit
 * EquipmentInspection whose required shop checkpoints are all ticked, or a
 * passing ShopQaUnitResult from a WI-06 batch. The batch is not a lighter-weight
 * route through -- it is the same predicate run over a selection, and its
 * checklist is resolved THROUGH the event rather than copied onto the unit, so
 * correcting a mis-entered batch stays one update.
 *
 * There turned out to be four paths that can release a unit, and only two of
 * them checked:
 *
 *   online, per item      PATCH /shop-orders/:id/items/:itemId/status   gated
 *   online, whole WO      PATCH /shop-orders/:id/status → 'complete'    gated
 *   offline status replay sync.ts shopWorkOrderItem update              NOT gated
 *   offline lock replay   sync.ts equipmentInspection → routing         NOT gated
 *
 * The last one was the live hole: an offline "Lock" on a pass inspection
 * replays as a plain field write and then calls routeShopItemFromInspection
 * DIRECTLY, stepping around lockInspectionRecord — which is where the QA gate
 * had been living. The unit was released on the strength of the outcome
 * dropdown alone, with an empty checklist behind it.
 *
 * ── Why the offline paths do not simply call the throwing gate ──────────────
 *
 * Because a sync reply must never block a technician. A mutation that throws is
 * marked `error` and retried; after MAX_RETRIES the client stops sending it and
 * it sits in the queue forever, inflating the pending badge, with the tech's
 * work neither landed nor visibly lost. That is the offline-prune failure mode
 * again, and it is worse than the thing it would be protecting against.
 *
 * The credit-hold and condemn-evidence gates DO throw on this path, and are
 * right to: both resolve themselves without the tech doing anything (AR clears
 * the account; the photo is usually the very next mutation in the same batch).
 * An empty QA checklist does not resolve itself. Nobody is coming.
 *
 * So offline, the gate DIVERTS instead of rejecting. The mutation is accepted,
 * every other field the tech recorded is written, and the unit lands in
 * `qc_testing` — the re-test lane it would have gone through anyway — instead
 * of `shop_complete`. The reason is written to the unit's status log, which is
 * what the board's unit history already renders.
 *
 * The unit therefore never enters a closing state, so the trigger never stamps
 * it, so it never becomes billable and never pushes to Vault. Same meaning as
 * the online 409, arrived at without ever failing a sync.
 */

import type { PrismaClient, ShopItemStatus } from '../db.js';
import {
  mapShopCategoryToInspection,
  categoryHasShopGate,
  isQaChecklistComplete,
  getMissingRequiredShopKeys,
  labelsForKeys,
} from './inspectionChecklist.js';
import { canTransitionShopItem } from './shopStateMachine.js';
import { unitQaComplete } from './shopBatchQa.js';

/** The item fields the gate needs. Kept structural so callers can select narrowly. */
export interface QaGateItem {
  id: string;
  equipmentCategory: string;
  parentItemId: string | null;
  status?: string;
}

export interface QaVerdict {
  satisfied: boolean;
  /** Why not, phrased for a technician. Present only when `satisfied` is false. */
  reason?: string;
}

/**
 * Where a unit goes when it asked for `shop_complete` and QA said no.
 *
 * `qc_testing` is the re-test lane the state machine already describes as the
 * convergence point for repair and vendor return — a unit whose checklist is
 * not finished is, precisely, awaiting QC. It is also non-releasing and not in
 * CLOSING_STATES, which is the property that actually matters.
 */
export const QA_DIVERT_STATUS: ShopItemStatus = 'qc_testing';

/**
 * The status to write instead of `shop_complete`, or null to leave the unit
 * where it is.
 *
 * Null happens when the divert itself would be an illegal transition — which,
 * for the states that can legally reach `shop_complete` at all (diagnosing,
 * in_work, qc_testing), it never is. It is a real possibility only for an
 * offline payload asking for a transition that was already illegal (say
 * received → shop_complete), and in that case holding position is the honest
 * answer: we are not going to invent a state machine move to launder a
 * malformed request.
 */
export function resolveQaDivert(currentStatus: string): ShopItemStatus | null {
  if (currentStatus === QA_DIVERT_STATUS) return null; // already there; nothing to write
  return canTransitionShopItem(currentStatus as ShopItemStatus, QA_DIVERT_STATUS)
    ? QA_DIVERT_STATUS
    : null;
}

/**
 * Has this unit satisfied the pre-pickup QA gate?
 *
 * Non-throwing on purpose: the online routes want an exception, the offline
 * ones want a verdict they can act on. One predicate, two presentations —
 * so the two paths cannot drift into disagreeing about what "QA passed" means.
 *
 * Sub-components (parentItemId set) inherit the parent assembly's QA and are
 * not independently gated; terminal dispositions need no QA at all.
 */
export async function evaluateItemQa(
  prisma: PrismaClient,
  item: QaGateItem,
): Promise<QaVerdict> {
  // Terminal dispositions need no QA — a condemned unit isn't being released for
  // service, and a returned one is already gone.
  if (item.status === 'condemned' || item.status === 'returned') return { satisfied: true };
  // Child components cascade with the parent; don't gate them separately.
  if (item.parentItemId) return { satisfied: true };

  const category = mapShopCategoryToInspection(item.equipmentCategory);
  if (!categoryHasShopGate(category)) return { satisfied: true }; // e.g. 'other' — nothing to QA

  const inspections = await prisma.equipmentInspection.findMany({
    where: { shopItemId: item.id },
    select: { data: true, outcome: true, serviceActions: true },
  });

  const passed = inspections.some((insp) => {
    // Condemn / cannot-service: nothing to QA — the unit isn't being serviced.
    if (insp.outcome === 'condemn' || insp.outcome === 'cannot_service') return true;
    const qaChecklist = (insp.data as Record<string, unknown> | null)?.qaChecklist;
    return isQaChecklistComplete(category, qaChecklist, insp.serviceActions);
  });

  if (passed) return { satisfied: true };

  // WI-06: a batch QA satisfies this gate on exactly the same terms as a
  // per-unit inspection -- same predicate, same required keys, same category.
  // Checked second only because the per-unit record is the common case; neither
  // is privileged.
  const qaResults = await prisma.shopQaUnitResult.findMany({
    where: { itemId: item.id, outcome: 'pass' },
    select: {
      checklistOverrides: true,
      qaEvent: { select: { checklistResults: true, serviceActions: true } },
    },
  });
  const batchPassed = qaResults.some((r) =>
    unitQaComplete(
      category,
      r.qaEvent.checklistResults,
      r.checklistOverrides,
      r.qaEvent.serviceActions,
    ),
  );
  if (batchPassed) return { satisfied: true };

  // Build a helpful message. If an inspection exists but is incomplete, list
  // what's missing from the most complete attempt; otherwise say none exists.
  let reason = 'No QA inspection has been completed for this item.';
  if (inspections.length > 0) {
    const missingByInsp = inspections.map((insp) =>
      getMissingRequiredShopKeys(
        category,
        (insp.data as Record<string, unknown> | null)?.qaChecklist,
        insp.serviceActions,
      ),
    );
    // Pick the attempt with the fewest missing items.
    const best = missingByInsp.reduce((a, b) => (b.length < a.length ? b : a));
    reason = `QA checklist incomplete — still required: ${labelsForKeys(category, best).join('; ')}`;
  }
  return { satisfied: false, reason };
}
