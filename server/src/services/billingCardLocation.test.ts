import { describe, expect, it, vi } from 'vitest';
import { billingCardLocation, invoiceCardLocations, shopBillingCardLocation } from './billingCardLocation.js';

describe('billing card locations', () => {
  it('uses the saved display or the most specific available location', () => {
    const source = { locationDisplay: 'Smith 14-4', well: { wellName: 'Well A' }, pad: { name: 'Pad A' }, field: { name: 'Field A' } };
    expect(billingCardLocation(source)).toBe('Smith 14-4');
    expect(billingCardLocation({ ...source, locationDisplay: ' ' })).toBe('Well A');
    expect(billingCardLocation({ field: source.field })).toBe('Field A');
    expect(billingCardLocation({})).toBeNull();
    expect(shopBillingCardLocation({ sourceLocation: { name: 'Customer pad' }, intakeSite: { name: 'Shop' } })).toBe('Customer pad');
    expect(shopBillingCardLocation({ intakeSite: { name: 'Shop' } })).toBe('Shop');
  });

  it('keeps distinct source locations on the correct invoices without per-card queries', async () => {
    const db = {
      serviceTicket: { findMany: vi.fn().mockResolvedValue([
        { id: 'a', billingGroupId: 'group', locationDisplay: 'Pad A' },
        { id: 'b', billingGroupId: 'group', locationDisplay: 'Pad A' },
        { id: 'c', billingGroupId: null, locationDisplay: 'Pad B' },
        { id: 'd', billingGroupId: 'group', locationDisplay: 'Pad D' },
      ]) },
      shopWorkOrder: { findMany: vi.fn().mockResolvedValue([{ id: 'shop', intakeSite: { name: 'Williston' } }]) },
      rentalAgreement: { findMany: vi.fn().mockResolvedValue([{ id: 'rental', well: { wellName: 'Well C' } }]) },
    };
    const base = { billingGroupId: null, shopWorkOrderId: null, rentalAgreementId: null, lineItems: [] };
    const locations = await invoiceCardLocations(db as any, [
      { ...base, id: 'grouped', billingGroupId: 'group' },
      { ...base, id: 'legacy', lineItems: [{ sourceTicketId: 'c' }] },
      { ...base, id: 'split', billingGroupId: 'group', lineItems: [{ sourceTicketId: 'a' }] },
      { ...base, id: 'shop-invoice', shopWorkOrderId: 'shop' },
      { ...base, id: 'rental-invoice', rentalAgreementId: 'rental' },
      { ...base, id: 'manual' },
    ]);
    expect(Object.fromEntries(locations)).toEqual({ grouped: 'Pad A, Pad D', legacy: 'Pad B', split: 'Pad A', 'shop-invoice': 'Williston', 'rental-invoice': 'Well C', manual: null });
    for (const model of Object.values(db)) expect(model.findMany).toHaveBeenCalledTimes(1);
  });
});
