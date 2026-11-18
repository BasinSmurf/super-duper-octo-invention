import { describe, expect, it, vi } from 'vitest';
import { appendRentalEventLog } from './rentalEventLog.js';

const ticket = { id: 'visit', ticketNumber: 'FS-1', linkedRentalAgreementId: 'rental',
  serviceDate: new Date('2026-09-22T17:00:00Z'), assignedTechId: 'tech', workDescription: 'Equipment return\nMonitor: 123' };
function harness(existing: any = null) {
  return { rentalDailyLog: { findFirst: vi.fn(async () => existing), create: vi.fn(), update: vi.fn() } };
}
describe('equipment visit job log', () => {
  it('uses the service day and ticket identity without closing a billable ticket', async () => {
    const tx = harness();
    await appendRentalEventLog(tx as any, ticket);
    const data = tx.rentalDailyLog.create.mock.calls[0][0].data;
    expect(data.logDate).toEqual(new Date('2026-09-22'));
    expect(data.loggedById).toBe('tech');
    expect(data.entries[0]).toMatchObject({ ticketId: 'visit', text: 'Service ticket FS-1 — Equipment return\nMonitor: 123' });
  });
  it('uses the recorded service time for backdated visits and leaves an unknown time blank', async () => {
    const tx = harness();
    await appendRentalEventLog(tx as any, { ...ticket, arrivalTime: new Date('2026-09-22T15:30:00Z') });
    expect(tx.rentalDailyLog.create.mock.calls[0][0].data.entries[0]).toMatchObject({ date: '2026-09-22', time: '15:30' });
    const noTime = harness(); await appendRentalEventLog(noTime as any, ticket);
    expect(noTime.rentalDailyLog.create.mock.calls[0][0].data.entries[0].time).toBe('');
  });
  it('appends to an existing Daily and preserves its entries', async () => {
    const prior = { id: 'daily', entries: [{ id: 'shift', text: 'Shift start' }] };
    const tx = harness(prior);
    await appendRentalEventLog(tx as any, ticket);
    expect(tx.rentalDailyLog.update.mock.calls[0][0].data.entries).toEqual([prior.entries[0], expect.objectContaining({ ticketId: 'visit' })]);
    expect(tx.rentalDailyLog.create).not.toHaveBeenCalled();
  });
  it.each([{ ticketId: 'visit' }, { text: 'Service ticket FS-1 — Equipment return' }])('does not duplicate a retry or record-only log: %o', async entry => {
    const tx = harness({ id: 'daily', entries: [entry] });
    await appendRentalEventLog(tx as any, ticket);
    expect(tx.rentalDailyLog.update).not.toHaveBeenCalled();
    expect(tx.rentalDailyLog.create).not.toHaveBeenCalled();
  });
});
