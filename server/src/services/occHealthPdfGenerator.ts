/**
 * occHealthPdfGenerator.ts
 *
 * The Occ Health report: a per-ticket PDF with the full detail of every
 * person's visit — fit test (respirator(s), method, fit factor, result,
 * expiry), audiometric exam (baseline/retest), MEQ status, disclosure
 * acknowledgments, adverse reactions, and the participant signature.
 *
 * This is the generated counterpart to the per-person machine printouts that
 * ride along as `fit_test_report` attachments — those are scans; this is the
 * structured record. Layout/branding mirrors ticketPdfGenerator.ts.
 */

import PDFDocument from 'pdfkit';
import { drawCompanyHeader, drawPdfFooters, loadPdfBranding, type PdfBranding } from './pdfBranding.js';

// ---- Types (mirrors the Prisma include from GET /tickets/:id/occ-health-pdf) ----

interface OccHealthRecord {
  employeeName: string;
  employeeId: string | null;
  employerName: string | null;
  jobTitle: string | null;
  respiratorMake: string | null;
  respiratorModel: string | null;
  respiratorSize: string | null;
  respiratorType: string | null;
  respiratorClass: string | null;
  secondMask: unknown;
  testType: string | null;
  testMethod: string | null;
  fitFactor: any;
  passFail: string;
  testDate: Date | string;
  expiryDate: Date | string | null;
  notes: string | null;
  meqAccepted: boolean;
  meqDate: Date | string | null;
  includesFitTest: boolean;
  includesAudiometric: boolean;
  audiometricResult: string | null;
  disclosureConditions: unknown;
  isCleanShaven: boolean | null;
  wearsGlassesContacts: boolean | null;
  criteriaAcknowledged: boolean;
  participantSignature: string | null;
  adverseReactions: unknown;
}

interface TicketForOccHealthPdf {
  ticketNumber: string | null;
  serviceDate: Date | string;
  locationDisplay: string | null;
  company?: { name: string } | null;
  field?: { name: string } | null;
  pad?: { name: string } | null;
  well?: { wellName: string | null } | null;
  assignedTech?: { name: string } | null;
  fitTestRecords: OccHealthRecord[];
}

// ---- Labels ----

const RESPIRATOR_TYPE_LABELS: Record<string, string> = {
  half_face: 'Half Face',
  full_face: 'Full Face',
  scba: 'SCBA',
  sar: 'SAR',
};

const TEST_METHOD_LABELS: Record<string, string> = {
  isoamyl_acetate: 'Isoamyl Acetate',
  bitrex: 'Bitrex',
  irritant_smoke: 'Irritant Smoke',
  portacount: 'PortaCount',
  tsi_8030: 'TSI 8030',
  ambient_aerosol: 'Ambient Aerosol',
};

// Keys mirror FitTestEditor.tsx DISCLOSURE_CONDITIONS / ADVERSE_REACTIONS.
const DISCLOSURE_CONDITION_LABELS: Record<string, string> = {
  beard_1_2_day: '1-2 Day beard growth prevents seal',
  beard_2_plus_day: '2+ Day beard growth prevents seal',
  glasses_prevent_seal: 'Glasses prevent seal',
  facial_scar: 'Facial scar can prevent seal',
  dentures: 'Dentures can prevent seal',
  weight_change: 'Extreme weight gain/loss (requires additional fit test)',
  annual_test: 'Must be fit tested annually',
  company_policies: 'Follow company policies',
  idlh_required: 'Respirator required in IDLH atmospheres',
};

const ADVERSE_REACTION_LABELS: Record<string, string> = {
  skin_irritation: 'Skin Irritation',
  difficulty_breathing: 'Difficulty Breathing',
  lack_of_visibility: 'Lack of Visibility',
  improper_fit: 'Respirator too tight / improper fit',
  claustrophobia: 'Claustrophobia',
};

// ---- Helpers ----

