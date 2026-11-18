import { describe, expect, it } from 'vitest';
import { buildInvoiceAdd, buildSalesOrderAdd } from '../qbxmlBuilder.js';

describe.each([buildInvoiceAdd, buildSalesOrderAdd])('QB PO/AFE export limits', build => {
  const render = (poNumber: string, memo?: string) => build({ customerFullName: 'SYNTHETIC', refNumber: 'INV-2026-00839', txnDate: '2026-09-28', poNumber, memo, lines: [] });
  it('reproduces QB3070 and preserves the full rejected reference in Memo', () => {
    const reference = 'SYN-FIELD-002-PO / SYN-FIELD-002-AFE';
    const xml = render(reference, 'SW-2026-00382');
    expect(xml).toContain(`<PONumber>${reference.slice(0,25)}</PONumber>`);
    expect(xml).toContain(`<Memo>SW-2026-00382\nPO/AFE: ${reference}</Memo>`);
  });
  it('preserves an exact 25-character PO and does not add redundant memo text', () => {
    const reference = 'P'.repeat(25);
    expect(render(reference, 'Job')).toContain(`<PONumber>${reference}</PONumber>`);
    expect(render(reference, 'Job')).toContain('<Memo>Job</Memo>');
  });
  it('limits decoded characters without splitting XML entities', () => {
    const xml = render('P'.repeat(24) + '&XYZ');
    expect(xml).toContain(`<PONumber>${'P'.repeat(24)}&amp;</PONumber>`);
    expect(xml).toContain(`<Memo>PO/AFE: ${'P'.repeat(24)}&amp;XYZ</Memo>`);
  });
  it('applies the limit after ASCII normalization', () => {
    expect(render('P'.repeat(24) + '…')).toContain(`<PONumber>${'P'.repeat(24)}.</PONumber>`);
    expect(render('P'.repeat(24) + '…')).toContain(`<Memo>PO/AFE: ${'P'.repeat(24)}...</Memo>`);
  });
  it('rejects an overflow that cannot fit in the memo rather than dropping reference text', () => {
    expect(() => render('P'.repeat(26), 'M'.repeat(4095))).toThrow(/Memo.*4095/);
  });
});
