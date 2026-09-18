import { describe, it, expect } from 'vitest';
import {
  resolveInvoiceRules,
  resolvePriceLevelRate,
  type BillingRuleContext,
  type BillingRulePriceLevel,
  type BillingRuleTicketContext,
} from './billingRules.js';

// Minimal context — rule 5A only reads ticket pad/well tier1 and the line
// amounts. No price levels, so nothing adjusts the rates underneath it.
function ctx(tickets: BillingRuleTicketContext[], amounts: number[] = [1000]): BillingRuleContext {
  return {
    invoiceCompanyId: 'co-1',
    invoiceCompanyName: 'Chord Energy LLC',
    tickets,
    lineItems: amounts.map(amount => ({ rate: amount, quantity: 1, amount })),
  };
}

const ticket = (over: Partial<BillingRuleTicketContext> = {}): BillingRuleTicketContext => ({
  id: over.id ?? 't1',
  ticketNumber: over.ticketNumber ?? 'T-1',
  pad: over.pad ?? null,
  well: over.well ?? null,
});

const TIER1 = 'tier1_reservation_fee';

describe('rule 5A — Tier 1 reservation fee fires on pad OR well', () => {
  it('fires on a tier1 pad (the original behaviour)', () => {
    const r = resolveInvoiceRules(ctx([ticket({ pad: { id: 'p1', tier1: true } })]));
    expect(r.appliedRules).toContain(TIER1);
    expect(r.extraLines).toHaveLength(1);
    expect(r.extraLines[0]!.amount).toBe(50); // 5% of 1000
  });

  // The reason this rule was widened: 2877 of 2886 wells have no pad, so a
  // pad-only check silently skipped the fee on nearly all reservation work.
  it('fires on a tier1 well with no pad at all', () => {
    const r = resolveInvoiceRules(ctx([ticket({ well: { id: 'w1', tier1: true } })]));
    expect(r.appliedRules).toContain(TIER1);
    expect(r.extraLines).toHaveLength(1);
    expect(r.extraLines[0]!.amount).toBe(50);
  });

  it('does not fire when neither pad nor well is flagged', () => {
    const r = resolveInvoiceRules(ctx([
      ticket({ pad: { id: 'p1', tier1: false }, well: { id: 'w1', tier1: false } }),
    ]));
    expect(r.appliedRules).not.toContain(TIER1);
    expect(r.extraLines).toHaveLength(0);
    expect(r.qbCustomerOverride).toBeNull();
  });

  it('does not fire when the ticket carries no location at all', () => {
    const r = resolveInvoiceRules(ctx([ticket()]));
    expect(r.appliedRules).not.toContain(TIER1);
    expect(r.extraLines).toHaveLength(0);
  });

  // A Tier 1 well sitting under a Tier 1 pad is the normal case once pads
  // get built for reservation sites — it must not double-charge.
  it('adds exactly one fee line when both pad and well are flagged', () => {
    const r = resolveInvoiceRules(ctx([
      ticket({ pad: { id: 'p1', tier1: true }, well: { id: 'w1', tier1: true } }),
    ]));
    expect(r.extraLines).toHaveLength(1);
    expect(r.extraLines[0]!.amount).toBe(50);
  });

  it('adds one fee line across several qualifying tickets, on the whole subtotal', () => {
    const r = resolveInvoiceRules(ctx(
      [
        ticket({ id: 't1', well: { id: 'w1', tier1: true } }),
        ticket({ id: 't2', pad: { id: 'p2', tier1: true } }),
        ticket({ id: 't3' }),
      ],
      [1000, 500, 500],
    ));
    expect(r.extraLines).toHaveLength(1);
    expect(r.extraLines[0]!.amount).toBe(100); // 5% of 2000
    expect(r.extraLines[0]!.notes).toContain('2 Tier 1 tickets');
  });

  it('flips the QB customer to Pale Horse and keeps the fee line out of QB', () => {
    const r = resolveInvoiceRules(ctx([ticket({ well: { id: 'w1', tier1: true } })]));
    expect(r.qbCustomerOverride).toBe('Pale Horse Service Inc');
    expect(r.extraLines[0]!.qbSkip).toBe(true);
    expect(r.extraLines[0]!.isTaxable).toBe(false);
  });

  it('excludes qbSkip lines from the subtotal the fee is taken on', () => {
    const base = ctx([ticket({ well: { id: 'w1', tier1: true } })], [1000]);
    const r = resolveInvoiceRules({
      ...base,
      lineItems: [...base.lineItems, { rate: 400, quantity: 1, amount: 400, qbSkip: true }],
    });
    expect(r.extraLines[0]!.amount).toBe(50); // 5% of 1000, not of 1400
  });

  it('skips the fee entirely when there is nothing billable to take it from', () => {
    const r = resolveInvoiceRules(ctx([ticket({ well: { id: 'w1', tier1: true } })], [0]));
    expect(r.appliedRules).not.toContain(TIER1);
    expect(r.extraLines).toHaveLength(0);
  });
});


