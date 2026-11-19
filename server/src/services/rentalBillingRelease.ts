/**
 * rentalBillingRelease.ts — "send for billing".
 *
 * An active rental no longer lands in AR's Ready queue just by being open
 * (40+ trailers and every monitor on rent made that queue a wall). A field
 * supervisor SENDS it: that stamps `billingReleasedThrough` on the agreement,
 * frozen at the day they clicked. The rental is in AR's queue while that stamp
 * is ahead of what has actually been invoiced, which makes it:
 *
 *   - self-clearing: cutting the invoice moves lastBilledThrough up to the
 *     stamp and the card drops off, no "mark done" step;
 *   - void-safe: voiding that invoice moves lastBilledThrough back and the card
 *     returns without anyone re-sending.
 *
 * A CLOSED rental needs no stamp. Closing is the send: it goes to AR on its own
 * once its tickets are approved. Deriving that from status (rather than
 * stamping at close) is deliberate — a rental closes through three different
 * write paths (the close endpoint, a return visit, an offline sync replay) and
 * a stamp any one of them forgot would hide a finished job from billing.
 *
 * The approval gate: nothing unapproved rides into billing. A ticket that is
 * finished but not yet approved (`completed`, `supervisor_review`) blocks the
 * release. A ticket still being worked (`in_progress` and earlier) does not —
 * a manned trailer has one open every single day — it is swept up by a later
 * release (the invoice generator sweeps back to the start of the job).
 *
 * Force: AR Supervisor can release without the field (`rentals:force_billing_
 * release`). Only field supervisors can approve tickets, so a force necessarily
 * skips the approval gate; it requires a reason and is recorded on the
 * agreement. Unapproved tickets still do not bill — the generator only takes
 * approved ones — they wait for the next invoice.
 */

import { prisma } from '../db.js';
import { AppError } from '../middleware/errorHandler.js';
import { billingCardLocation, billingLocationSelect } from './billingCardLocation.js';
import { computeRentalBillingState } from './rentalBilling.js';
import { lockRental, rentalToday } from './rentalLifecycle.js';

const DAY = 86_400_000;
const dateKey = (d: Date) => d.toISOString().slice(0, 10);

/** Finished-but-unapproved: these block a release. */
export const RELEASE_BLOCKING_STATUSES = ['completed', 'supervisor_review'] as const;
const isBlocking = (status: string) => (RELEASE_BLOCKING_STATUSES as readonly string[]).includes(status);

export type RentalReleaseState =
  /** Active, not sent (or already invoiced through the last send). The field's move. */
  | 'unreleased'
  /** Active and sent; waiting on AR to invoice. */
  | 'released'
  /** Closed, final bill owed, but tickets still need approval. The field's move. */
  | 'closed_blocked'
  /** Closed, final bill owed, nothing in the way. AR's move. */
  | 'closed_ready';

export interface ReleaseBlocker {
  id: string;
  ticketNumber: string;
  status: string;
  serviceDate: Date;
}

interface ReleaseFields {
  status: string;
  endDate: Date | null;
  billingReleasedThrough: Date | null;
  billingReleaseForceReason: string | null;
}

/**
 * Where a rental sits in the send-for-billing flow, or null when it owes
 * nothing (fully billed, scheduled, cancelled).
 */
export function rentalReleaseState(
  rental: ReleaseFields,
  billing: { lastBilledThrough: Date | null; isFullyBilled: boolean },
  blockerCount: number,
): RentalReleaseState | null {
  if (rental.status === 'completed') {
    if (billing.isFullyBilled) return null;
    // Only a force stamps a closed rental, and it covers the gate it skipped.
    const forced = !!rental.billingReleaseForceReason && !!rental.billingReleasedThrough
      && (!rental.endDate || rental.billingReleasedThrough >= rental.endDate);
    return blockerCount > 0 && !forced ? 'closed_blocked' : 'closed_ready';
  }
  if (rental.status !== 'active') return null;
  const pending = !!rental.billingReleasedThrough
    && (!billing.lastBilledThrough || rental.billingReleasedThrough > billing.lastBilledThrough);
  return pending ? 'released' : 'unreleased';
}

/** In AR's Ready queue? */
export const isReadyForBilling = (state: RentalReleaseState | null) => state === 'released' || state === 'closed_ready';

/**
 * Tickets blocking a release through `through`. A closed rental passes no date:
 * everything on a finished job has to be approved before its final bill.
 */
export function blockersFor<T extends { status: string; serviceDate: Date }>(tickets: T[], through: Date | null): T[] {
  return tickets.filter(t => isBlocking(t.status) && (!through || t.serviceDate <= through));
}

// ---------------------------------------------------------------------------
// Release / recall
// ---------------------------------------------------------------------------

export interface ReleaseResult {
  id: string;
  agreementNumber?: string;
  success: boolean;
  releasedThrough?: string;
  error?: string;
  /** Present when the approval gate refused the release. */
  blockers?: { id: string; ticketNumber: string; status: string; serviceDate: string }[];
}

