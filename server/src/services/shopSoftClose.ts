/**
 * shopSoftClose.ts — WI-05, the 48-hour window between "done" and "final".
 *
 * A unit that just closed is the most likely thing in the shop to be wrong: the
 * tech is still standing there, the customer is still on the phone, and the
 * mistakes that matter (wrong serial, wrong parts, wrong disposition) are found
 * in the next hour, not the next month. Petrifying the record at the moment of
 * close optimises for the audit trail at the expense of the thing being audited.
 *
 * So a close is two events, not one:
 *
 *   soft close   the unit reaches shop_complete / returned / condemned.
 *                Work is done. Still editable by the closing tech or a
 *                supervisor. NOT yet billable, NOT yet pushed to VaultPRO.
 *
 *   hard close   48 wall-clock hours later. The record is final, the unit
 *                becomes visible to billing, and the Vault push fires.
 *
 * WALL-CLOCK, NOT BUSINESS HOURS. A Friday 16:00 close is hard before Monday
 * morning and that is deliberate — a business-hours clock would mean a unit
 * closed before a holiday weekend stays editable for four days, and "when does
 * this bill?" would need a calendar to answer.
 *
 * PER-UNIT, because this repo already bills per unit. Making the close
 * per-work-order would have meant a five-unit WO where four units are finished
 * and one is still on the bench either bills nothing or bills unfinished work.
 *
 * ONE TIMESTAMP DRIVES EVERYTHING. Billable-ness and Vault-pushed-ness are both
 * read off `hardClosesAt` rather than kept as their own flags, so they cannot
 * end up disagreeing about whether a unit is final.
 */

/** Terminal-billable states. Identical to BILLABLE_STATES in shopBillingLines —
 *  "settled" and "closed" must be the same set or the two drift. */
export const CLOSING_STATES = ['shop_complete', 'returned', 'condemned'] as const;

export const SOFT_CLOSE_HOURS = 48;
const MS_PER_HOUR = 3_600_000;

export function isClosingState(status: string): boolean {
  return (CLOSING_STATES as readonly string[]).includes(status);
}

/**
 * The hard-close deadline for a close happening at `from`.
 *
 * Plain millisecond arithmetic on absolute time, deliberately. Adding "48
 * hours" via a calendar library across a DST boundary gives 48 *calendar*
 * hours, which is 47 or 49 real ones — so two units closed a minute apart in
 * March would get windows of different real length. Absolute time means the
 * window is always exactly 48 hours of the world happening.
 */
export function hardCloseDeadline(from: Date): Date {
  return new Date(from.getTime() + SOFT_CLOSE_HOURS * MS_PER_HOUR);
}

export type CloseState = 'open' | 'soft' | 'hard';

export interface UnitCloseFields {
  status: string;
  softClosedAt: Date | null;
  hardClosesAt: Date | null;
  closedById: string | null;
  parentItemId?: string | null;
}

/**
 * Where a unit sits right now.
 *
 * A unit with no `hardClosesAt` is open — including one whose status looks
 * terminal but predates this feature and was never stamped. Treating an
 * unstamped row as `open` (editable, not yet billable) rather than `hard` would
 * be the safer-looking default and is the wrong one: it would quietly pull
 * every historical unit out of billing. The migration backfills them as already
 * hard-closed for exactly this reason; this function only has to be correct for
 * rows that ARE stamped.
 */
export function closeStateOf(item: UnitCloseFields, now: Date = new Date()): CloseState {
  if (!item.softClosedAt || !item.hardClosesAt) return 'open';
  return now.getTime() >= item.hardClosesAt.getTime() ? 'hard' : 'soft';
}

/** Milliseconds left in the soft window; 0 once hard-closed or still open. */
export function msUntilHardClose(item: UnitCloseFields, now: Date = new Date()): number {
  if (!item.hardClosesAt) return 0;
  return Math.max(0, item.hardClosesAt.getTime() - now.getTime());
}

/**
 * Roles that may edit inside the soft window regardless of who closed the unit.
 *
 * Supervisors are here because the realistic correction is "the tech went home
 * and the customer just called". Billing is NOT here: they consume the record,
 * and a window that exists to let the shop fix its own work should not become
 * a way for billing to reshape it.
 */
