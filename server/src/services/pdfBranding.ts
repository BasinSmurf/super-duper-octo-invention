import sharp from 'sharp';
import { getBranding } from './branding.js';
import { getFileStore } from './fileStore.js';

export interface PdfBranding {
  companyName: string;
  logo: Buffer | null;
}

/** Resolve once per report, so every page uses the same saved company identity. */
export async function loadPdfBranding(config?: Awaited<ReturnType<typeof getBranding>>): Promise<PdfBranding> {
  const branding = config ?? await getBranding();
  let logo: Buffer | null = null;
  if (branding.logoKey) {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      // Normalize stored images defensively before PDFKit reads them. A broken
      // or unavailable logo must not prevent producing a service report.
      const bytes = await Promise.race([
        getFileStore().read(branding.logoKey),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('Company logo read timed out')), 3_000);
        }),
      ]);
      logo = await sharp(bytes, { limitInputPixels: 16_000_000 })
        .resize({ width: 1024, height: 512, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
    } catch {
      console.warn('[pdf-branding] Company logo unavailable; rendering the saved company name');
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
  return { companyName: branding.companyName, logo };
}

/** Keep branding inside the left header column, clear of the report identifier. */
export function drawCompanyHeader(doc: PDFKit.PDFDocument, branding: PdfBranding, x: number, y: number, width: number, color: string,
  options: { maxFontSize?: number; align?: 'left' | 'center' } = {}): void {
  const logoWidth = branding.logo ? 62 : 0;
  if (branding.logo) doc.image(branding.logo, x, y, { fit: [54, 24], align: 'center', valign: 'center' });
  const availableWidth = width - logoWidth;
  doc.font('Helvetica-Bold').fillColor(color);
  let size = options.maxFontSize ?? 22;
  while (size > 9 && doc.fontSize(size).widthOfString(branding.companyName) > availableWidth) size--;
  doc.fontSize(size).text(singleLine(doc, branding.companyName, availableWidth), x + logoWidth, y + (22 - size) / 2, {
    width: availableWidth, height: 25, lineBreak: false, align: options.align ?? 'left',
  });
}

function singleLine(doc: PDFKit.PDFDocument, text: string, width: number): string {
  if (doc.widthOfString(text) <= width) return text;
  let shortened = text;
  while (shortened.length && doc.widthOfString(`${shortened}...`) > width) shortened = shortened.slice(0, -1);
  return `${shortened.trimEnd()}...`;
}

export function drawPdfFooters(doc: PDFKit.PDFDocument, branding: PdfBranding, date: string, left: number, right: number): void {
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    // Footers live below the body margin. Temporarily permit writing there so
    // PDFKit neither adds a blank page nor paints the footer over long notes.
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = Math.min(bottom, 10);
    try {
      const y = doc.page.height - 40;
      doc.moveTo(left, y - 6).lineTo(right, y - 6).strokeColor('#e0e0e0').lineWidth(0.5).stroke();
      doc.font('Helvetica').fillColor('#aaaaaa').fontSize(7);
      const text = `Generated ${date}  |  ${branding.companyName}  |  Williston, ND  |  701.572.8140`;
      doc.text(singleLine(doc, text, right - left - 60), left, y, { width: right - left - 60, height: 12, align: 'center', lineBreak: false });
      doc.fillColor('#bbbbbb').text(`Page ${i + 1} of ${range.count}`, right - 55, y, { lineBreak: false });
    } finally {
      doc.page.margins.bottom = bottom;
    }
  }
}
