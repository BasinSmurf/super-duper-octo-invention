import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  db: { attachment: { create: vi.fn(), findUnique: vi.fn(), delete: vi.fn(), deleteMany: vi.fn(), count: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() }, shopWorkOrderItem: { findMany: vi.fn() }, $transaction: vi.fn() },
  enqueue: vi.fn(), remove: vi.fn(), promote: vi.fn(),
}));
vi.mock('../db.js', () => ({ prisma: mocks.db }));

vi.mock('./blueLionEnqueue.js', () => ({ enqueueAttachment: mocks.enqueue }));
vi.mock('./attachmentStore.js', () => ({ removeAttachmentBytes: mocks.remove, promoteToRemote: mocks.promote, remoteTierEnabled: () => true }));
vi.mock('./jobs.js', () => ({ runScheduledJob: vi.fn() }));
vi.mock('./supervisor.js', () => ({ heartbeat: vi.fn() }));

import { createJobAttachments, deleteStoredAttachment, selectJobAttachmentUnits } from './jobAttachments.js';
import { processAttachmentUploads } from './attachmentUploader.js';

const units = [
  { id: 'c1', serialNumber: 'CYL1', serializedEquipmentId: 'eq1', equipmentCategory: 'ue_cylinder' },
  { id: 's1', serialNumber: 'SCBA1', serializedEquipmentId: 'eq2', equipmentCategory: 'scba' },
  { id: 'c2', serialNumber: 'CYL2', serializedEquipmentId: null, equipmentCategory: 'ue_cylinder' },
];

beforeEach(() => {
  vi.resetAllMocks();
  mocks.enqueue.mockResolvedValue({});
  mocks.db.attachment.create.mockImplementation(async ({ data }) => data);
  mocks.db.$transaction.mockImplementation(promises => Promise.all(promises));
});

describe('whole-job attachments', () => {
  it('UE includes every cylinder and excludes other units, regardless of client selection', () => {
    expect(selectJobAttachmentUnits(units, 'ue_report', ['s1']).map(unit => unit.id)).toEqual(['c1', 'c2']);
    expect(() => selectJobAttachmentUnits([units[1]], 'ue_report', [])).toThrow('no UE cylinders');
  });

  it('Posi requires a nonempty selection from this job and deduplicates it', () => {
    expect(selectJobAttachmentUnits(units, 'pozi_report', ['s1', 'c2', 's1']).map(unit => unit.id)).toEqual(['s1', 'c2']);
    expect(() => selectJobAttachmentUnits(units, 'pozi_report', [])).toThrow('Select at least one');
    expect(() => selectJobAttachmentUnits(units, 'pozi_report', ['other-job'])).toThrow('belong to this job');
  });

  it('creates serial-specific links atomically, sharing the same file and enqueueing each unit', async () => {
    const original = await createJobAttachments({ id: 'capture', kind: 'ue_report', fileName: 'ue.pdf', sha256: 'sha', bufferKey: 'shared-key', storageState: 'buffered' }, [units[0], units[2]]);
    expect(original.id).toBe('capture');
    const records = mocks.db.attachment.create.mock.calls.map(([args]) => args.data);
    expect(records.map(row => row.serialNumber)).toEqual(['CYL1', 'CYL2']);
    expect(records.map(row => row.bufferKey)).toEqual(['shared-key', 'shared-key']);
    expect(records.map(row => row.offlineBlobId)).toEqual(['capture', 'capture']);
    expect(new Set(records.map(row => row.id)).size).toBe(2);
    expect(mocks.db.$transaction).toHaveBeenCalledOnce();
    expect(mocks.enqueue).toHaveBeenCalledTimes(2);
  });

  it('preserves bytes when removing one unit link and deletes bytes after the final link', async () => {
    const record = { id: 'link', bufferKey: null, remoteKey: 'shared-key', offlineBlobId: 'capture', shopItem: { workOrderId: 'wo' } };
    mocks.db.attachment.findUnique.mockResolvedValue(record);
    mocks.db.attachment.count.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    await deleteStoredAttachment('link');
    expect(mocks.remove).not.toHaveBeenCalled();
    await deleteStoredAttachment('link');
    expect(mocks.remove).toHaveBeenCalledWith(record);
  });

  it('whole-job removal is confined to this document and work order', async () => {
    mocks.db.attachment.findUnique.mockResolvedValue({ id: 'link', bufferKey: null, remoteKey: 'shared-key', offlineBlobId: 'capture', shopItem: { workOrderId: 'wo' } });
    mocks.db.attachment.count.mockResolvedValue(0);
    await deleteStoredAttachment('link', true);
    expect(mocks.db.attachment.deleteMany).toHaveBeenCalledWith({ where: { offlineBlobId: 'capture', shopItem: { workOrderId: 'wo' } } });
  });

  it('promotes shared bytes only once and updates every unit link', async () => {
    mocks.db.attachment.findMany.mockResolvedValue([
      { id: 'a', bufferKey: 'shared-key', uploadAttempts: 0, lastAttemptAt: null },
      { id: 'b', bufferKey: 'shared-key', uploadAttempts: 0, lastAttemptAt: null },
    ]);
    mocks.promote.mockResolvedValue({ remoteKey: 'shared-key', uploadedAt: new Date() });
    expect(await processAttachmentUploads()).toEqual({ promoted: 1, failed: 0 });
    expect(mocks.promote).toHaveBeenCalledOnce();
    expect(mocks.db.attachment.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { bufferKey: 'shared-key' }, data: expect.objectContaining({ storageState: 'remote', remoteKey: 'shared-key', bufferKey: null }) }));
  });

  it('a B2 failure leaves all shared links retryable with the buffer intact', async () => {
    mocks.db.attachment.findMany.mockResolvedValue([{ id: 'a', bufferKey: 'shared-key', uploadAttempts: 0, lastAttemptAt: null }]);
    mocks.promote.mockRejectedValue(new Error('B2 unavailable'));
    mocks.db.attachment.updateMany.mockResolvedValue({ count: 2 });
    expect(await processAttachmentUploads()).toEqual({ promoted: 0, failed: 1 });
    const update = mocks.db.attachment.updateMany.mock.calls[0][0];
    expect(update.where).toEqual({ bufferKey: 'shared-key' });
    expect(update.data.storageState).toBe('failed');
    expect(update.data).not.toHaveProperty('bufferKey');
  });
});
