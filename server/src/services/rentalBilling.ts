/**
 * rentalBilling.ts — single source of truth for "what's billed, what's due"
 * on a RentalAgreement. Used by the manual Billing page (invoices.ts
 * /uninvoiced/rentals), the linked-invoices "fully billed" badge, and the
 * rentalBillReadyWatcher notification job — all three must agree, or staff
 * see one answer on the Billing page and a different one on the agreement.
 */

import type { RentalRateType } from '../db.js';

export interface RentalBillingState {
  /** Latest non-void invoice's periodEnd for this agreement, or null if never billed. */
  lastBilledThrough: Date | null;
  /** True only for a completed agreement billed through its endDate. Active
   *  agreements are never "fully" billed while still ongoing. */
  isFullyBilled: boolean;
  /** When the next invoice is due. Completed-and-not-fully-billed uses the
   *  agreement's endDate (the final bill was already due); active uses
   *  end of the first unbilled calendar month for monthly billing, otherwise one cadence step.
   *  Null once fully billed, or for statuses that never bill (scheduled/cancelled). */
  nextDueDate: Date | null;
}

function addCadenceStep(d: Date, cadence: RentalRateType): Date {
  const next = new Date(d);
  if (cadence === 'daily') next.setUTCDate(next.getUTCDate() + 1);
  else if (cadence === 'weekly') next.setUTCDate(next.getUTCDate() + 7);
  else {
    const day = next.getUTCDate();
    next.setUTCDate(1);
    next.setUTCMonth(next.getUTCMonth() + 1);
    const lastDay = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
    next.setUTCDate(Math.min(day, lastDay));
  }
  return next;
}

export function computeRentalBillingState(
  agreement: { status: string; startDate: Date; endDate: Date | null; billingCadence: RentalRateType },
  /** Non-void invoices for this agreement — filter status !== 'void' before calling. */
  invoices: { periodEnd: Date | null }[],
): RentalBillingState {
  let lastBilledThrough: Date | null = null;
  for (const inv of invoices) {
    if (inv.periodEnd && (!lastBilledThrough || inv.periodEnd > lastBilledThrough)) {
      lastBilledThrough = inv.periodEnd;
    }
  }

  const isCompleted = agreement.status === 'completed';
  const isFullyBilled =
    isCompleted &&
    !!lastBilledThrough &&
    (!agreement.endDate || lastBilledThrough >= agreement.endDate);

  let nextDueDate: Date | null = null;
  if (isCompleted) {
    nextDueDate = isFullyBilled ? null : agreement.endDate;
  } else if (agreement.status === 'active') {
    const base = lastBilledThrough || agreement.startDate;
    if (agreement.billingCadence === 'monthly') {
      const firstUnbilled = lastBilledThrough ? new Date(+lastBilledThrough + 86400000) : base;
      nextDueDate = new Date(Date.UTC(firstUnbilled.getUTCFullYear(), firstUnbilled.getUTCMonth() + 1, 0));
    } else nextDueDate = addCadenceStep(base, agreement.billingCadence);
  }

  return { lastBilledThrough, isFullyBilled, nextDueDate };
}

/**
 * Whether an agreement gets the zero-quantity Delivery/Pickup template lines
 * (mileage + labor) seeded onto its first/last invoice.
 *
 * Dispatch means a truck rolls: a tech drives the gear out and drives back for
 * it. Both trips are real billable work, and the $0 rows exist so whoever
 * finishes the invoice has somewhere to put the miles and hours.
 *
 * Walk-in means the customer carried it off the counter themselves. Nobody
 * drove anywhere, so those four rows can never be anything but $0 — they just
 * pad a two-line counter invoice out to six and invite "why is this free?".
 * A personal gas monitor is almost always a walk-in, which is why the counter
 * invoices were the ones showing the dead lines.
 *
 * An unset pickup type reads as dispatch, matching the column default: a
 * stray $0 row someone deletes is cheaper than a delivery nobody bills.
 */
export function seedsDeliveryPickupLines(
  agreement: { pickupType?: string | null },
): boolean {
  return agreement.pickupType !== 'walk_in';
}
