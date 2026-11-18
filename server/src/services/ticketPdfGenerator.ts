import PDFDocument from 'pdfkit';
import { drawCompanyHeader, drawPdfFooters, loadPdfBranding, type PdfBranding } from './pdfBranding.js';

// ---- Types (mirrors the Prisma include from GET /tickets/:id) ----

interface LineItem {
  lineNumber: number;
  lineType: string;
  description: string | null;
  quantity: any;
  rate: any;
  total: any;
  unitOfMeasure: string | null;
  sortOrder: number;
  notes: string | null;
  serialNumberInstalled: string | null;
  serialNumberRemoved: string | null;
  testResult: string | null;
  product?: { partNumber: string; name: string } | null;
}

interface FitTestRecord {
  employeeName: string;
  employerName: string | null;
  respiratorMake: string | null;
  respiratorModel: string | null;
  respiratorSize: string | null;
  testMethod: string | null;
  fitFactor: any;
  passFail: string;
  testDate: string | Date;
}

interface TicketForPdf {
  ticketNumber: string | null;
  ticketType: string;
  serviceSubtype: string | null;
  status: string;
  serviceDate: Date | string;
  arrivalTime: Date | string | null;
  departureTime: Date | string | null;
  locationDisplay: string | null;
  afeNumber: string | null;
  poNumber: string | null;
  customerRepName: string | null;
  workDescription: string | null;
  dispatchNotes: string | null;
  internalNotes: string | null;
  subtotal: any;
  total: any;
  techSignature: string | null;
  customerRepSignature: string | null;
  company?: { name: string } | null;
  field?: { name: string } | null;
  pad?: { name: string } | null;
  well?: { wellName: string | null } | null;
  assignedTech?: { name: string } | null;
  lineItems?: LineItem[];
  fitTestRecords?: FitTestRecord[];
}

// ---- Helpers ----

// Date-only DB columns (serviceDate, testDate) hydrate as UTC midnight —
// format in UTC, or Central time renders them a day early.
function fmtDate(d: Date | string | null): string {
  if (!d) return '';
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt.getTime())) return String(d);
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function fmtDateTime(d: Date | string | null): string {
  if (!d) return '';
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt.getTime())) return '';
  return dt.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function fmtTime(d: Date | string | null): string {
  if (!d) return '';
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt.getTime())) return '';
  return dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
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

const TICKET_TYPE_LABELS: Record<string, string> = {
  field_service: 'Field Service',
  training: 'Training',
  sale: 'Sale',
  rental: 'Rental',
  repair: 'Repair',
  inspection: 'Inspection',
};

const SUBTYPE_LABELS: Record<string, string> = {
  fit_test: 'Fit Test',
  monitor: 'Monitor Service',
  air_system: 'Air System',
  bump_test: 'Bump Test',
  calibration: 'Calibration',
  general: 'General',
  ih_h2s: 'H2S Testing',
  ih_o2_voc: 'O2/VOC Testing',
  ih_sampling: 'Sampling',
  ih_audiometric: 'Audiometric',
  safety_training: 'Safety Training',
  inspection: 'Field Inspection',
};

const STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  dispatched: 'Dispatched',
  in_progress: 'In Progress',
  completed: 'Completed',
  supervisor_review: 'Supervisor Review',
  awaiting_signature: 'Awaiting Signature',
  billing_queue: 'Billing Queue',
  invoiced: 'Invoiced',
  closed: 'Closed',
};

// Brand color
const BRAND_DARK = '#1a2332';
const BRAND_ACCENT = '#0e7490';

// ---- Signature block coordinates ----

export const TICKET_SIGNATURE_FIELDS = [
  { kind: 'sig', label: 'Customer Signature', page: -1, x: 50, y: 700, w: 250, h: 40 },
  { kind: 'dat', label: 'Date Signed', page: -1, x: 380, y: 708, w: 120, h: 25 },
];

// ---- Main Generator ----

