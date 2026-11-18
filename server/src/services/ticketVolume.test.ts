import { beforeEach, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../db.js';
import { getTicketVolume } from './ticketVolume.js';

const groupBy = vi.fn();
const db = { serviceTicket: { groupBy } } as unknown as PrismaClient;
beforeEach(() => { groupBy.mockReset().mockResolvedValue([]); });

it('includes all 30 dates even when no tickets were submitted', async () => {
  const report = await getTicketVolume(db, new Date('2026-11-16T00:00:00Z'));
  expect(report).toMatchObject({ from: '2026-10-18', to: '2026-11-16', total: 0 });
  expect(report.days).toHaveLength(30);
  expect(report.days.every(day => day.count === 0)).toBe(true);
  expect(new Set(report.days.map(day => day.date)).size).toBe(30);
});

it('aggregates by service date, includes today, and excludes drafts, voids and future dates', async () => {
  groupBy.mockResolvedValue([
    { serviceDate: new Date('2026-11-16'), _count: { id: 4 } },
    { serviceDate: new Date('2026-10-18'), _count: { id: 2 } },
  ]);
  const report = await getTicketVolume(db, new Date('2026-11-16'));
  expect(groupBy).toHaveBeenCalledWith({
    by: ['serviceDate'], _count: { id: true },
    where: { serviceDate: { gte: new Date('2026-10-18'), lt: new Date('2026-11-17') }, status: { notIn: ['draft', 'void'] } },
  });
  expect(report.total).toBe(6);
  expect(report.days[0]).toEqual({ date: '2026-10-18', count: 2 });
  expect(report.days[29]).toEqual({ date: '2026-11-16', count: 4 });
  expect(report.days[1]).toEqual({ date: '2026-10-19', count: 0 });
});

it.each([
  ['2026-03-16', '2026-02-15'], // spring DST change
  ['2026-11-16', '2026-10-18'], // fall DST change
  ['2028-03-15', '2028-02-15'], // leap day
  ['2027-01-10', '2026-12-12'], // year boundary
])('keeps 30 consecutive calendar dates through %s', async (through, from) => {
  const report = await getTicketVolume(db, new Date(through));
  expect(report.from).toBe(from);
  expect(report.to).toBe(through);
  expect(report.days).toHaveLength(30);
  expect(report.days.every((day, index) => index === 0 || +new Date(day.date) - +new Date(report.days[index - 1].date) === 86_400_000)).toBe(true);
});

it('propagates database failures rather than fabricating an empty report', async () => {
  groupBy.mockRejectedValue(new Error('DB unavailable'));
  await expect(getTicketVolume(db, new Date('2026-11-16'))).rejects.toThrow('DB unavailable');
});
