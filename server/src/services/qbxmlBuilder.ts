/**
 * qbXML Request Builder
 *
 * Builds qbXML request strings for QuickBooks Desktop via QBWC.
 * Invoices post directly as QB Invoices (InvoiceAdd) by default. Customers with
 * Company.qbUsesSalesOrder push a SalesOrder instead, and the comptroller
 * converts SO→Invoice in QB Desktop (legacy path, opt-in).
 */

import { decodeHtmlEntities, decodeHtmlEntitiesOrNull } from '../utils/htmlEntities.js';

// Fallback QB item when a line has no item mapping
const QB_FALLBACK_ITEM = process.env.QB_FALLBACK_ITEM || 'Misc';

// XML-escape special characters and sanitize for QB's strict XML parser
function esc(val: string | null | undefined): string {
  if (!val) return '';
  return val
    // Replace common Unicode chars that QB's parser chokes on
    .replace(/\u2014/g, '-')   // em dash → hyphen
    .replace(/\u2013/g, '-')   // en dash → hyphen
    .replace(/\u2018/g, "'")   // left single quote → apostrophe
    .replace(/\u2019/g, "'")   // right single quote → apostrophe
    .replace(/\u201C/g, '"')   // left double quote → quote
    .replace(/\u201D/g, '"')   // right double quote → quote
    .replace(/\u2026/g, '...') // ellipsis → three dots
    .replace(/\u00B2/g, '2')   // superscript 2 (H₂S) → 2
    .replace(/\u2082/g, '2')   // subscript 2 (H₂S) → 2
    .replace(/\u00B3/g, '3')   // superscript 3 (NH₃) → 3
    .replace(/\u2083/g, '3')   // subscript 3 (NH₃) → 3
    // Strip any remaining non-ASCII chars that could break QB
    .replace(/[^\x20-\x7E\n\r\t]/g, '')
    // Standard XML escapes
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Truncate RefNumber to QB's 11-char limit.
 * INV-2026-00004 → 2026-00004  (10 chars, fits)
 */
function qbRefNumber(ref: string): string {
  let short = ref.replace(/^INV-/, '').replace(/^SO-/, '');
  return short.substring(0, 11);
}

// Format a Date as YYYY-MM-DD for qbXML
function qbDate(d: Date | string | null): string {
  if (!d) return new Date().toISOString().slice(0, 10);
  const dt = typeof d === 'string' ? new Date(d) : d;
  return dt.toISOString().slice(0, 10);
}

// Format a Decimal/number as string with 2 decimal places
function qbAmount(val: any): string {
  const n = typeof val === 'object' && val !== null
    ? parseFloat(val.toString())   // Prisma Decimal
    : parseFloat(val);
  return isNaN(n) ? '0.00' : n.toFixed(2);
}

// Build an <ItemRef> element, falling back to QB_FALLBACK_ITEM
function buildItemRef(listId?: string | null, fullName?: string | null): string {
  if (listId) {
    return `<ItemRef><ListID>${esc(listId)}</ListID></ItemRef>`;
  }
  const name = fullName || QB_FALLBACK_ITEM;
  return `<ItemRef><FullName>${esc(name)}</FullName></ItemRef>`;
}

// Build an optional <ClassRef> element
function buildClassRef(listId?: string | null, fullName?: string | null): string {
  if (!listId && !fullName) return '';
  if (listId) {
    return `<ClassRef><ListID>${esc(listId)}</ListID></ClassRef>`;
  }
  return `<ClassRef><FullName>${esc(fullName)}</FullName></ClassRef>`;
}

// Build the optional header <Other> element (LOCATION on the Basin template).
// QB caps Other at 29 chars and rejects the whole doc if it's longer.
const QB_OTHER_MAX_LEN = 29;
function buildOther(val?: string | null): string {
  const trimmed = (val || '').trim();
  if (!trimmed) return '';
  return `<Other>${esc(trimmed.slice(0, QB_OTHER_MAX_LEN))}</Other>`;
}

// ---------------------------------------------------------------------------
// SalesOrderAdd
// ---------------------------------------------------------------------------

export interface QbSalesOrderLine {
  qbItemListId?: string | null;
  qbItemFullName?: string | null;
  qbClassListId?: string | null;
  qbClassFullName?: string | null;
  description: string;
  quantity: number;
  rate: string;           // unit price as string
  amount: string;         // line total as string
  serviceDate?: Date | string | null;
  // Per-line ND sales tax flag. Emits <SalesTaxCodeRef> "Tax" / "Non" so QB
  // honors our per-item taxability (incl. manual overrides) rather than only
  // the QB item's default tax code. Undefined = omit (QB uses item default).
  isTaxable?: boolean;
}

// Standard QuickBooks sales tax code names. QB ships these two out of the box.
const QB_TAX_CODE_TAXABLE = 'Tax';
const QB_TAX_CODE_NONTAXABLE = 'Non';

function buildSalesTaxCodeRef(isTaxable?: boolean): string {
  if (isTaxable === undefined) return '';
  const name = isTaxable ? QB_TAX_CODE_TAXABLE : QB_TAX_CODE_NONTAXABLE;
  return `<SalesTaxCodeRef><FullName>${esc(name)}</FullName></SalesTaxCodeRef>`;
}

export interface QbSalesOrderData {
  // Customer
  customerListId?: string | null;
  customerFullName?: string | null;
  // Header
  txnDate: Date | string;
  refNumber: string;        // Our invoice number (SO ref# in QB)
  poNumber?: string | null;
  fob?: string | null;
  memo?: string | null;
  // Header-level class (optional — applies to whole SO if set)
  classListId?: string | null;
  classFullName?: string | null;
  // ND sales tax — the QB Sales Tax Item FullName for this transaction's
  // jurisdiction (e.g. "Williston (8%)"). QB applies it to taxable lines and
  // computes the tax total, which should match SP's frozen taxAmount.
  salesTaxItemFullName?: string | null;
  // QB header <Other> field — the Basin invoice template renames it LOCATION.
  // Carries the service site (well/pad name). QB caps it at 29 chars.
  otherLocation?: string | null;
  // Lines
  lines: QbSalesOrderLine[];
}

export function buildSalesOrderAdd(data: QbSalesOrderData): string {
  // Customer ref — prefer ListID, fall back to FullName
  let customerRef = '';
  if (data.customerListId) {
    customerRef = `<CustomerRef><ListID>${esc(data.customerListId)}</ListID></CustomerRef>`;
  } else if (data.customerFullName) {
    customerRef = `<CustomerRef><FullName>${esc(data.customerFullName)}</FullName></CustomerRef>`;
  } else {
    throw new Error('SalesOrderAdd requires CustomerRef (ListID or FullName)');
  }

  // Header-level class
  const headerClass = buildClassRef(data.classListId, data.classFullName);

  // Build line items
  const lineXml = data.lines.map(line => {
    const itemRef = buildItemRef(line.qbItemListId, line.qbItemFullName);
    const lineClass = buildClassRef(line.qbClassListId, line.qbClassFullName);
    const taxCodeRef = buildSalesTaxCodeRef(line.isTaxable);

    return [
      '      <SalesOrderLineAdd>',
      `        ${itemRef}`,
      `        <Desc>${esc(line.description)}</Desc>`,
      `        <Quantity>${line.quantity}</Quantity>`,
      `        <Rate>${qbAmount(line.rate)}</Rate>`,
      lineClass ? `        ${lineClass}` : '',
      taxCodeRef ? `        ${taxCodeRef}` : '',
      '      </SalesOrderLineAdd>',
    ].filter(Boolean).join('\n');
  }).join('\n');

  // Transaction-level sales tax item (the jurisdiction's rate). Per the qbXML
  // SalesOrderAdd element sequence it must come BEFORE Memo
  // (…RefNumber → PONumber → ItemSalesTaxRef → Memo → lines). Emitting it after
  // Memo is an out-of-order element and QB rejects the whole doc with
  // 0x80040400 (QBXML_ERROR_PARSE).
  const itemSalesTaxRef = data.salesTaxItemFullName
    ? `        <ItemSalesTaxRef><FullName>${esc(data.salesTaxItemFullName)}</FullName></ItemSalesTaxRef>`
    : '';

  // LOCATION on the Basin template (see buildOther).
  const otherRef = buildOther(data.otherLocation);

  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<?qbxml version="13.0"?>',
    '<QBXML>',
    '  <QBXMLMsgsRq onError="stopOnError">',
    '    <SalesOrderAddRq>',
    '      <SalesOrderAdd>',
    `        ${customerRef}`,
    headerClass ? `        ${headerClass}` : '',
    `        <TxnDate>${qbDate(data.txnDate)}</TxnDate>`,
    `        <RefNumber>${esc(qbRefNumber(data.refNumber))}</RefNumber>`,
    data.poNumber ? `        <PONumber>${esc(data.poNumber)}</PONumber>` : '',
    data.fob ? `        <FOB>${esc(data.fob)}</FOB>` : '',
    itemSalesTaxRef,
    data.memo ? `        <Memo>${esc(data.memo)}</Memo>` : '',
    // <Other> comes AFTER Memo and BEFORE the line adds — the qbXML header
    // sequence is …ItemSalesTaxRef → Memo → CustomerMsgRef → IsToBePrinted →
    // IsToBeEmailed → IsTaxIncluded → CustomerSalesTaxCodeRef → Other → lines.
    // Emitting it anywhere else is an out-of-order element and QB rejects the
    // whole doc with 0x80040400 (QBXML_ERROR_PARSE).
    otherRef ? `        ${otherRef}` : '',
    lineXml,
    '      </SalesOrderAdd>',
    '    </SalesOrderAddRq>',
    '  </QBXMLMsgsRq>',
    '</QBXML>',
  ].filter(Boolean).join('\n');
}

