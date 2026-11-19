import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import sharp from 'sharp';
import { writeFile } from 'node:fs/promises';
import { appendPdfAttachments } from './appendPdfAttachments.js';
import type { PdfExportAttachment } from './pdfExportAttachments.js';

async function pdf(label: string, pages = 1) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < pages; index++) {
    const page = doc.addPage([612, 792]);
    page.drawText(`${label} - page ${index + 1}`, { x: 42, y: 720, size: 24, font, color: rgb(0.1, 0.25, 0.4) });
  }
  return Buffer.from(await doc.save());
}
function file(fileName: string, mimeType: string | null, bytes: Buffer): PdfExportAttachment {
  return { key: fileName, fileName, mimeType, read: async () => bytes };
}

describe('combined PDF export', () => {
  it('retains the base, all report pages, images and other original files in order', async () => {
    const portrait = await sharp({ create: { width: 400, height: 800, channels: 3, background: '#216869' } }).png().toBuffer();
    const landscape = await sharp({ create: { width: 1200, height: 400, channels: 3, background: '#e6a23c' } }).webp().toBuffer();
    const result = await appendPdfAttachments(await pdf('Ticket summary'), [
      file('UE-results.pdf', 'application/pdf', await pdf('UE report', 2)),
      file('cylinder-photo.png', 'image/png', portrait),
      file('bench-photo.webp', 'image/webp', landscape),
      file('readings.txt', 'text/plain', Buffer.from('Testing readings\nCylinder 1: PASS\nCylinder 2: PASS')),
      file('source-data.bin', 'application/octet-stream', Buffer.from([1, 2, 3, 4])),
    ]);
    const merged = await PDFDocument.load(result);
    expect(merged.getPageCount()).toBe(7);
    expect(merged.getPages().every(page => page.getWidth() === 612 && page.getHeight() === 792)).toBe(true);
    const names = merged.catalog.lookup(merged.context.obj('Names'));
    expect(names).toBeDefined();
    if (process.env.PDF_EXPORT_PREVIEW) await writeFile(process.env.PDF_EXPORT_PREVIEW, result);
  });

  it('preserves original landscape PDF page dimensions and rotation', async () => {
    const source = await PDFDocument.create();
    source.addPage([900, 500]);
    const result = await PDFDocument.load(await appendPdfAttachments(await pdf('Base'), [file('report.pdf', null, Buffer.from(await source.save()))]));
    expect(result.getPage(1).getSize()).toEqual({ width: 900, height: 500 });
  });

  it('recognizes a PDF from its bytes even without the correct name or MIME', async () => {
    const result = await PDFDocument.load(await appendPdfAttachments(await pdf('Base'), [file('report', null, await pdf('Testing', 2))]));
    expect(result.getPageCount()).toBe(3);
  });

  it('fails clearly instead of silently omitting a missing or corrupt attachment', async () => {
    const base = await pdf('Base');
    await expect(appendPdfAttachments(base, [file('damaged.pdf', 'application/pdf', Buffer.from('broken'))])).rejects.toThrow('damaged.pdf');
    await expect(appendPdfAttachments(base, [{ key: 'missing', fileName: 'missing.jpg', mimeType: 'image/jpeg', read: async () => { throw new Error('B2 unavailable'); } }])).rejects.toThrow('missing.jpg');
  });

  it('returns the base untouched when there are no attachments', async () => {
    const base = await pdf('Base');
    expect(await appendPdfAttachments(base, [])).toBe(base);
  });
});
