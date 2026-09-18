/**
 * WI-08 — paid at drop.
 *
 * The claim under test is that billing exemption is DERIVED from money actually
 * collected, not from a flag. That is what makes the overage path fall out of
 * the shape instead of being a second feature: the same comparison that lets a
 * paid ticket skip the queue sends a ticket that outgrew its payment into it.
 */

import { describe, it, expect } from 'vitest';
import {
  attribution,
  billingRoute,
  collectedCcFees,
  collectedTotal,
  isBillingExempt,
  toNumber,
} from './paidAtDrop.js';

const WHEN = new Date('2026-08-31T15:00:00Z');

function pay(overrides: Partial<Parameters<typeof collectedTotal>[0][number]> = {}) {
  return {
    amount: 142,
    status: 'succeeded',
    paymentMethod: 'credit_card',
    stripeChargeId: 'ch_123',
    stripeReceiptUrl: null,
    cardLast4: '4242',
    cardBrand: 'visa',
    createdAt: WHEN,
    ...overrides,
  };
}

const order = (total: unknown, via: 'stripe' | 'lightspeed' | null = 'stripe', txn?: string) =>
  ({ total, paidAtDropVia: via, lightspeedTxnNumber: txn ?? null });

describe('toNumber', () => {
  it('handles the shapes a Decimal column arrives as', () => {
    expect(toNumber(142)).toBe(142);
    expect(toNumber('142.50')).toBe(142.5);
    expect(toNumber({ toString: () => '99.99' })).toBe(99.99);
  });

  it('treats null and nonsense as zero rather than NaN', () => {
    // A NaN would poison every comparison downstream and silently make a
    // ticket exempt.
    expect(toNumber(null)).toBe(0);
    expect(toNumber(undefined)).toBe(0);
    expect(toNumber('not money')).toBe(0);
  });
});

describe('collectedTotal', () => {
  it('counts only succeeded payments', () => {
    // A pending intent is a customer part-way through typing a card number.
    // Counting it would let a ticket skip billing because a form was opened.
    expect(collectedTotal([
      pay({ amount: 100 }),
      pay({ amount: 50, status: 'pending' }),
      pay({ amount: 25, status: 'failed' }),
    ])).toBe(100);
  });

  it('sums multiple settled payments', () => {
    expect(collectedTotal([pay({ amount: 100 }), pay({ amount: 42 })])).toBe(142);
  });

  it('is zero for no payments', () => {
    expect(collectedTotal([])).toBe(0);
  });
});

describe('billingRoute', () => {
  it('sends an unpaid ticket down the standard path', () => {
    expect(billingRoute(order(142, null), [])).toEqual({ route: 'standard', amountDue: 142 });
  });

  it('exempts a ticket paid in full', () => {
    expect(billingRoute(order(142), [pay({ amount: 142 })]))
      .toEqual({ route: 'exempt', collected: 142 });
  });

  it('routes the DELTA when work was added after payment', () => {
    // The overage path, and the reason exemption is derived: the customer paid
    // the flat cal rate, then the monitor needed a sensor.
    expect(billingRoute(order(210), [pay({ amount: 142 })]))
      .toEqual({ route: 'overage', collected: 142, amountDue: 68 });
  });

  it('does not re-enter the queue over a half-cent of rounding', () => {
    // Totals and card charges are rounded to cents by different code. A ticket
    // must not be billed for a penny because of it.
    expect(billingRoute(order(142.004), [pay({ amount: 142 })]).route).toBe('exempt');
  });

  it('DOES enter the queue for a real cent', () => {
    const r = billingRoute(order(143), [pay({ amount: 142 })]);
    expect(r.route).toBe('overage');
    expect(r).toMatchObject({ amountDue: 1 });
  });

  it('exempts on a Lightspeed reference, which has no Payment row by design', () => {
    // The money went through the POS; ServicePRO never sees it. The reference
    // is the only evidence, so it is what carries the exemption.
    expect(billingRoute(order(142, 'lightspeed', 'LS-4471'), []))
      .toEqual({ route: 'exempt', collected: 0 });
  });

  it('does NOT exempt a lightspeed flag with no reference typed', () => {
    // The flag says which door the money came through. It never asserts it
    // arrived — and a half-filled form must not skip billing.
    expect(billingRoute(order(142, 'lightspeed'), []).route).toBe('standard');
  });

  it('does not exempt a stripe-flagged ticket whose payment never settled', () => {
    expect(billingRoute(order(142), [pay({ status: 'pending' })]).route).toBe('standard');
  });

  it('exempts a ticket paid over its total rather than billing a negative', () => {
    expect(billingRoute(order(100), [pay({ amount: 142 })]).route).toBe('exempt');
  });

  it('treats a null total as nothing owed once anything was paid', () => {
    expect(billingRoute(order(null), [pay({ amount: 142 })]).route).toBe('exempt');
  });
});

describe('isBillingExempt', () => {
  it('agrees with billingRoute', () => {
    expect(isBillingExempt(order(142), [pay({ amount: 142 })])).toBe(true);
    expect(isBillingExempt(order(210), [pay({ amount: 142 })])).toBe(false);
    expect(isBillingExempt(order(142, null), [])).toBe(false);
  });
});

