import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { rentalSweepLines } from './rentalSweepLines.js';
import { buildInvoiceAdd, buildSalesOrderAdd } from './qbxmlBuilder.js';

describe('rental sweep customer lines', () => {
  const rows = [
    { partNumber: '0400002', description: 'FS-1 \u2014 Deploy labor', sourceTicketNumber: 'FS-1', quantity: 1.5, rate: 80, amount: 120, isTaxable: false },
    { partNumber: '0400001', description: 'FS-1 \u2014 Deploy miles', sourceTicketNumber: 'FS-1', quantity: 20, rate: 3, amount: 60, isTaxable: false },
    { partNumber: '0400002', description: 'FS-2 \u2014 Return labor', sourceTicketNumber: 'FS-2', quantity: 2, rate: 90, amount: 180, isTaxable: false },
    { partNumber: '0400001', description: 'FS-2 \u2014 Return miles', sourceTicketNumber: 'FS-2', quantity: 30, rate: 3, amount: 90, isTaxable: false },
    { partNumber: '0411011', description: 'Trailer rental package', quantity: 4, rate: 200, amount: 800, isTaxable: true },
    { partNumber: '0399999', description: 'FS-2 \u2014 Calibration', sourceTicketNumber: 'FS-2', quantity: 1, rate: 50, amount: 50, isTaxable: false },
  ];
  it('totals hours and miles and removes ticket references without changing stored rows', () => {
    const result = rentalSweepLines(rows);
    expect(result).toHaveLength(4);
    expect(result[0]).toMatchObject({ description: 'Labor', quantity: 3.5, amount: 300, sourceTicketNumber: null });
    expect(result[1]).toMatchObject({ description: 'Mileage', quantity: 50, amount: 150 });
    expect(result[2]).toEqual(rows[4]);
    expect(result[3].description).toBe('Calibration');
    expect(rows[0].description).toBe('FS-1 \u2014 Deploy labor');
    expect(rows[0].quantity).toBe(1.5);
    expect(rentalSweepLines([{ ...rows[0], quantity: 0, amount: 0 }, rows[2]])[0].rate).toBe(90);
  });
  it.each([buildInvoiceAdd, buildSalesOrderAdd])('exports totals with exact amounts across mixed labor rates', build => {
    const xml = build({ customerFullName: 'Customer', txnDate: '2026-11-02', refNumber: 'INV-1',
      lines: rentalSweepLines(rows).map(row => ({ ...row, rate: String(row.rate), amount: String(row.amount) })) });
    expect(xml).toContain('<Desc>Labor</Desc>');
    expect(xml).toContain('<Quantity>3.5</Quantity>');
    expect(xml).toContain('<Amount>300.00</Amount>');
    expect(xml).toContain('<Quantity>50</Quantity>');
    expect(xml).toContain('<Amount>150.00</Amount>');
    expect(xml).not.toContain('FS-');
  });
  it('preserves tax and QB exclusion boundaries', () => {
    expect(rentalSweepLines([rows[0], { ...rows[0], isTaxable: true }, { ...rows[0], qbSkip: true }])).toHaveLength(3);
  });
  it('keeps browser and server presentation rules identical', () => {
    expect(readFileSync(new URL('../../../client/src/lib/rentalSweepLines.ts', import.meta.url), 'utf8'))
      .toBe(readFileSync(new URL('./rentalSweepLines.ts', import.meta.url), 'utf8'));
  });
});