// ---------------------------------------------------------------------------
// InvoiceAdd — post a real QB Invoice directly (default path)
// ---------------------------------------------------------------------------

// Same shape as a Sales Order: customer + header + tax item + lines. The only
// difference is the QB request/element names (Invoice* instead of SalesOrder*).
export type QbInvoiceLine = QbSalesOrderLine;
export type QbInvoiceData = QbSalesOrderData;

export function buildInvoiceAdd(data: QbInvoiceData): string {
  // Customer ref — prefer ListID, fall back to FullName
  let customerRef = '';
  if (data.customerListId) {
    customerRef = `<CustomerRef><ListID>${esc(data.customerListId)}</ListID></CustomerRef>`;
  } else if (data.customerFullName) {
    customerRef = `<CustomerRef><FullName>${esc(data.customerFullName)}</FullName></CustomerRef>`;
  } else {
    throw new Error('InvoiceAdd requires CustomerRef (ListID or FullName)');
  }

  // Header-level class
  const headerClass = buildClassRef(data.classListId, data.classFullName);

  // Build line items
  const lineXml = data.lines.map(line => {
    const itemRef = buildItemRef(line.qbItemListId, line.qbItemFullName);
    const lineClass = buildClassRef(line.qbClassListId, line.qbClassFullName);
    const taxCodeRef = buildSalesTaxCodeRef(line.isTaxable);
    const serviceDate = line.serviceDate ? `        <ServiceDate>${qbDate(line.serviceDate)}</ServiceDate>` : '';

    return [
      '      <InvoiceLineAdd>',
      `        ${itemRef}`,
      `        <Desc>${esc(line.description)}</Desc>`,
      `        <Quantity>${line.quantity}</Quantity>`,
      `        <Rate>${qbAmount(line.rate)}</Rate>`,
      lineClass ? `        ${lineClass}` : '',
      serviceDate,
      taxCodeRef ? `        ${taxCodeRef}` : '',
      '      </InvoiceLineAdd>',
    ].filter(Boolean).join('\n');
  }).join('\n');

  // Transaction-level sales tax item. Per the qbXML InvoiceAdd element sequence
  // ItemSalesTaxRef must come BEFORE Memo (…RefNumber → PONumber →
  // ItemSalesTaxRef → Memo → lines) — same ordering as SalesOrderAdd. Out of
  // order → QB rejects the whole doc with 0x80040400 (QBXML_ERROR_PARSE).
  const itemSalesTaxRef = data.salesTaxItemFullName
    ? `        <ItemSalesTaxRef><FullName>${esc(data.salesTaxItemFullName)}</FullName></ItemSalesTaxRef>`
    : '';

  // LOCATION on the Basin template (see buildOther).
  const otherRef = buildOther(data.otherLocation);

  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<?qbxml version="13.0"?>',
    '<QBXML>',
    '  <QBXMLMsgsRq onError="stopOnError">',
    '    <InvoiceAddRq>',
    '      <InvoiceAdd>',
    `        ${customerRef}`,
    headerClass ? `        ${headerClass}` : '',
    `        <TxnDate>${qbDate(data.txnDate)}</TxnDate>`,
    `        <RefNumber>${esc(qbRefNumber(data.refNumber))}</RefNumber>`,
    data.poNumber ? `        <PONumber>${esc(data.poNumber)}</PONumber>` : '',
    data.fob ? `        <FOB>${esc(data.fob)}</FOB>` : '',
    itemSalesTaxRef,
    data.memo ? `        <Memo>${esc(data.memo)}</Memo>` : '',
    // <Other> comes AFTER Memo and BEFORE the line adds — the qbXML header
    // sequence is …ItemSalesTaxRef → Memo → CustomerMsgRef → IsToBePrinted →
    // IsToBeEmailed → IsTaxIncluded → CustomerSalesTaxCodeRef → Other → lines.
    // Emitting it anywhere else is an out-of-order element and QB rejects the
    // whole doc with 0x80040400 (QBXML_ERROR_PARSE).
    otherRef ? `        ${otherRef}` : '',
    lineXml,
    '      </InvoiceAdd>',
    '    </InvoiceAddRq>',
    '  </QBXMLMsgsRq>',
    '</QBXML>',
  ].filter(Boolean).join('\n');
}