class ReleaseBlockedError extends Error {
  constructor(public blockers: ReleaseBlocker[]) {
    super(`${blockers.length} ticket${blockers.length === 1 ? '' : 's'} must be approved first: ${blockers.map(b => b.ticketNumber).join(', ')}`);
  }
}

/**
 * Send rentals for billing. Each rental is its own transaction under the
 * rental lock, so one refusal never rolls back the rest of a bulk selection.
 */
export async function releaseRentals(opts: {
  ids: string[];
  userId: string;
  /** AR Supervisor override: skips the approval gate, records the reason. */
  force?: { reason: string };
}): Promise<ReleaseResult[]> {
  const results: ReleaseResult[] = [];
  for (const id of [...new Set(opts.ids)]) {
    try {
      results.push(await prisma.$transaction(async tx => {
        const rental = await lockRental(tx, id);
        const invoices = await tx.invoice.findMany({
          where: { rentalAgreementId: id, status: { not: 'void' } },
          select: { periodEnd: true },
        });
        const billing = computeRentalBillingState(rental, invoices);
        const today = rentalToday();

        let through: Date;
        if (rental.status === 'completed') {
          if (billing.isFullyBilled) throw new AppError(409, 'This rental is already fully billed');
          if (!opts.force) throw new AppError(409, 'A closed rental goes to billing on its own once its tickets are approved');
          through = rental.endDate ?? today;
        } else if (rental.status !== 'active') {
          throw new AppError(409, 'Only active rentals can be sent for billing');
        } else {
          // Frozen at the day of the click; never a future date.
          through = today;
          if (through < rental.startDate) throw new AppError(409, 'This rental has not started yet');
          if (billing.lastBilledThrough && through <= billing.lastBilledThrough) {
            throw new AppError(409, `Already billed through ${dateKey(billing.lastBilledThrough)}; nothing new to send`);
          }
        }

        if (!opts.force) {
          const tickets = await tx.serviceTicket.findMany({
            where: { linkedRentalAgreementId: id, status: { in: [...RELEASE_BLOCKING_STATUSES] } },
            select: { id: true, ticketNumber: true, status: true, serviceDate: true },
            orderBy: { serviceDate: 'asc' },
          });
          const blockers = blockersFor(tickets, through);
          if (blockers.length) throw new ReleaseBlockedError(blockers);
        }

        await tx.rentalAgreement.update({
          where: { id },
          data: {
            billingReleasedThrough: through,
            billingReleasedAt: new Date(),
            billingReleasedById: opts.userId,
            billingReleaseForceReason: opts.force?.reason ?? null,
          },
        });
        return { id, agreementNumber: rental.agreementNumber, success: true, releasedThrough: dateKey(through) };
      }, { maxWait: 10000, timeout: 30000 }));
    } catch (err) {
      results.push({
        id,
        success: false,
        error: err instanceof Error ? err.message : 'Failed to send for billing',
        ...(err instanceof ReleaseBlockedError
          ? { blockers: err.blockers.map(b => ({ ...b, serviceDate: dateKey(b.serviceDate) })) }
          : {}),
      });
    }
  }
  return results;
}

