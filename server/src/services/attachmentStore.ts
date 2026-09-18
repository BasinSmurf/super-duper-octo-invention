/**
 * attachmentStore.ts — the two-hop attachment pipeline.
 *
 *   device (offline capture)  ->  SP server  ->  object store (B2)
 *                             ^               ^
 *                       delete device   delete SP buffer
 *                       copy on SP      copy only after remote
 *                       server ACK      ACK + checksum re-read
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: no tier deletes its copy until the next
 * tier has acknowledged the bytes AND the bytes have been verified there.
 *
 * "Delete local copies once synced" is ambiguous in the worst possible way. Read
 * as "synced to B2" it means a device with a queued photo, on a job site, with
 * B2 unreachable, either blocks the tech or drops the only copy. Read as "synced
 * to the SP server" it means the server holds a durable copy the moment the
 * device is free, and a B2 outage becomes a backlog instead of data loss. This
 * module implements the second reading, and the `Attachment.storageState` column
 * records which hop each file has actually completed rather than assuming.
 *
 * A photo of a condemned cylinder is not re-takeable. That asymmetry is why the
 * buffer copy is kept on every doubt, including a checksum mismatch, including a
 * remote store that reports success but reads back wrong.
 *
 * WHEN THERE IS NO B2 (STORAGE_DRIVER unset or 'local'), there is no second hop:
 * the configured store IS the final destination, so ingest lands straight in
 * `remote` and the uploader has nothing to do. Nothing to survive, no buffer to
 * keep, and dev behaves exactly as it did before.
 */

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { getFileStore, LocalFileStore, type FileStore } from './fileStore.js';

/** True when the object store is a genuinely remote tier worth buffering for. */
export function remoteTierEnabled(): boolean {
  return (process.env.STORAGE_DRIVER || 'local').toLowerCase() === 's3';
}

/**
 * The SP server's durability buffer. Always local disk, never the object store
 * — the entire point is to hold bytes the object store does not have yet.
 *
 * Deliberately a separate directory from STORAGE_DIR: an operator clearing out
 * "the uploads folder" should not be able to delete the only copy of files that
 * have not reached B2. Different directory, different blast radius.
 */
let bufferStore: FileStore | null = null;
export function getBufferStore(): FileStore {
  if (!bufferStore) {
    bufferStore = new LocalFileStore(
      process.env.ATTACHMENT_BUFFER_DIR || join(process.cwd(), 'data', 'attachment-buffer'),
    );
  }
  return bufferStore;
}

/**
 * A transfer that arrived different from what the device sent.
 *
 * Its own class because the HTTP layer has to answer it with a 400, not a 500:
 * this is a correctable condition on a request, the device still holds the
 * original, and "Internal server error" tells whoever is holding the iPad
 * nothing about what to do next.
 */
export class ChecksumMismatchError extends Error {
  readonly expected: string;
  readonly actual: string;
  constructor(expected: string, actual: string) {
    super(
      `Attachment checksum mismatch on upload (device sent ${expected.slice(0, 12)}…, ` +
      `server computed ${actual.slice(0, 12)}…). The device copy has NOT been accepted; retry.`,
    );
    this.name = 'ChecksumMismatchError';
    this.expected = expected;
    this.actual = actual;
  }
}

export function sha256Of(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/** Storage key for an attachment, namespaced by its parent. */
export function attachmentKey(
  parent: { shopItemId?: string | null; inspectionId?: string | null; ticketId?: string | null },
  attachmentId: string,
  fileName: string,
): string {
  // The attachment id is in the path so two units can both have "photo.jpg"
  // and neither overwrites the other. File names come from a phone camera and
  // are not remotely unique.
  // Strip anything that isn't a plain name character, then collapse runs of
  // dots. The separator strip alone already makes traversal impossible, but a
  // stored name of ".._.._etc_passwd" is the kind of thing that later reads as
  // a live finding in an audit. Leave nothing to argue about.
  const safeName = fileName
    .replace(/[^\w.\-]/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.\-]+/, '')
    .slice(-120) || 'file';
  if (parent.shopItemId) return `shop-items/${parent.shopItemId}/${attachmentId}/${safeName}`;
  if (parent.inspectionId) return `inspections/${parent.inspectionId}/${attachmentId}/${safeName}`;
  if (parent.ticketId) return `tickets/${parent.ticketId}/${attachmentId}/${safeName}`;
  return `attachments/${attachmentId}/${safeName}`;
}

export interface IngestResult {
  sha256: string;
  fileSizeBytes: number;
  storageState: 'buffered' | 'remote';
  bufferKey: string | null;
  remoteKey: string | null;
  uploadedAt: Date | null;
}

/**
 * Hop 1: take custody of the bytes.
 *
 * Returns only after the SP server holds a durable copy, because the caller's
 * response is the device's cue to delete its own. If this throws, the device
 * keeps its copy and retries — which is correct, and is why nothing here is
 * best-effort.
 *
 * `expectedSha256`, when the device supplies one, is checked here: a photo
 * mangled in transit should be rejected while the device still has the original,
 * not discovered later when the original is gone.
 */
