import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = vi.hoisted(() => ({
  $transaction: vi.fn(), $queryRaw: vi.fn(),
  rentalAgreement: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn() },
  invoice: { findMany: vi.fn() },
  serviceTicket: { findMany: vi.fn() },
}));
vi.mock('../db.js', async importOriginal => ({ ...await importOriginal<typeof import('../db.js')>(), prisma }));
import {
  blockersFor, isReadyForBilling, listRentalsForRelease, recallReleases, releaseRentals, rentalKind, rentalReleaseState,
} from './rentalBillingRelease.js';

const d = (value: string) => new Date(value);
const TODAY = '2026-11-12';
let rental: any;

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers(); vi.setSystemTime(d(`${TODAY}T18:00:00Z`));
  prisma.$transaction.mockImplementation(async (action: any) => action(prisma));
  prisma.$queryRaw.mockResolvedValue([]);
  rental = { id: 'r1', agreementNumber: 'RA-1', status: 'active', startDate: d('2026-10-05'), endDate: null,
    billingCadence: 'monthly', billingReleasedThrough: null, billingReleaseForceReason: null };
  prisma.rentalAgreement.findUnique.mockImplementation(async () => rental);
  prisma.invoice.findMany.mockResolvedValue([]);
  prisma.serviceTicket.findMany.mockResolvedValue([]);
  return () => vi.useRealTimers();
});

describe('rentalReleaseState', () => {
  const unbilled = { lastBilledThrough: null, isFullyBilled: false };
  it('keeps an open rental out of billing until it is sent', () => {
    expect(rentalReleaseState(rental, unbilled, 0)).toBe('unreleased');
    expect(isReadyForBilling('unreleased')).toBe(false);
  });
  it('is sent while the stamp is ahead of what was invoiced, then clears itself', () => {
    rental.billingReleasedThrough = d('2026-10-31');
    expect(rentalReleaseState(rental, unbilled, 0)).toBe('released');
    expect(rentalReleaseState(rental, { lastBilledThrough: d('2026-10-20'), isFullyBilled: false }, 0)).toBe('released');
    // Invoiced through the stamp: the card drops off with no "mark done" step...
    expect(rentalReleaseState(rental, { lastBilledThrough: d('2026-10-31'), isFullyBilled: false }, 0)).toBe('unreleased');
    // ...and voiding that invoice (lastBilledThrough falls back) returns it.
    expect(rentalReleaseState(rental, unbilled, 0)).toBe('released');
  });
  it('sends a closed rental on its own once its tickets are approved', () => {
    rental.status = 'completed'; rental.endDate = d('2026-11-10');
    expect(rentalReleaseState(rental, unbilled, 0)).toBe('closed_ready');
    expect(rentalReleaseState(rental, unbilled, 2)).toBe('closed_blocked');
    expect(rentalReleaseState(rental, { lastBilledThrough: d('2026-11-10'), isFullyBilled: true }, 0)).toBeNull();
  });
  it('lets only a force carry a closed rental past unapproved tickets', () => {
    rental.status = 'completed'; rental.endDate = d('2026-11-10');
    // A normal send made while the job was still open is not a force.
    rental.billingReleasedThrough = d('2026-11-10');
    expect(rentalReleaseState(rental, unbilled, 2)).toBe('closed_blocked');
    rental.billingReleaseForceReason = 'Supervisor out';
    expect(rentalReleaseState(rental, unbilled, 2)).toBe('closed_ready');
  });
  it('ignores rentals that never bill', () => {
    expect(rentalReleaseState({ ...rental, status: 'scheduled' }, unbilled, 0)).toBeNull();
    expect(rentalReleaseState({ ...rental, status: 'cancelled' }, unbilled, 0)).toBeNull();
  });
});