export async function generateTicketPdf(ticket: TicketForPdf, providedBranding?: PdfBranding): Promise<PDFKit.PDFDocument> {
  const branding = providedBranding ?? await loadPdfBranding();
  const doc = new PDFDocument({
    size: 'LETTER',
    margins: { top: 36, bottom: 10, left: 50, right: 50 },
    bufferPages: true,
    info: {
      Title: `Ticket ${ticket.ticketNumber || 'Draft'}`,
      Author: branding.companyName,
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

  // Company name — big bold text
  drawCompanyHeader(doc, branding, contentLeft, y, contentWidth / 2 - 14, BRAND_DARK);

  // Contact info
  doc.fontSize(7.5).font('Helvetica').fillColor('#666666');
  doc.text('701.572.8140  |  billing@basinsafetyus.com  |  Williston, ND 58801', contentLeft, y + 26);

  // Ticket number + type (right side, same baseline as company name)
  const ticketLabel = ticket.ticketNumber || 'DRAFT';
  doc.fontSize(16).font('Helvetica-Bold').fillColor(BRAND_DARK)
    .text(ticketLabel, contentLeft, y + 3, { width: contentWidth, align: 'right' });

  const typeLabel = TICKET_TYPE_LABELS[ticket.ticketType] || ticket.ticketType;
  const subtypeLabel = ticket.serviceSubtype ? SUBTYPE_LABELS[ticket.serviceSubtype] || ticket.serviceSubtype.replace(/_/g, ' ') : '';
  doc.fontSize(9).font('Helvetica').fillColor('#666666')
    .text(subtypeLabel ? `${typeLabel} - ${subtypeLabel}` : typeLabel, contentLeft, y + 22, { width: contentWidth, align: 'right' });

  // Status badge
  const statusLabel = STATUS_LABELS[ticket.status] || ticket.status;
  doc.fontSize(9).font('Helvetica-Bold').fillColor(BRAND_ACCENT)
    .text(statusLabel.toUpperCase(), contentLeft, y + 34, { width: contentWidth, align: 'right' });

  y = y + 52;

  // Header divider — accent colored
  doc.moveTo(contentLeft, y).lineTo(contentRight, y).strokeColor(BRAND_ACCENT).lineWidth(1.5).stroke();
  y += 12;

  // ================================================================
  // JOB INFO — two-column grid
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
  yL = infoRow('Date of Service', fmtDate(ticket.serviceDate), col1X, yL);
  if (ticket.arrivalTime || ticket.departureTime) {
    const arrival = fmtTime(ticket.arrivalTime);
    const depart = fmtTime(ticket.departureTime);
    const timeStr = arrival && depart ? `${arrival} - ${depart}` : arrival || depart;
    yL = infoRow('Time', timeStr, col1X, yL);
  }
  yL = infoRow('Technician', ticket.assignedTech?.name || '', col1X, yL);
  yL = infoRow('Customer Rep', ticket.customerRepName || '', col1X, yL);

  // Right column
  let yR = y;
  yR = infoRow('Customer', ticket.company?.name || '', col2X, yR);

  // Site: Field > Pad > Well
  const siteParts = [
    ticket.field?.name,
    ticket.pad?.name,
    ticket.well?.wellName,
  ].filter(Boolean);
  const siteStr = siteParts.join('  >  ') || ticket.locationDisplay || '';
  if (siteStr) yR = infoRow('Site', siteStr, col2X, yR);

  if (ticket.afeNumber) yR = infoRow('AFE', ticket.afeNumber, col2X, yR);
  if (ticket.poNumber) yR = infoRow('PO #', ticket.poNumber, col2X, yR);

  y = Math.max(yL, yR) + 4;

  // ================================================================
  // WORK DESCRIPTION / DISPATCH NOTES
  // ================================================================
  if (ticket.workDescription || ticket.dispatchNotes || ticket.internalNotes) {
    y += 4;
    doc.moveTo(contentLeft, y).lineTo(contentRight, y).strokeColor('#e0e0e0').lineWidth(0.5).stroke();
    y += 10;

    if (ticket.workDescription) {
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#555555').text('Work Performed', contentLeft, y);
      y += 12;
      doc.fontSize(9).font('Helvetica').fillColor(valClr)
        .text(ticket.workDescription, contentLeft, y, { width: contentWidth });
      y = doc.y + 8;
    }

    if (ticket.dispatchNotes) {
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#555555').text('Dispatch Notes', contentLeft, y);
      y += 12;
      doc.fontSize(9).font('Helvetica').fillColor(valClr)
        .text(ticket.dispatchNotes, contentLeft, y, { width: contentWidth });
      y = doc.y + 8;
    }

    if (ticket.internalNotes) {
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#555555').text('Internal Notes', contentLeft, y);
      y += 12;
      doc.fontSize(9).font('Helvetica').fillColor(valClr)
        .text(ticket.internalNotes, contentLeft, y, { width: contentWidth });
      y = doc.y + 8;
    }
  }

  // ================================================================
  // LINE ITEMS TABLE
  // ================================================================
  const items = (ticket.lineItems || []).sort((a, b) => a.sortOrder - b.sortOrder);

  if (items.length > 0) {
    y += 4;
    doc.moveTo(contentLeft, y).lineTo(contentRight, y).strokeColor('#e0e0e0').lineWidth(0.5).stroke();
    y += 10;

    doc.fontSize(10).font('Helvetica-Bold').fillColor(BRAND_DARK).text('Products & Services', contentLeft, y);
    y += 16;

    // Column positions
    const colPart = contentLeft;
    const colDesc = contentLeft + 72;
    const colQty = contentRight - 170;
    const colRate = contentRight - 110;
    const colTotal = contentRight - 50;

    // Table header background
    doc.rect(contentLeft, y - 2, contentWidth, 14).fill('#f1f5f9');
    doc.fontSize(7).font('Helvetica-Bold').fillColor('#64748b');
    doc.text('PART #', colPart + 4, y + 1);
    doc.text('DESCRIPTION', colDesc, y + 1);
    doc.text('QTY', colQty, y + 1, { width: 40, align: 'right' });
    doc.text('RATE', colRate, y + 1, { width: 50, align: 'right' });
    doc.text('TOTAL', colTotal, y + 1, { width: 50, align: 'right' });
    y += 16;

    // Rows
    let rowIdx = 0;
    for (const item of items) {
      if (y > 690) {
        doc.addPage();
        y = 40;
      }

      // Alternating row background
      if (rowIdx % 2 === 1) {
        doc.rect(contentLeft, y - 2, contentWidth, 14).fill('#f8fafc');
      }

      const partNo = item.product?.partNumber || '';
      const desc = item.description || item.product?.name || '';

      doc.fontSize(8).font('Helvetica').fillColor('#000000');
      doc.text(partNo, colPart + 4, y, { width: 64 });
      doc.text(desc, colDesc, y, { width: colQty - colDesc - 10 });
      doc.text(fmtQty(item.quantity), colQty, y, { width: 40, align: 'right' });
      doc.text(fmtCurrency(item.rate), colRate, y, { width: 50, align: 'right' });
      doc.text(fmtCurrency(item.total), colTotal, y, { width: 50, align: 'right' });

      const descHeight = doc.heightOfString(desc, { width: colQty - colDesc - 10 });
      y += Math.max(14, descHeight + 4);

      // Show line item notes if present
      if (item.notes) {
        doc.fontSize(7).font('Helvetica-Oblique').fillColor('#666666')
          .text(item.notes, colDesc, y, { width: colQty - colDesc - 10 });
        y = doc.y + 4;
      }

      rowIdx++;
    }

    // Totals
    y += 6;
    doc.moveTo(colRate - 20, y).lineTo(contentRight, y).strokeColor('#cbd5e1').lineWidth(0.5).stroke();
    y += 8;

    if (ticket.subtotal && fmtCurrency(ticket.subtotal)) {
      doc.fontSize(8).font('Helvetica').fillColor('#64748b')
        .text('Subtotal', colRate - 60, y, { width: 100, align: 'right' });
      doc.fontSize(9).font('Helvetica').fillColor('#000000')
        .text(fmtCurrency(ticket.subtotal), colTotal, y, { width: 50, align: 'right' });
      y += 16;
    }

    if (ticket.total && fmtCurrency(ticket.total)) {
      doc.fontSize(9).font('Helvetica-Bold').fillColor('#000000')
        .text('Total', colRate - 60, y, { width: 100, align: 'right' });
      doc.fontSize(12).font('Helvetica-Bold').fillColor(BRAND_DARK)
        .text(fmtCurrency(ticket.total), colTotal, y, { width: 50, align: 'right' });
      y += 20;
    }
  }

  // ================================================================
  // FIT TEST RECORDS
  // ================================================================
  const fitTests = ticket.fitTestRecords || [];
  if (fitTests.length > 0) {
    if (y > 640) { doc.addPage(); y = 40; }

    y += 4;
    doc.moveTo(contentLeft, y).lineTo(contentRight, y).strokeColor('#e0e0e0').lineWidth(0.5).stroke();
    y += 10;

    doc.fontSize(10).font('Helvetica-Bold').fillColor(BRAND_DARK).text('Fit Test Records', contentLeft, y);
    y += 16;

    const ftColName = contentLeft;
    const ftColEmployer = contentLeft + 155;
    const ftColResp = contentLeft + 290;
    const ftColResult = contentRight - 40;

    // Table header
    doc.rect(contentLeft, y - 2, contentWidth, 14).fill('#f1f5f9');
    doc.fontSize(7).font('Helvetica-Bold').fillColor('#64748b');
    doc.text('NAME', ftColName + 4, y + 1);
    doc.text('EMPLOYER', ftColEmployer, y + 1);
    doc.text('RESPIRATOR', ftColResp, y + 1);
    doc.text('RESULT', ftColResult, y + 1, { width: 40, align: 'right' });
    y += 16;

    for (let i = 0; i < fitTests.length; i++) {
      if (y > 690) { doc.addPage(); y = 40; }

      const ft = fitTests[i];
      if (i % 2 === 1) {
        doc.rect(contentLeft, y - 2, contentWidth, 14).fill('#f8fafc');
      }

      const respStr = [ft.respiratorMake, ft.respiratorModel, ft.respiratorSize].filter(Boolean).join(' ');
      const resultStr = ft.passFail === 'pass' ? 'PASS' : 'FAIL';

      doc.fontSize(8).font('Helvetica').fillColor('#000000');
      doc.text(ft.employeeName, ftColName + 4, y, { width: 145 });
      doc.text(ft.employerName || '', ftColEmployer, y, { width: 130 });
      doc.text(respStr, ftColResp, y, { width: 110 });

      doc.fontSize(8).font('Helvetica-Bold')
        .fillColor(ft.passFail === 'pass' ? '#16a34a' : '#dc2626')
        .text(resultStr, ftColResult, y, { width: 40, align: 'right' });

      y += 14;
    }
  }

  // ================================================================
  // SIGNATURES
  // ================================================================
  const hasTechSig = ticket.techSignature && ticket.techSignature.startsWith('data:');
  const hasCustSig = ticket.customerRepSignature && ticket.customerRepSignature.startsWith('data:');

  if (hasTechSig || hasCustSig) {
    if (y > 580) { doc.addPage(); y = 40; }

    y += 8;
    doc.moveTo(contentLeft, y).lineTo(contentRight, y).strokeColor('#e0e0e0').lineWidth(0.5).stroke();
    y += 10;

    doc.fontSize(10).font('Helvetica-Bold').fillColor(BRAND_DARK).text('Signatures', contentLeft, y);
    y += 16;

    const sigWidth = 200;
    const sigHeight = 50;

    // Side by side if both present
    if (hasTechSig) {
      doc.fontSize(7.5).font('Helvetica').fillColor(labelClr).text('Technician', contentLeft, y);
      y += 10;
      try {
        doc.image(ticket.techSignature!, contentLeft, y, { fit: [sigWidth, sigHeight] });
      } catch {
        doc.fontSize(8).font('Helvetica').fillColor('#aaa').text('[signature]', contentLeft, y);
      }
      y += sigHeight + 2;
      doc.moveTo(contentLeft, y).lineTo(contentLeft + sigWidth, y).strokeColor('#999').lineWidth(0.5).stroke();
      doc.fontSize(7).font('Helvetica').fillColor('#666')
        .text(ticket.assignedTech?.name || '', contentLeft, y + 3);
      y += 18;
    }

    if (hasCustSig) {
      doc.fontSize(7.5).font('Helvetica').fillColor(labelClr).text('Customer Representative', contentLeft, y);
      y += 10;
      try {
        doc.image(ticket.customerRepSignature!, contentLeft, y, { fit: [sigWidth, sigHeight] });
      } catch {
        doc.fontSize(8).font('Helvetica').fillColor('#aaa').text('[signature]', contentLeft, y);
      }
      y += sigHeight + 2;
      doc.moveTo(contentLeft, y).lineTo(contentLeft + sigWidth, y).strokeColor('#999').lineWidth(0.5).stroke();
      doc.fontSize(7).font('Helvetica').fillColor('#666')
        .text(ticket.customerRepName || '', contentLeft, y + 3);
      y += 18;
    }
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
  const sigFld = TICKET_SIGNATURE_FIELDS[0];
  doc.rect(sigFld.x, sigFld.y, sigFld.w, sigFld.h).dash(3, { space: 3 }).strokeColor('#cccccc').lineWidth(0.5).stroke();
  doc.undash();
  doc.fontSize(7).font('Helvetica').fillColor('#aaaaaa').text('Signature', sigFld.x + 4, sigFld.y + sigFld.h + 3);

  // Date placeholder box
  const datFld = TICKET_SIGNATURE_FIELDS[1];
  doc.rect(datFld.x, datFld.y, datFld.w, datFld.h).dash(3, { space: 3 }).strokeColor('#cccccc').lineWidth(0.5).stroke();
  doc.undash();
  doc.fontSize(7).font('Helvetica').fillColor('#aaaaaa').text('Date', datFld.x + 4, datFld.y + datFld.h + 3);

  // ================================================================
  // FOOTER — every page
  // ================================================================
  // Generated-at is a real timestamp — keep it in server-local time.
  const now = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  drawPdfFooters(doc, branding, now, contentLeft, contentRight);

  // NOTE: caller is responsible for calling doc.end() — either via pdfToBuffer() or after .pipe()
  return doc;
}