export async function ingestAttachmentBytes(
  buffer: Buffer,
  key: string,
  mimeType: string | undefined,
  expectedSha256?: string | null,
  remoteStore?: FileStore,
): Promise<IngestResult> {
  const sha256 = sha256Of(buffer);

  if (expectedSha256 && expectedSha256 !== sha256) {
    throw new ChecksumMismatchError(expectedSha256, sha256);
  }

  // No remote tier: the configured store is the destination, one hop, done.
  if (!remoteTierEnabled()) {
    await (remoteStore ?? getFileStore()).write(key, buffer, mimeType);
    return {
      sha256,
      fileSizeBytes: buffer.length,
      storageState: 'remote',
      bufferKey: null,
      remoteKey: key,
      uploadedAt: new Date(),
    };
  }

  await getBufferStore().write(key, buffer, mimeType);
  return {
    sha256,
    fileSizeBytes: buffer.length,
    storageState: 'buffered',
    bufferKey: key,
    remoteKey: null,
    uploadedAt: null,
  };
}

export interface PromotionResult {
  remoteKey: string;
  uploadedAt: Date;
}

/**
 * Hop 2: move a buffered attachment to the object store and verify it landed
 * intact, then — and only then — drop the buffer copy.
 *
 * Verification is a genuine read-back, not a HEAD. A store that accepted a
 * truncated body, or a proxy that silently re-encoded it, both report success
 * on write and both fail here. The cost is one extra GET per attachment, once,
 * ever; the thing it protects against is discovering a corrupt evidence photo
 * years later when the buffer copy is long gone.
 *
 * Throws on any doubt. The caller records the failure and leaves the buffer
 * copy exactly where it is.
 */
export async function promoteToRemote(
  attachment: {
    id: string;
    bufferKey: string | null;
    sha256: string;
    mimeType: string | null;
    fileName: string;
  },
  /**
   * The destination tier. Defaults to the configured object store; passed
   * explicitly by tests so the custody rules can be exercised against a real
   * filesystem rather than a mocked SDK. The guarantees here are about byte
   * integrity, and a mock that returns whatever it was handed cannot test that.
   */
  remoteStore?: FileStore,
): Promise<PromotionResult> {
  if (!attachment.bufferKey) {
    throw new Error(`Attachment ${attachment.id} has no buffer key to promote`);
  }

  const buffer = getBufferStore();
  const remote = remoteStore ?? getFileStore();

  const bytes = await buffer.read(attachment.bufferKey);

  // The buffer itself can rot (bad disk, partial write on an earlier crash).
  // Uploading it unchecked would launder a corrupt local file into the durable
  // store and then delete the evidence that it was corrupt.
  const bufferedSha = sha256Of(bytes);
  if (attachment.sha256 !== bufferedSha) {
    throw new Error(
      `Buffer copy of attachment ${attachment.id} no longer matches its recorded checksum ` +
      `(expected ${attachment.sha256.slice(0, 12)}…, found ${bufferedSha.slice(0, 12)}…). ` +
      `NOT uploading; the buffer copy is retained for inspection.`,
    );
  }

  await remote.write(attachment.bufferKey, bytes, attachment.mimeType ?? undefined);

  // Read it back out of the remote store and compare. This is the "integrity
  // verify" half of the acknowledgement — without it, "uploaded" means only
  // "the SDK call returned".
  const readBack = await remote.read(attachment.bufferKey);
  const remoteSha = sha256Of(readBack);
  if (remoteSha !== attachment.sha256) {
    throw new Error(
      `Remote copy of attachment ${attachment.id} read back with checksum ` +
      `${remoteSha.slice(0, 12)}… but ${attachment.sha256.slice(0, 12)}… was expected. ` +
      `Buffer copy retained.`,
    );
  }

  const remoteKey = attachment.bufferKey;

  // Verified. Now, and only now, the buffer copy is redundant. A failure to
  // delete it is untidy, never dangerous — the row already points at the
  // verified remote copy, so a leftover buffer file is wasted disk and nothing
  // more. Do not let it fail the promotion.
  await buffer.remove(remoteKey).catch((err) => {
    console.warn(`[attachments] buffer cleanup failed for ${attachment.id} (harmless):`, err);
  });

  return { remoteKey, uploadedAt: new Date() };
}

/**
 * Read an attachment's bytes from wherever they currently live.
 *
 * Buffered files are served from the buffer, remote ones from the object store.
 * A tech who just took a photo can see it immediately; nothing waits on B2.
 */
export async function readAttachmentBytes(
  attachment: {
    storageState: string;
    bufferKey: string | null;
    remoteKey: string | null;
  },
  remoteStore?: FileStore,
): Promise<Buffer> {
  if (attachment.storageState === 'remote' && attachment.remoteKey) {
    return (remoteStore ?? getFileStore()).read(attachment.remoteKey);
  }
  if (attachment.bufferKey) {
    return getBufferStore().read(attachment.bufferKey);
  }
  throw new Error('Attachment has no readable copy');
}

/**
 * Delete both copies. Used when an attachment record is removed.
 *
 * Both are best-effort: the row is the index, and an orphaned object costs
 * storage, whereas a failed delete that blocks the API costs a stuck tech.
 */
export async function removeAttachmentBytes(
  attachment: {
    bufferKey: string | null;
    remoteKey: string | null;
  },
  remoteStore?: FileStore,
): Promise<void> {
  if (attachment.bufferKey) {
    await getBufferStore().remove(attachment.bufferKey).catch(() => {});
  }
  if (attachment.remoteKey) {
    await (remoteStore ?? getFileStore()).remove(attachment.remoteKey).catch(() => {});
  }
}
