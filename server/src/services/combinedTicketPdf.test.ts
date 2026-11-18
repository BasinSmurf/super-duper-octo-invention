import { beforeEach, describe, expect, it, vi } from 'vitest';
import PDFKit from 'pdfkit';
import { PDFDocument } from 'pdf-lib';
import type { PrismaClient } from '../db.js';
vi.mock('./pdfBranding.js', () => ({ loadPdfBranding: vi.fn(async () => ({ companyName: 'Test Services', logo: null })) }));

vi.mock('./ticketPdfGenerator.js', () => ({
  generateTicketPdf: (ticket: { width: number; pages: number }) => {
    const doc = new PDFKit({ size: [ticket.width, 792] });
    for (let i = 1; i < ticket.pages; i++) doc.addPage();
    return doc;
  },
}));

import { combinedTicketPdf } from './combinedTicketPdf.js';
import { loadPdfBranding } from './pdfBranding.js';
const findUnique = vi.fn();
const prisma = { serviceTicket: { findUnique } } as unknown as PrismaClient;

beforeEach(() => { vi.resetAllMocks(); });

describe('combined ticket PDF', () => {
  it('keeps every page in selected ticket order and deduplicates ticket IDs', async () => {
    findUnique.mockImplementation(async ({ where }) => ({ width: where.id === 'two' ? 620 : 610, pages: where.id === 'two' ? 2 : 1 }));
    const merged = await PDFDocument.load(await combinedTicketPdf(prisma, ['two', 'one', 'two']));
    expect(merged.getPages().map(page => page.getWidth())).toEqual([620, 620, 610]);
    expect(merged.getAuthor()).toBe('Test Services');
    expect(findUnique.mock.calls.map(([args]) => args.where.id)).toEqual(['two', 'one']);
    expect(loadPdfBranding).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, null, [], 'one', [''], ['one', 5], ['  ']])('rejects invalid selection %j', async input => {
    await expect(combinedTicketPdf(prisma, input)).rejects.toMatchObject({ statusCode: 400 });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('fails the entire combined export when any selected ticket is missing', async () => {
    findUnique.mockResolvedValueOnce({ width: 610, pages: 1 }).mockResolvedValueOnce(null);
    await expect(combinedTicketPdf(prisma, ['one', 'missing'])).rejects.toMatchObject({ statusCode: 404 });
  });
});