// ─────────────────────────────────────────────────────────────────────────
// Price Levels. These same rules now run on the DEVICE too, at the moment a
// line is added — client/src/lib/priceLevels.ts is a hand-kept mirror of
// resolvePriceLevelRate. The cases below are the contract both copies owe:
// change one and this file should tell you the other needs changing.
// ─────────────────────────────────────────────────────────────────────────

const CONOCO: BillingRulePriceLevel = {
  id: 'pl-conoco',
  name: 'Conoco',
  items: [
    { qbItemListId: 'item-451', customPrice: 175, adjustPercent: null },
    { qbItemListId: 'item-406', customPrice: 85, adjustPercent: null },
  ],
};

const TEN_OFF: BillingRulePriceLevel = {
  id: 'pl-ten-off',
  name: 'Ten Off Everything',
  items: [{ qbItemListId: '*', customPrice: null, adjustPercent: -10 }],
};

describe('resolvePriceLevelRate — the shared quote/bill resolver', () => {
  it('replaces the rate with the negotiated flat price', () => {
    expect(resolvePriceLevelRate([CONOCO], 'item-451', 250))
      .toEqual({ rate: 175, source: 'price_level:Conoco', priceLevelName: 'Conoco' });
  });

  it('scales the list rate by a whole-level percentage', () => {
    expect(resolvePriceLevelRate([TEN_OFF], 'item-999', 250)?.rate).toBe(225);
  });

  it('prefers a per-item rule over the whole-level percentage', () => {
    const both: BillingRulePriceLevel = { ...CONOCO, items: [...CONOCO.items, ...TEN_OFF.items] };
    expect(resolvePriceLevelRate([both], 'item-451', 250)?.rate).toBe(175);
  });

  it('returns null — meaning list price stands, not free — when nothing matches', () => {
    expect(resolvePriceLevelRate([CONOCO], 'item-unmapped', 250)).toBeNull();
  });

  it('returns null when the line has no QB ListID to match on', () => {
    // This is exactly why a shop WO used to bill at list: the WO invoice route
    // built every line with qbItemListId: null, so no contract could ever
    // attach to one. Resolving needs the key.
    expect(resolvePriceLevelRate([CONOCO], null, 250)).toBeNull();
  });
});

describe('rule 5C — price levels applied through resolveInvoiceRules', () => {
  const priced = (lineItems: BillingRuleContext['lineItems']): BillingRuleContext => ({
    invoiceCompanyId: 'co-1',
    invoiceCompanyName: 'ConocoPhillips',
    tickets: [ticket()],
    lineItems,
    priceLevels: [CONOCO],
  });

  it('adjusts a mapped line and leaves an unmapped one at list', () => {
    const r = resolveInvoiceRules(priced([
      { qbItemListId: 'item-451', rate: 250, quantity: 2, amount: 500 },
      { qbItemListId: null, partNumber: '999', rate: 40, quantity: 1, amount: 40 },
    ]));
    expect(r.appliedRules).toContain('price_level_apply');
    expect(r.lineAdjustments).toEqual([
      { index: 0, newRate: 175, newAmount: 350, source: 'price_level:Conoco' },
    ]);
  });

  it('takes the Tier 1 fee on the POST-contract subtotal', () => {
    const base = priced([{ qbItemListId: 'item-451', rate: 250, quantity: 1, amount: 250 }]);
    const r = resolveInvoiceRules({
      ...base,
      tickets: [ticket({ well: { id: 'w1', tier1: true } })],
    });
    // 5% of the contracted 175, not of the 250 list.
    expect(r.extraLines[0]!.amount).toBe(8.75);
  });
});
