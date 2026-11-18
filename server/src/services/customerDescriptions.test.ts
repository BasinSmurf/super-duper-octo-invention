import { describe, expect, it, vi } from 'vitest';
import { applyCustomerDescriptions, resolveCustomerDescription, type CustomerDescription } from './customerDescriptions.js';
import { buildInvoiceAdd } from './qbxmlBuilder.js';
import { buildInvoiceAsReceiptPayload, buildReceiptPayload } from './enverusPayloadBuilder.js';

const rule: CustomerDescription = { productId: 'p1', qbItemListId: 'QB-1', partNumber: '0300001',
  standardName: 'Primary breathing air', standardDescription: null, description: 'Cycle 1 breathing inspection' };
const baseLine = { description: 'Primary breathing air', qbItemListId: 'QB-1', quantity: 2,
  rate: 75, amount: 150, isTaxable: true, lineNumber: 1, partNumber: '0300001', unitOfMeasure: 'EA' };
function database(rules: CustomerDescription[] = [rule]) {
  return { company: { findUnique: vi.fn(async () => ({ customerDescriptions: rules })) },
    product: { findMany: vi.fn(async () => [{ qbItemListId: 'QB-1', name: 'Renamed item', description: null }]) } };
}

describe('customer billing wording', () => {
  it('preserves ticket, date, serial and quantity context', () => {
    expect(resolveCustomerDescription('T-123 — Primary breathing air (S/N: 987) × 2 — 9/24', rule))
      .toBe('T-123 — Cycle 1 breathing inspection (S/N: 987) × 2 — 9/24');
    expect(resolveCustomerDescription('Custom work at Pad 7', rule)).toBe('Cycle 1 breathing inspection — Custom work at Pad 7');
  });
  it('matches stable item identity and leaves financial fields and unrelated lines intact', async () => {
    const lines = [{ ...baseLine, description: 'Renamed item', partNumber: 'NEW-PART' },
      { ...baseLine, qbItemListId: 'OTHER' }, { ...baseLine, quantity: 0 }, { ...baseLine, qbSkip: true }];
    const original = structuredClone(lines);
    await applyCustomerDescriptions(database() as any, 'customer1', lines);
    expect(lines[0]).toEqual({ ...original[0], description: rule.description, originalDescription: 'Renamed item' });
    expect(lines.slice(1)).toEqual(original.slice(1));
  });
  it('leaves customers without overrides unchanged', async () => {
    const db = database([]);
    const lines = [{ ...baseLine }];
    await applyCustomerDescriptions(db as any, 'other-customer', lines);
    expect(lines).toEqual([baseLine]);
    expect(db.product.findMany).not.toHaveBeenCalled();
  });
  it('exports the persisted snapshot to QB and every Enverus invoice/receipt shape', async () => {
    const db = database();
    const lines: any[] = [{ ...baseLine, product: { enverusProductServiceDescription: 'Catalog wording', enverusProductServiceCode: '0300001' } }];
    await applyCustomerDescriptions(db as any, 'customer1', lines);
    // Changing the rule after generation must not affect the saved invoice.
    db.company.findUnique.mockResolvedValue({ customerDescriptions: [{ ...rule, description: 'Later wording' }] });
    const invoice: any = { id: 'i1', invoiceNumber: 'INV1', invoiceDate: new Date('2026-09-24'), companyName: 'Customer', subtotal: 150, total: 150, taxAmount: 0 };
    const xml = buildInvoiceAdd({ customerFullName: 'Customer', txnDate: invoice.invoiceDate, refNumber: 'INV1', lines } as any);
    expect(xml).toContain(`<Desc>${rule.description}</Desc>`);
    expect(xml).toContain('<ListID>QB-1</ListID>');
    const receipt: any = buildInvoiceAsReceiptPayload(invoice, lines, {});
    expect(receipt.events[0].data.transform.receipt.lineItems[0].description).toBe(rule.description);
    const ticketReceipt: any = buildReceiptPayload({ id: 't1', ticketNumber: 'T1', ticketType: 'service', serviceDate: invoice.invoiceDate },
      lines.map(line => ({ ...line, lineType: 'labor', total: line.amount })), {});
    expect(ticketReceipt.events[0].data.transform.receipt.lineItems[0].description).toBe(rule.description);
    expect(db.company.findUnique).toHaveBeenCalledTimes(1);
  });
  it('keeps manual wording and original Enverus charge classification', () => {
    const line: any = { ...baseLine, description: 'Manually approved inspection', originalDescription: 'Monitor rental' };
    const receipt: any = buildInvoiceAsReceiptPayload({ id: 'i', invoiceNumber: 'INV', invoiceDate: new Date(), companyName: 'Customer', subtotal: 150, total: 150, taxAmount: 0 } as any,
      [line], {}, { receiptType: 'lem' });
    expect(receipt.events[0].data.transform.receipt.lineItems[0]).toMatchObject({ description: 'Manually approved inspection', chargeType: 'Equipment' });
  });
});
