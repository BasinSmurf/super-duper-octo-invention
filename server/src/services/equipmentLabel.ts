/**
 * equipmentLabel.ts — badge generation for serialized equipment.
 *
 * Two outputs, one identity: both encode the bare SERIAL NUMBER in a QR code,
 * which is exactly what the in-app camera scanner (EquipmentScanner →
 * BarcodeScanner) looks up. Scan a badge → the unit drops onto the job.
 *
 *   - equipmentLabelZpl()  → 2x2" ZD411 thermal label (Zebra, reprint button)
 *   - generateEquipmentBadgePdf() → larger PDF placard for any printer / laminating
 *
 * The QR payload is the raw serial (no URL, no prefix) so the scanner's
 * serial lookup resolves it offline.
 */

import PDFDocument from 'pdfkit';
import { drawCompanyHeader, loadPdfBranding, type PdfBranding } from './pdfBranding.js';
import QRCode from 'qrcode';

/** Strip ZPL control chars so interpolated data can't break the label format. */
function sanitizeZpl(v: string): string {
  return v.replace(/[\^~]/g, ' ');
}

// 51x51mm ZD411 stock @ 300dpi = 51 * 300/25.4 ≈ 602 dots square.
const LABEL_DOTS = 602;
// QR target footprint — ~60% of the label (down from 80%, which dominated the
// badge), leaving room above for the Basin Safety brand line and the equipment
// type, and below for the human-readable serial.
const QR_TARGET_DOTS = Math.round(LABEL_DOTS * 0.6);
// Quiet zone (in QR modules) baked into the rendered bitmap so the graphic
// can run right up to the edge of its footprint and still scan.
const QR_QUIET_MODULES = 4;

/**
 * Render the serial as a QR bitmap scaled to fill ~QR_TARGET_DOTS, then emit it
 * as a ZPL ^GF graphic field. Integer module scaling keeps every module a whole
 * number of dots (crisp on thermal, reliable scans); the actual footprint lands
 * within one module of the target regardless of how long the serial is.
 */
function qrGraphicField(serial: string): { gf: string; dots: number } {
  const qr = QRCode.create(serial, { errorCorrectionLevel: 'H' });
  const size = qr.modules.size;
  const data = qr.modules.data; // row-major, 1 = dark
  const grid = size + QR_QUIET_MODULES * 2;

  // Largest whole-dot module size that keeps the QR (incl. quiet zone) within
  // the target footprint.
  const dotsPerModule = Math.max(1, Math.floor(QR_TARGET_DOTS / grid));
  const dots = dotsPerModule * grid;
  const bytesPerRow = Math.ceil(dots / 8);
  const bitmap = new Uint8Array(bytesPerRow * dots);

  for (let mr = 0; mr < size; mr++) {
    for (let mc = 0; mc < size; mc++) {
      if (!data[mr * size + mc]) continue; // light module → leave white
      const x0 = (mc + QR_QUIET_MODULES) * dotsPerModule;
      const y0 = (mr + QR_QUIET_MODULES) * dotsPerModule;
      for (let dy = 0; dy < dotsPerModule; dy++) {
        const rowBase = (y0 + dy) * bytesPerRow;
        for (let dx = 0; dx < dotsPerModule; dx++) {
          const x = x0 + dx;
          bitmap[rowBase + (x >> 3)] |= 0x80 >> (x & 7); // 1 = black
        }
      }
    }
  }

  let hex = '';
  for (let i = 0; i < bitmap.length; i++) {
    hex += bitmap[i]!.toString(16).padStart(2, '0').toUpperCase();
  }
  const total = bitmap.length;
  return { gf: `^GFA,${total},${total},${bytesPerRow},${hex}`, dots };
}

/**
 * 51x51mm (602x602 dot @ 300dpi) ZD411 label, stacked top-to-bottom:
 *
 *   Basin Safety           ← brand line
 *   <equipment type>       ← wraps to 2 lines so long names don't truncate
 *   [ QR of bare serial ]  ← ~60% of the label
 *   <SERIAL>               ← large, pulled up directly under the QR
 *
 * Every element is inset from the edges so nothing clips on the thermal head.
 * The QR is rendered to a ^GF graphic (rather than ^BQ) so its footprint stays
 * fixed no matter the serial length.
 */
export async function equipmentLabelZpl(serial: string, productName: string): Promise<string> {
  const s = sanitizeZpl(serial);
  const name = sanitizeZpl(productName);

  const { gf, dots } = qrGraphicField(serial);
  const qrX = Math.floor((LABEL_DOTS - dots) / 2);

  // The thermal head's top registration shaves the first ~30 dots, so the old
  // top line (at y=8) lost its top ~20%. Keep a blank safe margin before any
  // content and let the unused space at the bottom absorb the downward shift.
  const TOP_SAFE = 40;
  const BRAND_Y = TOP_SAFE;
  const TYPE_Y = BRAND_Y + 38; // below the brand line
  const TYPE_MARGIN = 20;
  // QR sits below the type band (room for up to two type lines); the serial
  // rides directly under the QR rather than pinned to the bottom edge.
  const QR_Y = TYPE_Y + 72;
  const serialY = QR_Y + dots + 16;

  return [
    '^XA',
    `^PW${LABEL_DOTS}`,
    `^LL${LABEL_DOTS}`,
    `^FO0,${BRAND_Y}^A0N,28,28^FB${LABEL_DOTS},1,0,C^FDBasin Safety^FS`,
    `^FO${TYPE_MARGIN},${TYPE_Y}^A0N,30,30^FB${LABEL_DOTS - TYPE_MARGIN * 2},2,0,C^FD${name}^FS`,
    `^FO${qrX},${QR_Y}${gf}^FS`,
    `^FO0,${serialY}^A0N,50,50^FB${LABEL_DOTS},1,0,C^FD${s}^FS`,
    '^XZ',
  ].join('\n');
}

/**
 * A laminate-friendly PDF placard (4x4"). Big centered QR of the serial,
 * serial in large bold below, product name, Basin footer. Returns a piped-ready
 * PDFKit document with all content already written — the caller pipes it to the
 * response (or a buffer) and calls .end().
 */
export async function generateEquipmentBadgePdf(
  serial: string,
  productName: string,
  providedBranding?: PdfBranding,
): Promise<PDFKit.PDFDocument> {
  const branding = providedBranding ?? await loadPdfBranding();
  const SIZE = 288; // 4 inches @ 72pt/in
  const doc = new PDFDocument({ size: [SIZE, SIZE], margin: 0, info: { Author: branding.companyName } });

  // QR as a PNG buffer — high error correction so a scuffed trailer sticker
  // still scans.
  const qrPng = await QRCode.toBuffer(serial, {
    errorCorrectionLevel: 'H',
    margin: 1,
    width: 600,
  });

  const qrSize = 176;
  const qrX = (SIZE - qrSize) / 2;
  doc.image(qrPng, qrX, 24, { width: qrSize, height: qrSize });

  doc
    .font('Helvetica-Bold')
    .fontSize(26)
    .text(serial, 0, 214, { width: SIZE, align: 'center' });

  doc
    .font('Helvetica')
    .fontSize(11)
    .fillColor('#444')
    .text(productName, 12, 246, { width: SIZE - 24, align: 'center' });

  drawCompanyHeader(doc, branding, 12, SIZE - 28, SIZE - 24, '#888888', { maxFontSize: 9, align: 'center' });

  return doc;
}
