/**
 * attachments.ts — the device end of the two-hop attachment pipeline.
 *
 * Every capture path (unit photo, UE report PDF, Pozi report, vendor invoice)
 * goes through `captureAttachment`. One function, so the custody rule is
 * implemented once:
 *
 *   1. Write the bytes to Dexie FIRST, with the checksum, before anything is
 *      queued. If the app is killed one line later, the file still exists.
 *   2. Queue the upload mutation. The sync engine drains it whenever there is
 *      a connection.
 *   3. The local copy is cleared ONLY by `markAttachmentSynced`, called when
 *      the SP SERVER has acknowledged the bytes — not when B2 has them. That
 *      distinction is the whole design: see services/attachmentStore.ts.
 *
 * Offline is the normal case here, not the exception. A tech in a shop with no
 * signal photographs a condemned cylinder and walks away; the photo has to
 * survive that, and it cannot be re-taken later.
 */

import { db } from './db'
import type { OfflineAttachment } from './db-types'

export type AttachmentKind =
  | 'photo'
  | 'ue_report'
  | 'pozi_report'
  | 'vendor_invoice'
  | 'packing_slip'
  | 'test_paperwork'
  | 'signature'
  | 'document'
  | 'other'

export interface AttachmentParent {
  shopItemId?: string | null
  inspectionId?: string | null
  ticketId?: string | null
}

/** SHA-256 of a data URL's payload, hex, via WebCrypto. */
export async function sha256OfDataUrl(dataUrl: string): Promise<string> {
  const base64 = dataUrl.split(',')[1] ?? ''
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}

export function fileToDataUrl(file: File | Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

function oneParent(parent: AttachmentParent): AttachmentParent {
  const set = [parent.shopItemId, parent.inspectionId, parent.ticketId].filter(Boolean)
  if (set.length !== 1) {
    throw new Error('An attachment needs exactly one parent (shop item, inspection or ticket)')
  }
  return {
    shopItemId: parent.shopItemId ?? null,
    inspectionId: parent.inspectionId ?? null,
    ticketId: parent.ticketId ?? null,
  }
}

export interface CaptureOptions {
  workOrderId?: string
  linkedShopItemIds?: string[]
  id: string
  parent: AttachmentParent
  kind: AttachmentKind
  file: File | Blob
  fileName: string
  /** The unit's serial, snapshotted so the evidence keeps its meaning. */
  serialNumber?: string | null
}

/**
 * Take custody of a file on the device and queue it for upload.
 *
 * Returns once the bytes are durably in Dexie — the caller can show the photo
 * immediately and the tech can walk away. Nothing here waits on a network.
 */
export async function captureAttachment(opts: CaptureOptions): Promise<OfflineAttachment> {
  const parent = oneParent(opts.parent)
  const dataUrl = await fileToDataUrl(opts.file)
  const sha256 = await sha256OfDataUrl(dataUrl)
  const capturedAt = new Date().toISOString()

  const record: OfflineAttachment = {
    id: opts.id,
    workOrderId: opts.workOrderId,
    linkedShopItemIds: opts.linkedShopItemIds,
    ...parent,
    serialNumber: opts.kind === 'vendor_invoice' || opts.kind === 'packing_slip'
      ? null : opts.serialNumber ?? null,
    kind: opts.kind,
    fileName: opts.fileName,
    mimeType: (opts.file as File).type || null,
    fileSizeBytes: opts.file.size,
    sha256,
    dataUrl,
    offlineBlobId: opts.id,
    capturedAt,
    storageState: 'local',
    _offlineStatus: 'pending',
  }

  // Bytes first, queue second. Reversing these opens a window where the sync
  // engine could read a queue entry whose file does not exist yet.
  await db.attachments.put(record)
  await db.mutationQueue.add({
    table: 'attachments',
    action: 'create',
    entityId: opts.id,
    payload: {
      id: opts.id,
      workOrderId: opts.workOrderId,
      linkedShopItemIds: opts.linkedShopItemIds,
      ...parent,
      serialNumber: record.serialNumber,
      kind: opts.kind,
      fileName: opts.fileName,
      mimeType: record.mimeType,
      offlineBlobId: opts.id,
      capturedAt,
      sha256,
      dataUrl,
    },
    createdAt: capturedAt,
    status: 'pending',
    retryCount: 0,
  })

  return record
}

/**
 * Hop 1 complete: the SP server holds the bytes, so the device's copy is
 * redundant and can go.
 *
 * Call this ONLY from the sync engine, on a successful server ack. Calling it
 * anywhere else — optimistically, on a timeout, on a guess — deletes the only
 * copy of something un-re-takeable.
 */
export async function markAttachmentSynced(id: string): Promise<void> {
  await db.attachments.update(id, {
    dataUrl: null,
    storageState: 'buffered',
    _offlineStatus: 'synced',
  })
}

export async function deleteAttachment(id: string, wholeJob = false): Promise<void> {
  const existing = await db.attachments.get(id)
  await db.mutationQueue.where('entityId').equals(id).filter(m => m.table === 'attachments' && m.action === 'create' && m.status !== 'done').delete()
  await db.attachments.delete(id).catch(() => {})
  // Queue removal after any in-flight upload, even if its acknowledgement has not arrived.
  if (existing) {
    await db.mutationQueue.add({
      table: 'attachments',
      action: 'delete',
      entityId: id,
      payload: { id, wholeJob },
      createdAt: new Date().toISOString(),
      status: 'pending',
      retryCount: 0,
    })
  }
}

export async function attachmentsFor(parent: AttachmentParent): Promise<OfflineAttachment[]> {
  const p = oneParent(parent)
  const rows = p.shopItemId
    ? await db.attachments.filter(a => a.shopItemId === p.shopItemId || !!a.linkedShopItemIds?.includes(p.shopItemId!)).toArray()
    : p.inspectionId
      ? await db.attachments.where('inspectionId').equals(p.inspectionId).toArray()
      : await db.attachments.where('ticketId').equals(p.ticketId!).toArray()
  return rows.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))
}

/**
 * How many captures still hold the only copy. §3.2 asks for this to be visible
 * to the tech — a queue nobody can see is a queue nobody notices has stalled.
 */
export async function localOnlyAttachmentCount(): Promise<number> {
  return db.attachments.where('storageState').equals('local').count()
}
