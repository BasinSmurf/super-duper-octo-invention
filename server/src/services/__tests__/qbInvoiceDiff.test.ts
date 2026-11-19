import { describe, expect, it } from 'vitest';
import { parseInvoiceDiffResponse } from '../qbxmlBuilder.js';

const invoice = (fields: string) => `<QBXML><QBXMLMsgsRs><InvoiceQueryRs statusCode="0" statusMessage="Status OK"><InvoiceRet>${fields}<InvoiceLineRet><Amount>3000.00</Amount></InvoiceLineRet></InvoiceRet></InvoiceQueryRs></QBXMLMsgsRs></QBXML>`;

describe('QuickBooks invoice gross total', () => {
  it('includes sales tax in a Desktop InvoiceRet without TotalAmount', () => {
    expect(parseInvoiceDiffResponse(invoice('<Subtotal>3000.00</Subtotal><SalesTaxTotal>150.00</SalesTaxTotal><BalanceRemaining>3150.00</BalanceRemaining>')).qbTotal).toBe(3150);
  });
  it('keeps the original gross total after partial payment', () => {
    expect(parseInvoiceDiffResponse(invoice('<Subtotal>3000.00</Subtotal><SalesTaxTotal>150.00</SalesTaxTotal><AppliedAmount>1000.00</AppliedAmount><BalanceRemaining>2150.00</BalanceRemaining>')).qbTotal).toBe(3150);
  });
  it('uses balance plus applied payments if subtotal is absent', () => {
    expect(parseInvoiceDiffResponse(invoice('<AppliedAmount>3150.00</AppliedAmount><BalanceRemaining>0.00</BalanceRemaining>')).qbTotal).toBe(3150);
  });
  it('retains an explicit total, including zero', () => {
    expect(parseInvoiceDiffResponse(invoice('<TotalAmount>0.00</TotalAmount><Subtotal>3000.00</Subtotal>')).qbTotal).toBe(0);
  });
  it('handles invoices with no sales tax', () => {
    expect(parseInvoiceDiffResponse(invoice('<Subtotal>3000.00</Subtotal>')).qbTotal).toBe(3000);
  });
  it('does not fabricate an amount from missing or invalid values', () => {
    expect(parseInvoiceDiffResponse(invoice('<Subtotal>invalid</Subtotal>')).qbTotal).toBeNull();
  });
});
