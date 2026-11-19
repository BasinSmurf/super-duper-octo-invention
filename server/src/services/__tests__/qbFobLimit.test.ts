import { describe, expect, it } from 'vitest';
import { buildInvoiceAdd, buildSalesOrderAdd } from '../qbxmlBuilder.js';

describe.each([buildInvoiceAdd, buildSalesOrderAdd])('QB FOB field length', build => {
  const render = (fob: string) => build({ customerFullName: 'Test', refNumber: 'INV-2026-00170', txnDate: '2026-09-24', fob, lines: [] });
  it('fits long site contacts into the QB 13-character field', () => {
    expect(render('DIAG Site Contact')).toContain('<FOB>DIAG Site Con</FOB>');
  });
  it('limits decoded characters without cutting XML entities', () => {
    expect(render('123456789012&ABC')).toContain('<FOB>123456789012&amp;</FOB>');
  });
  it('normalizes text before limiting and preserves short names', () => {
    expect(render('Jane Foreman')).toContain('<FOB>Jane Foreman</FOB>');
    expect(render('1234567890…abc')).toContain('<FOB>1234567890...</FOB>');
    expect(render('')).not.toContain('<FOB>');
  });
});
