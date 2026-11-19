import { beforeEach, describe, expect, it, vi } from 'vitest';
const { findMany } = vi.hoisted(() => ({ findMany: vi.fn() }));
vi.mock('../db.js', async importOriginal => ({ ...await importOriginal<typeof import('../db.js')>(), ...(() => ({ prisma: { serviceTicket: { findMany } } }))() }));
import { computeH2sAnalytics } from './h2sAnalytics.js';
const ticket = (overrides = {}) => ({
  id: 'ticket-1', ticketNumber: 'T-1', serviceDate: new Date('2026-09-10T00:00:00Z'),
  customData: null, ihTestRecords: [], wellId: 'well-1', well: { wellName: 'Well One' },
  padId: null, pad: null, fieldId: null, field: null, locationDisplay: null, ...overrides,
});
beforeEach(() => findMany.mockReset());
describe('H2S test history', () => {
  it('scopes the query to the company, portal statuses and inclusive dates', async () => {
    findMany.mockResolvedValue([]);
    await computeH2sAnalytics('customer-1', { visibleStatuses: ['completed', 'closed'], dateFrom: '2026-09-01', dateTo: '2026-09-15' });
    expect(findMany.mock.calls[0][0].where).toEqual({ companyId: 'customer-1', status: { in: ['completed', 'closed'] }, serviceDate: { gte: new Date('2026-09-01'), lte: new Date('2026-09-15') } });
  });
  it('includes structured tests without custom data and retains zero readings', async () => {
    findMany.mockResolvedValue([ticket({ ihTestRecords: [{ locationPoint: 'Wellhead', testData: { readings: [{ ppmReading: 0 }, { ppmReading: 12, locationPoint: 'Treater' }, { ppmReading: null }, { ppmReading: -1 }] } }] })]);
    const result = await computeH2sAnalytics('customer-1');
    expect(result.locations[0]).toMatchObject({ readingCount: 2, maxH2S: 12, latestH2S: 12 });
    expect(result.locations[0].readings[0]).toMatchObject({ value: 0, context: 'Wellhead', ticketId: 'ticket-1', serviceDate: '2026-09-10' });
  });
  it('does not double count legacy mirrors of structured tests', async () => {
    findMany.mockResolvedValue([ticket({ customData: { gasReadings: [{ type: 'h2s', value: 12 }] }, ihTestRecords: [{ testData: { readings: [{ ppmReading: 12 }] } }] })]);
    expect((await computeH2sAnalytics('customer-1')).locations[0].readingCount).toBe(1);
  });
  it('keeps legacy ppm readings and excludes other gases, units and invalid values', async () => {
    findMany.mockResolvedValue([ticket({ customData: { gasReadings: [{ type: 'h2s', value: 4, unit: 'ppm' }, { type: 'h2s', value: 0 }, { type: 'h2s', value: 1, unit: '%' }, { type: 'o2', value: 20 }, { type: 'h2s', value: 'bad' }] } })]);
    expect((await computeH2sAnalytics('customer-1')).locations[0].readings.map(r => r.value)).toEqual([4, 0]);
  });
});
