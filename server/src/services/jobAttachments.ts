import { randomUUID } from 'node:crypto';
import { prisma, type Prisma, type AttachmentKind } from '../db.js';
import { AppError } from '../middleware/errorHandler.js';
import { enqueueAttachment } from './blueLionEnqueue.js';
import { removeAttachmentBytes } from './attachmentStore.js';

type Unit = { id: string; serialNumber: string; serializedEquipmentId: string | null; equipmentCategory: string };

export function selectJobAttachmentUnits(units: Unit[], kind: AttachmentKind, selectedIds: unknown): Unit[] {
  if (kind === 'ue_report') {
    const cylinders = units.filter(unit => unit.equipmentCategory === 'ue_cylinder');
    if (!cylinders.length) throw new AppError(400, 'This job has no UE cylinders');
    return cylinders;
  }
  if (!Array.isArray(selectedIds) || !selectedIds.length || selectedIds.some(id => typeof id !== 'string')) {
    throw new AppError(400, 'Select at least one unit for this document');
  }
  const ids = new Set(selectedIds);
  const selected = units.filter(unit => ids.has(unit.id));
  if (selected.length !== ids.size) throw new AppError(400, 'Selected units must belong to this job');
  return selected;
}

export async function jobAttachmentUnits(workOrderId: unknown, kind: AttachmentKind, selectedIds: unknown) {
  if (typeof workOrderId !== 'string' || !workOrderId) throw new AppError(400, 'A work order is required');
  const units = await prisma.shopWorkOrderItem.findMany({
    where: { workOrderId },
    select: { id: true, serialNumber: true, serializedEquipmentId: true, equipmentCategory: true },
  });
  return selectJobAttachmentUnits(units, kind, selectedIds);
}

/** One set of stored bytes, separate serial evidence records for each unit. */
export async function createJobAttachments(data: Prisma.AttachmentUncheckedCreateInput, units: Unit[]) {
  const rows = await prisma.$transaction(units.map((unit, index) => prisma.attachment.create({
    data: {
      ...data,
      id: index === 0 ? data.id : randomUUID(),
      shopItemId: unit.id,
      inspectionId: null,
      ticketId: null,
      serialNumber: unit.serialNumber,
      serializedEquipmentId: unit.serializedEquipmentId,
      offlineBlobId: data.id,
    },
  })));
  for (const row of rows) void enqueueAttachment(row.id).catch(error =>
    console.warn('[attachments] VaultPRO enqueue failed (non-fatal):', error));
  return rows[0];
}

/** Removing one unit's link must preserve the file used by the other units. */
export async function removeUnreferencedAttachmentBytes(attachment: { bufferKey: string | null; remoteKey: string | null }) {
  const keys = [attachment.bufferKey, attachment.remoteKey].filter((key): key is string => !!key);
  if (!keys.length) return;
  const references = await prisma.attachment.count({
    where: { OR: [{ bufferKey: { in: keys } }, { remoteKey: { in: keys } }] },
  });
  if (!references) await removeAttachmentBytes(attachment);
}

export async function deleteStoredAttachment(id: string, wholeJob = false) {
  const attachment = await prisma.attachment.findUnique({
    where: { id },
    include: { shopItem: { select: { workOrderId: true } } },
  });
  if (!attachment) return null;
  if (wholeJob && attachment.offlineBlobId && attachment.shopItem) {
    await prisma.attachment.deleteMany({
      where: { offlineBlobId: attachment.offlineBlobId, shopItem: { workOrderId: attachment.shopItem.workOrderId } },
    });
  } else {
    await prisma.attachment.delete({ where: { id } });
  }
  await removeUnreferencedAttachmentBytes(attachment);
  return attachment;
}
