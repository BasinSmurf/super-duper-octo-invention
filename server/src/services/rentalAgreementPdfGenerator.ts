import PDFDocument from 'pdfkit';
import { drawCompanyHeader, drawPdfFooters, loadPdfBranding, type PdfBranding } from './pdfBranding.js';

// ---- Types (mirrors the include shape from GET /rentals/:id) ----

interface RentalItemForPdf {
  rate: any;
  rateType: string;
  deployedDate: Date | string;
  returnedDate: Date | string | null;
  status: string;
  product?: { name: string; partNumber: string; category: string } | null;
  serializedEquipment?: { serialNumber: string } | null;
}

interface RentalPic {
  name?: string;
  phone?: string;
  email?: string;
}

interface RentalAgreementForPdf {
  agreementNumber: string;
  status: string;
  pickupType: string;
  startDate: Date | string;
  endDate: Date | string | null;
  billingRateType: string;
  poNumber: string | null;
  afeNumber: string | null;
  notes: string | null;
  isManned: boolean;
  isRigJob: boolean;
  monitorsIncluded: boolean;
  liabilityAcknowledged: boolean;
  liabilitySignedByName: string | null;
  liabilitySignature: string | null;
  liabilitySignedAt: Date | string | null;
  siteContactName: string | null;
  siteContactPhone: string | null;
  personCallingName: string | null;
  personCallingPhone: string | null;
  pics?: RentalPic[] | null;
  company?: { name: string } | null;
  field?: { name: string } | null;
  pad?: { name: string } | null;
  well?: { wellName: string | null } | null;
  items?: RentalItemForPdf[];
}

// ---- Helpers ----

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

function fmtCurrency(val: any): string {
  if (val == null || val === '') return '';
  const n = typeof val === 'string' ? parseFloat(val) : Number(val);
  if (isNaN(n)) return '';
  return `$${n.toFixed(2)}`;
}

const RATE_TYPE_LABELS: Record<string, string> = {
  daily: 'Daily',
  weekly: 'Weekly',
  monthly: 'Monthly',
  flat: 'Flat',
};

