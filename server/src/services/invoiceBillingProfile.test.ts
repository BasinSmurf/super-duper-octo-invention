import { describe, expect, it, vi } from 'vitest';
import { resolveInvoiceBillingProfile } from './invoiceBillingProfile.js';

const profiles = [
  { id: 'hse', companyId: 'conoco', appliesToTicketTypes: ['inspection'] },
  { id: 'sampling', companyId: 'conoco', appliesToTicketTypes: ['ih_sampling'], defaultServiceApprover: 'Sampling approver' },
];
const fixture = () => ({ customerBillingProfile: { findMany: vi.fn(async () => profiles) },
  serviceTicket: { findMany: vi.fn(async () => [{ ticketType: 'inspection', serviceSubtype: 'ih_sampling' }]) } });

describe('invoice billing-profile provenance', () => {
  it('keeps a bound Sampling profile even when HSE is the first active profile', async () => {
    const db = fixture();
    expect(await resolveInvoiceBillingProfile(db as any, { companyId: 'conoco', billingProfileId: 'sampling' }))
      .toMatchObject({ id: 'sampling', defaultServiceApprover: 'Sampling approver' });
    expect(db.serviceTicket.findMany).not.toHaveBeenCalled();
  });
  it('resolves a legacy unbound invoice from the source work subtype', async () => {
    expect((await resolveInvoiceBillingProfile(fixture() as any, { companyId: 'conoco', lineItems: [{ sourceTicketId: 't1' }] }))?.id)
      .toBe('sampling');
  });
  it('fails instead of falling back when the bound profile is disabled or belongs to another customer', async () => {
    await expect(resolveInvoiceBillingProfile(fixture() as any, { companyId: 'conoco', billingProfileId: 'missing' }))
      .rejects.toThrow('no longer active');
  });
  it('rejects mixed approval groups in an unbound legacy invoice', async () => {
    const db = fixture();
    db.serviceTicket.findMany.mockResolvedValue([{ ticketType: 'inspection', serviceSubtype: 'ih_sampling' },
      { ticketType: 'inspection', serviceSubtype: 'ih_h2s' }]);
    await expect(resolveInvoiceBillingProfile(db as any, { companyId: 'conoco', lineItems: [{ sourceTicketId: 't1' }, { sourceTicketId: 't2' }] }))
      .rejects.toThrow('separate invoice');
  });
});
