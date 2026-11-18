import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  db: { signatureRequest: { findFirst: vi.fn(), create: vi.fn() }, invoice: { update: vi.fn() } },
  send: vi.fn(),
}));
vi.mock('../db.js', () => ({ prisma: mocks.db }));
vi.mock('./mailer.js', () => ({ sendMail: mocks.send, FROM_ADDRESS: 'sender@example.test', BILLING_CC: 'billing@example.test', mailerConfigured: true }));
vi.mock('./invoicePdfGenerator.js', () => ({ generateInvoicePdf: vi.fn() }));
vi.mock('./ticketPdfGenerator.js', () => ({ generateTicketPdf: vi.fn() }));
vi.mock('../utils/pdfToBuffer.js', () => ({ pdfToBuffer: vi.fn(async () => Buffer.from('pdf')) }));
vi.mock('./branding.js', () => ({ getBranding: vi.fn(async () => ({ companyName: 'Acme & Sons', logoUrl: '/api/branding/logo?v=123' })) }));
import { sendForSigning } from './sendForSigning.js';
import { generateInvoicePdf } from './invoicePdfGenerator.js';
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv('APP_BASE_URL', 'https://service.example.test'); mocks.db.signatureRequest.findFirst.mockResolvedValue(null); });
afterEach(() => vi.unstubAllEnvs());
it('uses saved company branding and a public storage-backed logo in the signature email', async () => {
  await sendForSigning({ type: 'invoice', referenceId: 'invoice', data: { invoiceNumber: 'INV1', companyName: 'Customer', total: 10 }, contactEmail: 'customer@example.test', sentByUserId: 'admin' });
  const mail = mocks.send.mock.calls[0][0];
  expect(mail.subject).toBe('Signature Requested — Acme & Sons Invoice INV1');
  expect(mail.html).toContain('Acme &amp; Sons');
  expect(mail.html).toContain('src="https://service.example.test/api/branding/logo?v=123"');
  expect(mail.html).not.toContain('/logo.png');
  expect(mail.attachments[0].content).toEqual(Buffer.from('pdf'));
  expect(generateInvoicePdf).toHaveBeenCalledWith(expect.anything(), { companyName: 'Acme & Sons', logo: null });
  expect(mocks.db.invoice.update).toHaveBeenCalledWith({ where: { id: 'invoice' }, data: { signatureStatus: 'PENDING', status: 'awaiting_signature' } });
});