// ---------------------------------------------------------------------------
// SalesReceiptAdd (for CC/cash payments — direct sale or shop pickup)
// ---------------------------------------------------------------------------

export interface QbSalesReceiptData {
  // Customer
  customerListId?: string | null;
  customerFullName?: string | null;
  // Header
  txnDate: Date | string;
  refNumber: string;
  memo?: string | null;
  // Payment method (Visa, MasterCard, Cash, Check, etc.)
  paymentMethodName?: string | null;
  // CheckNumber = Stripe charge ID or reference
  checkNumber?: string | null;
  // ND sales tax — the QB Sales Tax Item FullName for this sale's jurisdiction
  // (e.g. "Williston (8%)"). QB applies it to the taxable lines.
  salesTaxItemFullName?: string | null;
  // Lines
  lines: QbSalesOrderLine[];  // reuse same line shape (incl. per-line isTaxable)
}

export function buildSalesReceiptAdd(data: QbSalesReceiptData): string {
  let customerRef = '';
  if (data.customerListId) {
    customerRef = `<CustomerRef><ListID>${esc(data.customerListId)}</ListID></CustomerRef>`;
  } else if (data.customerFullName) {
    customerRef = `<CustomerRef><FullName>${esc(data.customerFullName)}</FullName></CustomerRef>`;
  } else {
    throw new Error('SalesReceiptAdd requires CustomerRef (ListID or FullName)');
  }

  const paymentMethodRef = data.paymentMethodName
    ? `<PaymentMethodRef><FullName>${esc(data.paymentMethodName)}</FullName></PaymentMethodRef>`
    : '';

  const itemSalesTaxRef = data.salesTaxItemFullName
    ? `        <ItemSalesTaxRef><FullName>${esc(data.salesTaxItemFullName)}</FullName></ItemSalesTaxRef>`
    : '';

  const lineXml = data.lines.map(line => {
    const itemRef = buildItemRef(line.qbItemListId, line.qbItemFullName);
    const lineClass = buildClassRef(line.qbClassListId, line.qbClassFullName);
    const taxCodeRef = buildSalesTaxCodeRef(line.isTaxable);

    return [
      '      <SalesReceiptLineAdd>',
      `        ${itemRef}`,
      `        <Desc>${esc(line.description)}</Desc>`,
      `        <Quantity>${line.quantity}</Quantity>`,
      `        <Rate>${qbAmount(line.rate)}</Rate>`,
      lineClass ? `        ${lineClass}` : '',
      taxCodeRef ? `        ${taxCodeRef}` : '',
      '      </SalesReceiptLineAdd>',
    ].filter(Boolean).join('\n');
  }).join('\n');

  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<?qbxml version="13.0"?>',
    '<QBXML>',
    '  <QBXMLMsgsRq onError="stopOnError">',
    '    <SalesReceiptAddRq>',
    '      <SalesReceiptAdd>',
    `        ${customerRef}`,
    `        <TxnDate>${qbDate(data.txnDate)}</TxnDate>`,
    `        <RefNumber>${esc(qbRefNumber(data.refNumber))}</RefNumber>`,
    data.checkNumber ? `        <CheckNumber>${esc(data.checkNumber)}</CheckNumber>` : '',
    paymentMethodRef ? `        ${paymentMethodRef}` : '',
    itemSalesTaxRef,
    data.memo ? `        <Memo>${esc(data.memo)}</Memo>` : '',
    lineXml,
    '      </SalesReceiptAdd>',
    '    </SalesReceiptAddRq>',
    '  </QBXMLMsgsRq>',
    '</QBXML>',
  ].filter(Boolean).join('\n');
}

