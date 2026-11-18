import { PDFDocument } from 'pdf-lib';
import type { PrismaClient } from '../db.js';
import { AppError } from '../middleware/errorHandler.js';
import { pdfToBuffer } from '../utils/pdfToBuffer.js';
import { generateTicketPdf } from './ticketPdfGenerator.js';
import { loadPdfBranding } from './pdfBranding.js';

// Keep single-ticket and combined exports on the same document data.
export const ticketPdfInclude = {
  company: true, field: true, pad: true, well: true,
  assignedTech: { select: { id: true, name: true, email: true } },
  lineItems: {
    include: { product: { select: { id: true, partNumber: true, name: true } } },
    orderBy: { sortOrder: 'asc' },
  },
  fitTestRecords: true,
} as const;

export async function combinedTicketPdf(prisma: PrismaClient, input: unknown): Promise<Buffer> {
  if (!Array.isArray(input) || input.length === 0 || input.some(id => typeof id !== 'string' || !id.trim())) {
    throw new AppError(400, 'Select at least one ticket; ticketIds must contain non-empty strings');
  }
  const output = await PDFDocument.create();
  const branding = await loadPdfBranding();
  output.setAuthor(branding.companyName);
  for (const id of new Set<string>(input)) {
    const ticket = await prisma.serviceTicket.findUnique({ where: { id }, include: ticketPdfInclude });
    if (!ticket) throw new AppError(404, `Ticket ${id} not found; combined PDF was not created`);
    const source = await PDFDocument.load(await pdfToBuffer(await generateTicketPdf(ticket as any, branding)));
    for (const page of await output.copyPages(source, source.getPageIndices())) output.addPage(page);
  }
  return Buffer.from(await output.save());
}
