import PDFDocument from 'pdfkit';

// ---- Types (mirrors the WO_DETAIL_INCLUDE shape from GET /shop-orders/:id) ----

interface ShopItemForPdf {
  itemNumber: number;
  serialNumber: string;
  equipmentCategory: string;
  equipmentDescription: string | null;
  fexBrand: string | null;
  fexSize: string | null;
  fexType: string | null;
  serviceType: string;
  reportedIssue: string | null;
  status: string;
  diagnosisNotes: string | null;
  workNotes: string | null;
  estimatedCost: any;
  isWarranty: boolean;
  warrantyVendor: string | null;
  sentOutTo: string | null;
  qcResult: string | null;
  qcNotes: string | null;
  parentItemId: string | null;
  product?: { name: string; partNumber: string } | null;
  diagnosedBy?: { name: string } | null;
  assignedTo?: { name: string } | null;
  childComponents?: ShopItemForPdf[];
}

interface ShopWorkOrderForPdf {
  workOrderNumber: string;
  status: string;
  isInternal: boolean;
  poNumber: string | null;
  afeNumber: string | null;
  intakeDate: Date | string;
  intakeNotes: string | null;
  promisedDate: Date | string | null;
  completedDate: Date | string | null;
  returnedDate: Date | string | null;
  notes: string | null;
  dropOffContactName: string | null;
  dropOffContactPhone: string | null;
  pickupContactName: string | null;
  pickupContactPhone: string | null;
  pickupSignedByName: string | null;
  pickupSignature: string | null;
  pickupSignedAt: Date | string | null;
  pickupNotes: string | null;
  totalItems: number;
  completedItems: number;
  company?: { name: string } | null;
  intakeBy?: { name: string } | null;
  items?: ShopItemForPdf[];
}

// ---- Helpers ----

// Date-only DB columns hydrate as UTC midnight — format in UTC.
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

const CATEGORY_LABELS: Record<string, string> = {
  fire_extinguisher: 'Fire Extinguisher',
  area_monitor: 'Area Monitor',
  personal_monitor: 'Personal Monitor',
  fall_arrest: 'Fall Arrest',
  scba: 'SCBA',
  ue_cylinder: 'UE Cylinder',
  other: 'Other',
};

const SERVICE_LABELS: Record<string, string> = {
  repair: 'Repair',
  recharge: 'Recharge',
  inspection: 'Inspection',
  test: 'Test',
  calibrate: 'Calibrate',
  bump_test: 'Bump Test',
  warranty_repair: 'Warranty',
  ue_testing: 'UE Testing',
  sensor_replace: 'Sensor Replace',
  general: 'General',
};

// Display-layer relabel (mirrors ShopOrderDetailPage ITEM_STATUS).
const ITEM_STATUS_LABELS: Record<string, string> = {
  received: 'Received',
  diagnosing: 'Inspecting',
  awaiting_parts: 'Awaiting Parts',
  awaiting_approval: 'Awaiting Approval',
  in_work: 'In Repair',
  warranty_out: 'Warranty Out',
  outside_service: 'At Vendor',
  qc_testing: 'Re-Test',
  on_hold: 'On Hold',
  shop_complete: 'Ready for Pickup',
  returned: 'Returned',
  condemned: 'Condemned',
};

const WO_STATUS_LABELS: Record<string, string> = {
  intake: 'New',
  in_progress: 'Active',
  hold: 'On Hold',
  complete: 'Ready for Pickup',
  closed: 'Done',
};

// Brand color
const BRAND_DARK = '#1a2332';
const BRAND_ACCENT = '#0e7490';

// ---- Main Generator ----

