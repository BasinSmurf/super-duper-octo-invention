import { describe, it, expect } from 'vitest';
import { resolveHoldReason, isSettableHoldReason, HOLD_STATUSES } from './shopHoldReason.js';
import { holdReasonError, canTransitionShopItem } from './shopStateMachine.js';

describe('resolveHoldReason — derived, not stored', () => {
  it('derives the reason from status for the three holds that already encode one', () => {
    expect(resolveHoldReason({ status: 'awaiting_parts' })).toMatchObject({
      code: 'waiting_parts',
      label: 'Waiting parts',
    });
    expect(resolveHoldReason({ status: 'awaiting_approval' })).toMatchObject({
      code: 'waiting_customer_approval',
    });
    expect(resolveHoldReason({ status: 'outside_service' })).toMatchObject({
      code: 'external_vendor',
    });
  });

  it('maps the retired warranty_out status to external_vendor too', () => {
    // Legacy rows predate the isWarranty flag; they still have to render.
    expect(resolveHoldReason({ status: 'warranty_out' })).toMatchObject({
      code: 'external_vendor',
    });
  });

  it('ignores a stored reason that contradicts a derived status', () => {
    // The derivation is the source of truth. A stray stored value -- from a
    // direct DB edit, say -- must not be able to mislabel the pill.
    expect(
      resolveHoldReason({ status: 'awaiting_parts', holdReason: 'waiting_internal' }),
    ).toMatchObject({ code: 'waiting_parts' });
  });

  it('reads the stored reason only for the generic on_hold status', () => {
    expect(resolveHoldReason({ status: 'on_hold', holdReason: 'waiting_internal' })).toMatchObject({
      code: 'waiting_internal',
      label: 'Waiting internal',
    });
  });

  it('returns null rather than throwing on a legacy on_hold row with no reason', () => {
    // Unreachable through the state machine, but a wall display must not crash
    // on a row that got there some other way.
    expect(resolveHoldReason({ status: 'on_hold', holdReason: null })).toBeNull();
  });

  it('returns null for units that are not on hold at all', () => {
    expect(resolveHoldReason({ status: 'in_work' })).toBeNull();
    expect(resolveHoldReason({ status: 'shop_complete' })).toBeNull();
  });

  it('carries the optional qualifier through as a display-only note', () => {
    const r = resolveHoldReason({ status: 'awaiting_parts', holdNote: '  ETA 9/1  ' });
    expect(r?.note).toBe('ETA 9/1');
  });

  it('treats a whitespace-only qualifier as absent', () => {
    expect(resolveHoldReason({ status: 'awaiting_parts', holdNote: '   ' })?.note).toBeNull();
  });

  it('covers every hold status with a reason, so no On-Hold card can be blank', () => {
    for (const status of HOLD_STATUSES) {
      const reason = resolveHoldReason({
        status,
        // on_hold is the only one that needs a stored value supplied.
        holdReason: status === 'on_hold' ? 'other' : null,
      });
      expect(reason, `no reason resolved for ${status}`).not.toBeNull();
    }
  });
});

describe('isSettableHoldReason — the derived three are not choices', () => {
  it('accepts the two reasons a human picks', () => {
    expect(isSettableHoldReason('waiting_internal')).toBe(true);
    expect(isSettableHoldReason('other')).toBe(true);
  });

  it('rejects the derived reasons, which have their own statuses', () => {
    expect(isSettableHoldReason('waiting_parts')).toBe(false);
    expect(isSettableHoldReason('external_vendor')).toBe(false);
    expect(isSettableHoldReason('waiting_customer_approval')).toBe(false);
  });

  it('rejects junk', () => {
    expect(isSettableHoldReason('')).toBe(false);
    expect(isSettableHoldReason(undefined)).toBe(false);
    expect(isSettableHoldReason(42)).toBe(false);
  });
});

describe('holdReasonError — the gate is in the state machine, not the form', () => {
  it('rejects a move to on_hold with no reason', () => {
    expect(holdReasonError('on_hold', undefined)).toBeTruthy();
    expect(holdReasonError('on_hold', null)).toBeTruthy();
    expect(holdReasonError('on_hold', '')).toBeTruthy();
  });

  it('rejects a derived reason, pointing at the status that already means it', () => {
    const err = holdReasonError('on_hold', 'waiting_parts');
    expect(err).toBeTruthy();
    expect(err).toContain('own statuses');
  });

  it('allows a move to on_hold with a settable reason', () => {
    expect(holdReasonError('on_hold', 'waiting_internal')).toBeNull();
    expect(holdReasonError('on_hold', 'other')).toBeNull();
  });

  it('does not demand a reason for any other transition', () => {
    // The parts/approval/vendor holds carry their reason implicitly, so asking
    // for one again would be asking the same question twice.
    expect(holdReasonError('awaiting_parts', undefined)).toBeNull();
    expect(holdReasonError('outside_service', undefined)).toBeNull();
    expect(holdReasonError('in_work', undefined)).toBeNull();
  });
});

describe('on_hold transitions', () => {
  it('is reachable from the active working states', () => {
    for (const from of ['received', 'diagnosing', 'in_work', 'qc_testing'] as const) {
      expect(canTransitionShopItem(from, 'on_hold'), `${from} -> on_hold`).toBe(true);
    }
  });

  it('leads back to work, never straight to release', () => {
    expect(canTransitionShopItem('on_hold', 'in_work')).toBe(true);
    expect(canTransitionShopItem('on_hold', 'qc_testing')).toBe(true);
    // Releasing gear still has to pass the QA gate on its own path.
    expect(canTransitionShopItem('on_hold', 'shop_complete')).toBe(false);
    expect(canTransitionShopItem('on_hold', 'returned')).toBe(false);
  });
});
