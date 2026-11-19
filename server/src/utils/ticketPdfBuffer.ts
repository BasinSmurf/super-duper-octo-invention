/**
 * Get a ticket's PDF as a Buffer — from storage if available, or generate on the fly.
 * Used by Enverus receipt submissions to attach the PDF.
 */

import { PrismaClient } from '../db.js';
import { generateTicketPdf } from '../services/ticketPdfGenerator.js';
import { pdfToBuffer } from './pdfToBuffer.js';
import { getFileStore, ticketKey } from '../services/fileStore.js';

/**
 * Returns { buffer, fileName } for a ticket's PDF.
 * 1. Checks file storage for an existing PDF
 * 2. If not found, generates one on the fly (does NOT store it)
 */
export async function getTicketPdfBuffer(
  ticketId: string,
  prisma: PrismaClient,
): Promise<{ buffer: Buffer; fileName: string }> {
  const store = getFileStore();

  // Check if we have a stored PDF via TicketAttachment
  const attachment = await prisma.ticketAttachment.findFirst({
    where: { ticketId, fileType: 'document', mimeType: 'application/pdf' },
    orderBy: { uploadedAt: 'desc' },
  });

  if (attachment?.filePath) {
    try {
      if (await store.exists(attachment.filePath)) {
        const buffer = await store.read(attachment.filePath);
        return { buffer, fileName: attachment.fileName };
      }
    } catch {
      // Fall through to generation
    }
  }

  // Generate on the fly
  const ticket = await prisma.serviceTicket.findUnique({
    where: { id: ticketId },
    include: {
      company: true,
      field: true,
      pad: true,
      well: true,
      assignedTech: { select: { id: true, name: true, email: true } },
      lineItems: {
        include: { product: { select: { id: true, partNumber: true, name: true } } },
        orderBy: { sortOrder: 'asc' },
      },
      fitTestRecords: true,
    },
  });

  if (!ticket) throw new Error(`Ticket ${ticketId} not found`);

  const pdfDoc = await generateTicketPdf(ticket as any);
  const buffer = await pdfToBuffer(pdfDoc);
  const fileName = `ticket-${ticket.ticketNumber || ticket.id}.pdf`;

  return { buffer, fileName };
}

/**
 * Same as getTicketPdfBuffer but for invoices.
 */
export async function getInvoicePdfBuffer(
  invoiceId: string,
  prisma: PrismaClient,
): Promise<{ buffer: Buffer; fileName: string }> {
  const { generateInvoicePdf } = await import('../services/invoicePdfGenerator.js');
  const store = getFileStore();

  // Check stored PDF
  const attachment = await prisma.invoiceAttachment.findFirst({
    where: { invoiceId, fileType: 'document', mimeType: 'application/pdf' },
    orderBy: { uploadedAt: 'desc' },
  });

  if (attachment?.filePath) {
    try {
      if (await store.exists(attachment.filePath)) {
        const buffer = await store.read(attachment.filePath);
        return { buffer, fileName: attachment.fileName };
      }
    } catch {
      // Fall through
    }
  }

  // Generate on the fly
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: {
      company: { select: { id: true, name: true } },
      approvedBy: { select: { id: true, name: true } },
      createdBy: { select: { id: true, name: true } },
      lineItems: {
        orderBy: { sortOrder: 'asc' },
        include: { product: { select: { id: true, partNumber: true, name: true } } },
      },
    },
  });

  if (!invoice) throw new Error(`Invoice ${invoiceId} not found`);

  const pdfDoc = await generateInvoicePdf(invoice as any);
  const buffer = await pdfToBuffer(pdfDoc);
  const fileName = `invoice-${invoice.invoiceNumber}.pdf`;

  return { buffer, fileName };
}
