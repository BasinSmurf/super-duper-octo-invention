import { describe, expect, it } from 'vitest';
import { billableRentalPeriods, dailyRentalCharges, occupiedRentalPeriods, proratedRentalCharges, isMannedDailyTicket, parseRentalBillingPolicy, rentalBillingDays } from './rentalBillingPolicy.js';

const date = (d: string) => new Date(d);
const pause = { startDate: '2026-09-19', endDate: '2026-09-20' };

describe('rental billing pauses and daily attendance', () => {
  it('prorates periodic prices by active calendar days, with exact stored line arithmetic', () => {
    const charges = proratedRentalCharges(date('2026-08-01'), date('2026-08-31'), 'monthly', 310,
      [{startDate:'2026-08-29',endDate:'2026-09-03'}]);
    expect(charges).toEqual([{ quantity:28,rate:10,amount:280 }]);
    expect(proratedRentalCharges(date('2026-08-01'),date('2026-08-07'),'weekly',70,[{startDate:'2026-08-07',endDate:'2026-08-08'}]))
      .toEqual([{quantity:6,rate:10,amount:60}]);
  });
  it.each([100, 310, 999.99])('preserves a $%s monthly price across every possible invoice split, including penny allocation', rate => {
    const total = (start: number, end: number) => proratedRentalCharges(date(`2026-08-${String(start).padStart(2,'0')}`),
      date(`2026-08-${String(end).padStart(2,'0')}`), 'monthly', rate, [])
      .reduce((sum,line) => { expect(Math.round(line.quantity*line.rate*100)/100).toBe(line.amount); return sum+Math.round(line.amount*100); },0);
    for (let split=1;split<31;split++) expect(total(1,split)+total(split+1,31)).toBe(Math.round(rate*100));
  });
  it('preserves historical daily rates across mode switches and billing periods', () => {
    const policy = { pauses: [{ startDate: '2026-08-31', endDate: '2026-09-01' }], ticketRates: { manned: 100, unmanned: 40 },
      rateChanges: [{ effectiveDate: '2026-09-02', manned: 150, unmanned: 60 }] };
    expect(dailyRentalCharges(date('2026-08-30'), date('2026-09-03'), policy, new Set(['2026-08-30', '2026-09-02'])))
      .toEqual([{ mode: 'manned', rate: 100, days: 1 }, { mode: 'manned', rate: 150, days: 1 }, { mode: 'unmanned', rate: 60, days: 1 }]);
  });
  it('caps same-day swaps at contract slots and excludes collection gaps', () => {
    const items = [{ deployedDate: date('2026-08-01'), returnedDate: date('2026-08-15') },
      { deployedDate: date('2026-08-15'), returnedDate: null }];
    expect(occupiedRentalPeriods(date('2026-08-01'), date('2026-08-31'), 'daily', [], items, 1)).toBe(31);
    items[1].deployedDate = date('2026-08-20');
    expect(occupiedRentalPeriods(date('2026-08-01'), date('2026-08-31'), 'daily', [], items, 1)).toBe(27);
  });
  it('pauses an inclusive weekend and resumes Monday with daily ticket classification', () => {
    const days = rentalBillingDays(date('2026-09-18'), date('2026-09-22'), [pause],
      new Set(['2026-09-18', '2026-09-19', '2026-09-21']));
    expect(days).toEqual({ total: 5, paused: 2, manned: 2, unmanned: 1 });
    expect(days.manned * 500 + days.unmanned * 200).toBe(1200);
  });
  it('does not subtract overlapping pauses twice or count pauses outside the window', () => {
    expect(rentalBillingDays(date('2026-09-18'), date('2026-09-21'), [pause, pause,
      { startDate: '2026-09-20', endDate: '2026-09-30' }]))
      .toEqual({ total: 4, paused: 3, manned: 0, unmanned: 1 });
  });
  it('allows a one-day pause and returns zero for fully paused or future deployment windows', () => {
    expect(billableRentalPeriods(date('2026-09-19'), date('2026-09-19'), 'daily', [pause]).qty).toBe(0);
    expect(billableRentalPeriods(date('2026-09-22'), date('2026-09-21'), 'daily').qty).toBe(0);
  });
  it('preserves normal period billing and prorates weekly/monthly pauses', () => {
    expect(billableRentalPeriods(date('2026-09-14'), date('2026-09-20'), 'weekly').qty).toBe(1);
    expect(billableRentalPeriods(date('2026-09-14'), date('2026-09-20'), 'weekly', [pause]).qty).toBe(0.71);
    expect(billableRentalPeriods(date('2026-09-01'), date('2026-09-30'), 'monthly', [pause]).qty).toBe(0.93);
  });
  it('counts calendar days across month/year and DST boundaries', () => {
    expect(rentalBillingDays(date('2026-12-31'), date('2027-01-01')).total).toBe(2);
    expect(rentalBillingDays(date('2026-03-07'), date('2026-03-09')).total).toBe(3);
  });
  it('requires an actual daily ticket and ignores drafts, dispatches and voids', () => {
    for (const status of ['in_progress', 'completed', 'billing_queue', 'invoiced', 'closed']) {
      expect(isMannedDailyTicket({ status, customData: { onSiteSubtype: 'manned_trailer' } })).toBe(true);
    }
    for (const status of ['draft', 'dispatched', 'void']) {
      expect(isMannedDailyTicket({ status, customData: { onSiteSubtype: 'manned_trailer' } })).toBe(false);
    }
    expect(isMannedDailyTicket({ status: 'completed', customData: { onSiteSubtype: 'confined_space' } })).toBe(false);
    expect(isMannedDailyTicket({ status: 'completed' })).toBe(false);
  });
  it('rejects invalid dates, reversed ranges, and missing/invalid rates; accepts free rates', () => {
    for (const startDate of ['2026-02-30', 'bad', '2026-9-01']) {
      expect(() => parseRentalBillingPolicy({ pauses: [{ startDate, endDate: '2026-09-30' }] })).toThrow();
    }
    expect(() => parseRentalBillingPolicy({ pauses: [{ startDate: '2026-09-21', endDate: '2026-09-20' }] })).toThrow();
    for (const unmanned of [undefined, -1, NaN, Infinity, '100']) {
      expect(() => parseRentalBillingPolicy({ pauses: [], ticketRates: { manned: 100, unmanned } })).toThrow();
    }
    expect(parseRentalBillingPolicy({ pauses: [pause], ticketRates: { manned: 100, unmanned: 0 } }).ticketRates?.unmanned).toBe(0);
  });
});
