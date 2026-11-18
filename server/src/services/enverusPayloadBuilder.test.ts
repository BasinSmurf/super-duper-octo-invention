import { describe, expect, it, vi } from 'vitest';
vi.mock('./enverusClient.js', () => ({ getSupplierDuns: () => 'SUPPLIER' }));
import { buildReceiptPayload, buildInvoiceAsReceiptPayload } from './enverusPayloadBuilder.js';

const profile = { buyerDuns: 'BUYER', defaultPriceBookNumber: '422493-2' };
const ticket: any = { id: 't1', ticketNumber: 'T1', ticketType: 'inspection', serviceDate: new Date('2026-10-20') };
const invoice: any = { id: 'i1', invoiceNumber: 'I1', invoiceDate: ticket.serviceDate, companyName: 'Buyer', total: 185 };
const line: any = { lineNumber: 1, lineType: 'service', description: 'Breathing Air System Inspection — Primary', quantity: 1, rate: 185, amount: 185, partNumber: '0311001' };
const receiptOf = (payload: any) => payload.events[0].data.transform.receipt;

describe('receipt API wire field names', () => {
  it('keeps AFE, cost center and GL code objects separate on every invoice line', () => {
    const receipt = receiptOf(buildInvoiceAsReceiptPayload(invoice, [line, { ...line, lineNumber: 2 }], profile,
      { afeNumber: '330250463800', costCenter: 'ABAKDATACQGO', major: 'ACTIVITY', minor: 'FUNCTION' }));
    for (const item of receipt.lineItems) {
      expect(item).toMatchObject({ afe: { number: '330250463800' }, costCenter: { number: 'ABAKDATACQGO' },
        major: { code: 'ACTIVITY' }, minor: { code: 'FUNCTION' } });
    }
  });
  it.each(['ticket', 'invoice'])('sends %s productServiceCode and contract.number without unsupported aliases', type => {
    const payload = type === 'ticket' ? buildReceiptPayload(ticket, [line], profile)
      : buildInvoiceAsReceiptPayload(invoice, [line], profile);
    const receipt = receiptOf(payload);
    expect(receipt.contract).toEqual({ number: '422493-2' });
    expect(receipt).not.toHaveProperty('priceBookNumber');
    expect(receipt).not.toHaveProperty('poNumber');
    expect(receipt.lineItems[0]).toMatchObject({ productServiceCode: '0311001', description: line.description });
    expect(receipt.lineItems[0]).not.toHaveProperty('serviceCode');
    expect(receipt.lineItems[0]).not.toHaveProperty('partNumber');
  });
  it('adds sales tax as a coded line so the lines sum to the tax-inclusive header total', () => {
    const receipt = receiptOf(buildInvoiceAsReceiptPayload({ ...invoice, total: 472.5, taxAmount: 22.5 },
      [{ ...line, quantity: 10, rate: 45, amount: 450 }], profile,
      { receiptType: 'lem', afeNumber: 'BK', costCenter: 'CC', major: 'FA-L48', minor: 'L48_OPS_H_S', location: 'Vihon 44-8H' }));
    expect(receipt.lineItems).toHaveLength(2);
    expect(receipt.lineItems[1]).toEqual({ lineItemNumber: '2', description: 'Sales Tax', chargeType: 'Material',
      serviceDateFrom: receipt.lineItems[0].serviceDateFrom, serviceDateTo: receipt.lineItems[0].serviceDateTo,
      quantity: 1, unitOfMeasure: 'EA', rate: 22.5, afe: { number: 'BK' }, costCenter: { number: 'CC' },
      major: { code: 'FA-L48' }, minor: { code: 'L48_OPS_H_S' }, location: 'Vihon 44-8H' });
    const sum = receipt.lineItems.reduce((s: number, l: any) => s + l.quantity * l.rate, 0);
    expect(sum).toBe(receipt.totalAmount);
  });
  it('adds no tax line to an untaxed invoice, and no charge type to a General tax line', () => {
    expect(receiptOf(buildInvoiceAsReceiptPayload({ ...invoice, taxAmount: 0 }, [line], profile)).lineItems).toHaveLength(1);
    const general = receiptOf(buildInvoiceAsReceiptPayload({ ...invoice, total: 194.25, taxAmount: 9.25 }, [line], profile));
    expect(general.lineItems[1]).not.toHaveProperty('chargeType');
  });
  it('uses a product part number when no explicit mapping or saved line part number is present', () => {
    const receipt = receiptOf(buildInvoiceAsReceiptPayload(invoice, [{ ...line, partNumber: null, product: { partNumber: '0311001' } }], profile));
    expect(receipt.lineItems[0].productServiceCode).toBe('0311001');
  });
  it('preserves the buyer-profile approver identifiers when its value is overridden', () => {
    const receipt = receiptOf(buildInvoiceAsReceiptPayload(invoice, [line], {
      ...profile, defaultAdditionalDataFields: [{ itemID: '85068', name: 'Invoice Approver', code: 'FIPP',
        value: 'OLD', referenceDetailId: '3251126', type: 'text' }],
    }, { invoiceApproverName: 'JAJEHN' }));
    expect(receipt.additionalDataFields).toEqual([{ itemID: '85068', name: 'Invoice Approver', code: 'FIPP',
      value: 'JAJEHN', referenceDetailId: '3251126', type: 'text' }]);
  });
  it('replaces stale browser approver IDs with current profile IDs while preserving the selected value', () => {
    const receipt = receiptOf(buildInvoiceAsReceiptPayload(invoice, [line], {
      ...profile, defaultAdditionalDataFields: [{ itemID: '85068', name: 'Invoice Approver', code: 'FIPP',
        value: 'DEFAULT', referenceDetailId: '3251126' }],
    }, { additionalDataFields: [{ itemID: '99872', name: 'Invoice Approver', code: 'FIPP',
      value: 'JAJEHN', referenceDetailId: '13212546' }] }));
    expect(receipt.additionalDataFields).toEqual([{ itemID: '85068', name: 'Invoice Approver', code: 'FIPP',
      value: 'JAJEHN', referenceDetailId: '3251126' }]);
  });
});
