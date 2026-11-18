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

describe('Tier 1 routes to Pale Horse without an upcharge', () => {
  it.each([
    { pad: { id: 'p1', tier1: true } },
    { well: { id: 'w1', tier1: true } },
    { pad: { id: 'p1', tier1: true }, well: { id: 'w1', tier1: true } },
  ])('routes a qualifying site: %j', location => {
    const input = ctx([ticket(location)]);
    const before = JSON.stringify(input);
    const result = resolveInvoiceRules(input);
    expect(result.qbCustomerOverride).toBe('Pale Horse Service Inc');
    expect(result.appliedRules).toContain('tier1_customer_override');
    expect(result.extraLines).toEqual([]);
    expect(result.lineAdjustments).toEqual([]);
    expect(JSON.stringify(input)).toBe(before);
  });
  it.each([{}, { pad: { id: 'p1', tier1: false }, well: { id: 'w1', tier1: false } }])(
    'preserves ordinary customer billing: %j', location => {
      const result = resolveInvoiceRules(ctx([ticket(location)]));
      expect(result.qbCustomerOverride).toBeNull();
      expect(result.extraLines).toEqual([]);
      expect(result.appliedRules).not.toContain('tier1_customer_override');
    });
  it.each([{ amounts: [0] }, { amounts: [1000, 500, 500] }])('does not depend on subtotal: %j', ({ amounts }) => {
    const result = resolveInvoiceRules(ctx([ticket({ well: { id: 'w1', tier1: true } }), ticket()], amounts));
    expect(result.qbCustomerOverride).toBe('Pale Horse Service Inc');
    expect(result.extraLines).toEqual([]);
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

  it('preserves negotiated rates while routing Tier 1 to Pale Horse', () => {
    const base = priced([{ qbItemListId: 'item-451', rate: 250, quantity: 1, amount: 250 }]);
    const r = resolveInvoiceRules({
      ...base,
      tickets: [ticket({ well: { id: 'w1', tier1: true } })],
    });
    expect(r.lineAdjustments[0]!.newAmount).toBe(175);
    expect(r.extraLines).toEqual([]);
    expect(r.qbCustomerOverride).toBe('Pale Horse Service Inc');
  });
});
