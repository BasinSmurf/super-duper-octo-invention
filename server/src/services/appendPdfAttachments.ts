import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import sharp from 'sharp';
import PDFKit from 'pdfkit';
import { pdfToBuffer } from '../utils/pdfToBuffer.js';
import type { PdfExportAttachment } from './pdfExportAttachments.js';
import { AppError } from '../middleware/errorHandler.js';

const printable = (value: string) => value.replace(/[^\x20-\x7e]/g, '?');

/** Preserve every PDF page; fit each image on its own labeled letter-size page. */
export async function appendPdfAttachments(basePdf: Buffer, attachments: PdfExportAttachment[]): Promise<Buffer> {
  if (!attachments.length) return basePdf;
  const output = await PDFDocument.load(basePdf);
  const font = await output.embedFont(StandardFonts.Helvetica);
  for (const [index, attachment] of attachments.entries()) {
    try {
      const bytes = await attachment.read();
      const pdf = bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'));
      if (pdf || attachment.mimeType === 'application/pdf' || /\.pdf$/i.test(attachment.fileName)) {
        const source = await PDFDocument.load(bytes);
        if (!source.getPageCount()) throw new Error('PDF has no pages');
        const pages = await output.copyPages(source, source.getPageIndices());
        for (const page of pages) output.addPage(page);
      } else if (attachment.mimeType?.startsWith('image/') || /\.(png|jpe?g|webp|gif|tiff?|bmp|heic|avif|svg)$/i.test(attachment.fileName)) {
        const metadata = await sharp(bytes).metadata();
        for (let frame = 0; frame < (metadata.pages || 1); frame++) {
          const png = await sharp(bytes, { page: frame }).rotate().png().toBuffer();
          const image = await output.embedPng(png);
          const page = output.addPage([612, 792]);
          const size = image.scale(Math.min(540 / image.width, 684 / image.height));
          const name = printable(attachment.fileName);
          let label = name;
          while (font.widthOfTextAtSize(label, 10) > 540) label = label.slice(0, -4) + '...';
          page.drawText(label, { x: 36, y: 754, size: 10, font, color: rgb(0.3, 0.3, 0.3) });
          page.drawImage(image, { x: (612 - size.width) / 2, y: 36 + (684 - size.height) / 2, ...size });
        }
      } else {
        // Keep arbitrary uploaded files in the one export without dropping them.
        await output.attach(bytes, `${index + 1}-${attachment.fileName}`, { mimeType: attachment.mimeType || 'application/octet-stream' });
        const doc = new PDFKit({ size: 'LETTER', margin: 42 });
        doc.fontSize(18).text('Additional attachment');
        doc.moveDown().fontSize(12).text(printable(attachment.fileName));
        doc.moveDown().text('The original file is embedded in this PDF. Open the PDF in a viewer that supports file attachments to save or open it.');
        if (attachment.mimeType?.startsWith('text/') || /\.(txt|csv|json|log)$/i.test(attachment.fileName)) {
          doc.moveDown().fontSize(10).text(bytes.toString('utf8').replace(/[^\x09\x0a\x0d\x20-\x7e]/g, '?'));
        }
        const source = await PDFDocument.load(await pdfToBuffer(doc));
        for (const page of await output.copyPages(source, source.getPageIndices())) output.addPage(page);
      }
    } catch (error) {
      console.warn('[pdf-export] Could not append attachment', attachment.key, error);
      throw new AppError(422, `Could not include attachment "${attachment.fileName}". Check that the file is available and is not damaged or password-protected, or export without attachments.`);
    }
  }
  return Buffer.from(await output.save());
}
