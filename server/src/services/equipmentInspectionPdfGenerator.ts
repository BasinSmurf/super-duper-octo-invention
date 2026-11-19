import PDFDocument from 'pdfkit';
import { drawCompanyHeader, drawPdfFooters, loadPdfBranding, type PdfBranding } from './pdfBranding.js';

// Minimal one-page condemnation report — the attachment BlueLion's
// POST /documents (docType: 'condemnation') requires. Not a replacement for
// the full shop work order PDF; just enough of a defensible record to satisfy
// "a file exists for this condemned unit" per §3.4 of the integration spec.

export interface EquipmentInspectionForPdf {
  serialNumber: string;
  category: string;
  outcome: string;
  inspectedOn: Date | string;
  condemnedOn?: Date | string | null;
  serviceActions?: string[];
  notes?: string | null;
  technician?: string | null;
  customer?: string | null;
  manualRefs?: Array<{ key: string; doc: string; section?: string; revision?: string }>;
}

function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return '';
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt.getTime())) return String(d);
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

const CATEGORY_LABELS: Record<string, string> = {
  fire_extinguisher: 'Fire Extinguisher',
  gas_detection: 'Gas Detection',
  scba: 'SCBA',
  fall_arrest: 'Fall Arrest',
  ue_cylinder: 'UE Cylinder',
  breathing_air_system: 'Breathing Air System',
  first_aid_kit: 'First Aid Kit',
  other: 'Other',
};

const BRAND_DARK = '#1a2332';
const BRAND_ACCENT = '#0e7490';
const DANGER = '#b91c1c';

export async function generateEquipmentInspectionPdf(insp: EquipmentInspectionForPdf, providedBranding?: PdfBranding): Promise<PDFKit.PDFDocument> {
  const branding = providedBranding ?? await loadPdfBranding();
  const doc = new PDFDocument({
    size: 'LETTER',
    margins: { top: 50, bottom: 50, left: 50, right: 50 },
    bufferPages: true,
    info: {
      Title: `Condemnation Report — ${insp.serialNumber}`,
      Author: branding.companyName,
      Creator: 'Sundog Field Service Platform',
    },
  });

  const contentLeft = 50;
  const contentRight = 562;
  const contentWidth = contentRight - contentLeft;
  let y = 50;

  drawCompanyHeader(doc, branding, contentLeft, y, contentWidth / 2 - 14, BRAND_DARK);
  doc.fontSize(8).font('Helvetica').fillColor('#666666')
    .text('701.572.8140  |  billing@basinsafetyus.com  |  Williston, ND 58801', contentLeft, y + 24);

  doc.fontSize(14).font('Helvetica-Bold').fillColor(DANGER)
    .text('CONDEMNATION REPORT', contentLeft, y + 2, { width: contentWidth, align: 'right' });

  y += 50;
  doc.moveTo(contentLeft, y).lineTo(contentRight, y).strokeColor(DANGER).lineWidth(1.5).stroke();
  y += 16;

  const row = (label: string, value: string) => {
    if (!value) return;
    doc.fontSize(8).font('Helvetica').fillColor('#888888').text(label, contentLeft, y, { width: 110 });
    doc.fontSize(10).font('Helvetica').fillColor('#000000').text(value, contentLeft + 114, y, { width: contentWidth - 114 });
    y = doc.y + 6;
  };

  row('Serial Number', insp.serialNumber);
  row('Category', CATEGORY_LABELS[insp.category] || insp.category.replace(/_/g, ' '));
  row('Customer', insp.customer || '');
  row('Inspected On', fmtDate(insp.inspectedOn));
  row('Condemned On', fmtDate(insp.condemnedOn ?? insp.inspectedOn));
  row('Inspector', insp.technician || '');

  y += 6;
  doc.moveTo(contentLeft, y).lineTo(contentRight, y).strokeColor('#e0e0e0').lineWidth(0.5).stroke();
  y += 14;

  doc.fontSize(11).font('Helvetica-Bold').fillColor(DANGER)
    .text('Result: CONDEMNED — removed from service', contentLeft, y);
  y += 20;

  const actions = insp.serviceActions?.filter(Boolean) ?? [];
  if (actions.length) {
    doc.fontSize(9).font('Helvetica-Bold').fillColor('#555555').text('Service Actions', contentLeft, y);
    y += 14;
    doc.fontSize(9).font('Helvetica').fillColor('#000000').text(actions.join(', '), contentLeft, y, { width: contentWidth });
    y = doc.y + 10;
  }

  if (insp.notes) {
    doc.fontSize(9).font('Helvetica-Bold').fillColor('#555555').text('Notes', contentLeft, y);
    y += 14;
    doc.fontSize(9).font('Helvetica').fillColor('#000000').text(insp.notes, contentLeft, y, { width: contentWidth });
    y = doc.y + 10;
  }

  const refs = insp.manualRefs?.filter((r) => r?.doc) ?? [];
  if (refs.length) {
    doc.fontSize(9).font('Helvetica-Bold').fillColor('#555555').text('Manual References', contentLeft, y);
    y += 14;
    for (const r of refs) {
      const line = [r.doc, r.section, r.revision ? `rev. ${r.revision}` : null].filter(Boolean).join(' · ');
      doc.fontSize(8.5).font('Helvetica').fillColor('#000000').text(`• ${line}`, contentLeft + 6, y, { width: contentWidth - 6 });
      y = doc.y + 3;
    }
    y += 8;
  }

  drawPdfFooters(doc, branding, fmtDate(new Date()), contentLeft, contentRight);

  // NOTE: caller is responsible for calling doc.end()
  return doc;
}