// ---------------------------------------------------------------------------
// SalesReceiptAdd Response Parsing
// ---------------------------------------------------------------------------

export function parseSalesReceiptResponse(responseXml: string): QbResponseResult {
  const statusCode = extractAttr(responseXml, 'SalesReceiptAddRs', 'statusCode') || '9999';
  const statusSeverity = extractAttr(responseXml, 'SalesReceiptAddRs', 'statusSeverity') || 'Error';
  const statusMessage = extractAttr(responseXml, 'SalesReceiptAddRs', 'statusMessage') || 'Unknown error';

  const txnId = extractTag(responseXml, 'TxnID');
  const refNumber = extractTag(responseXml, 'RefNumber');
  const timeModified = extractTag(responseXml, 'TimeModified') || extractTag(responseXml, 'TimeCreated');

  return { statusCode, statusSeverity, statusMessage, txnId, refNumber, timeModified };
}

// ---------------------------------------------------------------------------
// InvoiceQuery — check if a Sales Order has been converted to an Invoice
// ---------------------------------------------------------------------------

/**
 * Query QB for invoices linked to a specific Sales Order.
 * We use the SO's RefNumber to find the Invoice (QB links them internally).
 *
 * Strategy: Query invoices that reference our SO's RefNumber or TxnID.
 * QB's InvoiceQuery supports filtering by RefNumber, LinkToTxnID, etc.
 */
export function buildInvoiceQueryByRefNumber(refNumber: string): string {
  // Search for invoices whose RefNumber matches our SO number
  // When comptroller converts SO→Invoice, QB often copies the RefNumber
  const shortRef = qbRefNumber(refNumber);

  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<?qbxml version="13.0"?>',
    '<QBXML>',
    '  <QBXMLMsgsRq onError="stopOnError">',
    '    <InvoiceQueryRq>',
    `      <RefNumber>${esc(shortRef)}</RefNumber>`,
    '    </InvoiceQueryRq>',
    '  </QBXMLMsgsRq>',
    '</QBXML>',
  ].filter(Boolean).join('\n');
}

/**
 * Slice F — Query a specific Invoice by its QB TxnID, returning the full
 * Invoice record including line items and totals. Used by the diff watcher
 * to compare the QB-side state against Sundog's canonical record.
 *
 * IncludeLineItems=true gets us per-line Amount + Quantity for line-by-line
 * diff in a follow-up slice; the MVP just compares the TxnTotal.
 */
export function buildInvoiceQueryByTxnId(invoiceTxnId: string): string {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<?qbxml version="13.0"?>',
    '<QBXML>',
    '  <QBXMLMsgsRq onError="stopOnError">',
    '    <InvoiceQueryRq>',
    `      <TxnID>${esc(invoiceTxnId)}</TxnID>`,
    '      <IncludeLineItems>true</IncludeLineItems>',
    '    </InvoiceQueryRq>',
    '  </QBXMLMsgsRq>',
    '</QBXML>',
  ].join('\n');
}

/**
 * Query the Sales Order by TxnID to check if it's been fully invoiced.
 *
 * QB returns <IsFullyInvoiced>true/false</IsFullyInvoiced> in the SO response.
 * When the comptroller converts the SO to an Invoice in QB Desktop,
 * IsFullyInvoiced flips to true.
 *
 * NOTE: Neither IncludeLinkedTxn (on SalesOrderQueryRq) nor LinkToTxnID
 * (on InvoiceQueryRq) work reliably — both cause 0x80040400 parse errors
 * in QB Desktop. A plain SO query by TxnID is the safe approach.
 */
export function buildSalesOrderQueryForLinkedInvoice(soTxnId: string): string {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<?qbxml version="13.0"?>',
    '<QBXML>',
    '  <QBXMLMsgsRq onError="stopOnError">',
    '    <SalesOrderQueryRq>',
    `      <TxnID>${esc(soTxnId)}</TxnID>`,
    '    </SalesOrderQueryRq>',
    '  </QBXMLMsgsRq>',
    '</QBXML>',
  ].filter(Boolean).join('\n');
}

// ---------------------------------------------------------------------------
// Response Parsing — extract key fields from QB's qbXML response
// ---------------------------------------------------------------------------

/**
 * Simple regex-based XML value extractor.
 * We don't need a full XML parser — QB responses have a predictable structure.
 */
function extractTag(xml: string, tagName: string): string | null {
  const re = new RegExp(`<${tagName}>([^<]*)</${tagName}>`, 'i');
  const m = xml.match(re);
  return m ? m[1] : null;
}

/**
 * Read one attribute off the first `<tagName ...>` in the response.
 *
 * Scans the tag quote-aware instead of the old `<tag[^>]*attr="([^"]*)"`,
 * because statusMessage is free-form English from QB and routinely carries
 * the characters that pattern chokes on:
 *   - a `>` inside the message aborted the `[^>]*` hop, so the attribute was
 *     never found at all and callers fell back to "Unknown error";
 *   - a `"` inside the message ended `[^"]*` early, truncating the text
 *     mid-sentence (the "There was a required element (" reports).
 * Both should be escaped by QB, and are — but only a quote-aware scan is
 * honest about it, and entity-decoding the value is what makes the stored
 * message readable rather than `(&quot;TxnID&quot;)`.
 */
