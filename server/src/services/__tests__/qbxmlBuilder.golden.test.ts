// qbxmlBuilder.golden.test.ts — ADR-0008 / ADR-0001 safety net.
//
// Two kinds of test here:
//  1) SNAPSHOTS (regression lock): pin the exact bytes the builders emit today,
//     so refactoring qbwc.ts / the wizard can't silently change qbXML output.
//     These lock in CURRENT behavior — including any of the ~25% QB still rejects.
//  2) INVARIANTS (correctness): encode the rules that actually make QuickBooks
//     reject a doc (element ORDER → 0x80040400, 11-char RefNumber cap, ASCII-only
//     sanitization, Tax/Non code refs). These are the start of attacking the 25%:
//     when a real rejection case turns up, add it to FAILURE CORPUS below.
//
// The builders are pure (data in → XML string out), so no DB / network needed.

import { describe, it, expect } from 'vitest';
import {
  buildSalesOrderAdd,
  buildInvoiceAdd,
  buildSalesReceiptAdd,
  buildInvoiceQueryByRefNumber,
  buildItemQueryRq,
  parseInvoiceAddResponse,
  parseInvoiceQueryResponse,
  parseSalesTaxQueryResponse,
  type QbInvoiceData,
  type QbSalesReceiptData,
} from '../qbxmlBuilder.js';

// Fixed date so snapshots are deterministic (Date.now() is never used here).
const TXN_DATE = new Date('2026-06-15T00:00:00.000Z');

function baseInvoice(overrides: Partial<QbInvoiceData> = {}): QbInvoiceData {
  return {
    customerListId: '80000001-1234567890',
    customerFullName: 'Continental Resources',
    txnDate: TXN_DATE,
    refNumber: 'INV-2026-00042',
    poNumber: 'PO-7788',
    classFullName: 'D3',
    salesTaxItemFullName: 'Williston (8%)',
    lines: [
      { qbItemListId: '80000010-1', qbItemFullName: 'Labor:Field', description: 'Field labor', quantity: 2, rate: '95.00', amount: '190.00', isTaxable: false },
      { qbItemListId: '80000011-1', qbItemFullName: 'Parts:Sensor', description: 'H2S sensor', quantity: 1, rate: '120.00', amount: '120.00', isTaxable: true },
    ],
    ...overrides,
  };
}

const refOf = (xml: string) => xml.match(/<RefNumber>(.*?)<\/RefNumber>/)?.[1] ?? '';

describe('qbXML snapshots (regression lock)', () => {
  it('InvoiceAdd — typical (class + tax item + mixed taxable lines)', () => {
    expect(buildInvoiceAdd(baseInvoice())).toMatchSnapshot();
  });

  it('InvoiceAdd — with LOCATION (header <Other>)', () => {
    expect(buildInvoiceAdd(baseInvoice({ otherLocation: 'Pronghorn 44-11PH' }))).toMatchSnapshot();
  });

  it('InvoiceAdd — unmapped item falls back to FullName only (no ListID)', () => {
    expect(buildInvoiceAdd(baseInvoice({
      lines: [{ qbItemListId: null, qbItemFullName: 'Misc', description: 'Catch-all line', quantity: 1, rate: '50.00', amount: '50.00' }],
    }))).toMatchSnapshot();
  });

  it('InvoiceAdd — no sales tax (untaxed, no tax item)', () => {
    expect(buildInvoiceAdd(baseInvoice({
      salesTaxItemFullName: null,
      lines: [{ qbItemFullName: 'Labor', description: 'Labor', quantity: 1, rate: '100.00', amount: '100.00', isTaxable: false }],
    }))).toMatchSnapshot();
  });

  it('SalesOrderAdd — typical', () => {
    expect(buildSalesOrderAdd(baseInvoice())).toMatchSnapshot();
  });

  it('SalesReceiptAdd — card payment', () => {
    const data: QbSalesReceiptData = {
      customerFullName: 'Walk In Purchase',
      txnDate: TXN_DATE,
      refNumber: 'SR-2026-00007',
      paymentMethodName: 'Visa',
      checkNumber: 'ch_3Pabc123',
      salesTaxItemFullName: 'Williston (8%)',
      lines: [{ qbItemFullName: 'Retail:Gloves', description: 'Gloves', quantity: 3, rate: '12.00', amount: '36.00', isTaxable: true }],
    };
    expect(buildSalesReceiptAdd(data)).toMatchSnapshot();
  });

  it('InvoiceQueryByRefNumber + ItemQueryRq', () => {
    expect(buildInvoiceQueryByRefNumber('2026-00042')).toMatchSnapshot();
    expect(buildItemQueryRq()).toMatchSnapshot();
  });
});

