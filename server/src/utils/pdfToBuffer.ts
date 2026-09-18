import PDFDocument from 'pdfkit';

/**
 * Collect a PDFKit document stream into a Buffer.
 * Calls doc.end() internally — caller should NOT call .end() beforehand.
 */
export function pdfToBuffer(doc: InstanceType<typeof PDFDocument>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}