/** Take back a send that AR has not invoiced yet. */
export async function recallReleases(ids: string[]): Promise<ReleaseResult[]> {
  const results: ReleaseResult[] = [];
  for (const id of [...new Set(ids)]) {
    try {
      results.push(await prisma.$transaction(async tx => {
        const rental = await lockRental(tx, id);
        const invoices = await tx.invoice.findMany({
          where: { rentalAgreementId: id, status: { not: 'void' } },
          select: { periodEnd: true },
        });
        const billing = computeRentalBillingState(rental, invoices);
        if (rentalReleaseState(rental, billing, 0) !== 'released') {
          throw new AppError(409, rental.billingReleasedThrough
            ? 'Already invoiced; void the invoice to take this back'
            : 'This rental has not been sent for billing');
        }
        await tx.rentalAgreement.update({
          where: { id },
          data: { billingReleasedThrough: null, billingReleasedAt: null, billingReleasedById: null, billingReleaseForceReason: null },
        });
        return { id, agreementNumber: rental.agreementNumber, success: true };
      }, { maxWait: 10000, timeout: 30000 }));
    } catch (err) {
      results.push({ id, success: false, error: err instanceof Error ? err.message : 'Failed to recall' });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// The supervisor's list
// ---------------------------------------------------------------------------

export type RentalKind = 'manned' | 'unmanned' | 'non_trailer';

/** Manned / unmanned trailer, or no trailer at all (monitors, other gear). */
export function rentalKind(rental: { composition: unknown; isManned: boolean; pickupType: string }): RentalKind {
  const composition = rental.composition as { trailer?: { manned?: boolean } | null } | null;
  if (composition) return composition.trailer ? (composition.trailer.manned ? 'manned' : 'unmanned') : 'non_trailer';
  // Pre-composition agreements only have the flat flag, which DEFAULTS to
  // manned — so it can't identify a trailer-less rental. A walk-in is counter
  // gear; anything else is taken at the flag's word.
  if (rental.pickupType === 'walk_in') return 'non_trailer';
  return rental.isManned ? 'manned' : 'unmanned';
}

/**
 * Every rental that owes billing, with where it sits in the flow. Feeds the
 * dashboard "Rental Billing" tab. Not paginated: the set is open rentals plus
 * closed-not-yet-final-billed, and the tab filters and searches client-side.
 */
export async function listRentalsForRelease() {
  const candidates = await prisma.rentalAgreement.findMany({
    where: { status: { in: ['active', 'completed'] } },
    select: {
      id: true, agreementNumber: true, status: true, pickupType: true, startDate: true, endDate: true,
      billingCadence: true, billingRateType: true, isManned: true, composition: true, siteId: true,
      billingReleasedThrough: true, billingReleasedAt: true, billingReleaseForceReason: true,
      lastBillReadyNotifiedFor: true,
      ...billingLocationSelect,
      company: { select: { id: true, name: true } },
      site: { select: { id: true, name: true } },
      billingReleasedBy: { select: { id: true, name: true } },
      linkedServiceTickets: {
        where: { status: { in: [...RELEASE_BLOCKING_STATUSES, 'billing_queue'] } },
        select: { id: true, ticketNumber: true, status: true, serviceDate: true, lineItems: { select: { total: true } } },
        orderBy: { serviceDate: 'asc' },
      },
    },
    orderBy: [{ status: 'asc' }, { startDate: 'asc' }],
  });

  const invoices = await prisma.invoice.findMany({
    where: { rentalAgreementId: { in: candidates.map(r => r.id) }, status: { not: 'void' } },
    select: { rentalAgreementId: true, periodEnd: true },
  });
  const invoicesFor = new Map<string, { periodEnd: Date | null }[]>();
  for (const inv of invoices) {
    if (!inv.rentalAgreementId) continue;
    invoicesFor.set(inv.rentalAgreementId, [...(invoicesFor.get(inv.rentalAgreementId) ?? []), { periodEnd: inv.periodEnd }]);
  }

  const today = rentalToday();
  return candidates.flatMap(r => {
    const billing = computeRentalBillingState(r, invoicesFor.get(r.id) ?? []);
    const blockers = blockersFor(r.linkedServiceTickets, r.status === 'completed' ? null : today);
    const state = rentalReleaseState(r, billing, blockers.length);
    if (!state) return [];

    const unbilledFrom = billing.lastBilledThrough ? new Date(+billing.lastBilledThrough + DAY) : r.startDate;
    const unbilledThrough = r.status === 'completed' ? (r.endDate ?? today) : today;
    const approved = r.linkedServiceTickets.filter(t => t.status === 'billing_queue');
    const { linkedServiceTickets: _tickets, composition: _composition, field: _f, pad: _p, well: _w, facility: _fa, ...rest } = r;
    return [{
      ...rest,
      kind: rentalKind(r),
      locationName: billingCardLocation(r),
      padName: r.pad?.name ?? null,
      state,
      lastBilledThrough: billing.lastBilledThrough,
      nextDueDate: billing.nextDueDate,
      unbilledFrom,
      unbilledDays: Math.max(0, Math.round((+unbilledThrough - +unbilledFrom) / DAY) + 1),
      // Past its billing cadence and still not sent — the nag list.
      overdue: state === 'unreleased' && !!billing.nextDueDate && billing.nextDueDate <= today,
      blockers: blockers.map(({ lineItems: _li, ...t }) => t),
      approvedTicketCount: approved.length,
      approvedTicketTotal: approved.reduce((sum, t) => sum + t.lineItems.reduce((s, li) => s + (li.total ? parseFloat(li.total.toString()) : 0), 0), 0),
    }];
  });
}

// ---------------------------------------------------------------------------
// Month-end stragglers (the dashboard "Ready Rentals Not Billed" banner)
// ---------------------------------------------------------------------------

/** Last day of the month before `today`. */
export function priorMonthEnd(today: Date): Date {
  return new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0));
}

/**
 * What is left over from the last completed month. A rental is a straggler
 * while it still has an unbilled day on or before that month-end — so the
 * count appears on the 1st and only falls as invoices are actually cut, not
 * when someone merely looks at it.
 */
export function summarizeReleases(
  rows: Array<{ state: RentalReleaseState; unbilledFrom: Date; overdue: boolean }>,
  today: Date = rentalToday(),
) {
  const cutoff = priorMonthEnd(today);
  const straggler = (r: { unbilledFrom: Date }) => r.unbilledFrom <= cutoff;
  return {
    /** Open, not sent. The field's move. */
    unsent: rows.filter(r => r.state === 'unreleased' && straggler(r)).length,
    /** Closed, waiting on ticket approvals. The field's move. */
    closedBlocked: rows.filter(r => r.state === 'closed_blocked' && straggler(r)).length,
    /** Sent (or closed and clear), not invoiced. AR's move. */
    awaitingInvoice: rows.filter(r => isReadyForBilling(r.state) && straggler(r)).length,
    /** Everything the field should act on today, any month: the tab badge. */
    needsSending: rows.filter(r => r.overdue || r.state === 'closed_blocked').length,
  };
}
