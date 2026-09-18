/**
 * paidAtDrop.ts — WI-08: money collected at the counter, and what it means.
 *
 * A monitor calibration is paid when the customer hands the unit over at the
 * shop counter. The work order must never reach billing as an unpaid job,
 * because there is nothing left to bill.
 *
 * ── EXEMPTION IS DERIVED, NOT DECLARED ───────────────────────────────────
 *
 * The obvious implementation is a `billingExempt` boolean set when payment is
 * taken. It is wrong for one reason: work gets added afterwards. The customer
 * pays the flat cal rate, the tech opens the monitor, and it needs a sensor.
 * A boolean set at 9am is still true at noon and the order silently never
 * bills the difference.
 *
 * So the work order records only WHICH counter path collected the money, and this
 * module answers "does it still cover the work?" by comparing what was actually
 * collected against the current total. An order that grows past its payment
 * becomes billable again on its own, for the delta, with nobody remembering to
 * clear a flag. That is the WI-08 overage path falling out of the shape rather
 * than being a second code path bolted beside it.
 *
 * ── SERVICEPRO DOES NOT ASSERT THAT MONEY MOVED ──────────────────────────
 *
 * §2 again: the QB receipt is the accounting fact; the ServicePRO record is a
 * REPORT of it, with the source named. Stripe payments carry their own proof
 * (a PaymentIntent that Stripe says succeeded). A Lightspeed reference does
 * not -- it is a number a person typed off a POS slip, and this module treats
 * it as exactly that: a pointer that makes the manual re-key reconcilable, not
 * evidence of settlement. Hence `attribution()`, which always says where the
 * claim came from.
 */

import type { PaidAtDropMethod } from '../db.js';

/**
 * What this module needs to know about the thing that was paid for.
 *
 * A ShopWorkOrder today — monitor calibration is shop work, arriving as an item
 * with `serviceType: 'calibrate'`. Kept as a structural type rather than the
 * Prisma model so the same rules apply unchanged if counter payment is ever
 * wanted on a ServiceTicket, which carries the identical three fields.
 */
export interface PaidAtDropSubject {
  total: unknown;
  paidAtDropVia: PaidAtDropMethod | null;
  lightspeedTxnNumber?: string | null;
}

/** A settled payment against that thing, as far as this module cares. */
export interface CountedPayment {
  amount: unknown; // Prisma Decimal | number | string
  /**
   * The card surcharge inside `amount`, if any. Excluded from what counts
   * against the work -- see collectedTotal.
   */
  ccFeeAmount?: unknown;
  status: string;
  paymentMethod: string;
  stripeChargeId?: string | null;
  stripeReceiptUrl?: string | null;
  cardLast4?: string | null;
  cardBrand?: string | null;
  createdAt: Date;
}

export function toNumber(v: unknown): number {
  if (v == null) return 0;
  const n = typeof v === 'number' ? v : Number(String(v));
  return Number.isFinite(n) ? n : 0;
}

/**
 * What has actually been collected TOWARD THE WORK on this order.
 *
 * Only `succeeded` counts. A pending PaymentIntent is a customer part-way
 * through typing a card number, and treating that as money would let an order
 * skip billing because somebody opened a payment form.
 *
 * The card surcharge is subtracted, and that is not a rounding detail. Once a
 * counter payment reduces what is owed at handoff, every dollar this function
 * returns is a dollar the customer does not pay again. The convenience fee went
 * to the card network; counting it here would quietly refund the surcharge to
 * the customer as free labour on the final invoice. `amount` stays the figure
 * Stripe actually charged -- it has to, it is what reconciles against the
 * deposit -- so the split is carried alongside it rather than netted out of it.
 */
export function collectedTotal(payments: CountedPayment[]): number {
  return payments
    .filter((p) => p.status === 'succeeded')
    .reduce((sum, p) => sum + toNumber(p.amount) - toNumber(p.ccFeeAmount), 0);
}

/** Surcharge collected across settled payments. Reported, never credited. */
export function collectedCcFees(payments: CountedPayment[]): number {
  return payments
    .filter((p) => p.status === 'succeeded')
    .reduce((sum, p) => sum + toNumber(p.ccFeeAmount), 0);
}

