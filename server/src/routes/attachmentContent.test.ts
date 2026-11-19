import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  db: { attachment: { findUnique: vi.fn() }, ticketAttachment: { findUnique: vi.fn() } },
  readCustody: vi.fn(), read: vi.fn(), exists: vi.fn(),
}));
vi.mock('../db.js', () => ({ prisma: mocks.db }));
vi.mock('../services/jobAttachments.js', () => ({ jobAttachmentUnits: vi.fn(), createJobAttachments: vi.fn(), deleteStoredAttachment: vi.fn() }));
vi.mock('../services/attachmentStore.js', () => ({
  attachmentKey: vi.fn(), ingestAttachmentBytes: vi.fn(), readAttachmentBytes: mocks.readCustody, ChecksumMismatchError: class extends Error {},
}));
vi.mock('../services/fileStore.js', () => ({ getFileStore: () => ({ read: mocks.read, exists: mocks.exists }) }));
vi.mock('../services/blueLionEnqueue.js', () => ({ enqueueAttachment: vi.fn() }));
vi.mock('../utils/auditLog.js', () => ({ createAuditLog: vi.fn() }));
import { attachmentsRouter } from './attachments.js';
const handler = attachmentsRouter.stack.find(layer => layer.route?.path === '/:id/content')!.route.stack[0].handle;
async function download() {
  const res = { setHeader: vi.fn(), send: vi.fn() }, next = vi.fn();
  await handler({ params: { id: 'document' } }, res, next);
  return { res, next };
}
beforeEach(() => { vi.resetAllMocks(); mocks.exists.mockResolvedValue(true); });
it.each(['buffered', 'remote'])('reads unified %s attachments through the custody resolver', async storageState => {
  const row = { fileName: 'report.pdf', mimeType: 'application/pdf', storageState, bufferKey: 'buffer', remoteKey: 'b2' };
  mocks.db.attachment.findUnique.mockResolvedValue(row);
  mocks.readCustody.mockResolvedValue(Buffer.from('custody bytes'));
  const { res, next } = await download();
  expect(next).not.toHaveBeenCalled();
  expect(mocks.readCustody).toHaveBeenCalledWith(row);
  expect(res.send).toHaveBeenCalledWith(Buffer.from('custody bytes'));
  expect(mocks.db.ticketAttachment.findUnique).not.toHaveBeenCalled();
});
it('resolves legacy ticket storage keys through the configured B2-compatible store', async () => {
  mocks.db.attachment.findUnique.mockResolvedValue(null);
  mocks.db.ticketAttachment.findUnique.mockResolvedValue({ filePath: 'tickets/t1/report.pdf', fileName: 'report.pdf', mimeType: 'application/pdf' });
  mocks.read.mockResolvedValue(Buffer.from('B2 bytes'));
  const { res, next } = await download();
  expect(next).not.toHaveBeenCalled();
  expect(mocks.read).toHaveBeenCalledWith('tickets/t1/report.pdf');
  expect(res.send).toHaveBeenCalledWith(Buffer.from('B2 bytes'));
});
it('returns a missing-file error without serving a partial document', async () => {
  mocks.db.ticketAttachment.findUnique.mockResolvedValue({ filePath: 'tickets/t1/missing.pdf', fileName: 'missing.pdf' });
  mocks.exists.mockResolvedValue(false);
  const { res, next } = await download();
  expect(next.mock.calls[0][0].statusCode).toBe(404);
  expect(res.send).not.toHaveBeenCalled();
});
it('rejects a legacy traversal key before consulting storage', async () => {
  mocks.db.ticketAttachment.findUnique.mockResolvedValue({ filePath: '../secret', fileName: 'secret' });
  const { next } = await download();
  expect(next.mock.calls[0][0].statusCode).toBe(404);
  expect(mocks.exists).not.toHaveBeenCalled();
});
it('encodes non-ASCII filenames without introducing invalid response headers', async () => {
  mocks.db.attachment.findUnique.mockResolvedValue({ fileName: '測試 "report".pdf', mimeType: 'application/pdf' });
  mocks.readCustody.mockResolvedValue(Buffer.from('bytes'));
  const { res } = await download();
  const disposition = res.setHeader.mock.calls.find(([name]) => name === 'Content-Disposition')[1];
  expect(disposition).toMatch(/^[\x20-\x7e]+$/);
  expect(disposition).toContain("filename*=UTF-8''%E6%B8%AC%E8%A9%A6");
});
