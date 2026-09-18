import PDFDocument from 'pdfkit';

// ---- Types ----

interface InvoiceLineItem {
  lineNumber: number;
  description: string;
  productId: string | null;
  partNumber: string | null;
  quantity: any;
  unitOfMeasure: string | null;
  rate: any;
  amount: any;
  isTaxable: boolean;
  notes: string | null;
  sortOrder: number;
  product?: { partNumber: string; name: string } | null;
}

interface InvoiceForPdf {
  invoiceNumber: string;
  status: string;
  sourceType: string;
  companyName: string;
  poNumber: string | null;
  afeNumber: string | null;
  costCenter: string | null;
  invoiceDate: Date | string;
  dueDate: Date | string | null;
  periodStart: Date | string | null;
  periodEnd: Date | string | null;
  subtotal: any;
  taxAmount: any;
  taxRate?: any;
  total: any;
  notes: string | null;
  internalNotes: string | null;
  qbSalesOrderNumber: string | null;
  qbInvoiceNumber: string | null;
  approvedBy?: { name: string } | null;
  createdBy?: { name: string } | null;
  lineItems?: InvoiceLineItem[];
}

// ---- Helpers ----

// Date-only DB columns (invoiceDate, dueDate, periodStart/End) hydrate as UTC
// midnight — format in UTC, or Central time renders them a day early.
function fmtDate(d: Date | string | null): string {
  if (!d) return '';
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt.getTime())) return String(d);
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function fmtCurrency(val: any): string {
  if (val == null || val === '') return '';
  const n = typeof val === 'string' ? parseFloat(val) : Number(val);
  if (isNaN(n)) return '';
  return `$${n.toFixed(2)}`;
}

function fmtQty(val: any): string {
  if (val == null) return '';
  const n = typeof val === 'string' ? parseFloat(val) : Number(val);
  if (isNaN(n)) return '';
  return n === Math.floor(n) ? String(n) : n.toFixed(2);
}

const SOURCE_LABELS: Record<string, string> = {
  billing_group: 'Field Service',
  shop_work_order: 'Shop Work Order',
  rental_agreement: 'Rental Agreement',
  manual: 'Manual Invoice',
};

const STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  approved: 'Approved',
  queued: 'QB Queued',
  so_created: 'Sales Order Created',
  invoiced: 'Invoiced',
  sent: 'Sent',
  paid: 'Paid',
  void: 'Voided',
};

// Brand colors
const BRAND_DARK = '#1a2332';
const BRAND_ACCENT = '#0e7490';

// ---- Signature block coordinates ----

/**
 * Signature field placements. Coordinates are in PDF points (letter = 612x792),
 * relative to page top-left. `page` is -1 meaning "last page", resolved at send time.
 */
export const INVOICE_SIGNATURE_FIELDS = [
  { kind: 'sig', label: 'Customer Signature', page: -1, x: 50, y: 700, w: 250, h: 40 },
  { kind: 'dat', label: 'Date Signed', page: -1, x: 380, y: 708, w: 120, h: 25 },
];

// ---- Main Generator ----