export type BillingRoute =
  /** Nothing was collected at drop; the ordinary path. */
  | { route: 'standard'; amountDue: number }
  /** Paid in full at the counter. Does not enter the billing queue. */
  | { route: 'exempt'; collected: number }
  /** Paid at the counter, then the work grew. Bills the DELTA only. */
  | { route: 'overage'; collected: number; amountDue: number };

/**
 * Where this order should go.
 *
 * The three-way answer is the whole feature. Note that `standard` is returned
 * whenever no counter payment was taken, regardless of the flag: an order
 * marked `paidAtDropVia: 'lightspeed'` whose reference was typed but whose
 * total is unpaid is not exempt from anything. The flag says which door the
 * money came through, never that it arrived.
 */
export function billingRoute(
  order: PaidAtDropSubject,
  payments: CountedPayment[],
): BillingRoute {
  const total = round2(toNumber(order.total));
  const collected = round2(collectedTotal(payments));

  // Lightspeed is settled OUTSIDE ServicePRO -- the money went through the POS
  // and there is no Payment row for it, by design. The reference number is the
  // only evidence, so it is what makes the order exempt. This is the one place
  // ServicePRO takes a human's word, and it does so explicitly rather than by
  // failing to notice.
  if (order.paidAtDropVia === 'lightspeed' && order.lightspeedTxnNumber) {
    return { route: 'exempt', collected };
  }

  if (collected <= 0) return { route: 'standard', amountDue: total };

  const due = round2(total - collected);
  // A tolerance, not an equality test. Totals and card charges are both money
  // rounded to cents by different code; a half-cent of drift must not make a
  // fully-paid order billable for one penny.
  if (due <= 0.005) return { route: 'exempt', collected };

  return { route: 'overage', collected, amountDue: due };
}

/** True when this order carries no balance and should not be billed. */
export function isBillingExempt(
  order: PaidAtDropSubject,
  payments: CountedPayment[],
): boolean {
  return billingRoute(order, payments).route === 'exempt';
}

/**
 * The line the billing card shows: "Paid $142.00 via Visa ····4242 on 8/31/2026".
 *
 * ATTRIBUTED, ALWAYS. ServicePRO is reporting what a payment processor told it,
 * not asserting a fact of its own, and the phrasing should make that obvious to
 * whoever reads it six weeks later while looking at a reduced amount due and
 * wondering why.
 */
export function attribution(
  order: Pick<PaidAtDropSubject, 'paidAtDropVia' | 'lightspeedTxnNumber'>,
  payments: CountedPayment[],
): string | null {
  const settled = payments.filter((p) => p.status === 'succeeded');

  if (settled.length > 0) {
    const total = round2(collectedTotal(settled));
    const latest = settled.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
    const when = latest.createdAt.toLocaleDateString('en-US');
    const card = latest.cardBrand && latest.cardLast4
      ? ` via ${titleCase(latest.cardBrand)} ····${latest.cardLast4}`
      : latest.paymentMethod === 'credit_card' ? ' via CC' : ` via ${latest.paymentMethod}`;
    const ref = latest.stripeChargeId ? ` — Stripe ref ${latest.stripeChargeId}` : '';
    // The surcharge is named separately rather than folded into the figure.
    // `total` is what came off the job; the card was charged more than that,
    // and someone reconciling this line against a Stripe payout needs to see
    // both numbers rather than wonder which one they are looking at.
    const fees = round2(collectedCcFees(settled));
    const fee = fees > 0 ? ` (+$${fees.toFixed(2)} card fee)` : '';
    return `Paid $${total.toFixed(2)}${fee}${card} on ${when}${ref}`;
  }

  if (order.paidAtDropVia === 'lightspeed' && order.lightspeedTxnNumber) {
    // No amount: ServicePRO does not know it, and inventing one from the
    // order total would be asserting a settlement it has not seen.
    return `Paid at counter — Lightspeed txn ${order.lightspeedTxnNumber} (amount recorded in Lightspeed)`;
  }

  return null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