describe('qbXML invariants (the rules that make QB reject a doc)', () => {
  // 0x80040400 (QBXML_ERROR_PARSE): elements MUST be in sequence.
  // SalesOrder/Invoice header order: …RefNumber → PONumber → ItemSalesTaxRef → Memo → lines.
  it('ItemSalesTaxRef sits AFTER PONumber and BEFORE Memo (SalesOrderAdd)', () => {
    const xml = buildSalesOrderAdd(baseInvoice({ memo: 'thanks' }));
    const po = xml.indexOf('<PONumber>');
    const tax = xml.indexOf('<ItemSalesTaxRef>');
    const memo = xml.indexOf('<Memo>');
    expect(po).toBeGreaterThanOrEqual(0);
    expect(tax).toBeGreaterThan(po);
    expect(memo).toBeGreaterThan(tax);
  });

  it('ItemSalesTaxRef sits AFTER PONumber and BEFORE Memo (InvoiceAdd)', () => {
    const xml = buildInvoiceAdd(baseInvoice({ memo: 'thanks' }));
    expect(xml.indexOf('<ItemSalesTaxRef>')).toBeGreaterThan(xml.indexOf('<PONumber>'));
    expect(xml.indexOf('<Memo>')).toBeGreaterThan(xml.indexOf('<ItemSalesTaxRef>'));
  });

  it('FOB sits AFTER PONumber and BEFORE ItemSalesTaxRef (InvoiceAdd)', () => {
    const xml = buildInvoiceAdd(baseInvoice({ fob: 'Jane Foreman' }));
    expect(xml.indexOf('<FOB>Jane Foreman</FOB>')).toBeGreaterThan(xml.indexOf('<PONumber>'));
    expect(xml.indexOf('<ItemSalesTaxRef>')).toBeGreaterThan(xml.indexOf('<FOB>Jane Foreman</FOB>'));
  });

  it('Invoice line ServiceDate sits before SalesTaxCodeRef', () => {
    const xml = buildInvoiceAdd(baseInvoice({
      lines: [{
        qbItemFullName: 'Rental',
        description: 'Rental package',
        quantity: 1,
        rate: '100.00',
        amount: '100.00',
        serviceDate: '2026-06-30',
        isTaxable: true,
      }],
    }));
    expect(xml.indexOf('<ServiceDate>2026-06-30</ServiceDate>')).toBeGreaterThan(xml.indexOf('<Rate>100.00</Rate>'));
    expect(xml.indexOf('<SalesTaxCodeRef>')).toBeGreaterThan(xml.indexOf('<ServiceDate>2026-06-30</ServiceDate>'));
  });

  // The Basin invoice template renames the header <Other> field to LOCATION.
  // Sequence: …ItemSalesTaxRef → Memo → … → Other → line adds.
  it('Other sits AFTER Memo and BEFORE the first line add (InvoiceAdd)', () => {
    const xml = buildInvoiceAdd(baseInvoice({ memo: 'thanks', otherLocation: 'Pronghorn 44-11PH' }));
    expect(xml.indexOf('<Other>')).toBeGreaterThan(xml.indexOf('<Memo>'));
    expect(xml.indexOf('<Other>')).toBeLessThan(xml.indexOf('<InvoiceLineAdd>'));
  });

  it('Other sits AFTER Memo and BEFORE the first line add (SalesOrderAdd)', () => {
    const xml = buildSalesOrderAdd(baseInvoice({ memo: 'thanks', otherLocation: 'Pronghorn 44-11PH' }));
    expect(xml.indexOf('<Other>')).toBeGreaterThan(xml.indexOf('<Memo>'));
    expect(xml.indexOf('<Other>')).toBeLessThan(xml.indexOf('<SalesOrderLineAdd>'));
  });

  it('Other is capped at QB max 29 chars, and omitted when empty', () => {
    const long = buildInvoiceAdd(baseInvoice({ otherLocation: 'Pronghorn Federal 44-11PH 3BX North Unit' }));
    expect(long).toContain('<Other>Pronghorn Federal 44-11PH 3BX</Other>');
    expect(buildInvoiceAdd(baseInvoice({ otherLocation: '   ' }))).not.toContain('<Other>');
    expect(buildInvoiceAdd(baseInvoice({ otherLocation: null }))).not.toContain('<Other>');
  });

  it('RefNumber is truncated to QB max 11 chars', () => {
    const xml = buildInvoiceAdd(baseInvoice({ refNumber: 'INVOICE-2026-000000042' }));
    expect(refOf(xml).length).toBeLessThanOrEqual(11);
  });

  it('output is ASCII-sanitized (smart quotes, em-dash, H2S subscript stripped/normalized)', () => {
    const xml = buildInvoiceAdd(baseInvoice({
      lines: [{ qbItemFullName: 'X', description: 'H₂S “smart” quotes — em', quantity: 1, rate: '1.00', amount: '1.00' }],
    }));
    // None of the offending non-ASCII characters should survive into qbXML.
    expect(xml).not.toMatch(/[‘’“”—₂]/);
  });

  it('per-line tax code ref: true→Tax, false→Non, undefined→absent', () => {
    const taxable = buildInvoiceAdd(baseInvoice({ lines: [{ qbItemFullName: 'X', description: 'd', quantity: 1, rate: '1', amount: '1', isTaxable: true }] }));
    const nonTaxable = buildInvoiceAdd(baseInvoice({ lines: [{ qbItemFullName: 'X', description: 'd', quantity: 1, rate: '1', amount: '1', isTaxable: false }] }));
    const omitted = buildInvoiceAdd(baseInvoice({ lines: [{ qbItemFullName: 'X', description: 'd', quantity: 1, rate: '1', amount: '1' }] }));
    expect(taxable).toContain('<SalesTaxCodeRef><FullName>Tax</FullName></SalesTaxCodeRef>');
    expect(nonTaxable).toContain('<SalesTaxCodeRef><FullName>Non</FullName></SalesTaxCodeRef>');
    expect(omitted).not.toContain('<SalesTaxCodeRef>');
  });

  it('missing CustomerRef throws (never emit a doc QB will hard-reject)', () => {
    expect(() => buildInvoiceAdd(baseInvoice({ customerListId: null, customerFullName: null }))).toThrow();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Sales-tax pull parsing. Both Ret kinds embed nested <SomethingRef> blocks
// whose ListID/FullName belong to the REFERENCED record: items carry a
// TaxVendorRef (agency vendor), groups carry one ItemSalesTaxRef per member.
// Case 2026-07-10: every item's fullName came back as its agency vendor
// ("ND State Tax Commissioner"); mapping a jurisdiction to that string sent
// <ItemSalesTaxRef><FullName>vendor</FullName>… → QB 3140 invalid reference.
describe('parseSalesTaxQueryResponse', () => {
  const RESPONSE = [
    '<QBXML><QBXMLMsgsRs>',
    '<ItemSalesTaxQueryRs statusCode="0" statusSeverity="Info">',
    '  <ItemSalesTaxRet>',
    '    <ListID>80000A01-1</ListID>',
    '    <TimeModified>2026-07-01T10:00:00-06:00</TimeModified>',
    '    <Name>ND State Sales Tax</Name>',
    '    <IsActive>true</IsActive>',
    '    <ItemDesc>North Dakota state sales tax</ItemDesc>',
    '    <TaxRate>5.0</TaxRate>',
    '    <TaxVendorRef>',
    '      <ListID>80000V01-1</ListID>',
    '      <FullName>ND State Tax Commissioner</FullName>',
    '    </TaxVendorRef>',
    '  </ItemSalesTaxRet>',
    '  <ItemSalesTaxRet>',
    '    <ListID>80000A02-1</ListID>',
    '    <Name>MT No Sales Tax</Name>',
    '    <IsActive>false</IsActive>',
    '    <TaxRate>0.0</TaxRate>',
    '    <TaxVendorRef>',
    '      <ListID>80000V02-1</ListID>',
    '      <FullName>Montana State Capital</FullName>',
    '    </TaxVendorRef>',
    '  </ItemSalesTaxRet>',
    '</ItemSalesTaxQueryRs>',
    '<ItemSalesTaxGroupQueryRs statusCode="0" statusSeverity="Info">',
    '  <ItemSalesTaxGroupRet>',
    '    <ListID>80000B01-1</ListID>',
    '    <Name>Williston Combined Rate</Name>',
    '    <IsActive>true</IsActive>',
    '    <ItemSalesTaxRef>',
    '      <ListID>80000A01-1</ListID>',
    '      <FullName>North Dakota State Component</FullName>',
    '    </ItemSalesTaxRef>',
    '    <ItemSalesTaxRef>',
    '      <ListID>80000A03-1</ListID>',
    '      <FullName>Williston City Component</FullName>',
    '    </ItemSalesTaxRef>',
    '  </ItemSalesTaxGroupRet>',
    '</ItemSalesTaxGroupQueryRs>',
    '</QBXMLMsgsRs></QBXML>',
  ].join('\n');

  it('items: fullName is the item Name, never the TaxVendorRef vendor', () => {
    const items = parseSalesTaxQueryResponse(RESPONSE).filter(r => r.recordType === 'item');
    expect(items.map(i => i.fullName)).toEqual(['ND State Sales Tax', 'MT No Sales Tax']);
    expect(items[0]).toMatchObject({
      qbListId: '80000A01-1',
      isActive: true,
      description: 'North Dakota state sales tax',
      taxRatePercent: 5,
    });
    expect(items[1]?.isActive).toBe(false);
  });

  it('groups: fullName is the group Name, never a member ref', () => {
    const groups = parseSalesTaxQueryResponse(RESPONSE).filter(r => r.recordType === 'group');
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      qbListId: '80000B01-1',
      fullName: 'Williston Combined Rate',
      taxRatePercent: null,
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// FAILURE CORPUS — the path to clawing back the ~25% QB still rejects.
// When a real QB rejection turns up, drop it here as a failing test:
//   - the input data that produced it,
//   - the QB error (e.g. 0x80040400 + statusMessage),
//   - and (if known) the corrected XML.
// Make it red, fix the builder, make it green. Each one is a permanent guard.
// Example skeleton (kept skipped until a real case is supplied):
describe('error message extraction (statusMessage is free-form English)', () => {
  // The Ops Dashboard's whole triage story is error_message. When the parser
  // clips it, every distinct failure reads as the same useless prefix — which
  // is exactly what 20 identical "There was a required element (" rows were.
  it('keeps the whole message when QB quotes an element name', () => {
    const xml = '<?xml version="1.0"?><QBXML><QBXMLMsgsRs>'
      + '<InvoiceAddRs requestID="1" statusCode="3140" statusSeverity="Error"'
      + ' statusMessage="There was an error when saving an Invoice. QuickBooks error message:'
      + ' Invalid reference to &quot;ItemSalesTaxRef&quot; in the Invoice." />'
      + '</QBXMLMsgsRs></QBXML>';

    const result = parseInvoiceAddResponse(xml);

    expect(result.statusCode).toBe('3140');
    expect(result.statusMessage).toBe(
      'There was an error when saving an Invoice. QuickBooks error message:'
      + ' Invalid reference to "ItemSalesTaxRef" in the Invoice.',
    );
  });

  it('survives a > inside the message', () => {
    // `[^>]*` used to abort the hop to the attribute here, so statusMessage
    // came back null and the caller stored the string "Unknown".
    const xml = '<?xml version="1.0"?><QBXML><QBXMLMsgsRs>'
      + '<InvoiceQueryRs requestID="2" statusCode="500" statusSeverity="Error"'
      + ' statusMessage="The element &lt;TxnID&gt; is out of order." />'
      + '</QBXMLMsgsRs></QBXML>';

    const result = parseInvoiceQueryResponse(xml);

    expect(result.statusCode).toBe('500');
    expect(result.statusMessage).toBe('The element <TxnID> is out of order.');
  });

  it('reads a single-quoted attribute', () => {
    const xml = "<?xml version='1.0'?><QBXML><QBXMLMsgsRs>"
      + "<InvoiceAddRs statusCode='3120' statusSeverity='Error'"
      + " statusMessage='Object not found.' />"
      + '</QBXMLMsgsRs></QBXML>';

    expect(parseInvoiceAddResponse(xml).statusMessage).toBe('Object not found.');
  });
});

describe.skip('FAILURE CORPUS (fill from real QB rejections)', () => {
  it('case YYYY-MM-DD: <short description of what QB rejected>', () => {
    // const xml = buildInvoiceAdd({ ...the input that QB rejected... });
    // expect(xml).toContain(/* the element/order/value that should be present */);
  });
});
