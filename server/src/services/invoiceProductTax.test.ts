import { describe, expect, it, vi } from 'vitest';
import { applyInvoiceProductTax } from './invoiceProductTax.js';
import { computeTaxAmount } from './salesTax.js';
import { parseItemQueryResponse } from './qbxmlBuilder.js';
import { productCreateFromQbItem } from './qbItemMapping.js';

describe('QB item tax defaults', () => {
  it('parses Tax, Non, and custom codes by stable ListID, without guessing absent codes', () => {
    const items = parseItemQueryResponse([
      '<SalesTaxCodeRet><ListID>tax-service</ListID><Name>LBR</Name><IsTaxable>false</IsTaxable></SalesTaxCodeRet>',
      ...['Tax', 'Non', 'LBR', 'UNKNOWN', ''].map((name, i) => `<ItemServiceRet><ListID>p${i}</ListID><FullName>Item${i}</FullName>
        ${name ? `<SalesTaxCodeRef>${name === 'LBR' ? '<ListID>tax-service</ListID>' : ''}<FullName>${name}</FullName></SalesTaxCodeRef>` : ''}
        <PurchaseTaxCodeRef><FullName>Tax</FullName></PurchaseTaxCodeRef></ItemServiceRet>`),
    ].join(''));
    expect(items.map(item => item.isTaxable)).toEqual([true, false, false, null, null]);
    expect(productCreateFromQbItem(items[1], new Date()).isTaxable).toBe(false);
    expect(productCreateFromQbItem(items[0], new Date()).isTaxable).toBe(true);
    expect(productCreateFromQbItem(items[3], new Date())).not.toHaveProperty('isTaxable');
  });
  it('applies imported flags before computing totals, matching ID, QB mapping, or part number', async () => {
    const db = { product: { findMany: vi.fn(async () => [
      { id: 'labor', partNumber: '0400002', qbItemListId: 'qb-labor', isTaxable: false },
      { id: 'rental', partNumber: '0411011', qbItemListId: 'qb-rental', isTaxable: true },
    ]) } };
    const lines = [
      { productId: 'labor', isTaxable: true, amount: 200 },
      { qbItemListId: 'qb-labor', isTaxable: true, amount: 100 },
      { partNumber: '0411011', isTaxable: false, amount: 800 },
      { partNumber: 'unmapped', isTaxable: false, amount: 50 },
    ];
    await applyInvoiceProductTax(db as any, lines, false);
    expect(lines.map(line => line.isTaxable)).toEqual([false, false, true, false]);
    expect(computeTaxAmount(lines, 0.08)).toBe(64);
    await applyInvoiceProductTax(db as any, lines, true);
    expect(lines.every(line => !line.isTaxable)).toBe(true);
    expect(db.product.findMany).toHaveBeenCalledTimes(1);
  });
});
