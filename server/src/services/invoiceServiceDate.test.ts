import { describe, expect, it } from 'vitest';
import { invoiceServiceEndDate } from './invoiceServiceDate.js';

describe('invoice service date', () => {
  const invoiceDate = new Date('2026-11-02');
  it('uses the sweep end even when the record was generated or imported later', () => {
    const periodEnd = new Date('2026-10-31');
    expect(invoiceServiceEndDate({ invoiceDate, periodEnd }, [{ serviceDate: new Date('2026-10-20') }])).toEqual(periodEnd);
  });
  it('uses the last ticket service date when no billing period was recorded', () => {
    expect(invoiceServiceEndDate({ invoiceDate, periodEnd: null }, [
      { serviceDate: new Date('2026-10-20') }, { serviceDate: new Date('2026-10-25') }, { serviceDate: new Date('2026-10-22') },
    ])).toEqual(new Date('2026-10-25'));
  });
  it('retains the saved date when there is no service date to recover', () => {
    expect(invoiceServiceEndDate({ invoiceDate, periodEnd: null })).toEqual(invoiceDate);
  });
});