export function generateInvoicePdf(invoice: InvoiceForPdf): PDFKit.PDFDocument {
  const doc = new PDFDocument({
    size: 'LETTER',
    margins: { top: 36, bottom: 10, left: 50, right: 50 },
    bufferPages: true,
    info: {
      Title: `Invoice ${invoice.invoiceNumber}`,
      Author: 'Basin Safety',
      Creator: 'Sundog Field Service Platform',
    },
  });

  const pageWidth = 612;
  const contentLeft = 50;
  const contentRight = pageWidth - 50;
  const contentWidth = contentRight - contentLeft;

  // ================================================================
  // HEADER
  // ================================================================
  let y = 36;

  doc.fontSize(22).font('Helvetica-Bold').fillColor(BRAND_DARK).text('BASIN SAFETY', contentLeft, y);
  doc.fontSize(7.5).font('Helvetica').fillColor('#666666');
  doc.text('701.572.8140  |  billing@basinsafetyus.com  |  Williston, ND 58801', contentLeft, y + 26);

  // Invoice number (right side)
  doc.fontSize(16).font('Helvetica-Bold').fillColor(BRAND_DARK)
    .text(invoice.invoiceNumber, contentLeft, y + 3, { width: contentWidth, align: 'right' });

  // Source type + status
  const sourceLabel = SOURCE_LABELS[invoice.sourceType] || invoice.sourceType;
  doc.fontSize(9).font('Helvetica').fillColor('#666666')
    .text(sourceLabel, contentLeft, y + 22, { width: contentWidth, align: 'right' });

  const statusLabel = STATUS_LABELS[invoice.status] || invoice.status;
  doc.fontSize(9).font('Helvetica-Bold').fillColor(BRAND_ACCENT)
    .text(statusLabel.toUpperCase(), contentLeft, y + 34, { width: contentWidth, align: 'right' });

  y = y + 52;

  // Header divider
  doc.moveTo(contentLeft, y).lineTo(contentRight, y).strokeColor(BRAND_ACCENT).lineWidth(1.5).stroke();
  y += 12;

  // ================================================================
  // INVOICE INFO — two-column grid
  // ================================================================
  const colLabelW = 80;
  const col1X = contentLeft;
  const col2X = contentLeft + contentWidth / 2 + 10;
  const labelClr = '#888888';
  const valClr = '#000000';

  function infoRow(label: string, value: string, x: number, yPos: number, labelWidth = colLabelW): number {
    if (!value) return yPos;
    doc.fontSize(7.5).font('Helvetica').fillColor(labelClr).text(label, x, yPos, { width: labelWidth });
    doc.fontSize(9).font('Helvetica').fillColor(valClr).text(value, x + labelWidth + 4, yPos, { width: contentWidth / 2 - labelWidth - 14 });
    return yPos + 14;
  }

  // Left column
  let yL = y;
  yL = infoRow('Invoice Date', fmtDate(invoice.invoiceDate), col1X, yL);
  if (invoice.dueDate) yL = infoRow('Due Date', fmtDate(invoice.dueDate), col1X, yL);
  if (invoice.periodStart && invoice.periodEnd) {
    yL = infoRow('Service Period', `${fmtDate(invoice.periodStart)} - ${fmtDate(invoice.periodEnd)}`, col1X, yL);
  }
  if (invoice.approvedBy) yL = infoRow('Approved By', invoice.approvedBy.name, col1X, yL);

  // Right column
  let yR = y;
  yR = infoRow('Customer', invoice.companyName, col2X, yR);
  if (invoice.poNumber) yR = infoRow('PO Number', invoice.poNumber, col2X, yR);
  if (invoice.afeNumber) yR = infoRow('AFE', invoice.afeNumber, col2X, yR);
  if (invoice.costCenter) yR = infoRow('Cost Center', invoice.costCenter, col2X, yR);
  if (invoice.qbInvoiceNumber) yR = infoRow('QB Invoice #', invoice.qbInvoiceNumber, col2X, yR);
  else if (invoice.qbSalesOrderNumber) yR = infoRow('QB SO #', invoice.qbSalesOrderNumber, col2X, yR);

  y = Math.max(yL, yR) + 4;

  // ================================================================
  // LINE ITEMS TABLE
  // ================================================================
  const items = (invoice.lineItems || []).sort((a, b) => a.sortOrder - b.sortOrder);
  // A line is informational (notes area) ONLY when it's a genuine auto-generated
  // note — no product, no part number, zero quantity (training / fit-test
  // attendee lists). Real item & labor lines always print as line items, even
  // at $0 — never strip them between ticket and billing over a zero amount.
  const isNoteItem = (li: InvoiceLineItem) =>
    !li.productId && !li.partNumber && (parseFloat(String(li.quantity)) || 0) === 0;
  const billableItems = items.filter(li => !isNoteItem(li));
  const noteItems = items.filter(li => isNoteItem(li));

  if (billableItems.length > 0) {
    y += 4;
    doc.moveTo(contentLeft, y).lineTo(contentRight, y).strokeColor('#e0e0e0').lineWidth(0.5).stroke();
    y += 10;

    doc.fontSize(10).font('Helvetica-Bold').fillColor(BRAND_DARK).text('Line Items', contentLeft, y);
    y += 16;

    // Column positions
    const colNum = contentLeft;
    const colDesc = contentLeft + 28;
    const colQty = contentRight - 170;
    const colRate = contentRight - 110;
    const colTotal = contentRight - 50;

    // Table header
    doc.rect(contentLeft, y - 2, contentWidth, 14).fill('#f1f5f9');
    doc.fontSize(7).font('Helvetica-Bold').fillColor('#64748b');
    doc.text('#', colNum + 4, y + 1);
    doc.text('DESCRIPTION', colDesc, y + 1);
    doc.text('QTY', colQty, y + 1, { width: 40, align: 'right' });
    doc.text('RATE', colRate, y + 1, { width: 50, align: 'right' });
    doc.text('AMOUNT', colTotal, y + 1, { width: 50, align: 'right' });
    y += 16;

    let rowIdx = 0;
    for (const item of billableItems) {
      if (y > 690) {
        doc.addPage();
        y = 40;
      }

      if (rowIdx % 2 === 1) {
        doc.rect(contentLeft, y - 2, contentWidth, 14).fill('#f8fafc');
      }

      const desc = item.description || item.product?.name || '';
      const partNo = item.partNumber || item.product?.partNumber || '';

      doc.fontSize(8).font('Helvetica').fillColor('#000000');
      doc.text(String(item.lineNumber), colNum + 4, y, { width: 20 });
      doc.text(desc, colDesc, y, { width: colQty - colDesc - 10 });
      doc.text(fmtQty(item.quantity), colQty, y, { width: 40, align: 'right' });
      doc.text(fmtCurrency(item.rate), colRate, y, { width: 50, align: 'right' });
      doc.text(fmtCurrency(item.amount), colTotal, y, { width: 50, align: 'right' });

      const descHeight = doc.heightOfString(desc, { width: colQty - colDesc - 10 });
      y += Math.max(14, descHeight + 4);

      // Part number under description
      if (partNo) {
        doc.fontSize(6.5).font('Helvetica').fillColor('#999999')
          .text(`Part #: ${partNo}`, colDesc, y - 2);
        y += 8;
      }

      // Notes
      if (item.notes) {
        doc.fontSize(7).font('Helvetica-Oblique').fillColor('#666666')
          .text(item.notes, colDesc, y, { width: colQty - colDesc - 10 });
        y = doc.y + 4;
      }

      rowIdx++;
    }

    // Note lines (zero-dollar items)
    if (noteItems.length > 0) {
      y += 4;
      for (const item of noteItems) {
        if (y > 690) { doc.addPage(); y = 40; }
        doc.fontSize(7).font('Helvetica-Oblique').fillColor('#888888')
          .text(`Note: ${item.description}`, contentLeft + 4, y, { width: contentWidth - 8 });
        y = doc.y + 4;
      }
    }

    // ================================================================
    // TOTALS
    // ================================================================
    y += 6;
    doc.moveTo(colRate - 20, y).lineTo(contentRight, y).strokeColor('#cbd5e1').lineWidth(0.5).stroke();
    y += 8;

    const subtotalVal = typeof invoice.subtotal === 'string' ? parseFloat(invoice.subtotal) : Number(invoice.subtotal);
    const taxVal = typeof invoice.taxAmount === 'string' ? parseFloat(invoice.taxAmount) : Number(invoice.taxAmount);
    const totalVal = typeof invoice.total === 'string' ? parseFloat(invoice.total) : Number(invoice.total);

    if (subtotalVal > 0) {
      doc.fontSize(8).font('Helvetica').fillColor('#64748b')
        .text('Subtotal', colRate - 60, y, { width: 100, align: 'right' });
      doc.fontSize(9).font('Helvetica').fillColor('#000000')
        .text(fmtCurrency(subtotalVal), colTotal, y, { width: 50, align: 'right' });
      y += 16;
    }

    if (taxVal > 0) {
      const rateNum = invoice.taxRate == null ? 0 : Number(invoice.taxRate);
      const rateLabel = rateNum > 0 ? ` (${(rateNum * 100).toFixed(rateNum * 100 % 1 === 0 ? 0 : 2)}%)` : '';
      doc.fontSize(8).font('Helvetica').fillColor('#64748b')
        .text(`Sales Tax${rateLabel}`, colRate - 60, y, { width: 100, align: 'right' });
      doc.fontSize(9).font('Helvetica').fillColor('#000000')
        .text(fmtCurrency(taxVal), colTotal, y, { width: 50, align: 'right' });
      y += 16;
    }

    doc.fontSize(9).font('Helvetica-Bold').fillColor('#000000')
      .text('Total', colRate - 60, y, { width: 100, align: 'right' });
    doc.fontSize(12).font('Helvetica-Bold').fillColor(BRAND_DARK)
      .text(fmtCurrency(totalVal), colTotal, y, { width: 50, align: 'right' });
    y += 20;
  }

  // ================================================================
  // NOTES
  // ================================================================
  if (invoice.notes) {
    if (y > 650) { doc.addPage(); y = 40; }
    y += 4;
    doc.moveTo(contentLeft, y).lineTo(contentRight, y).strokeColor('#e0e0e0').lineWidth(0.5).stroke();
    y += 10;
    doc.fontSize(8).font('Helvetica-Bold').fillColor('#555555').text('Notes', contentLeft, y);
    y += 12;
    doc.fontSize(9).font('Helvetica').fillColor(valClr)
      .text(invoice.notes, contentLeft, y, { width: contentWidth });
    y = doc.y + 8;
  }

  // ================================================================
  // CUSTOMER APPROVAL — signature block (visual placeholders for signature fields)
  // ================================================================
  if (y > 660) { doc.addPage(); y = 40; }

  y += 12;
  doc.moveTo(contentLeft, y).lineTo(contentRight, y).strokeColor(BRAND_ACCENT).lineWidth(0.75).stroke();
  y += 10;

  doc.fontSize(9).font('Helvetica-Bold').fillColor(BRAND_DARK).text('Customer Approval', contentLeft, y);
  y += 16;

  // Signature placeholder box
  const sigX = INVOICE_SIGNATURE_FIELDS[0].x;
  const sigY = INVOICE_SIGNATURE_FIELDS[0].y;
  const sigW = INVOICE_SIGNATURE_FIELDS[0].w;
  const sigH = INVOICE_SIGNATURE_FIELDS[0].h;
  doc.rect(sigX, sigY, sigW, sigH).dash(3, { space: 3 }).strokeColor('#cccccc').lineWidth(0.5).stroke();
  doc.undash();
  doc.fontSize(7).font('Helvetica').fillColor('#aaaaaa').text('Signature', sigX + 4, sigY + sigH + 3);

  // Date placeholder box
  const datX = INVOICE_SIGNATURE_FIELDS[1].x;
  const datY = INVOICE_SIGNATURE_FIELDS[1].y;
  const datW = INVOICE_SIGNATURE_FIELDS[1].w;
  const datH = INVOICE_SIGNATURE_FIELDS[1].h;
  doc.rect(datX, datY, datW, datH).dash(3, { space: 3 }).strokeColor('#cccccc').lineWidth(0.5).stroke();
  doc.undash();
  doc.fontSize(7).font('Helvetica').fillColor('#aaaaaa').text('Date', datX + 4, datY + datH + 3);

  // ================================================================
  // FOOTER — every page
  // ================================================================
  // Generated-at is a real timestamp — keep it in server-local time.
  const now = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const footerY = 752;

  const range = doc.bufferedPageRange();
  const pageCount = range.count;
  for (let i = 0; i < pageCount; i++) {
    doc.switchToPage(range.start + i);
    doc.moveTo(contentLeft, footerY - 6).lineTo(contentRight, footerY - 6).strokeColor('#e0e0e0').lineWidth(0.5).stroke();
    doc.fontSize(7).font('Helvetica').fillColor('#aaaaaa')
      .text(`Generated ${now}  |  Basin Safety  |  Williston, ND  |  701.572.8140`, contentLeft, footerY, { width: contentWidth - 60, align: 'center', lineBreak: false });
    doc.fontSize(7).font('Helvetica').fillColor('#bbbbbb')
      .text(`Page ${i + 1} of ${pageCount}`, contentRight - 55, footerY, { lineBreak: false });
  }

  // NOTE: caller is responsible for calling doc.end() — either via pdfToBuffer() or after .pipe()
  return doc;
}
