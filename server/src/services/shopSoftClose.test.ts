import { describe, it, expect } from 'vitest';
import {
  hardCloseDeadline,
  closeStateOf,
  canEditUnit,
  canUnlockUnit,
  isHardClosed,
  softCloseStamp,
  unlockStamp,
  msUntilHardClose,
  isClosingState,
  SOFT_CLOSE_HOURS,
  CLOSING_STATES,
} from './shopSoftClose.js';

const HOUR = 3_600_000;

function unit(overrides: Partial<Parameters<typeof closeStateOf>[0]> = {}) {
  return {
    status: 'shop_complete',
    softClosedAt: null,
    hardClosesAt: null,
    closedById: null,
    parentItemId: null,
    ...overrides,
  };
}

describe('hardCloseDeadline — 48 wall-clock hours', () => {
  it('adds exactly 48 hours', () => {
    const from = new Date('2026-08-28T12:00:00Z');
    expect(hardCloseDeadline(from).toISOString()).toBe('2026-08-30T12:00:00.000Z');
  });

  it('carries a Friday-afternoon close straight through the weekend', () => {
    // WI-05 is explicit that this is intended, not an oversight: a unit closed
    // Friday 16:00 local is final before anyone is back on Monday.
    const fridayLocal = new Date('2026-08-28T21:00:00Z'); // 16:00 America/Chicago (CDT)
    const deadline = hardCloseDeadline(fridayLocal);
    expect(deadline.toISOString()).toBe('2026-08-30T21:00:00.000Z'); // Sunday
    expect(deadline.getTime() - fridayLocal.getTime()).toBe(48 * HOUR);
  });

  it('gives the same REAL 48 hours across the America/Chicago spring DST jump', () => {
    // 2026-03-08 02:00 local is when CST -> CDT skips an hour. A calendar-based
    // "+48 hours" would hand back 47 real hours here, so two units closed a
    // minute apart would get windows of different length. Absolute time does not.
    const beforeSpringForward = new Date('2026-03-07T12:00:00Z');
    const deadline = hardCloseDeadline(beforeSpringForward);
    expect(deadline.getTime() - beforeSpringForward.getTime()).toBe(48 * HOUR);
    expect(deadline.toISOString()).toBe('2026-03-09T12:00:00.000Z');
  });

  it('gives the same REAL 48 hours across the autumn fall-back', () => {
    const beforeFallBack = new Date('2026-10-31T12:00:00Z');
    const deadline = hardCloseDeadline(beforeFallBack);
    expect(deadline.getTime() - beforeFallBack.getTime()).toBe(48 * HOUR);
  });

  it('uses the documented window length', () => {
    expect(SOFT_CLOSE_HOURS).toBe(48);
  });
});

describe('closeStateOf', () => {
  const closedAt = new Date('2026-08-28T12:00:00Z');
  const deadline = hardCloseDeadline(closedAt);

  it('is open before anything closes it', () => {
    expect(closeStateOf(unit(), closedAt)).toBe('open');
  });

  it('is soft inside the window', () => {
    const u = unit({ softClosedAt: closedAt, hardClosesAt: deadline });
    expect(closeStateOf(u, new Date(closedAt.getTime() + HOUR))).toBe('soft');
    expect(closeStateOf(u, new Date(deadline.getTime() - 1))).toBe('soft');
  });

  it('is hard exactly AT the deadline, not a millisecond later', () => {
    // The boundary belongs to the closed side: "48 hours" should not leave a
    // unit editable at 48:00:00.000.
    const u = unit({ softClosedAt: closedAt, hardClosesAt: deadline });
    expect(closeStateOf(u, deadline)).toBe('hard');
    expect(isHardClosed(u, deadline)).toBe(true);
  });

  it('treats an unstamped row as open even when the status looks terminal', () => {
    // Rows predating this feature are backfilled as already hard-closed by the
    // migration; this function only has to be right about stamped rows.
    expect(closeStateOf(unit({ status: 'returned' }), closedAt)).toBe('open');
  });
});

describe('msUntilHardClose', () => {
  it('counts down inside the window and floors at zero', () => {
    const closedAt = new Date('2026-08-28T12:00:00Z');
    const u = unit({ softClosedAt: closedAt, hardClosesAt: hardCloseDeadline(closedAt) });
    expect(msUntilHardClose(u, new Date(closedAt.getTime() + 47 * HOUR))).toBe(HOUR);
    expect(msUntilHardClose(u, new Date(closedAt.getTime() + 100 * HOUR))).toBe(0);
  });

  it('is zero for a unit that never closed', () => {
    expect(msUntilHardClose(unit())).toBe(0);
  });
});

