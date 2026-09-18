import { describe, it, expect } from 'vitest';
import { seedsDeliveryPickupLines } from './rentalBilling.js';

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