// All the record dates here (testDate, expiryDate, meqDate, serviceDate) are
// date-only DB columns that hydrate as UTC midnight — format in UTC, or Central
// time renders them a day early.
function fmtDate(d: Date | string | null): string {
  if (!d) return '';
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt.getTime())) return String(d);
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function fmtFitFactor(val: any): string {
  if (val == null || val === '') return '';
  const n = typeof val === 'string' ? parseFloat(val) : Number(val);
  if (isNaN(n) || n <= 0) return '';
  return n === Math.floor(n) ? String(n) : n.toFixed(2);
}

function asKeyArray(val: unknown): string[] {
  return Array.isArray(val) ? val.filter((k): k is string => typeof k === 'string') : [];
}

// Brand colors (match ticketPdfGenerator)
const BRAND_DARK = '#1a2332';
const BRAND_ACCENT = '#0e7490';

// ---- Main Generator ----

export async function generateOccHealthPdf(ticket: TicketForOccHealthPdf, providedBranding?: PdfBranding): Promise<PDFKit.PDFDocument> {
  const branding = providedBranding ?? await loadPdfBranding();
  const doc = new PDFDocument({
    size: 'LETTER',
    margins: { top: 36, bottom: 10, left: 50, right: 50 },
    bufferPages: true,
    info: {
      Title: `Occ Health Report ${ticket.ticketNumber || 'Draft'}`,
      Author: branding.companyName,
      Creator: 'Sundog Field Service Platform',
    },
  });

  const pageWidth = 612;
  const contentLeft = 50;
  const contentRight = pageWidth - 50;
  const contentWidth = contentRight - contentLeft;
  const labelClr = '#888888';
  const valClr = '#000000';

  // ================================================================
  // HEADER
  // ================================================================
  let y = 36;

  drawCompanyHeader(doc, branding, contentLeft, y, contentWidth / 2 - 14, BRAND_DARK);
  doc.fontSize(7.5).font('Helvetica').fillColor('#666666');
  doc.text('701.572.8140  |  billing@basinsafetyus.com  |  Williston, ND 58801', contentLeft, y + 26);

  doc.fontSize(16).font('Helvetica-Bold').fillColor(BRAND_DARK)
    .text(ticket.ticketNumber || 'DRAFT', contentLeft, y + 3, { width: contentWidth, align: 'right' });
  doc.fontSize(9).font('Helvetica').fillColor('#666666')
    .text('Occupational Health Report', contentLeft, y + 22, { width: contentWidth, align: 'right' });

  y += 52;
  doc.moveTo(contentLeft, y).lineTo(contentRight, y).strokeColor(BRAND_ACCENT).lineWidth(1.5).stroke();
  y += 12;

  // ================================================================
  // VISIT INFO
  // ================================================================
  const colLabelW = 80;
  const col2X = contentLeft + contentWidth / 2 + 10;

  function infoRow(label: string, value: string, x: number, yPos: number): number {
    if (!value) return yPos;
    doc.fontSize(7.5).font('Helvetica').fillColor(labelClr).text(label, x, yPos, { width: colLabelW });
    doc.fontSize(9).font('Helvetica').fillColor(valClr).text(value, x + colLabelW + 4, yPos, { width: contentWidth / 2 - colLabelW - 14 });
    return yPos + 14;
  }

  let yL = y;
  yL = infoRow('Date of Service', fmtDate(ticket.serviceDate), contentLeft, yL);
  yL = infoRow('Technician', ticket.assignedTech?.name || '', contentLeft, yL);

  let yR = y;
  yR = infoRow('Customer', ticket.company?.name || '', col2X, yR);
  const siteParts = [ticket.field?.name, ticket.pad?.name, ticket.well?.wellName].filter(Boolean);
  const siteStr = siteParts.join('  >  ') || ticket.locationDisplay || '';
  if (siteStr) yR = infoRow('Site', siteStr, col2X, yR);

  y = Math.max(yL, yR) + 6;

  // ================================================================
  // PER-PERSON SECTIONS
  // ================================================================
  function detailRow(label: string, value: string, x: number, yPos: number, valueColor = valClr, bold = false): number {
    if (!value) return yPos;
    doc.fontSize(7.5).font('Helvetica').fillColor(labelClr).text(label, x, yPos, { width: 90 });
    doc.fontSize(8.5).font(bold ? 'Helvetica-Bold' : 'Helvetica').fillColor(valueColor)
      .text(value, x + 94, yPos, { width: contentWidth / 2 - 104 });
    return Math.max(yPos + 13, doc.y + 2);
  }

  const records = ticket.fitTestRecords || [];
  for (const rec of records) {
    // Rough worst-case block height: header + two detail columns + disclosure
    // list + signature. Start a fresh page rather than splitting a person.
    if (y > 480) { doc.addPage(); y = 40; }

    y += 4;
    doc.moveTo(contentLeft, y).lineTo(contentRight, y).strokeColor('#e0e0e0').lineWidth(0.5).stroke();
    y += 10;

    // Person header: name + services performed
    const services: string[] = [];
    if (rec.includesFitTest) services.push(`Fit Test: ${rec.passFail === 'pass' ? 'PASS' : 'FAIL'}`);
    if (rec.includesAudiometric) {
      services.push(`Audiometric: ${rec.audiometricResult === 'retest' ? 'Retest' : 'Baseline'}`);
    }
    doc.fontSize(11).font('Helvetica-Bold').fillColor(BRAND_DARK).text(rec.employeeName, contentLeft, y);
    doc.fontSize(9).font('Helvetica-Bold')
      .fillColor(rec.includesFitTest && rec.passFail !== 'pass' ? '#dc2626' : '#16a34a')
      .text(services.join('   |   '), contentLeft, y + 1.5, { width: contentWidth, align: 'right' });
    y += 15;

    const subParts = [rec.employerName, rec.jobTitle, rec.employeeId ? `ID ${rec.employeeId}` : null].filter(Boolean);
    if (subParts.length) {
      doc.fontSize(8).font('Helvetica').fillColor('#666666').text(subParts.join('  ·  '), contentLeft, y);
      y += 13;
    }
    y += 2;

    // Two-column detail grid: fit test left, screening/audio right
    let dL = y;
    let dR = y;

    if (rec.includesFitTest) {
      const mask = [rec.respiratorMake, rec.respiratorModel].filter(Boolean).join(' ');
      const maskStr = mask ? (rec.respiratorSize ? `${mask} (${rec.respiratorSize})` : mask) : '';
      const typeLabel = rec.respiratorType ? RESPIRATOR_TYPE_LABELS[rec.respiratorType] || rec.respiratorType : '';
      const typeStr = rec.respiratorClass ? `${typeLabel} — ${rec.respiratorClass.toUpperCase()}` : typeLabel;
      const methodParts = [
        rec.testType ? (rec.testType === 'quantitative' ? 'Quantitative' : 'Qualitative') : null,
        rec.testMethod ? TEST_METHOD_LABELS[rec.testMethod] || rec.testMethod : null,
      ].filter(Boolean);

      dL = detailRow('Respirator', maskStr, contentLeft, dL);
      dL = detailRow('Type', typeStr, contentLeft, dL);
      dL = detailRow('Method', methodParts.join(' — '), contentLeft, dL);
      dL = detailRow('Fit Factor', fmtFitFactor(rec.fitFactor), contentLeft, dL);

      const second = rec.secondMask as { make?: string; model?: string; size?: string; respiratorType?: string; respiratorClass?: string; fitFactor?: any } | null;
      if (second && (second.make || second.model)) {
        const m2 = [second.make, second.model].filter(Boolean).join(' ');
        const m2Str = second.size ? `${m2} (${second.size})` : m2;
        const ff2 = fmtFitFactor(second.fitFactor);
        dL = detailRow('2nd Mask', ff2 ? `${m2Str} — FF ${ff2}` : m2Str, contentLeft, dL);
      }
    }

    dR = detailRow('Test Date', fmtDate(rec.testDate), col2X, dR);
    if (rec.includesFitTest) {
      dR = detailRow('Expires', fmtDate(rec.expiryDate), col2X, dR);
      dR = detailRow(
        'MEQ',
        rec.meqAccepted ? `Current${rec.meqDate ? ` (${fmtDate(rec.meqDate)})` : ''}` : 'Not verified',
        col2X, dR, rec.meqAccepted ? valClr : '#b45309',
      );
      if (rec.isCleanShaven !== null) dR = detailRow('Clean Shaven', rec.isCleanShaven ? 'Yes' : 'No', col2X, dR);
      if (rec.wearsGlassesContacts !== null) dR = detailRow('Glasses/Contacts', rec.wearsGlassesContacts ? 'Yes' : 'No', col2X, dR);
    }

    y = Math.max(dL, dR) + 2;

    // Adverse reactions — only when something was reported; flag it visibly.
    const reactions = asKeyArray(rec.adverseReactions).map((k) => ADVERSE_REACTION_LABELS[k] || k);
    if (reactions.length > 0) {
      doc.fontSize(7.5).font('Helvetica-Bold').fillColor('#dc2626').text('Adverse Reactions', contentLeft, y);
      doc.fontSize(8.5).font('Helvetica').fillColor('#dc2626')
        .text(reactions.join(', '), contentLeft + 94, y, { width: contentWidth - 94 });
      y = doc.y + 4;
    }

    // Disclosure acknowledgment — compact single line listing what was acknowledged.
    const conditions = asKeyArray(rec.disclosureConditions);
    if (rec.includesFitTest && (conditions.length > 0 || rec.criteriaAcknowledged)) {
      const allAcknowledged = conditions.length >= Object.keys(DISCLOSURE_CONDITION_LABELS).length;
      const ackStr = allAcknowledged
        ? 'Participant acknowledged all fit test seal/usage conditions'
        : `Participant acknowledged: ${conditions.map((k) => DISCLOSURE_CONDITION_LABELS[k] || k).join('; ')}`;
      doc.fontSize(7.5).font('Helvetica-Oblique').fillColor('#666666')
        .text(ackStr, contentLeft, y, { width: contentWidth });
      y = doc.y + 4;
    }

    if (rec.notes) {
      doc.fontSize(7.5).font('Helvetica').fillColor(labelClr).text('Notes', contentLeft, y);
      doc.fontSize(8.5).font('Helvetica').fillColor(valClr)
        .text(rec.notes, contentLeft + 94, y, { width: contentWidth - 94 });
      y = doc.y + 4;
    }

    // Participant signature
    if (rec.participantSignature && rec.participantSignature.startsWith('data:')) {
      doc.fontSize(7.5).font('Helvetica').fillColor(labelClr).text('Participant Signature', contentLeft, y);
      y += 10;
      try {
        doc.image(rec.participantSignature, contentLeft, y, { fit: [160, 36] });
      } catch {
        doc.fontSize(8).font('Helvetica').fillColor('#aaa').text('[signature]', contentLeft, y);
      }
      y += 40;
    }

    y += 2;
  }

  if (records.length === 0) {
    doc.fontSize(10).font('Helvetica').fillColor('#888888')
      .text('No occupational health records on this ticket.', contentLeft, y + 10);
  }

  // ================================================================
  // FOOTER — every page
  // ================================================================
  const now = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  drawPdfFooters(doc, branding, now, contentLeft, contentRight);

  // NOTE: caller is responsible for calling doc.end() — either via pdfToBuffer() or after .pipe()
  return doc;
}