describe('canEditUnit — who may correct what, and when', () => {
  const closedAt = new Date('2026-08-28T12:00:00Z');
  const inWindow = new Date(closedAt.getTime() + HOUR);
  const afterWindow = new Date(closedAt.getTime() + 49 * HOUR);
  const softClosed = unit({
    softClosedAt: closedAt,
    hardClosesAt: hardCloseDeadline(closedAt),
    closedById: 'tech-1',
  });

  it('lets anyone edit an open unit', () => {
    expect(canEditUnit(unit(), { userId: 'tech-9', role: 'field_tech' }, inWindow).allowed).toBe(true);
  });

  it('lets the closing tech edit inside the window', () => {
    expect(canEditUnit(softClosed, { userId: 'tech-1', role: 'field_tech' }, inWindow).allowed).toBe(true);
  });

  it('lets a supervisor edit inside the window', () => {
    expect(canEditUnit(softClosed, { userId: 'super-1', role: 'field_super' }, inWindow).allowed).toBe(true);
  });

  it('does NOT let an unrelated tech edit inside the window', () => {
    const verdict = canEditUnit(softClosed, { userId: 'tech-2', role: 'field_tech' }, inWindow);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/closed by someone else/i);
  });

  it('does not let billing edit during the window', () => {
    // The window exists so the shop can fix its own work, not so the record can
    // be reshaped by the people who consume it.
    expect(canEditUnit(softClosed, { userId: 'ar-1', role: 'billing_ar' }, inWindow).allowed).toBe(false);
  });

  it('locks everyone out after hard close, supervisors included', () => {
    for (const role of ['field_tech', 'field_super', 'boss', 'platform_admin']) {
      const verdict = canEditUnit(softClosed, { userId: 'tech-1', role }, afterWindow);
      expect(verdict.allowed, `${role} should be locked out`).toBe(false);
      expect(verdict.reason).toMatch(/Platform Admin can reopen/i);
    }
  });

  it('never gates a sub-component — it follows its parent assembly', () => {
    const child = unit({
      parentItemId: 'parent-1',
      softClosedAt: closedAt,
      hardClosesAt: hardCloseDeadline(closedAt),
    });
    expect(canEditUnit(child, { userId: 'anyone', role: 'field_tech' }, afterWindow).allowed).toBe(true);
  });
});

describe('canUnlockUnit', () => {
  it('is platform admin only', () => {
    expect(canUnlockUnit('platform_admin')).toBe(true);
    for (const role of ['field_super', 'boss', 'billing_ar', 'field_tech']) {
      expect(canUnlockUnit(role), `${role} must not unlock`).toBe(false);
    }
  });
});

describe('softCloseStamp — the clock starts once', () => {
  const now = new Date('2026-08-28T12:00:00Z');

  it('stamps a unit closing for the first time', () => {
    const stamp = softCloseStamp({ softClosedAt: null }, 'tech-1', now);
    expect(stamp).toMatchObject({ softClosedAt: now, closedById: 'tech-1' });
    expect(stamp!.hardClosesAt.getTime()).toBe(now.getTime() + 48 * HOUR);
  });

  it('refuses to restart the clock on a re-close', () => {
    // shop_complete -> returned is a handover, not a second close. Restarting
    // would let a unit be held out of billing forever by bouncing its status.
    const alreadyClosed = new Date('2026-08-20T12:00:00Z');
    expect(softCloseStamp({ softClosedAt: alreadyClosed }, 'tech-1', now)).toBeNull();
  });
});

describe('unlockStamp', () => {
  it('grants a fresh 48 hours and records who and why', () => {
    const now = new Date('2026-09-01T09:00:00Z');
    const stamp = unlockStamp('admin-1', 'customer disputed the serial', now);
    expect(stamp.hardClosesAt.getTime()).toBe(now.getTime() + 48 * HOUR);
    expect(stamp).toMatchObject({
      unlockedById: 'admin-1',
      unlockReason: 'customer disputed the serial',
    });
  });

  it('moves softClosedAt forward too, or the unit reads as hard-closed instantly', () => {
    const now = new Date('2026-09-01T09:00:00Z');
    const stamp = unlockStamp('admin-1', 'reason', now);
    expect(closeStateOf({ ...unit(), ...stamp }, now)).toBe('soft');
  });
});

describe('CLOSING_STATES', () => {
  it('matches the billable set exactly — settled and closed must not drift', () => {
    expect([...CLOSING_STATES].sort()).toEqual(['condemned', 'returned', 'shop_complete']);
  });

  it('recognises closing states and nothing else', () => {
    expect(isClosingState('shop_complete')).toBe(true);
    expect(isClosingState('returned')).toBe(true);
    expect(isClosingState('condemned')).toBe(true);
    expect(isClosingState('in_work')).toBe(false);
    expect(isClosingState('on_hold')).toBe(false);
  });
});