describe('approval gate', () => {
  const ticket = (status: string, day: string) => ({ id: `${status}-${day}`, ticketNumber: `FS-${day}`, status, serviceDate: d(day) });
  it('blocks on finished-but-unapproved tickets and nothing else', () => {
    const tickets = [ticket('draft', '2026-11-01'), ticket('in_progress', '2026-11-12'), ticket('completed', '2026-11-02'),
      ticket('supervisor_review', '2026-11-03'), ticket('awaiting_signature', '2026-11-04'), ticket('billing_queue', '2026-11-05')];
    expect(blockersFor(tickets, d(TODAY)).map(t => t.status)).toEqual(['completed', 'supervisor_review']);
  });
  it('ignores tickets dated after the send date on an open rental, but not on a closed one', () => {
    const tickets = [ticket('supervisor_review', '2026-11-20')];
    expect(blockersFor(tickets, d(TODAY))).toEqual([]);
    expect(blockersFor(tickets, null)).toHaveLength(1);
  });
});

describe('releaseRentals', () => {
  it('stamps the release through today, frozen, with who sent it', async () => {
    const [result] = await releaseRentals({ ids: ['r1'], userId: 'super' });
    expect(result).toMatchObject({ id: 'r1', success: true, releasedThrough: TODAY });
    expect(prisma.rentalAgreement.update).toHaveBeenCalledWith({ where: { id: 'r1' }, data: expect.objectContaining({
      billingReleasedThrough: d(TODAY), billingReleasedById: 'super', billingReleaseForceReason: null }) });
  });
  it('refuses while a finished ticket is unapproved, and names it', async () => {
    prisma.serviceTicket.findMany.mockResolvedValue([
      { id: 't1', ticketNumber: 'FS-100', status: 'supervisor_review', serviceDate: d('2026-11-08') }]);
    const [result] = await releaseRentals({ ids: ['r1'], userId: 'super' });
    expect(result).toMatchObject({ success: false, blockers: [{ ticketNumber: 'FS-100', status: 'supervisor_review', serviceDate: '2026-11-08' }] });
    expect(result.error).toContain('FS-100');
    expect(prisma.rentalAgreement.update).not.toHaveBeenCalled();
    expect(prisma.serviceTicket.findMany.mock.calls[0][0].where.status).toEqual({ in: ['completed', 'supervisor_review'] });
  });
  it('lets a force skip the gate and records the reason', async () => {
    prisma.serviceTicket.findMany.mockResolvedValue([
      { id: 't1', ticketNumber: 'FS-100', status: 'supervisor_review', serviceDate: d('2026-11-08') }]);
    const [result] = await releaseRentals({ ids: ['r1'], userId: 'arsup', force: { reason: 'Supervisor out' } });
    expect(result.success).toBe(true);
    expect(prisma.serviceTicket.findMany).not.toHaveBeenCalled();
    expect(prisma.rentalAgreement.update.mock.calls[0][0].data).toMatchObject({ billingReleasedById: 'arsup', billingReleaseForceReason: 'Supervisor out' });
  });
  it('has nothing to send when already billed through today', async () => {
    prisma.invoice.findMany.mockResolvedValue([{ periodEnd: d(TODAY) }]);
    const [result] = await releaseRentals({ ids: ['r1'], userId: 'super' });
    expect(result).toMatchObject({ success: false });
    expect(result.error).toContain('Already billed through 2026-11-12');
  });
  it('does not take a manual send for a closed rental, only a force', async () => {
    rental.status = 'completed'; rental.endDate = d('2026-11-10');
    expect((await releaseRentals({ ids: ['r1'], userId: 'super' }))[0].error).toContain('goes to billing on its own');
    const [forced] = await releaseRentals({ ids: ['r1'], userId: 'arsup', force: { reason: 'Customer needs it today' } });
    expect(forced).toMatchObject({ success: true, releasedThrough: '2026-11-10' });
  });
  it('keeps going past a refusal in a bulk selection', async () => {
    prisma.rentalAgreement.findUnique.mockImplementation(async ({ where }: any) => where.id === 'gone' ? null : { ...rental, id: where.id });
    const results = await releaseRentals({ ids: ['r1', 'gone', 'r2', 'r1'], userId: 'super' });
    expect(results.map(r => [r.id, r.success])).toEqual([['r1', true], ['gone', false], ['r2', true]]);
  });
});

