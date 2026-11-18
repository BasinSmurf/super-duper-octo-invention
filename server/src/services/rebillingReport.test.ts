import { describe, expect, it } from 'vitest';
import { rebillingReportFilter, combineRebillingTotals } from './rebillingReport.js';

describe('rebilling report', () => {
  it('keeps original operators separate even when the QB customer is the same', () => {
    const row = (companyId: string, companyName: string, total: string, count = 1, billedTo = 'Pale Horse Service Inc') => ({
      companyId, companyName, qbCustomerOverride: billedTo, _count: { _all: count }, _sum: { total },
    });
    expect(combineRebillingTotals([
      row('chord', 'Chord', '385.25', 1), row('other', 'Other', '200.00', 2),
      row('chord', 'Chord renamed', '10.00'), row('chord', 'Chord', '50.00', 1, 'Other payer'),
    ], [row('chord', 'Chord', '404.51', 4)])).toEqual([
      { companyId: 'chord', customer: 'Chord', billedTo: 'Other payer', qbInvoiceCount: 1, qbInvoiceTotal: 50, pendingCount: 0, pendingTotal: 0 },
      { companyId: 'chord', customer: 'Chord', billedTo: 'Pale Horse Service Inc', qbInvoiceCount: 2, qbInvoiceTotal: 395.25, pendingCount: 4, pendingTotal: 404.51 },
      { companyId: 'other', customer: 'Other', billedTo: 'Pale Horse Service Inc', qbInvoiceCount: 2, qbInvoiceTotal: 200, pendingCount: 0, pendingTotal: 0 },
    ]);
  });
  it('excludes void and ordinary invoices, includes the entire through date, and searches both customers', () => {
    expect(rebillingReportFilter({ from: '2026-10-01', through: '2026-10-06', search: ' Chord ' })).toEqual({
      status: { not: 'void' }, qbCustomerOverride: { not: null },
      invoiceDate: { gte: new Date('2026-10-01T00:00:00Z'), lt: new Date('2026-10-07T00:00:00Z') },
      OR: [ { companyName: { contains: 'Chord', mode: 'insensitive' } }, { qbCustomerOverride: { contains: 'Chord', mode: 'insensitive' } } ],
    });
  });
  it('rejects invalid, impossible, and reversed dates', () => {
    for (const query of [{ from: 'garbage' }, { from: '2026-02-30' }, { through: ['2026-01-01'] }, { from: '2026-10-06', through: '2026-10-05' }]) {
      expect(() => rebillingReportFilter(query)).toThrow();
    }
    expect(() => rebillingReportFilter({ from: '2026-10-06', through: '2026-10-06' })).not.toThrow();
  });
});