const STATUS_LABELS: Record<string, string> = {
  scheduled: 'Scheduled',
  active: 'Active',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

const ITEM_STATUS_LABELS: Record<string, string> = {
  deployed: 'Deployed',
  returned: 'Returned',
};

// Brand color
const BRAND_DARK = '#1a2332';
const BRAND_ACCENT = '#0e7490';

// ---- Main Generator ----

export async function generateRentalAgreementPdf(ra: RentalAgreementForPdf, providedBranding?: PdfBranding): Promise<PDFKit.PDFDocument> {
  const branding = providedBranding ?? await loadPdfBranding();
  const doc = new PDFDocument({
    size: 'LETTER',
    margins: { top: 36, bottom: 10, left: 50, right: 50 },
    bufferPages: true,
    info: {
      Title: `Rental ${ra.agreementNumber}`,
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

  drawCompanyHeader(doc, branding, contentLeft, y, contentWidth / 2 - 14, BRAND_DARK);
  doc.fontSize(7.5).font('Helvetica').fillColor('#666666');
  doc.text('701.572.8140  |  billing@basinsafetyus.com  |  Williston, ND 58801', contentLeft, y + 26);

  doc.fontSize(16).font('Helvetica-Bold').fillColor(BRAND_DARK)
    .text(ra.agreementNumber, contentLeft, y + 3, { width: contentWidth, align: 'right' });
  const subtitle = ra.pickupType === 'walk_in' ? 'Rental Agreement (Walk-in)' : 'Rental Agreement';
  doc.fontSize(9).font('Helvetica').fillColor('#666666')
    .text(subtitle, contentLeft, y + 22, { width: contentWidth, align: 'right' });

  const statusLabel = STATUS_LABELS[ra.status] || ra.status;
  doc.fontSize(9).font('Helvetica-Bold').fillColor(BRAND_ACCENT)
    .text(statusLabel.toUpperCase(), contentLeft, y + 34, { width: contentWidth, align: 'right' });

  y = y + 52;
  doc.moveTo(contentLeft, y).lineTo(contentRight, y).strokeColor(BRAND_ACCENT).lineWidth(1.5).stroke();
  y += 12;

  // ================================================================
  // AGREEMENT INFO — two-column grid
  // ================================================================
  const colLabelW = 90;
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

  let yL = y;
  yL = infoRow('Customer', ra.company?.name || '', col1X, yL);
  const siteParts = [ra.field?.name, ra.pad?.name, ra.well?.wellName].filter(Boolean);
  if (siteParts.length) yL = infoRow('Site', siteParts.join('  >  '), col1X, yL);
  yL = infoRow('Start Date', fmtDate(ra.startDate), col1X, yL);
  if (ra.endDate) yL = infoRow('End Date', fmtDate(ra.endDate), col1X, yL);
  yL = infoRow('Billing', RATE_TYPE_LABELS[ra.billingRateType] || ra.billingRateType, col1X, yL);

  let yR = y;
  if (ra.poNumber) yR = infoRow('PO #', ra.poNumber, col2X, yR);
  if (ra.afeNumber) yR = infoRow('AFE', ra.afeNumber, col2X, yR);
  const classParts: string[] = [];
  if (ra.isManned) classParts.push('Manned');
  if (ra.isRigJob) classParts.push('Rig Job');
  if (ra.monitorsIncluded) classParts.push('Monitors');
  if (classParts.length) yR = infoRow('Type', classParts.join(', '), col2X, yR);
  if (ra.personCallingName) {
    yR = infoRow('Requested By', [ra.personCallingName, ra.personCallingPhone].filter(Boolean).join(' · '), col2X, yR);
  }
  if (ra.siteContactName) {
    yR = infoRow('Site Contact', [ra.siteContactName, ra.siteContactPhone].filter(Boolean).join(' · '), col2X, yR);
  }

  y = Math.max(yL, yR) + 4;

  // ================================================================
  // PERSONS IN CHARGE (foreperson roster)
  // ================================================================
  const pics = Array.isArray(ra.pics) ? ra.pics.filter(p => p && p.name) : [];
  if (pics.length > 0) {
    y += 4;
    doc.moveTo(contentLeft, y).lineTo(contentRight, y).strokeColor('#e0e0e0').lineWidth(0.5).stroke();
    y += 10;
    doc.fontSize(8).font('Helvetica-Bold').fillColor('#555555').text('Persons In Charge', contentLeft, y);
    y += 12;
    for (const p of pics) {
      const line = [p.name, p.phone, p.email].filter(Boolean).join('  ·  ');
      doc.fontSize(9).font('Helvetica').fillColor(valClr).text(line, contentLeft, y, { width: contentWidth });
      y = doc.y + 2;
    }
    y += 6;
  }

  // ================================================================
  // DEPLOYED EQUIPMENT
  // ================================================================
  const items = ra.items || [];
  if (items.length > 0) {
    y += 4;
    doc.moveTo(contentLeft, y).lineTo(contentRight, y).strokeColor('#e0e0e0').lineWidth(0.5).stroke();
    y += 10;
    doc.fontSize(10).font('Helvetica-Bold').fillColor(BRAND_DARK).text('Deployed Equipment', contentLeft, y);
    y += 16;

    const colSerial = contentLeft;
    const colDesc = contentLeft + 110;
    const colDeployed = contentRight - 200;
    const colRate = contentRight - 110;
    const colStatus = contentRight - 50;

    doc.rect(contentLeft, y - 2, contentWidth, 14).fill('#f1f5f9');
    doc.fontSize(7).font('Helvetica-Bold').fillColor('#64748b');
    doc.text('SERIAL #', colSerial + 4, y + 1);
    doc.text('DESCRIPTION', colDesc, y + 1);
    doc.text('DEPLOYED', colDeployed, y + 1, { width: 70 });
    doc.text('RATE', colRate, y + 1, { width: 55 });
    doc.text('STATUS', colStatus, y + 1, { width: 50, align: 'right' });
    y += 16;

    let rowIdx = 0;
    for (const item of items) {
      if (y > 700) { doc.addPage(); y = 40; }
      if (rowIdx % 2 === 1) doc.rect(contentLeft, y - 2, contentWidth, 14).fill('#f8fafc');

      const serial = item.serializedEquipment?.serialNumber || '';
      const desc = item.product?.name || '';
      const rateStr = item.rate != null
        ? `${fmtCurrency(item.rate)}/${(RATE_TYPE_LABELS[item.rateType] || item.rateType).toLowerCase().slice(0, 2) || 'd'}`
        : '';
      const statusTxt = ITEM_STATUS_LABELS[item.status] || item.status;

      doc.fontSize(8).font('Helvetica').fillColor('#000000');
      doc.text(serial, colSerial + 4, y, { width: 102 });
      doc.text(desc, colDesc, y, { width: colDeployed - colDesc - 6 });
      doc.text(fmtDate(item.deployedDate), colDeployed, y, { width: 70 });
      doc.text(rateStr, colRate, y, { width: 55 });
      doc.text(statusTxt, colStatus, y, { width: 50, align: 'right' });

      const descHeight = doc.heightOfString(desc, { width: colDeployed - colDesc - 6 });
      y += Math.max(14, descHeight + 4);
      rowIdx++;
    }
    y += 6;
  }

  // ================================================================
  // NOTES
  // ================================================================
  if (ra.notes) {
    if (y > 660) { doc.addPage(); y = 40; }
    y += 4;
    doc.moveTo(contentLeft, y).lineTo(contentRight, y).strokeColor('#e0e0e0').lineWidth(0.5).stroke();
    y += 10;
    doc.fontSize(8).font('Helvetica-Bold').fillColor('#555555').text('Notes', contentLeft, y);
    y += 12;
    doc.fontSize(9).font('Helvetica').fillColor(valClr).text(ra.notes, contentLeft, y, { width: contentWidth });
    y = doc.y + 8;
  }

  // ================================================================
  // LIABILITY WAIVER / SIGNATURE
  // ================================================================
  if (y > 580) { doc.addPage(); y = 40; }

  y += 8;
  doc.moveTo(contentLeft, y).lineTo(contentRight, y).strokeColor(BRAND_ACCENT).lineWidth(0.75).stroke();
  y += 10;
  doc.fontSize(9).font('Helvetica-Bold').fillColor(BRAND_DARK).text('Liability Acknowledgement', contentLeft, y);
  y += 14;

  doc.fontSize(8).font('Helvetica').fillColor('#555555').text(
    'The customer acknowledges receipt of the equipment listed above in good working condition and accepts ' +
    `responsibility for its safe use, care, and return. ${branding.companyName} is not liable for misuse or damage occurring ` +
    'during the rental period.',
    contentLeft, y, { width: contentWidth },
  );
  y = doc.y + 12;

  const hasSig = ra.liabilitySignature && ra.liabilitySignature.startsWith('data:');
  const sigWidth = 250;
  const sigHeight = 45;

  doc.fontSize(7.5).font('Helvetica').fillColor(labelClr).text('Customer Signature', contentLeft, y);
  y += 10;
  if (hasSig) {
    try {
      doc.image(ra.liabilitySignature!, contentLeft, y, { fit: [sigWidth, sigHeight] });
    } catch {
      doc.fontSize(8).font('Helvetica').fillColor('#aaa').text('[signature]', contentLeft, y);
    }
    y += sigHeight + 2;
  } else {
    y += sigHeight;
  }
  doc.moveTo(contentLeft, y).lineTo(contentLeft + sigWidth, y).strokeColor('#999').lineWidth(0.5).stroke();
  doc.fontSize(7).font('Helvetica').fillColor('#666')
    .text(ra.liabilitySignedByName || '', contentLeft, y + 3, { width: sigWidth });
  if (ra.liabilitySignedAt) {
    doc.fontSize(7).font('Helvetica').fillColor('#999')
      .text(fmtDateTime(ra.liabilitySignedAt), contentLeft + sigWidth + 20, y + 3);
  }

  // ================================================================
  // FOOTER — every page
  // ================================================================
  const now = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  drawPdfFooters(doc, branding, now, contentLeft, contentRight);

  // NOTE: caller is responsible for calling doc.end()
  return doc;
}
