import { beforeEach, describe, expect, it, vi } from 'vitest';
const prisma = vi.hoisted(() => ({
  company: { findUnique: vi.fn() },
  rentalAgreement: { findUnique: vi.fn() },
  customerBillingProfile: { findMany: vi.fn() },
}));
vi.mock('../db.js', async importOriginal => ({ ...await importOriginal<typeof import('../db.js')>(), ...(() => ({ prisma }))() }));
import { prepareTicketCustomerChange } from './ticketCustomerChange.js';

const existing = {
  companyId: 'old', status: 'in_progress', ticketType: 'field_service', division: 'D3',
  serviceDate: new Date('2026-10-16'), billingProfileId: 'old-profile', customerContactId: 'old-contact',
};
beforeEach(() => {
  vi.resetAllMocks();
  prisma.company.findUnique.mockResolvedValue({ id: 'new', isActive: true, creditHold: false });
  prisma.customerBillingProfile.findMany.mockResolvedValue([{ id: 'new-profile' }]);
});
describe('ticket customer corrections', () => {
  it.each(['draft', 'dispatched', 'in_progress'])('reselects customer billing and drops the old contact for %s', async status => {
    const payload: any = { companyId: 'new', billingProfileId: 'old-profile', customerContactId: 'old-contact' };
    await prepareTicketCustomerChange({ ...existing, status }, payload);
    expect(payload).toEqual({ companyId: 'new', billingProfileId: 'new-profile', customerContactId: null,
      billingGroupKey: expect.stringMatching(/^co:new\|fld:none\|mo:/) });
    expect(prisma.customerBillingProfile.findMany).toHaveBeenCalledWith({
      where: { companyId: 'new', isActive: true }, orderBy: { effectiveFrom: 'desc' },
    });
    expect(payload.status).toBeUndefined();
  });
  it('clears the old billing profile when the new customer has none', async () => {
    prisma.customerBillingProfile.findMany.mockResolvedValue([]);
    const payload: any = { companyId: 'new' };
    await prepareTicketCustomerChange(existing, payload);
    expect(payload.billingProfileId).toBeNull();
  });
  it('leaves existing customer references alone when customer is unchanged', async () => {
    const payload = { companyId: 'old', dispatchNotes: 'Corrected notes' };
    await prepareTicketCustomerChange(existing, payload);
    expect(payload).toEqual({ companyId: 'old', dispatchNotes: 'Corrected notes' });
    expect(prisma.company.findUnique).not.toHaveBeenCalled();
  });
  it.each(['completed', 'supervisor_review', 'billing_queue', 'invoiced', 'closed', 'void'])('rejects customer change after work for %s', async status => {
    await expect(prepareTicketCustomerChange({ ...existing, status }, { companyId: 'new' })).rejects.toThrow(/Return the ticket/);
  });
  it('rejects a retained rental for another customer even when the payload omits it', async () => {
    prisma.rentalAgreement.findUnique.mockResolvedValue({ companyId: 'old' });
    await expect(prepareTicketCustomerChange({ ...existing, linkedRentalAgreementId: 'rental' }, { companyId: 'new' })).rejects.toThrow(/different customer/);
  });
  it.each([{ isActive: false, creditHold: false }, { isActive: true, creditHold: true }])('rejects unavailable customer %j', async company => {
    prisma.company.findUnique.mockResolvedValue({ id: 'new', ...company });
    await expect(prepareTicketCustomerChange(existing, { companyId: 'new' })).rejects.toThrow();
    expect(prisma.customerBillingProfile.findMany).not.toHaveBeenCalled();
  });
});