export function generateShopWorkOrderPdf(wo: ShopWorkOrderForPdf): PDFKit.PDFDocument {
  const doc = new PDFDocument({
    size: 'LETTER',
    margins: { top: 36, bottom: 10, left: 50, right: 50 },
    bufferPages: true,
    info: {
      Title: `Work Order ${wo.workOrderNumber}`,
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

  doc.fontSize(16).font('Helvetica-Bold').fillColor(BRAND_DARK)
    .text(wo.workOrderNumber, contentLeft, y + 3, { width: contentWidth, align: 'right' });
  doc.fontSize(9).font('Helvetica').fillColor('#666666')
    .text(wo.isInternal ? 'Shop Work Order (Internal)' : 'Shop Work Order', contentLeft, y + 22, { width: contentWidth, align: 'right' });

  const statusLabel = WO_STATUS_LABELS[wo.status] || wo.status.replace(/_/g, ' ');
  doc.fontSize(9).font('Helvetica-Bold').fillColor(BRAND_ACCENT)
    .text(statusLabel.toUpperCase(), contentLeft, y + 34, { width: contentWidth, align: 'right' });

  y = y + 52;
  doc.moveTo(contentLeft, y).lineTo(contentRight, y).strokeColor(BRAND_ACCENT).lineWidth(1.5).stroke();
  y += 12;

  // ================================================================
  // WORK ORDER INFO — two-column grid
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
  yL = infoRow('Customer', wo.company?.name || '', col1X, yL);
  yL = infoRow('Intake Date', fmtDate(wo.intakeDate), col1X, yL);
  if (wo.promisedDate) yL = infoRow('Promised', fmtDate(wo.promisedDate), col1X, yL);
  yL = infoRow('Received By', wo.intakeBy?.name || '', col1X, yL);
  if (wo.dropOffContactName) {
    const dc = [wo.dropOffContactName, wo.dropOffContactPhone].filter(Boolean).join(' · ');
    yL = infoRow('Dropped Off By', dc, col1X, yL);
  }

  let yR = y;
  if (wo.poNumber) yR = infoRow('PO #', wo.poNumber, col2X, yR);
  if (wo.afeNumber) yR = infoRow('AFE', wo.afeNumber, col2X, yR);
  yR = infoRow('Items', `${wo.totalItems} total / ${wo.completedItems} ready`, col2X, yR);
  if (wo.pickupContactName) {
    const pc = [wo.pickupContactName, wo.pickupContactPhone].filter(Boolean).join(' · ');
    yR = infoRow('Pickup Contact', pc, col2X, yR);
  }
  if (wo.completedDate) yR = infoRow('Completed', fmtDate(wo.completedDate), col2X, yR);
  if (wo.returnedDate) yR = infoRow('Returned', fmtDate(wo.returnedDate), col2X, yR);

  y = Math.max(yL, yR) + 4;

  // ================================================================
  // INTAKE / GENERAL NOTES
  // ================================================================
  if (wo.intakeNotes || wo.notes) {
    y += 4;
    doc.moveTo(contentLeft, y).lineTo(contentRight, y).strokeColor('#e0e0e0').lineWidth(0.5).stroke();
    y += 10;
    if (wo.intakeNotes) {
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#555555').text('Intake Notes', contentLeft, y);
      y += 12;
      doc.fontSize(9).font('Helvetica').fillColor(valClr).text(wo.intakeNotes, contentLeft, y, { width: contentWidth });
      y = doc.y + 8;
    }
    if (wo.notes) {
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#555555').text('Notes', contentLeft, y);
      y += 12;
      doc.fontSize(9).font('Helvetica').fillColor(valClr).text(wo.notes, contentLeft, y, { width: contentWidth });
      y = doc.y + 8;
    }
  }

  // ================================================================
  // EQUIPMENT / ITEMS
  // ================================================================
  const items = (wo.items || []).sort((a, b) => a.itemNumber - b.itemNumber);

  if (items.length > 0) {
    y += 4;
    doc.moveTo(contentLeft, y).lineTo(contentRight, y).strokeColor('#e0e0e0').lineWidth(0.5).stroke();
    y += 10;
    doc.fontSize(10).font('Helvetica-Bold').fillColor(BRAND_DARK).text('Equipment & Service', contentLeft, y);
    y += 18;

    for (const item of items) {
      // Page-break guard — keep the item header block together.
      if (y > 680) { doc.addPage(); y = 40; }

      const category = CATEGORY_LABELS[item.equipmentCategory] || item.equipmentCategory.replace(/_/g, ' ');
      const service = SERVICE_LABELS[item.serviceType] || item.serviceType.replace(/_/g, ' ');
      const statusTxt = ITEM_STATUS_LABELS[item.status] || item.status.replace(/_/g, ' ');

      // Item title row: #N  Serial — Category
      doc.fontSize(9).font('Helvetica-Bold').fillColor(BRAND_DARK)
        .text(`#${item.itemNumber}  ${item.serialNumber}`, contentLeft, y, { width: contentWidth - 110, continued: false });
      // Status badge (right aligned)
      doc.fontSize(8).font('Helvetica-Bold').fillColor(BRAND_ACCENT)
        .text(statusTxt.toUpperCase(), contentRight - 110, y, { width: 110, align: 'right' });
      y += 13;

      // Sub-line: category · service · description
      const descParts = [category, service];
      if (item.equipmentDescription) descParts.push(item.equipmentDescription);
      const fexParts = [item.fexBrand, item.fexSize, item.fexType].filter(Boolean);
      if (fexParts.length) descParts.push(fexParts.join(' '));
      doc.fontSize(8).font('Helvetica').fillColor('#555555')
        .text(descParts.filter(Boolean).join('  ·  '), contentLeft + 8, y, { width: contentWidth - 8 });
      y = doc.y + 3;

      const detail = (label: string, value: string | null) => {
        if (!value) return;
        if (y > 720) { doc.addPage(); y = 40; }
        doc.fontSize(7.5).font('Helvetica-Bold').fillColor('#777777').text(label, contentLeft + 8, y, { width: 70, continued: true });
        doc.font('Helvetica').fillColor('#000000').text(`  ${value}`, { width: contentWidth - 86 });
        y = doc.y + 2;
      };

      detail('Reported', item.reportedIssue);
      detail('Diagnosis', item.diagnosisNotes);
      detail('Work', item.workNotes);
      if (item.isWarranty) detail('Warranty', item.warrantyVendor ? `Yes — ${item.warrantyVendor}` : 'Yes');
      if (item.sentOutTo) detail('Sent To', item.sentOutTo);
      if (item.qcResult) detail('QC', `${item.qcResult}${item.qcNotes ? ` — ${item.qcNotes}` : ''}`);
      if (item.assignedTo?.name) detail('Tech', item.assignedTo.name);
      const cost = fmtCurrency(item.estimatedCost);
      if (cost) detail('Est. Cost', cost);

      // SCBA sub-components
      const kids = item.childComponents || [];
      if (kids.length > 0) {
        for (const kid of kids) {
          if (y > 730) { doc.addPage(); y = 40; }
          const kcat = CATEGORY_LABELS[kid.equipmentCategory] || kid.equipmentCategory.replace(/_/g, ' ');
          doc.fontSize(7.5).font('Helvetica-Oblique').fillColor('#666666')
            .text(`└ ${kid.serialNumber}  (${kcat})`, contentLeft + 16, y, { width: contentWidth - 16 });
          y = doc.y + 2;
        }
      }

      y += 6;
      doc.moveTo(contentLeft, y).lineTo(contentRight, y).strokeColor('#eeeeee').lineWidth(0.5).stroke();
      y += 8;
    }
  }

  // ================================================================
  // PICKUP / RELEASE SIGNATURE
  // ================================================================
  const hasPickupSig = wo.pickupSignature && wo.pickupSignature.startsWith('data:');

  if (y > 600) { doc.addPage(); y = 40; }

  y += 8;
  doc.moveTo(contentLeft, y).lineTo(contentRight, y).strokeColor(BRAND_ACCENT).lineWidth(0.75).stroke();
  y += 10;
  doc.fontSize(9).font('Helvetica-Bold').fillColor(BRAND_DARK).text('Pickup / Release', contentLeft, y);
  y += 16;

  const sigWidth = 250;
  const sigHeight = 45;

  if (hasPickupSig) {
    doc.fontSize(7.5).font('Helvetica').fillColor(labelClr).text('Received By (Signature)', contentLeft, y);
    y += 10;
    try {
      doc.image(wo.pickupSignature!, contentLeft, y, { fit: [sigWidth, sigHeight] });
    } catch {
      doc.fontSize(8).font('Helvetica').fillColor('#aaa').text('[signature]', contentLeft, y);
    }
    y += sigHeight + 2;
  } else {
    // Empty placeholder line for manual sign-off
    y += 14;
    doc.rect(contentLeft, y - 12, sigWidth, 1).fill('#cccccc');
  }
  doc.moveTo(contentLeft, y).lineTo(contentLeft + sigWidth, y).strokeColor('#999').lineWidth(0.5).stroke();
  doc.fontSize(7).font('Helvetica').fillColor('#666')
    .text(wo.pickupSignedByName || '', contentLeft, y + 3, { width: sigWidth });
  if (wo.pickupSignedAt) {
    doc.fontSize(7).font('Helvetica').fillColor('#999')
      .text(fmtDateTime(wo.pickupSignedAt), contentLeft + sigWidth + 20, y + 3);
  }
  y += 18;
  if (wo.pickupNotes) {
    doc.fontSize(8).font('Helvetica-Oblique').fillColor('#666').text(wo.pickupNotes, contentLeft, y, { width: contentWidth });
  }

  // ================================================================
  // FOOTER — every page
  // ================================================================
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

  // NOTE: caller is responsible for calling doc.end()
  return doc;
}