function extractAttr(xml: string, tagName: string, attrName: string): string | null {
  const open = new RegExp(`<${tagName}(?=[\\s/>])`, 'i').exec(xml);
  if (!open) return null;

  // Walk to the tag's closing `>`, ignoring any that sit inside an attribute
  // value. QB's statusMessage can legitimately contain `>` when unescaped.
  let quote: string | null = null;
  let end = open.index + open[0].length;
  for (; end < xml.length; end++) {
    const ch = xml[end];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      break;
    }
  }

  const tag = xml.slice(open.index, end);
  const attr = new RegExp(`\\b${attrName}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag);
  if (!attr) return null;
  return decodeHtmlEntities(attr[1] ?? attr[2] ?? '');
}

export interface QbResponseResult {
  statusCode: string;
  statusSeverity: string;
  statusMessage: string;
  txnId: string | null;
  refNumber: string | null;
  // QB's own TimeModified (falls back to TimeCreated for a brand-new Add) —
  // billing_observation.as_of must be this, never the sync-run time. See
  // services/billingObservations.ts.
  timeModified: string | null;
}

export function parseSalesOrderResponse(responseXml: string): QbResponseResult {
  // QB wraps the result in <SalesOrderAddRs> or <SalesOrderModRs>
  const statusCode = extractAttr(responseXml, 'SalesOrderAddRs', 'statusCode')
    || extractAttr(responseXml, 'SalesOrderModRs', 'statusCode')
    || '9999';
  const statusSeverity = extractAttr(responseXml, 'SalesOrderAddRs', 'statusSeverity')
    || extractAttr(responseXml, 'SalesOrderModRs', 'statusSeverity')
    || 'Error';
  const statusMessage = extractAttr(responseXml, 'SalesOrderAddRs', 'statusMessage')
    || extractAttr(responseXml, 'SalesOrderModRs', 'statusMessage')
    || 'Unknown error';

  // The SalesOrderRet child has the TxnID and RefNumber
  const txnId = extractTag(responseXml, 'TxnID');
  const refNumber = extractTag(responseXml, 'RefNumber');
  const timeModified = extractTag(responseXml, 'TimeModified') || extractTag(responseXml, 'TimeCreated');

  return { statusCode, statusSeverity, statusMessage, txnId, refNumber, timeModified };
}

export function parseInvoiceAddResponse(responseXml: string): QbResponseResult {
  // QB wraps the result in <InvoiceAddRs>; the InvoiceRet child has TxnID/RefNumber.
  const statusCode = extractAttr(responseXml, 'InvoiceAddRs', 'statusCode') || '9999';
  const statusSeverity = extractAttr(responseXml, 'InvoiceAddRs', 'statusSeverity') || 'Error';
  const statusMessage = extractAttr(responseXml, 'InvoiceAddRs', 'statusMessage') || 'Unknown error';

  const txnId = extractTag(responseXml, 'TxnID');
  const refNumber = extractTag(responseXml, 'RefNumber');
  const timeModified = extractTag(responseXml, 'TimeModified') || extractTag(responseXml, 'TimeCreated');

  return { statusCode, statusSeverity, statusMessage, txnId, refNumber, timeModified };
}

// ---------------------------------------------------------------------------
// InvoiceQuery Response Parsing — detect SO→Invoice conversion
// ---------------------------------------------------------------------------

export interface QbInvoiceQueryResult {
  statusCode: string;
  statusSeverity: string;
  statusMessage: string;
  found: boolean;
  invoiceTxnId: string | null;
  invoiceRefNumber: string | null;
  invoiceDate: string | null;
}

/**
 * Parse SO→Invoice conversion detection response.
 *
 * Handles multiple response types:
 *
 * 1. SalesOrderQueryRs (current) — we query the SO by TxnID and check
 *    <IsFullyInvoiced>true</IsFullyInvoiced>. QB returns this on every SO.
 *    We won't get the Invoice TxnID this way, but we detect the conversion.
 *
 * 2. InvoiceQueryRs (fallback for RefNumber search) — if the SO query
 *    detects fully invoiced, we queue a RefNumber-based invoice search
 *    as a follow-up to grab the actual QB invoice number.
 */
export function parseInvoiceQueryResponse(responseXml: string): QbInvoiceQueryResult {
  // ── SalesOrderQueryRs path: check IsFullyInvoiced ──
  const soStatusCode = extractAttr(responseXml, 'SalesOrderQueryRs', 'statusCode');
  if (soStatusCode !== null) {
    const statusCode = soStatusCode;
    const statusSeverity = extractAttr(responseXml, 'SalesOrderQueryRs', 'statusSeverity') || 'Info';
    const statusMessage = extractAttr(responseXml, 'SalesOrderQueryRs', 'statusMessage') || '';

    if (statusCode === '0') {
      const isFullyInvoiced = extractTag(responseXml, 'IsFullyInvoiced');

      if (isFullyInvoiced === 'true') {
        // SO has been converted to an Invoice!
        // We don't get the Invoice TxnID from an SO query, but we know it happened.
        // The RefNumber on the SO is our ref, not the QB invoice number.
        return {
          statusCode, statusSeverity, statusMessage,
          found: true,
          invoiceTxnId: null,             // not available from SO query
          invoiceRefNumber: null,          // will be fetched in follow-up if needed
          invoiceDate: null,
        };
      }

      // SO exists but not yet fully invoiced
      return {
        statusCode, statusSeverity, statusMessage,
        found: false,
        invoiceTxnId: null,
        invoiceRefNumber: null,
        invoiceDate: null,
      };
    }

    // statusCode "1" = SO not found (deleted? unusual)
    return {
      statusCode, statusSeverity, statusMessage,
      found: false,
      invoiceTxnId: null,
      invoiceRefNumber: null,
      invoiceDate: null,
    };
  }

  // ── InvoiceQueryRs path: RefNumber search result ──
  const invStatusCode = extractAttr(responseXml, 'InvoiceQueryRs', 'statusCode') || '9999';
  const invStatusSeverity = extractAttr(responseXml, 'InvoiceQueryRs', 'statusSeverity') || 'Error';
  const invStatusMessage = extractAttr(responseXml, 'InvoiceQueryRs', 'statusMessage') || 'Unknown';

  if (invStatusCode === '0') {
    const invoiceRetBlock = responseXml.match(/<InvoiceRet>[\s\S]*?<\/InvoiceRet>/);
    if (invoiceRetBlock) {
      const block = invoiceRetBlock[0];
      return {
        statusCode: invStatusCode, statusSeverity: invStatusSeverity, statusMessage: invStatusMessage,
        found: true,
        invoiceTxnId: extractTag(block, 'TxnID'),
        invoiceRefNumber: extractTag(block, 'RefNumber'),
        invoiceDate: extractTag(block, 'TxnDate'),
      };
    }
  }

  return {
    statusCode: invStatusCode, statusSeverity: invStatusSeverity, statusMessage: invStatusMessage,
    found: false,
    invoiceTxnId: null,
    invoiceRefNumber: null,
    invoiceDate: null,
  };
}

// ---------------------------------------------------------------------------
// Item Query — Pull items from QB to sync UOM, description, price
// ---------------------------------------------------------------------------

/**
 * Build qbXML requests to query all item types from QB.
 * Uses individual typed queries (ItemServiceQueryRq, etc.) because
 * the generic ItemQueryRq isn't available in older QB SDK versions.
 *
 * Returns a single qbXML document with multiple requests inside one QBXML block.
 * QB Desktop processes them sequentially and returns all responses in one batch.
 */
export function buildItemQueryRq(fromModifiedDate?: string): string {
  const dateFilter = fromModifiedDate
    ? `<FromModifiedDate>${fromModifiedDate}</FromModifiedDate>`
    : '';

  // Query all 4 item types that can appear on sales orders/invoices
  return `<?xml version="1.0" encoding="utf-8"?>
<?qbxml version="13.0"?>
<QBXML>
  <QBXMLMsgsRq onError="continueOnError">
    <ItemServiceQueryRq>
      ${dateFilter}
      <ActiveStatus>All</ActiveStatus>
    </ItemServiceQueryRq>
    <ItemNonInventoryQueryRq>
      ${dateFilter}
      <ActiveStatus>All</ActiveStatus>
    </ItemNonInventoryQueryRq>
    <ItemInventoryQueryRq>
      ${dateFilter}
      <ActiveStatus>All</ActiveStatus>
    </ItemInventoryQueryRq>
    <ItemOtherChargeQueryRq>
      ${dateFilter}
      <ActiveStatus>All</ActiveStatus>
    </ItemOtherChargeQueryRq>
  </QBXMLMsgsRq>
</QBXML>`;
}

/** A parsed QB item record. */
export interface QbItemRecord {
  listId: string;
  fullName: string;
  isActive: boolean;
  description: string | null;
  price: number | null;
  unitOfMeasure: string | null;
  itemType: string;  // service, non_inventory, inventory, other_charge
}

/** Normalize UOM strings from QB to standard codes. */
function normalizeUoM(raw: string): string {
  if (!raw) return 'EA';
  const lower = raw.toLowerCase();
  if (lower.includes('hour') || lower === 'hr') return 'HR';
  if (lower.includes('day')) return 'DAY';
  if (lower.includes('mile') || lower === 'mi') return 'MI';
  if (lower.includes('each') || lower === 'ea') return 'EA';
  if (lower.includes('week') || lower === 'wk') return 'WK';
  if (lower.includes('month') || lower === 'mon') return 'MON';
  if (lower.includes('case')) return 'CS';
  if (lower.includes('box')) return 'BX';
  if (lower.includes('pair')) return 'PR';
  if (lower.includes('pack')) return 'PK';
  if (lower.includes('roll')) return 'RL';
  if (lower.includes('ft') || lower.includes('foot') || lower.includes('feet')) return 'FT';
  if (lower.includes('bbl') || lower.includes('barrel')) return 'BBL';
  return raw.substring(0, 10).toUpperCase();
}

/**
 * Parse a QB response containing item query results.
 * Handles ItemServiceRet, ItemNonInventoryRet, ItemInventoryRet, ItemOtherChargeRet.
 */
export function parseItemQueryResponse(responseXml: string): QbItemRecord[] {
  const items: QbItemRecord[] = [];

  const typeMap: Record<string, string> = {
    ItemServiceRet: 'service',
    ItemNonInventoryRet: 'non_inventory',
    ItemInventoryRet: 'inventory',
    ItemOtherChargeRet: 'other_charge',
  };

  for (const [retTag, itemType] of Object.entries(typeMap)) {
    // Match all <ItemServiceRet>...</ItemServiceRet> blocks (etc.)
    const re = new RegExp(`<${retTag}>[\\s\\S]*?</${retTag}>`, 'g');
    let match: RegExpExecArray | null;
    while ((match = re.exec(responseXml)) !== null) {
      const block = match[0];
      const listId = extractTag(block, 'ListID');
      const fullName = extractTag(block, 'FullName');
      if (!listId || !fullName) continue;

      const isActive = extractTag(block, 'IsActive') !== 'false';

      // Description: SalesOrPurchaseDesc > SalesDesc > Description.
      // Decoded here, at the single point QB item text enters the system, so the
      // product name, the category guess and everything downstream see real
      // punctuation instead of "&#151;" / "&amp;". Pushing back out is safe:
      // esc() below already folds em/en dashes and smart quotes down to ASCII
      // for QB's parser.
      const description = decodeHtmlEntitiesOrNull(
        extractTag(block, 'Desc') ||   // inside SalesOrPurchase block
        extractTag(block, 'SalesDesc') ||
        extractTag(block, 'Description') ||
        null,
      );

      // Price: SalesOrPurchasePrice > SalesPrice > Price
      const priceStr =
        extractTag(block, 'Price') ||   // inside SalesOrPurchase block
        extractTag(block, 'SalesPrice') ||
        null;
      const price = priceStr ? parseFloat(priceStr) : null;

      // UOM: UnitOfMeasureSetRef > FullName (inside the ref block)
      // The structure is <UnitOfMeasureSetRef><FullName>Each</FullName></UnitOfMeasureSetRef>
      const uomBlock = block.match(/<UnitOfMeasureSetRef>[\s\S]*?<\/UnitOfMeasureSetRef>/);
      const rawUom = uomBlock ? extractTag(uomBlock[0], 'FullName') : null;
      const unitOfMeasure = rawUom ? normalizeUoM(rawUom) : null;

      items.push({ listId, fullName, isActive, description, price, unitOfMeasure, itemType });
    }
  }

  return items;
}


// ---------------------------------------------------------------------------
// Slice F — Invoice Diff parsing. Pulls just enough off the InvoiceQueryRs
// payload to detect divergence vs Sundog's canonical record. Today: TxnTotal
// + line count. Per-line line-item diff in a follow-up slice.
// ---------------------------------------------------------------------------

export interface QbInvoiceDiffResult {
  found: boolean;
  statusCode: string;
  statusMessage: string;
  /** Total amount on the QB invoice (TxnTotal). */
  qbTotal: number | null;
  /** Number of <InvoiceLineRet> blocks in the response. */
  qbLineCount: number;
  /** When QB last edited this invoice — useful for follow-up logic. */
  qbTimeModified: string | null;
}

export function parseInvoiceDiffResponse(responseXml: string): QbInvoiceDiffResult {
  const statusCode = extractAttr(responseXml, 'InvoiceQueryRs', 'statusCode') || '9999';
  const statusMessage = extractAttr(responseXml, 'InvoiceQueryRs', 'statusMessage') || 'Unknown';

  // No matching invoice — QB returns statusCode "500" / "1" depending on version.
  // We treat any response without an <InvoiceRet> block as not-found.
  const invoiceRetMatch = responseXml.match(/<InvoiceRet>([\s\S]*?)<\/InvoiceRet>/);
  if (!invoiceRetMatch) {
    return {
      found: false,
      statusCode,
      statusMessage,
      qbTotal: null,
      qbLineCount: 0,
      qbTimeModified: null,
    };
  }

  const block = invoiceRetMatch[1];
  const totalStr = extractTag(block, 'TotalAmount') || extractTag(block, 'Subtotal');
  const qbTotal = totalStr ? parseFloat(totalStr) : null;

  // Count line items — InvoiceLineRet is the standard line item block.
  // Group lines (InvoiceLineGroupRet) are not counted separately; their
  // child lines surface as InvoiceLineRet inside.
  const lineMatches = block.match(/<InvoiceLineRet>/g);
  const qbLineCount = lineMatches ? lineMatches.length : 0;

  return {
    found: true,
    statusCode,
    statusMessage,
    qbTotal,
    qbLineCount,
    qbTimeModified: extractTag(block, 'TimeModified'),
  };
}

// ---------------------------------------------------------------------------
// Slice 5B — Price Level pull (PriceLevelQueryRq)
// ---------------------------------------------------------------------------

/**
 * Pull QB Per-Item price levels. ActiveStatus=All catches archived levels too
 * so we can mark them inactive in Sundog instead of leaving stale records
 * around. fromModifiedDate scopes a delta sync after the first full pull.
 */
export function buildPriceLevelQueryRq(fromModifiedDate?: string): string {
  const filter = fromModifiedDate
    ? `      <ModifiedDateRangeFilter><FromModifiedDate>${esc(fromModifiedDate)}</FromModifiedDate></ModifiedDateRangeFilter>`
    : '';
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<?qbxml version="13.0"?>',
    '<QBXML>',
    '  <QBXMLMsgsRq onError="continueOnError">',
    '    <PriceLevelQueryRq>',
    '      <ActiveStatus>All</ActiveStatus>',
    filter,
    '    </PriceLevelQueryRq>',
    '  </QBXMLMsgsRq>',
    '</QBXML>',
  ].filter(Boolean).join('\n');
}

export interface QbPriceLevelPerItem {
  qbItemListId: string;
  qbItemFullName: string | null;
  customPrice: number | null;
  adjustPercent: number | null;
}

export interface QbPriceLevel {
  qbListId: string;
  name: string;
  isActive: boolean;
  qbCustomerListId: string | null;
  qbCustomerName: string | null;
  qbTimeModified: string | null;
  items: QbPriceLevelPerItem[];
}

/**
 * Parse PriceLevelQueryRs. QB returns repeated <PriceLevelRet> blocks; each
 * may carry zero or more <PriceLevelPerItemRet> children. PriceLevelFixedPercentage
 * is the alternative shape (whole-level % adjustment) — we surface the
 * percentage on a synthetic per-item-less PriceLevel for callers that want
 * to apply it across all items at resolve time.
 */
export function parsePriceLevelQueryResponse(responseXml: string): QbPriceLevel[] {
  const out: QbPriceLevel[] = [];
  const blockMatches = responseXml.match(/<PriceLevelRet>[\s\S]*?<\/PriceLevelRet>/g);
  if (!blockMatches) return out;

  for (const block of blockMatches) {
    const qbListId = extractTag(block, 'ListID');
    const name = extractTag(block, 'Name');
    if (!qbListId || !name) continue;

    const isActive = extractTag(block, 'IsActive') !== 'false';
    const qbTimeModified = extractTag(block, 'TimeModified');

    // Customer the level is assigned to
    const customerRefBlock = block.match(/<CustomerRef>[\s\S]*?<\/CustomerRef>/);
    const qbCustomerListId = customerRefBlock ? extractTag(customerRefBlock[0], 'ListID') : null;
    const qbCustomerName = customerRefBlock ? extractTag(customerRefBlock[0], 'FullName') : null;

    const items: QbPriceLevelPerItem[] = [];

    // PriceLevelPerItemRet — per-item override (preferred shape in this org's QB)
    const itemMatches = block.match(/<PriceLevelPerItemRet>[\s\S]*?<\/PriceLevelPerItemRet>/g);
    if (itemMatches) {
      for (const itemBlock of itemMatches) {
        const itemRef = itemBlock.match(/<ItemRef>[\s\S]*?<\/ItemRef>/);
        const qbItemListId = itemRef ? extractTag(itemRef[0], 'ListID') : null;
        const qbItemFullName = itemRef ? extractTag(itemRef[0], 'FullName') : null;
        if (!qbItemListId) continue;
        const customPriceStr = extractTag(itemBlock, 'CustomPrice');
        const adjustPctStr = extractTag(itemBlock, 'CustomPricePercent');
        items.push({
          qbItemListId,
          qbItemFullName,
          customPrice: customPriceStr ? parseFloat(customPriceStr) : null,
          adjustPercent: adjustPctStr ? parseFloat(adjustPctStr) : null,
        });
      }
    }

    // PriceLevelFixedPercentage — whole-level % adjustment. Surface as a
    // single synthetic item-less level marker; resolver decides what to do
    // (apply across the board or warn).
    const wholeLevelPct = extractTag(block, 'PriceLevelFixedPercentage');
    if (wholeLevelPct && items.length === 0) {
      items.push({
        qbItemListId: '*',  // sentinel for "all items"
        qbItemFullName: null,
        customPrice: null,
        adjustPercent: parseFloat(wholeLevelPct),
      });
    }

    out.push({ qbListId, name, isActive, qbCustomerListId, qbCustomerName, qbTimeModified, items });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Sales Tax pull (ItemSalesTaxQueryRq + ItemSalesTaxGroupQueryRq)
//
// QB Desktop holds tax in two record kinds, both valid as an Invoice's
// ItemSalesTaxRef:
//   • Sales Tax Item  (ItemSalesTaxRet)      — a single component, has a TaxRate
//   • Sales Tax Group (ItemSalesTaxGroupRet) — combined rate; rate is the sum
//     of its member items, so QB does NOT return a TaxRate on the group itself.
//
// We pull BOTH so SalesTaxRate.qbTaxItemName can be reconciled against the
// real, authoritative QB names instead of hand-typed guesses (the source of
// the recurring 3140 "invalid reference to QuickBooks Item Sales Tax" rejects).
// ---------------------------------------------------------------------------

/**
 * Build a qbXML doc that queries every sales-tax item AND group from QB.
 * ActiveStatus=All so archived rows surface too (we mark them inactive in
 * Sundog rather than silently dropping them). continueOnError so a failure on
 * one query type still returns the other.
 */
export function buildSalesTaxQueryRq(): string {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<?qbxml version="13.0"?>',
    '<QBXML>',
    '  <QBXMLMsgsRq onError="continueOnError">',
    '    <ItemSalesTaxQueryRq>',
    '      <ActiveStatus>All</ActiveStatus>',
    '    </ItemSalesTaxQueryRq>',
    '    <ItemSalesTaxGroupQueryRq>',
    '      <ActiveStatus>All</ActiveStatus>',
    '    </ItemSalesTaxGroupQueryRq>',
    '  </QBXMLMsgsRq>',
    '</QBXML>',
  ].join('\n');
}

/** A parsed QB sales-tax record (item or group). */
export interface QbSalesTaxRecord {
  qbListId: string;
  fullName: string;
  /** 'item' = single Sales Tax Item; 'group' = Sales Tax Group (combined). */
  recordType: 'item' | 'group';
  isActive: boolean;
  description: string | null;
  /** Percent value as QB returns it (5 = 5%). Null for groups (sum of members). */
  taxRatePercent: number | null;
  qbTimeModified: string | null;
}

/**
 * Parse ItemSalesTaxQueryRs + ItemSalesTaxGroupQueryRs into a flat list.
 * Items carry a TaxRate; groups don't (their rate is the sum of member items),
 * so taxRatePercent is null for groups.
 */
export function parseSalesTaxQueryResponse(responseXml: string): QbSalesTaxRecord[] {
  const out: QbSalesTaxRecord[] = [];

  // Both Ret kinds embed nested <SomethingRef> children whose <ListID>/
  // <FullName> belong to the REFERENCED record, not this one: items carry a
  // <TaxVendorRef> (the tax agency vendor), groups carry one <ItemSalesTaxRef>
  // per member component. Neither Ret has a top-level <FullName> (only <Name>),
  // so an unstripped block reads the nested ref's name instead — e.g. every
  // tax item surfacing as its agency "ND State Tax Commissioner", every group
  // as its first member "North Dakota State Component". Strip all nested refs
  // before extracting.
  const stripNestedRefs = (block: string) => block.replace(/<(\w+Ref)>[\s\S]*?<\/\1>/g, '');

  const itemBlocks = responseXml.match(/<ItemSalesTaxRet>[\s\S]*?<\/ItemSalesTaxRet>/g) || [];
  for (const rawBlock of itemBlocks) {
    const block = stripNestedRefs(rawBlock);
    const qbListId = extractTag(block, 'ListID');
    const fullName = extractTag(block, 'FullName') || extractTag(block, 'Name');
    if (!qbListId || !fullName) continue;
    const rateStr = extractTag(block, 'TaxRate');
    out.push({
      qbListId,
      fullName,
      recordType: 'item',
      isActive: extractTag(block, 'IsActive') !== 'false',
      description: extractTag(block, 'ItemDesc') || null,
      taxRatePercent: rateStr ? parseFloat(rateStr) : null,
      qbTimeModified: extractTag(block, 'TimeModified'),
    });
  }

  const groupBlocks = responseXml.match(/<ItemSalesTaxGroupRet>[\s\S]*?<\/ItemSalesTaxGroupRet>/g) || [];
  for (const rawBlock of groupBlocks) {
    const block = stripNestedRefs(rawBlock);
    const qbListId = extractTag(block, 'ListID');
    const fullName = extractTag(block, 'FullName') || extractTag(block, 'Name');
    if (!qbListId || !fullName) continue;
    out.push({
      qbListId,
      fullName,
      recordType: 'group',
      isActive: extractTag(block, 'IsActive') !== 'false',
      description: extractTag(block, 'ItemDesc') || null,
      taxRatePercent: null,
      qbTimeModified: extractTag(block, 'TimeModified'),
    });
  }

  return out;
}
