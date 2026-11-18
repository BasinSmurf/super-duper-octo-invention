import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  db: { attachment: { findMany: vi.fn() }, ticketAttachment: { findMany: vi.fn() }, equipmentDocument: { findMany: vi.fn() }, shopWorkOrderItem: { findMany: vi.fn() }, serviceTicket: { findUnique: vi.fn() } },
  read: vi.fn(), readAttachment: vi.fn(),
}));
vi.mock('../db.js', () => ({ prisma: mocks.db }));
vi.mock('./fileStore.js', () => ({ getFileStore: () => ({ read: mocks.read }) }));
vi.mock('./attachmentStore.js', () => ({ readAttachmentBytes: mocks.readAttachment }));
import { pdfExportAttachments } from './pdfExportAttachments.js';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.db.attachment.findMany.mockResolvedValue([]);
  mocks.db.ticketAttachment.findMany.mockResolvedValue([]);
  mocks.db.equipmentDocument.findMany.mockResolvedValue([]);
  mocks.db.shopWorkOrderItem.findMany.mockResolvedValue([]);
  mocks.db.serviceTicket.findUnique.mockResolvedValue(null);
});

describe('PDF attachment inventory', () => {
  it('collects ticket uploads, inspection/testing documents and return photos without reading files for the prompt', async () => {
    mocks.db.ticketAttachment.findMany.mockResolvedValue([{ filePath: 'ticket/photo.jpg', fileName: 'photo.jpg', mimeType: 'image/jpeg' }]);
    mocks.db.equipmentDocument.findMany.mockResolvedValue([{ storageKey: 'inspection/ue.pdf', fileName: 'ue.pdf', mimeType: 'application/pdf' }]);
    mocks.db.serviceTicket.findUnique.mockResolvedValue({ customData: { inspection: { data: { damagePhotos: [{ dataUrl: 'data:image/png;base64,AQID' }] } } } });
    const files = await pdfExportAttachments({ ticketId: 'ticket' });
    expect(files.map(file => file.fileName)).toEqual(['photo.jpg', 'ue.pdf', 'Return inspection photo 1']);
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.db.equipmentDocument.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { inspection: { ticketId: 'ticket' } } }));
    expect(await files[2].read()).toEqual(Buffer.from([1, 2, 3]));
  });

  it('includes all job units, their inspections and vendor scans, deduplicating shared B2 files', async () => {
    const shared = { id: 'a', fileName: 'UE.pdf', mimeType: 'application/pdf', remoteKey: 'shared-ue', bufferKey: null, storageState: 'remote' };
    mocks.db.attachment.findMany.mockResolvedValue([shared, { ...shared, id: 'b' }, { ...shared, id: 'c', remoteKey: null, bufferKey: 'buffered-posi', storageState: 'buffered' }]);
    mocks.db.shopWorkOrderItem.findMany.mockResolvedValue([{ billing: { vendor: { attachmentKey: 'invoice', attachmentName: 'invoice.pdf' } } }]);
    const files = await pdfExportAttachments({ workOrderId: 'wo' });
    expect(files.map(file => file.key)).toEqual(['shared-ue', 'buffered-posi', 'invoice']);
    await files[1].read();
    expect(mocks.readAttachment).toHaveBeenCalledWith(expect.objectContaining({ bufferKey: 'buffered-posi' }));
    expect(mocks.db.attachment.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { OR: [{ shopItem: { workOrderId: 'wo' } }, { inspection: { shopItem: { workOrderId: 'wo' } } }] } }));
    expect(mocks.db.ticketAttachment.findMany).not.toHaveBeenCalled();
  });
});
