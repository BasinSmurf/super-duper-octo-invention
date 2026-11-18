import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import PDFKit from 'pdfkit';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
const mocks = vi.hoisted(() => ({ get: vi.fn(), read: vi.fn() }));
vi.mock('./branding.js', () => ({ getBranding: mocks.get }));
vi.mock('./fileStore.js', () => ({ getFileStore: () => ({ read: mocks.read }) }));
import { drawCompanyHeader, loadPdfBranding } from './pdfBranding.js';
import { generateInvoicePdf } from './invoicePdfGenerator.js';
import { generateEquipmentInspectionPdf } from './equipmentInspectionPdfGenerator.js';
import { pdfToBuffer } from '../utils/pdfToBuffer.js';
import { invoiceFixture, pdfBrandingCases } from './__tests__/fixtures/pdfBranding.js';

beforeEach(() => { vi.resetAllMocks(); mocks.get.mockResolvedValue({ companyName: 'Example Safety Services', logoKey: null }); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it('reads fresh saved branding for every newly generated report', async () => {
  mocks.get.mockResolvedValueOnce({ companyName: 'First Company', logoKey: null }).mockResolvedValueOnce({ companyName: 'Updated Company', logoKey: null });
  const first = await PDFDocument.load(await pdfToBuffer(await generateInvoicePdf(invoiceFixture)));
  const second = await PDFDocument.load(await pdfToBuffer(await generateInvoicePdf(invoiceFixture)));
  expect(first.getAuthor()).toBe('First Company'); expect(second.getAuthor()).toBe('Updated Company');
  expect(mocks.get).toHaveBeenCalledTimes(2);
});
it('resolves the custom logo from the configured Backblaze-compatible store', async () => {
  mocks.get.mockResolvedValue({ companyName: 'Example Safety Services', logoKey: 'branding/company.png' });
  mocks.read.mockResolvedValue(await sharp({ create: { width: 40, height: 20, channels: 3, background: '#126b9a' } }).png().toBuffer());
  const branding = await loadPdfBranding();
  expect(mocks.read).toHaveBeenCalledWith('branding/company.png');
  expect(await sharp(branding.logo!).metadata()).toMatchObject({ format: 'png', width: 40, height: 20 });
});
it.each(['unavailable', 'corrupt'])('retains the configured company name when its logo is %s', async mode => {
  mocks.get.mockResolvedValue({ companyName: 'Example Safety Services', logoKey: 'branding/company.png' });
  if (mode === 'unavailable') mocks.read.mockRejectedValueOnce(new Error('B2 unavailable'));
  else mocks.read.mockResolvedValueOnce(Buffer.from('not an image'));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(await loadPdfBranding()).toEqual({ companyName: 'Example Safety Services', logo: null });
});
it.each(pdfBrandingCases)('brands $name without changing its core document layout', async ({ name, render }) => {
  const logo = await sharp({ create: { width: 160, height: 50, channels: 3, background: '#126b9a' } }).png().toBuffer();
  const text = vi.spyOn(PDFKit.prototype, 'text');
  const images = vi.spyOn(PDFKit.prototype, 'image');
  const bytes = await pdfToBuffer(await render({ companyName: 'Example Safety Services', logo }));
  const parsed = await PDFDocument.load(bytes);
  expect(parsed.getAuthor()).toBe('Example Safety Services');
  expect(parsed.getPageCount()).toBe(1);
  expect(parsed.getPages()[0].getWidth()).toBe(name === 'equipment-badge' ? 288 : 612);
  expect(images.mock.calls.some(([input]) => input === logo)).toBe(true);
  const printed = text.mock.calls.map(([value]) => value).join('\n');
  expect(printed).toContain('Example Safety Services');
  expect(printed).not.toContain('BASIN SAFETY');
  if (name === 'invoice') expect(printed).toContain('$177.50');
  if (name === 'rental') expect(printed).toContain('Example Safety Services is not liable');
});
it('does not hold up a report indefinitely when the remote logo store stalls', async () => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  mocks.get.mockResolvedValue({ companyName: 'Example Safety Services', logoKey: 'branding/company.png' });
  mocks.read.mockImplementation(() => new Promise(() => {}));
  const pending = loadPdfBranding();
  await vi.advanceTimersByTimeAsync(3_000);
  expect(await pending).toEqual({ companyName: 'Example Safety Services', logo: null });
});
it('keeps long names inside the header rather than overlapping the report number', async () => {
  const doc = new PDFKit();
  const text = vi.spyOn(doc, 'text');
  drawCompanyHeader(doc, { companyName: 'W'.repeat(100), logo: null }, 50, 36, 242, '#111111');
  const label = text.mock.calls[0][0] as string;
  expect(label).toMatch(/\.\.\.$/);
  expect(doc.widthOfString(label)).toBeLessThanOrEqual(242);
  await pdfToBuffer(doc);
});
it('prints the selected brand and page count on every page of a long invoice', async () => {
  const text = vi.spyOn(PDFKit.prototype, 'text');
  const invoice = { ...invoiceFixture, lineItems: Array.from({ length: 60 }, (_, i) => ({ ...invoiceFixture.lineItems![0], lineNumber: i + 1, sortOrder: i })) };
  const parsed = await PDFDocument.load(await pdfToBuffer(await generateInvoicePdf(invoice, { companyName: 'Example Safety Services', logo: null })));
  const footers = text.mock.calls.filter(([value]) => typeof value === 'string' && value.startsWith('Generated '));
  expect(parsed.getPageCount()).toBeGreaterThan(1);
  expect(footers).toHaveLength(parsed.getPageCount());
  for (const [value] of footers) expect(value).toContain('Example Safety Services');
  const labels = text.mock.calls.map(([value]) => value);
  expect(labels).toContain(`Page ${parsed.getPageCount()} of ${parsed.getPageCount()}`);
});
it('does not create a blank page when a condemnation footer meets its bottom margin', async () => {
  const doc = await generateEquipmentInspectionPdf({ serialNumber: 'EQP-12345', category: 'gas_detection', outcome: 'condemn', inspectedOn: '2026-11-16' }, { companyName: 'Example Safety Services', logo: null });
  expect((await PDFDocument.load(await pdfToBuffer(doc))).getPageCount()).toBe(1);
});
it('places condemnation footers below the body margin and restores that margin on every page', async () => {
  const text = vi.spyOn(PDFKit.prototype, 'text');
  const doc = await generateEquipmentInspectionPdf({ serialNumber: 'EQP-12345', category: 'gas_detection', outcome: 'condemn', inspectedOn: '2026-11-16',
    notes: 'Inspection evidence: damaged housing, broken mounts, and exposed wiring. '.repeat(80),
  }, { companyName: 'Example Safety Services', logo: null });
  const range = doc.bufferedPageRange();
  expect(range.count).toBeGreaterThan(1);
  for (let i = 0; i < range.count; i++) { doc.switchToPage(i); expect(doc.page.margins.bottom).toBe(50); }
  const footers = text.mock.calls.filter(([value]) => typeof value === 'string' && value.startsWith('Generated '));
  expect(footers).toHaveLength(range.count);
  for (const [, , y] of footers) expect(y).toBe(752);
  expect((await PDFDocument.load(await pdfToBuffer(doc))).getPageCount()).toBe(range.count);
});