describe('attribution', () => {
  it('names the card and the Stripe reference', () => {
    const line = attribution(order(142), [pay({ amount: 142 })])!;
    expect(line).toContain('Paid $142.00');
    expect(line).toContain('Visa ····4242');
    expect(line).toContain('Stripe ref ch_123');
  });

  it('sums multiple payments but dates from the latest', () => {
    const later = new Date('2026-09-02T15:00:00Z');
    const line = attribution(order(200), [
      pay({ amount: 142, createdAt: WHEN }),
      pay({ amount: 58, createdAt: later, cardLast4: '1111', cardBrand: 'amex' }),
    ])!;
    expect(line).toContain('Paid $200.00');
    expect(line).toContain('Amex ····1111');
  });

  it('reports a Lightspeed txn WITHOUT claiming an amount', () => {
    // ServicePRO does not know what Lightspeed collected. Printing the ticket
    // total here would be asserting a settlement it has never seen — the exact
    // thing WI-08's attribution rule forbids.
    const line = attribution(order(142, 'lightspeed', 'LS-4471'), [])!;
    expect(line).toContain('LS-4471');
    expect(line).not.toContain('142');
    expect(line).toContain('recorded in Lightspeed');
  });

  it('says nothing when nothing was collected', () => {
    expect(attribution(order(142, null), [])).toBeNull();
    expect(attribution(order(142), [pay({ status: 'pending' })])).toBeNull();
  });

  it('always attributes — never states payment as ServicePRO fact', () => {
    // Every non-null attribution names its source. If this ever fails,
    // ServicePRO has started asserting accounting facts on its own authority.
    const stripeLine = attribution(order(142), [pay()])!;
    const lsLine = attribution(order(142, 'lightspeed', 'LS-1'), [])!;
    expect(/Stripe|Visa|CC|credit_card/.test(stripeLine)).toBe(true);
    expect(/Lightspeed/.test(lsLine)).toBe(true);
  });
});


/**
 * The card surcharge, and why it is not the customer's money.
 *
 * Once a counter payment reduces the handoff balance, anything counted as
 * "collected" is work the customer never pays for again. The convenience fee
 * went to the card network, so counting it would hand the surcharge back as
 * free labour -- quietly, on an invoice nobody re-checks.
 */
describe('the card surcharge is charged but never credited', () => {
  it('credits the work portion, not the whole charge', () => {
    // $150 toward the job, $6 surcharge: Stripe took $156.
    const p = pay({ amount: 156, ccFeeAmount: 6 });
    expect(collectedTotal([p])).toBe(150);
    expect(collectedCcFees([p])).toBe(6);
  });

  it('leaves a job still owing the surcharge-sized gap', () => {
    // The regression this guards: with the fee credited, a $150 job paid with a
    // $156 charge would read as $6 OVERPAID and settle. It is exactly paid.
    const r = billingRoute(order(150), [pay({ amount: 156, ccFeeAmount: 6 })]);
    expect(r.route).toBe('exempt');
    expect(r.route === 'exempt' && r.collected).toBe(150);
  });

  it('bills the true delta when the work grows past the deposit', () => {
    const r = billingRoute(order(200), [pay({ amount: 156, ccFeeAmount: 6 })]);
    expect(r.route).toBe('overage');
    // $50, not the $44 a fee-inclusive credit would have produced.
    expect(r.route === 'overage' && r.amountDue).toBe(50);
  });

  it('reads a fee-less payment exactly as before', () => {
    // Every payment written before the column existed has null here, and must
    // keep crediting its full amount.
    expect(collectedTotal([pay({ amount: 142 })])).toBe(142);
    expect(collectedTotal([pay({ amount: 142, ccFeeAmount: null })])).toBe(142);
    expect(collectedCcFees([pay({ amount: 142 })])).toBe(0);
  });

  it('only counts surcharges on settled payments', () => {
    expect(collectedCcFees([pay({ status: 'pending', ccFeeAmount: 6 })])).toBe(0);
  });

  it('names the fee separately rather than folding it into the figure', () => {
    // Someone reconciling this line against a Stripe payout needs both numbers.
    const line = attribution(order(150), [pay({ amount: 156, ccFeeAmount: 6 })])!;
    expect(line).toContain('$150.00');
    expect(line).toContain('$6.00 card fee');
  });

  it('says nothing about a fee when none was taken', () => {
    expect(attribution(order(142), [pay()])!).not.toContain('card fee');
  });
});

/**
 * Ringing up an arbitrary amount at the counter.
 *
 * The panel used to charge `data.total` and disable itself when that was zero,
 * which is every monitor at drop-off: nothing is priced until the tech opens
 * it. These are the shapes that produces.
 */
describe('a deposit taken before the work is priced', () => {
  it('a deposit against an as-yet-unpriced order is an overpayment, not a debt', () => {
    // Total $0 because no unit has cleared its 48h window yet.
    const r = billingRoute(order(0), [pay({ amount: 150, ccFeeAmount: 0 })]);
    expect(r.route).toBe('exempt');
  });

  it('the same deposit becomes an overage once the work is priced above it', () => {
    const payments = [pay({ amount: 150, ccFeeAmount: 0 })];
    expect(billingRoute(order(0), payments).route).toBe('exempt');
    // The tech opens it and it needs a sensor.
    const grown = billingRoute(order(325), payments);
    expect(grown.route).toBe('overage');
    expect(grown.route === 'overage' && grown.amountDue).toBe(175);
    expect(isBillingExempt(order(325), payments)).toBe(false);
  });

  it('sums multiple counter payments, each net of its own fee', () => {
    // A deposit at drop-off, then the balance at handoff.
    const payments = [
      pay({ amount: 104, ccFeeAmount: 4, stripeChargeId: 'ch_a' }),
      pay({ amount: 208, ccFeeAmount: 8, stripeChargeId: 'ch_b' }),
    ];
    expect(collectedTotal(payments)).toBe(300);
    expect(billingRoute(order(300), payments).route).toBe('exempt');
  });
});