const SOFT_WINDOW_ROLES = new Set(['field_super', 'boss', 'platform_admin']);

/** Roles that may grant a fresh window after hard close. */
const UNLOCK_ROLES = new Set(['platform_admin']);

export interface EditVerdict {
  allowed: boolean;
  state: CloseState;
  reason?: string;
}

/**
 * May this actor edit this unit right now?
 *
 * Sub-components are not separately gated — they follow the parent assembly,
 * the same way the QA and condemn-evidence gates treat them.
 */
export function canEditUnit(
  item: UnitCloseFields,
  actor: { userId: string; role: string },
  now: Date = new Date(),
): EditVerdict {
  if (item.parentItemId) return { allowed: true, state: 'open' };

  const state = closeStateOf(item, now);
  if (state === 'open') return { allowed: true, state };

  if (state === 'hard') {
    return {
      allowed: false,
      state,
      reason:
        'This unit is closed and its record is final. A Platform Admin can reopen it ' +
        'for 48 hours with a reason.',
    };
  }

  // Soft window: the closing tech, or a supervisor.
  const isCloser = !!item.closedById && item.closedById === actor.userId;
  if (isCloser || SOFT_WINDOW_ROLES.has(actor.role)) {
    return { allowed: true, state };
  }
  return {
    allowed: false,
    state,
    reason:
      'This unit was closed by someone else. Only the tech who closed it, or a ' +
      'supervisor, can change it during the 48-hour window.',
  };
}

export function canUnlockUnit(role: string): boolean {
  return UNLOCK_ROLES.has(role);
}

/**
 * A unit is billable only once it is HARD closed.
 *
 * This is the whole point of the window: an invoice raised against a record
 * still being corrected is worse than an invoice raised two days later.
 */
export function isHardClosed(item: UnitCloseFields, now: Date = new Date()): boolean {
  return closeStateOf(item, now) === 'hard';
}

/**
 * The stamp applied when a unit first reaches a closing state.
 *
 * Returns null when the unit is already stamped — re-entering a closing state
 * must NOT restart the clock, or a unit could be held out of billing
 * indefinitely by bouncing it between shop_complete and returned.
 */
export function softCloseStamp(
  item: { softClosedAt: Date | null },
  actorUserId: string,
  now: Date = new Date(),
): { softClosedAt: Date; hardClosesAt: Date; closedById: string } | null {
  if (item.softClosedAt) return null;
  return {
    softClosedAt: now,
    hardClosesAt: hardCloseDeadline(now),
    closedById: actorUserId,
  };
}

/**
 * The one close field the DATABASE cannot fill in: who did it.
 *
 * soft_closed_at / hard_closes_at are stamped by a BEFORE UPDATE trigger
 * (see the 20260828180000 migration), because a unit reaches a closing state
 * from at least seven code paths and billing correctness now depends on the
 * stamp existing on every one of them. WI-04 already proved that a guard each
 * route must remember to call is a guard a future route forgets -- and here the
 * failure would be silent, the unit would just bill early.
 *
 * The trigger has no idea who is acting, so routes contribute closedById where
 * they know it. When it ends up null, canEditUnit falls back to
 * supervisor-only for the window: restrictive, not permissive.
 */
export function closerFieldsFor(
  item: { softClosedAt: Date | null },
  newStatus: string,
  actorUserId: string,
): Record<string, unknown> {
  if (!isClosingState(newStatus)) return {};
  if (item.softClosedAt) return {}; // already closed once; don't reassign the closer
  return { closedById: actorUserId };
}

/** The stamp applied by a Platform Admin unlock: a fresh window from now. */
export function unlockStamp(
  actorUserId: string,
  reason: string,
  now: Date = new Date(),
): {
  softClosedAt: Date;
  hardClosesAt: Date;
  unlockedAt: Date;
  unlockedById: string;
  unlockReason: string;
} {
  return {
    // The window restarts, so softClosedAt moves with it — otherwise
    // closeStateOf would read the original close and immediately say 'hard'.
    softClosedAt: now,
    hardClosesAt: hardCloseDeadline(now),
    unlockedAt: now,
    unlockedById: actorUserId,
    unlockReason: reason,
  };
}
