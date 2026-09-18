import { describe, it, expect } from 'vitest';
import {
  parsePickupType, kioskBoardFilter, boardScopeWhere, KIOSK_ROLE_PICKUP_TYPE,
} from './rentalsBoard.js';

describe('parsePickupType — what a query string is allowed to mean', () => {
  it('accepts the two real pickup types', () => {
    expect(parsePickupType('dispatch')).toBe('dispatch');
    expect(parsePickupType('walk_in')).toBe('walk_in');
  });

  it('reads anything else as "no filter" instead of throwing', () => {
    // A wall display showing both halves is a recoverable wrong; one showing a
    // stack trace is not. Nobody is standing at the tablet to fix a typo.
    for (const junk of [undefined, null, '', 'walkin', 'walk-in', 'DISPATCH', 'both', 42, {}]) {
      expect(parsePickupType(junk)).toBeNull();
    }
  });
});

describe('kioskBoardFilter — provisioning decides, not the URL', () => {
  it('pins a dispatch kiosk to its own site and to dispatch work', () => {
    expect(kioskBoardFilter({ siteId: 'site-wil', role: 'RENTALS_DISPATCH' }))
      .toEqual({ siteId: 'site-wil', pickupType: 'dispatch' });
  });

  it('pins a walk-in kiosk to walk_in work', () => {
    expect(kioskBoardFilter({ siteId: 'site-dic', role: 'RENTALS_WALKIN' }))
      .toEqual({ siteId: 'site-dic', pickupType: 'walk_in' });
  });

  it('still scopes a mis-provisioned kiosk to its site, with no type filter', () => {
    // A shop BOARD token pointed at the rentals URL. It must not leak another
    // shop's rentals, but showing both pickup types is the better failure —
    // obviously wrong to whoever set the device up, rather than blank.
    expect(kioskBoardFilter({ siteId: 'site-wil', role: 'BOARD' }))
      .toEqual({ siteId: 'site-wil', pickupType: null });
  });

  it('maps exactly the two rentals roles and nothing else', () => {
    expect(Object.keys(KIOSK_ROLE_PICKUP_TYPE).sort())
      .toEqual(['RENTALS_DISPATCH', 'RENTALS_WALKIN']);
  });
});

describe('boardScopeWhere — an unset filter must not become an IN list', () => {
  it('omits both keys when nothing is filtered', () => {
    // The important part is the ABSENCE of siteId: agreements written before
    // rentals carried a site have site_id = null, and they belong on the
    // all-sites board. An `{ in: [...known ids] }` would drop exactly those.
    expect(boardScopeWhere({})).toEqual({});
    expect(boardScopeWhere({ siteId: null, pickupType: null })).toEqual({});
  });

  it('filters on site alone', () => {
    expect(boardScopeWhere({ siteId: 'site-wil' })).toEqual({ siteId: 'site-wil' });
  });

  it('filters on pickup type alone', () => {
    expect(boardScopeWhere({ pickupType: 'walk_in' })).toEqual({ pickupType: 'walk_in' });
  });

  it('filters on both — the kiosk case', () => {
    expect(boardScopeWhere({ siteId: 'site-dic', pickupType: 'dispatch' }))
      .toEqual({ siteId: 'site-dic', pickupType: 'dispatch' });
  });

  it('treats an empty-string site as unset rather than matching nothing', () => {
    // `?site=` with no value must not become `siteId: ''`, which matches no row
    // and would render an empty board with no explanation.
    expect(boardScopeWhere({ siteId: '' })).toEqual({});
  });
});
