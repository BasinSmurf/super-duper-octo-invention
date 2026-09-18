/**
 * shopHoldReason.ts — the single source of truth for "why is this unit parked".
 *
 * WI-02 asked for a five-value reason enum, required to enter On Hold. Three of
 * those five already existed as item statuses:
 *
 *   awaiting_parts    -> waiting_parts
 *   awaiting_approval -> waiting_customer_approval
 *   outside_service   -> external_vendor
 *   warranty_out      -> external_vendor   (legacy; send-out no longer produces it)
 *
 * Storing a reason alongside those statuses would be a second copy of the same
 * fact, free to drift. So they are DERIVED here and never written. The two that
 * had no status — waiting_internal and other — get the generic `on_hold`
 * status, and that status is the only one where holdReason is stored and
 * required (enforced in shopStateMachine.assertHoldReasonValid, not in the UI).
 *
 * Consequence worth noting: a vendor send-out lands in `outside_service` and
 * therefore *already* carries `external_vendor`. WI-02's "transfer-out auto-sets
 * the reason" needs no auto-set code — the reason cannot be absent or wrong.
 */

import type { ShopHoldReason, ShopItemStatus } from '../db.js';

/** Item statuses that render under the board's collapsed "On Hold" column. */
export const HOLD_STATUSES: ShopItemStatus[] = [
  'awaiting_parts',
  'awaiting_approval',
  'outside_service',
  'warranty_out',
  'on_hold',
];

/** Reasons a human may actually pick. The rest are derived from status. */
export const SETTABLE_HOLD_REASONS: ShopHoldReason[] = ['waiting_internal', 'other'];

export const HOLD_REASON_LABEL: Record<ShopHoldReason, string> = {
  waiting_parts: 'Waiting parts',
  external_vendor: 'External vendor',
  waiting_customer_approval: 'Waiting customer approval',
  waiting_internal: 'Waiting internal',
  other: 'Other',
};

/** Status -> reason for the four holds that carry their reason implicitly. */
const DERIVED_REASON: Partial<Record<ShopItemStatus, ShopHoldReason>> = {
  awaiting_parts: 'waiting_parts',
  awaiting_approval: 'waiting_customer_approval',
  outside_service: 'external_vendor',
  warranty_out: 'external_vendor',
};

export function isHoldStatus(status: ShopItemStatus): boolean {
  return HOLD_STATUSES.includes(status);
}

export function isSettableHoldReason(value: unknown): value is ShopHoldReason {
  return typeof value === 'string' && (SETTABLE_HOLD_REASONS as string[]).includes(value);
}

export interface ResolvedHoldReason {
  code: ShopHoldReason;
  label: string;
  /** Optional short free-text qualifier. Display-only — never parsed. */
  note: string | null;
}

/**
 * The reason to show on the On-Hold pill, or null when the unit isn't on hold.
 *
 * Returns null for `on_hold` with no stored reason too. That state should be
 * unreachable (the state machine refuses the transition), but a legacy row or a
 * direct DB edit shouldn't crash a wall display.
 */
export function resolveHoldReason(item: {
  status: ShopItemStatus;
  holdReason?: ShopHoldReason | null;
  holdNote?: string | null;
}): ResolvedHoldReason | null {
  const note = item.holdNote?.trim() || null;

  const derived = DERIVED_REASON[item.status];
  if (derived) return { code: derived, label: HOLD_REASON_LABEL[derived], note };

  if (item.status === 'on_hold' && item.holdReason) {
    return { code: item.holdReason, label: HOLD_REASON_LABEL[item.holdReason], note };
  }

  return null;
}
