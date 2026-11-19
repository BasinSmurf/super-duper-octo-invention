import { describe, expect, it, vi } from 'vitest';

vi.mock('../db.js', async importOriginal => ({ ...await importOriginal<typeof import('../db.js')>(), prisma: {} }));
import { dueForNag, type NagRow } from './rentalBillReadyWatcher.js';
import { priorMonthEnd, summarizeReleases } from './rentalBillingRelease.js';

const d = (value: string) => new Date(value);
const row = (over: Partial<NagRow>): NagRow => ({
  id: 'r', agreementNumber: 'RA-1', state: 'unreleased', endDate: null, unbilledFrom: d('2026-11-01'), unbilledDays: 30,
  overdue: false, nextDueDate: d('2026-11-30'), lastBillReadyNotifiedFor: null,
  company: { name: 'Continental' }, blockers: [], ...over,
});

describe('who gets nagged to send rentals for billing', () => {
  it('stays quiet until a rental is past its billing cadence', () => {
    expect(dueForNag([row({})])).toEqual([]);
  });
  it('nags once an open rental is due and not sent, e.g. on the last day of the month', () => {
    expect(dueForNag([row({ overdue: true })])).toEqual([
      { id: 'r', agreementNumber: 'RA-1', companyName: 'Continental', notifyFor: d('2026-11-30'), detail: '30 days unbilled, not sent' },
    ]);
  });
  it('does not repeat for the same period, and starts again once billing advances', () => {
    expect(dueForNag([row({ overdue: true, lastBillReadyNotifiedFor: d('2026-11-30') })])).toEqual([]);
    expect(dueForNag([row({ overdue: true, nextDueDate: d('2026-12-31'), lastBillReadyNotifiedFor: d('2026-11-30') })])).toHaveLength(1);
  });
  it('never nags about a rental that has been sent or is ready for AR', () => {
    expect(dueForNag([row({ state: 'released' }), row({ state: 'closed_ready', endDate: d('2026-11-10') })])).toEqual([]);
  });
  it('nags once about a closed job stuck behind unapproved tickets, naming them', () => {
    const closed = row({ state: 'closed_blocked', endDate: d('2026-11-10'), blockers: [{ ticketNumber: 'FS-9' }, { ticketNumber: 'FS-12' }] });
    expect(dueForNag([closed])[0]).toMatchObject({ notifyFor: d('2026-11-10'), detail: 'closed, 2 tickets to approve (FS-9, FS-12)' });
    expect(dueForNag([{ ...closed, lastBillReadyNotifiedFor: d('2026-11-10') }])).toEqual([]);
  });
});

describe('month-end stragglers', () => {
  const rows = [
    // Still owes October.
    { state: 'unreleased' as const, unbilledFrom: d('2026-10-05'), overdue: true },
    { state: 'closed_blocked' as const, unbilledFrom: d('2026-10-20'), overdue: false },
    { state: 'released' as const, unbilledFrom: d('2026-10-01'), overdue: false },
    { state: 'closed_ready' as const, unbilledFrom: d('2026-10-31'), overdue: false },
    // October is billed; only November days remain.
    { state: 'unreleased' as const, unbilledFrom: d('2026-11-01'), overdue: false },
    { state: 'released' as const, unbilledFrom: d('2026-11-01'), overdue: false },
    { state: 'closed_blocked' as const, unbilledFrom: d('2026-11-03'), overdue: false },
  ];
  it('counts what is left of the last completed month, split by whose move it is', () => {
    expect(summarizeReleases(rows, d('2026-11-12'))).toEqual({
      unsent: 1, closedBlocked: 1, awaitingInvoice: 2, needsSending: 3,
    });
  });
  it('goes quiet once the month is billed, and rolls to the next month on the 1st', () => {
    const november = rows.filter(r => r.unbilledFrom >= d('2026-11-01'));
    expect(summarizeReleases(november, d('2026-11-30'))).toMatchObject({ unsent: 0, closedBlocked: 0, awaitingInvoice: 0 });
    expect(summarizeReleases(november, d('2026-12-01'))).toMatchObject({ unsent: 1, closedBlocked: 1, awaitingInvoice: 1 });
  });
  it('finds the prior month-end across a year boundary', () => {
    expect(priorMonthEnd(d('2027-01-15'))).toEqual(d('2026-12-31'));
    expect(priorMonthEnd(d('2026-03-01'))).toEqual(d('2026-02-28'));
  });
});
