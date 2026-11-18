import { prisma, type Prisma } from '../db.js';
import { getFileStore } from './fileStore.js';
import { readAttachmentBytes } from './attachmentStore.js';

export interface PdfExportAttachment {
  key: string;
  fileName: string;
  mimeType: string | null;
  read: () => Promise<Buffer>;
}
export type PdfExportScope = { ticketId: string } | { workOrderId: string };

function storedFile(key: string, fileName: string, mimeType: string | null): PdfExportAttachment {
  return { key, fileName, mimeType, read: () => getFileStore().read(key) };
}

/** Scope evidence to this job/inspection, rather than the equipment's entire history. */
export async function pdfExportAttachments(scope: PdfExportScope): Promise<PdfExportAttachment[]> {
  const ticket = 'ticketId' in scope;
  const inspectionWhere: Prisma.EquipmentInspectionWhereInput = ticket
    ? { ticketId: scope.ticketId }
    : { shopItem: { workOrderId: scope.workOrderId } };
  const where: Prisma.AttachmentWhereInput = {
    OR: [ticket ? { ticketId: scope.ticketId } : { shopItem: { workOrderId: scope.workOrderId } }, { inspection: inspectionWhere }],
  };
  const [unified, legacy, documents, items, ticketRecord] = await Promise.all([
    prisma.attachment.findMany({ where, orderBy: [{ capturedAt: 'asc' }, { id: 'asc' }] }),
    ticket ? prisma.ticketAttachment.findMany({ where: { ticketId: scope.ticketId }, orderBy: [{ uploadedAt: 'asc' }, { id: 'asc' }] }) : [],
    prisma.equipmentDocument.findMany({ where: { inspection: inspectionWhere }, orderBy: [{ uploadedAt: 'asc' }, { id: 'asc' }] }),
    ticket ? [] : prisma.shopWorkOrderItem.findMany({ where: { workOrderId: scope.workOrderId }, select: { billing: true, customData: true }, orderBy: { itemNumber: 'asc' } }),
    ticket ? prisma.serviceTicket.findUnique({ where: { id: scope.ticketId }, select: { customData: true } }) : null,
  ]);
  const files: PdfExportAttachment[] = unified.map(file => ({
    key: file.remoteKey || file.bufferKey || `attachment:${file.id}`,
    fileName: file.fileName,
    mimeType: file.mimeType,
    read: () => readAttachmentBytes(file),
  }));
  for (const file of legacy) files.push(storedFile(file.filePath, file.fileName, file.mimeType));
  for (const file of documents) files.push(storedFile(file.storageKey, file.fileName, file.mimeType));
  for (const item of items) {
    const billing = item.billing as { vendor?: { attachmentKey?: string; attachmentName?: string } } | null;
    const custom = item.customData as { vendorBilling?: { attachmentKey?: string; attachmentName?: string } } | null;
    const vendor = billing?.vendor || custom?.vendorBilling;
    if (vendor?.attachmentKey) files.push(storedFile(vendor.attachmentKey, vendor.attachmentName || 'Vendor paperwork', null));
  }
  const custom = ticketRecord?.customData as { inspection?: { data?: { damagePhotos?: { id?: string; dataUrl?: string }[] } } } | null;
  for (const [index, photo] of (custom?.inspection?.data?.damagePhotos || []).entries()) {
    if (!photo.dataUrl) continue;
    const match = /^data:([^;]+);base64,(.+)$/s.exec(photo.dataUrl);
    if (!match) continue;
    files.push({ key: `damage-photo:${photo.id || index}`, fileName: `Return inspection photo ${index + 1}`, mimeType: match[1], read: async () => Buffer.from(match[2], 'base64') });
  }
  return [...new Map(files.map(file => [file.key, file])).values()];
}
