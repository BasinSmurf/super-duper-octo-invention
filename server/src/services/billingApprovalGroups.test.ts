import { describe, expect, it } from 'vitest';
import { selectBillingProfile } from './billingProfileSelector.js';
import { assertSingleApprovalGroup, invoiceApprovalProfile, profileForBillingWork } from './billingApprovalGroups.js';

const profiles = [
  { id: 'hse', appliesToTicketTypes: ['inspection', 'field_service'], isActive: true },
  { id: 'sampling', appliesToTicketTypes: ['ih_sampling'], isActive: true },
];
const sampling = { ticketType: 'inspection', serviceSubtype: 'ih_sampling' };
const hse = { ticketType: 'inspection', serviceSubtype: 'ih_h2s' };

describe('IH approval destinations', () => {
  it('prefers Sampling scope over general Inspection regardless of profile order', () => {
    for (const list of [profiles, [...profiles].reverse()]) {
      expect(selectBillingProfile(list, sampling)?.id).toBe('sampling');
      expect(selectBillingProfile(list, hse)?.id).toBe('hse');
    }
  });
  it('does not select a Sampling-only profile for other work', () => {
    expect(selectBillingProfile([profiles[1]], hse)).toBeNull();
  });
  it('reselects when a legacy generic ticket becomes Sampling', () => {
    expect(profileForBillingWork(profiles, { ...sampling, billingProfileId: 'hse' })?.id).toBe('sampling');
  });
  it('rejects combined Sampling/HSE metadata and legacy IH records when approval profiles differ', () => {
    expect(() => assertSingleApprovalGroup(profiles, { ...hse,
      customData: { ihSubtypes: ['ih_h2s', 'ih_sampling'] } })).toThrow('allocation during ticket approval');
    expect(() => assertSingleApprovalGroup(profiles, { ...sampling,
      ihTestRecords: [{ testType: 'ih_h2s' }] })).toThrow('allocation during ticket approval');
  });
  it('retains combined IH work when all work shares one approval group', () => {
    expect(() => assertSingleApprovalGroup([profiles[0]], { ...hse,
      customData: { ihSubtypes: ['ih_h2s', 'ih_sampling'] } })).not.toThrow();
  });
  it('rejects a cross-group invoice while allowing multiple Sampling tickets', () => {
    expect(() => invoiceApprovalProfile(profiles, [sampling, hse])).toThrow('separate invoice');
    expect(invoiceApprovalProfile(profiles, [sampling, sampling])?.id).toBe('sampling');
  });
  it('honors effective dates and narrower scopes', () => {
    const future = { ...profiles[1], effectiveFrom: '2099-01-01' };
    expect(selectBillingProfile([profiles[0], future], { ...sampling, serviceDate: new Date('2026-10-21') })?.id).toBe('hse');
    expect(selectBillingProfile([{ ...profiles[0], id: 'broad', appliesToTicketTypes: ['inspection', 'training'] },
      { ...profiles[0], id: 'narrow', appliesToTicketTypes: ['inspection'] }], hse)?.id).toBe('narrow');
  });
});

describe('overlapping company profile precedence', () => {
  it('uses the most recent effective start regardless of result order, with a stable final tie-break', () => {
    const old = { id: 'old', isActive: true, effectiveFrom: '2026-01-01' };
    const current = { id: 'current', isActive: true, effectiveFrom: '2026-06-09' };
    const ctx = { serviceDate: new Date('2026-10-27') };
    expect(selectBillingProfile([old, current], ctx)?.id).toBe('current');
    expect(selectBillingProfile([current, old], ctx)?.id).toBe('current');
    expect(selectBillingProfile([{ ...current, id: 'b' }, { ...current, id: 'a' }], ctx)?.id).toBe('a');
  });
});
