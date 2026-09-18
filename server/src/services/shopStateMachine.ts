/**
 * Shop Work Order Item Status State Machine
 *
 * Defines valid status transitions for individual shop work order items.
 *
 * Flow:
 *   received → diagnosing | in_work | awaiting_approval | warranty_out | outside_service
 *   diagnosing → awaiting_parts | awaiting_approval | in_work | warranty_out
 *   awaiting_parts → in_work | diagnosing | awaiting_approval
 *   awaiting_approval → in_work | returned (customer declined)
 *   in_work → qc_testing | shop_complete | awaiting_parts | awaiting_approval | warranty_out
 *
 *   awaiting_approval is the "hold for customer approval" state — reachable from
 *   any active working state so a unit can be parked for a quote/scope sign-off
 *   (it surfaces in the board's "Waiting Approval" column).
 *   warranty_out → received (comes back, restarts)
 *   outside_service → received (comes back, restarts)
 *   qc_testing → shop_complete | in_work (fail → rework) | outside_service (send back out) | condemned
 *   on_hold → back to any active working state (WI-02 generic park)
 *   shop_complete → returned
 *   condemned → (terminal — billable; writes a BlueLion DEAD record)
 *   returned → (terminal)
 *
 * ShopWork refactor (Wave 1c): the inspection is the spine. The INITIAL
 * inspection runs on the bench (received → diagnosing = "Inspecting") and its
 * outcome + cascade rules route the unit — pass → shop_complete (ReadyVisualOnly),
 * fail/requires-parts → in_work (InRepair), FACTORY_RETURN → outside_service
 * (AtVendor), CONDEMN → condemned. Re-test = the final inspection at qc_testing,
 * which repair AND vendor return converge on, looping until pass or condemn.
 * 'condemned' is reachable from both Inspecting (diagnosing) and ReTest
 * (qc_testing) — no-parts brands often fail on first look.
 */

import type { ShopItemStatus } from '../db.js';
import { isSettableHoldReason, SETTABLE_HOLD_REASONS } from './shopHoldReason.js';

const ITEM_TRANSITIONS: Record<string, ShopItemStatus[]> = {
  // 'outside_service' is the single "someone offsite has it" status; warranty is
  // now the orthogonal isWarranty flag. 'warranty_out' is retired/deprecated —
  // kept here for legacy rows but no longer produced by the send-out flow.
  received: ['diagnosing', 'in_work', 'awaiting_approval', 'warranty_out', 'outside_service', 'on_hold'],
  // diagnosing = "Inspecting". A visual-only PASS routes straight to shop_complete
  // (ReadyVisualOnly) with no repair; other outcomes route to in_work / outside_service / condemned.
  // 'qc_testing' is reachable from here because the QA gate diverts an ungated
  // release into the re-test lane (services/shopQaGate.ts). A visual-only pass
  // whose checklist is not finished has to land SOMEWHERE that isn't
  // shop_complete, and "awaiting QC" is what it is.
  diagnosing: ['awaiting_parts', 'awaiting_approval', 'in_work', 'warranty_out', 'outside_service', 'condemned', 'shop_complete', 'qc_testing', 'on_hold'],
  awaiting_parts: ['in_work', 'diagnosing', 'awaiting_approval', 'on_hold'],
  awaiting_approval: ['in_work', 'returned', 'on_hold'],
  in_work: ['qc_testing', 'shop_complete', 'awaiting_parts', 'awaiting_approval', 'warranty_out', 'outside_service', 'condemned', 'on_hold'],
  warranty_out: ['received'],
  outside_service: ['received'],
  qc_testing: ['shop_complete', 'in_work', 'outside_service', 'condemned', 'on_hold'],
  // Generic park (WI-02). Leads back to every active state so a unit that was
  // waiting on someone internal can resume wherever it left off. Deliberately
  // NOT a route to shop_complete/returned — coming off hold means going back to
  // work, and releasing gear still has to pass the QA gate on its own path.
  on_hold: ['received', 'diagnosing', 'in_work', 'awaiting_parts', 'awaiting_approval', 'outside_service', 'qc_testing', 'condemned'],
  shop_complete: ['returned'],
  // condemned is terminal — no transitions out (terminal-billable)
  // returned is terminal — no transitions out
};

/**
 * WI-02: a unit cannot enter the generic `on_hold` state without a reason.
 *
 * This lives in the state machine rather than the route handler on purpose —
 * the acceptance criterion is that the transition is rejected structurally, not
 * that one UI form validates. Every caller that moves an item goes through
 * here, so there is no path that parks a unit with no explanation.
 *
 * The other hold statuses need no check: their reason is derived from the
 * status itself and so cannot be missing (see services/shopHoldReason.ts).
 *
 * Returns an error message, or null when the transition is acceptable.
 */
export function holdReasonError(
  target: ShopItemStatus,
  holdReason: unknown,
): string | null {
  if (target !== 'on_hold') return null;
  if (isSettableHoldReason(holdReason)) return null;
  return `Moving a unit to On Hold requires a reason (${SETTABLE_HOLD_REASONS.join(' or ')}). ` +
    'Waiting on parts, customer approval, or an outside vendor are their own statuses — use those instead.';
}

export function canTransitionShopItem(
  current: ShopItemStatus,
  target: ShopItemStatus,
): boolean {
  const allowed = ITEM_TRANSITIONS[current];
  if (!allowed) return false;
  return allowed.includes(target);
}

export function getAvailableShopItemTransitions(
  current: ShopItemStatus,
): ShopItemStatus[] {
  return ITEM_TRANSITIONS[current] || [];
}

/**
 * Work-order-level status transitions.
 * These are simpler — mostly manual overrides or auto-computed from item statuses.
 */
import type { ShopWorkOrderStatus } from '../db.js';

const WO_TRANSITIONS: Record<string, ShopWorkOrderStatus[]> = {
  intake: ['in_progress', 'hold', 'closed'],
  in_progress: ['hold', 'complete', 'closed'],
  hold: ['in_progress', 'closed'],
  complete: ['in_progress', 'closed'], // reopen if needed
  // closed is terminal
};

export function canTransitionShopWO(
  current: ShopWorkOrderStatus,
  target: ShopWorkOrderStatus,
): boolean {
  const allowed = WO_TRANSITIONS[current];
  if (!allowed) return false;
  return allowed.includes(target);
}

export function getAvailableShopWOTransitions(
  current: ShopWorkOrderStatus,
): ShopWorkOrderStatus[] {
  return WO_TRANSITIONS[current] || [];
}