describe('recallReleases', () => {
  it('clears a send that has not been invoiced', async () => {
    rental.billingReleasedThrough = d('2026-11-10');
    expect((await recallReleases(['r1']))[0].success).toBe(true);
    expect(prisma.rentalAgreement.update).toHaveBeenCalledWith({ where: { id: 'r1' },
      data: { billingReleasedThrough: null, billingReleasedAt: null, billingReleasedById: null, billingReleaseForceReason: null } });
  });
  it('refuses once the send has been invoiced', async () => {
    rental.billingReleasedThrough = d('2026-11-10');
    prisma.invoice.findMany.mockResolvedValue([{ periodEnd: d('2026-11-10') }]);
    expect((await recallReleases(['r1']))[0].error).toContain('Already invoiced');
    expect(prisma.rentalAgreement.update).not.toHaveBeenCalled();
  });
});

describe('rentalKind', () => {
  it('reads manned / unmanned / no trailer from the composition', () => {
    expect(rentalKind({ composition: { trailer: { manned: true } }, isManned: false, pickupType: 'dispatch' })).toBe('manned');
    expect(rentalKind({ composition: { trailer: { manned: false } }, isManned: true, pickupType: 'dispatch' })).toBe('unmanned');
    expect(rentalKind({ composition: { trailer: null, gasMonitors: [{}] }, isManned: true, pickupType: 'dispatch' })).toBe('non_trailer');
  });
  it('does not trust the default-true manned flag on a walk-in with no composition', () => {
    expect(rentalKind({ composition: null, isManned: true, pickupType: 'walk_in' })).toBe('non_trailer');
    expect(rentalKind({ composition: null, isManned: false, pickupType: 'dispatch' })).toBe('unmanned');
  });
});

describe('listRentalsForRelease', () => {
  const row = (over: any) => ({ id: 'a', agreementNumber: 'RA-A', status: 'active', pickupType: 'dispatch', startDate: d('2026-10-05'),
    endDate: null, billingCadence: 'monthly', billingRateType: 'daily', isManned: true, composition: { trailer: { manned: true } },
    siteId: 's1', billingReleasedThrough: null, billingReleasedAt: null, billingReleaseForceReason: null,
    company: { id: 'c', name: 'Continental' }, site: null, billingReleasedBy: null, pad: { name: 'Bison 4-9H' }, well: null,
    field: null, facility: null, linkedServiceTickets: [], ...over });
  it('reports days unbilled, overdue, blockers and state per rental, dropping fully billed jobs', async () => {
    prisma.rentalAgreement.findMany.mockResolvedValue([
      row({}),
      row({ id: 'b', agreementNumber: 'RA-B', billingReleasedThrough: d('2026-11-10'), composition: { trailer: null } }),
      row({ id: 'c', agreementNumber: 'RA-C', status: 'completed', endDate: d('2026-11-10'), linkedServiceTickets: [
        { id: 't', ticketNumber: 'FS-9', status: 'supervisor_review', serviceDate: d('2026-11-10'), lineItems: [] },
        { id: 'u', ticketNumber: 'FS-8', status: 'billing_queue', serviceDate: d('2026-11-09'), lineItems: [{ total: '120.50' }] }] }),
      row({ id: 'done', status: 'completed', endDate: d('2026-10-20') }),
    ]);
    prisma.invoice.findMany.mockResolvedValue([
      { rentalAgreementId: 'b', periodEnd: d('2026-10-31') },
      { rentalAgreementId: 'done', periodEnd: d('2026-10-20') },
    ]);
    const rows = await listRentalsForRelease();
    expect(rows.map(r => r.id)).toEqual(['a', 'b', 'c']);
    // Opened Oct 5, never billed: Oct 5 through Nov 12 inclusive, and October's month-end has passed.
    expect(rows[0]).toMatchObject({ state: 'unreleased', kind: 'manned', unbilledDays: 39, overdue: true, padName: 'Bison 4-9H', locationName: 'Bison 4-9H' });
    expect(rows[1]).toMatchObject({ state: 'released', kind: 'non_trailer', unbilledDays: 12, overdue: false });
    expect(rows[2]).toMatchObject({ state: 'closed_blocked', approvedTicketCount: 1, approvedTicketTotal: 120.5,
      blockers: [{ id: 't', ticketNumber: 'FS-9', status: 'supervisor_review', serviceDate: d('2026-11-10') }] });
    expect(rows[2].unbilledDays).toBe(37); // Oct 5 through the Nov 10 close
  });
});
