import { describe, expect, it } from 'vitest';
import { billingApprovalPlan, splitBillingApprovals } from './billingApprovalSplit.js';

const profiles = [{ id: 'hse', appliesToTicketTypes: ['inspection'] }, { id: 'sampling', appliesToTicketTypes: ['ih_sampling'] }];
const tickets = [{ id: 't1', ticketType: 'inspection', serviceSubtype: 'ih_h2s',
  customData: { ihSubtypes: ['ih_h2s', 'ih_sampling'] }, updatedAt: new Date('2026-10-21') }];
const lines = [{ lineNumber: 1, sourceTicketId: 't1', sourceTicketLineItemId: 'labor1', description: 'Shared tech time',
  quantity: 4, rate: 100, amount: 400, isTaxable: false }];
const allocation = [{ key: 'labor1', parts: [{ profileId: 'hse', quantity: 1 }, { profileId: 'sampling', quantity: 3 }] }];

describe('billing-only approval splits', () => {
  it('accepts a combined field ticket and asks billing to allocate shared charges', () => {
    const plan = billingApprovalPlan(profiles, tickets, lines);
    expect(plan.requiresReview).toBe(true);
    expect(plan.rows[0].profileIds).toEqual(['hse', 'sampling']);
    expect(tickets[0].customData.ihSubtypes).toEqual(['ih_h2s', 'ih_sampling']);
  });
  it('splits charges by the selected profiles with conserved quantity and cents', () => {
    const plan = billingApprovalPlan(profiles, tickets, lines);
    const parts = splitBillingApprovals(profiles, tickets, lines, allocation, plan.version);
    expect(parts.map(part => [part.billingProfileId, part.lines[0].quantity, part.lines[0].amount]))
      .toEqual([['hse', 1, 100], ['sampling', 3, 300]]);
    expect(parts.every(part => part.lines[0].sourceTicketLineItemId === 'labor1')).toBe(true);
    expect(lines[0].quantity).toBe(4);
  });
  it('automatically partitions single-work tickets without field-tech routing input', () => {
    const single = [{ ...tickets[0], customData: null }, { ...tickets[0], id: 't2', serviceSubtype: 'ih_sampling', customData: null }];
    const source = [lines[0], { ...lines[0], sourceTicketId: 't2', sourceTicketLineItemId: 'labor2', lineNumber: 2 }];
    expect(billingApprovalPlan(profiles, single, source).requiresReview).toBe(false);
    expect(splitBillingApprovals(profiles, single, source).map(part => part.billingProfileId)).toEqual(['hse', 'sampling']);
  });
  it.each([0, 2, 5])('rejects omitted or overallocated quantity %s', quantity => {
    const plan = billingApprovalPlan(profiles, tickets, lines);
    expect(() => splitBillingApprovals(profiles, tickets, lines, [{ key: 'labor1', parts: [{ profileId: 'sampling', quantity }] }], plan.version)).toThrow();
  });
  it('rejects stale previews, duplicate rows and foreign approval profiles', () => {
    const plan = billingApprovalPlan(profiles, tickets, lines);
    expect(() => splitBillingApprovals(profiles, tickets, [{ ...lines[0], rate: 110, amount: 440 }], allocation, plan.version)).toThrow('changed');
    expect(() => splitBillingApprovals(profiles, tickets, lines, [...allocation, ...allocation], plan.version)).toThrow('duplicate');
    expect(() => splitBillingApprovals(profiles, tickets, lines, [{ key: 'labor1', parts: [{ profileId: 'foreign', quantity: 4 }] }], plan.version)).toThrow('Invalid approval group');
  });
  it('cannot silently send an unallocated shared charge to the first profile', () => {
    expect(() => splitBillingApprovals(profiles, tickets, lines)).toThrow('ticket approval');
  });
  it('keeps a combined visit on one invoice when approval defaults do not differ', () => {
    expect(splitBillingApprovals([profiles[0]], tickets, lines)).toHaveLength(1);
  });
  it('conserves pennies when splitting fractional quantities', () => {
    const source = [{ ...lines[0], quantity: 0.03, rate: 0.67, amount: 0.02 }];
    const plan = billingApprovalPlan(profiles, tickets, source);
    const result = splitBillingApprovals(profiles, tickets, source, [{ key: 'labor1', parts: [
      { profileId: 'hse', quantity: 0.01 }, { profileId: 'sampling', quantity: 0.02 },
    ] }], plan.version);
    expect(result.reduce((sum, part) => sum + Math.round(part.lines[0].amount * 100), 0)).toBe(2);
    expect(result.every(part => part.lines[0].amount >= 0)).toBe(true);
  });
});
