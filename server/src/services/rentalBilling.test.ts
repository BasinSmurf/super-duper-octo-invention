import { describe, it, expect } from 'vitest';
import { computeRentalBillingState, seedsDeliveryPickupLines } from './rentalBilling.js';

describe('rental calendar-month due dates', () => {
  it.each([['2026-06-15','2026-06-30'],['2026-08-31','2026-08-31'],['2026-02-01','2026-02-28'],['2024-02-01','2024-02-29']])('bills %s at EOM %s', (start, end) => {
    expect(computeRentalBillingState({ status:'active', startDate:new Date(start), endDate:null, billingCadence:'monthly' }, []).nextDueDate).toEqual(new Date(end));
  });
  it('advances EOM only after the previous month is fully invoiced', () => {
    const rental = { status:'active', startDate:new Date('2026-06-15'), endDate:null, billingCadence:'monthly' as const };
    expect(computeRentalBillingState(rental, [{ periodEnd:new Date('2026-06-20') }]).nextDueDate).toEqual(new Date('2026-06-30'));
    expect(computeRentalBillingState(rental, [{ periodEnd:new Date('2026-06-30') }]).nextDueDate).toEqual(new Date('2026-07-31'));
    expect(computeRentalBillingState({ ...rental, status:'completed', endDate:new Date('2026-07-05') }, [{ periodEnd:new Date('2026-06-30') }]).nextDueDate).toEqual(new Date('2026-07-05'));
  });
});

describe('seedsDeliveryPickupLines — who gets Delivery/Pickup rows', () => {
  it('seeds them for a dispatch rental, where a truck actually rolled', () => {
    expect(seedsDeliveryPickupLines({ pickupType: 'dispatch' })).toBe(true);
  });

  it('withholds them from a walk-in, where nobody drove anywhere', () => {
    // The counter rental that started this: a personal 5-gas monitor billed
    // $70 and carried four $0 mobilization rows it could never fill in.
    expect(seedsDeliveryPickupLines({ pickupType: 'walk_in' })).toBe(false);
  });

  it('treats an unset pickup type as dispatch, matching the column default', () => {
    // A stray $0 row someone deletes beats a delivery nobody remembers to bill.
    for (const missing of [undefined, null]) {
      expect(seedsDeliveryPickupLines({ pickupType: missing })).toBe(true);
    }
    expect(seedsDeliveryPickupLines({})).toBe(true);
  });
});
