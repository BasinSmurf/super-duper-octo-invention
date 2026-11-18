/**
 * attachmentUploader.ts — drains the SP server's attachment buffer to B2.
 *
 * Hop 2 of the pipeline in attachmentStore.ts, run as a supervised background
 * processor so it is not on any technician's critical path. Capture acks as
 * soon as the SP server has the bytes; this catches up whenever the object
 * store is reachable.
 *
 * DESIGN NOTES worth keeping:
 *
 * - It NEVER gives up. `failed` is a display state ("this one keeps not
 *   working, someone look"), not a terminal one — failed rows are retried on
 *   the same schedule as everything else, with a backoff, forever. The buffer
 *   copy is kept the whole time. A file that stops being retried is a file
 *   that quietly becomes lost the first time someone tidies the buffer folder.
 *
 * - Errors are recorded on the row, not just logged. `lastUploadError` is what
 *   the Ops dashboard and the ticket's documentation-pending indicator read;
 *   an error that exists only in a log file is an error nobody sees.
 *
 * - Runs under the shared job lock so two API containers do not both promote
 *   the same attachment. Double-promotion is harmless (same bytes, same key,
 *   verified either way) but wasteful of B2 egress, which is metered.
 */

import { prisma } from '../db.js';
import { runScheduledJob } from './jobs.js';
import { heartbeat } from './supervisor.js';
import { promoteToRemote, remoteTierEnabled } from './attachmentStore.js';

export const CHECK_INTERVAL_MS = parseInt(
  process.env.ATTACHMENT_UPLOAD_TICK_MS || `${60_000}`,
  10,
);

/** How many to promote per tick. Keeps a backlog from monopolising the box. */
const BATCH_SIZE = parseInt(process.env.ATTACHMENT_UPLOAD_BATCH || '25', 10);

/**
 * Backoff between retries of a repeatedly-failing attachment, capped so a file
 * that has failed 200 times is still retried within the hour rather than drifting
 * to a once-a-week cadence and looking abandoned.
 */
const BASE_RETRY_MS = 60_000;
const MAX_RETRY_MS = 30 * 60_000;

function retryDelayFor(attempts: number): number {
  return Math.min(BASE_RETRY_MS * Math.pow(2, Math.max(0, attempts - 1)), MAX_RETRY_MS);
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Attachments whose bytes are not yet verified in the object store. */
async function findPending(now: Date) {
  const candidates = await prisma.attachment.findMany({
    where: { storageState: { in: ['buffered', 'failed'] } },
    orderBy: [{ lastAttemptAt: { sort: 'asc', nulls: 'first' } }, { capturedAt: 'asc' }],
    take: BATCH_SIZE * 4,
    select: {
      id: true, bufferKey: true, sha256: true, mimeType: true, fileName: true,
      uploadAttempts: true, lastAttemptAt: true,
    },
  });

  // Backoff is applied here rather than in the query so the interval maths
  // stays in one readable place.
  return candidates
    .filter((a) => {
      if (!a.lastAttemptAt) return true;
      return now.getTime() - a.lastAttemptAt.getTime() >= retryDelayFor(a.uploadAttempts);
    })
    .slice(0, BATCH_SIZE);
}

export async function processAttachmentUploads(): Promise<{ promoted: number; failed: number }> {
  const now = new Date();
  const pending = await findPending(now);
  let promoted = 0;
  let failed = 0;

  const processedKeys = new Set<string>();
  for (const attachment of pending) {
    if (attachment.bufferKey && processedKeys.has(attachment.bufferKey)) continue;
    if (attachment.bufferKey) processedKeys.add(attachment.bufferKey);
    try {
      const { remoteKey, uploadedAt } = await promoteToRemote(attachment);
      await prisma.attachment.updateMany({
        where: attachment.bufferKey ? { bufferKey: attachment.bufferKey } : { id: attachment.id },
        data: {
          storageState: 'remote',
          remoteKey,
          uploadedAt,
          // The buffer copy is gone (or orphaned and harmless); the row must
          // stop claiming it is the source of truth.
          bufferKey: null,
          lastUploadError: null,
          lastAttemptAt: uploadedAt,
          uploadAttempts: { increment: 1 },
        },
      });
      promoted++;
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : String(err);
      await prisma.attachment.updateMany({
        where: attachment.bufferKey ? { bufferKey: attachment.bufferKey } : { id: attachment.id },
        data: {
          // Stays retryable. 'failed' means "surfacing this to a human",
          // not "stopped trying".
          storageState: 'failed',
          lastUploadError: message.slice(0, 500),
          lastAttemptAt: new Date(),
          uploadAttempts: { increment: 1 },
        },
      }).catch(() => { /* the next tick will pick it up regardless */ });
      console.warn(`[attachments] promote failed for ${attachment.id}:`, message);
    }
  }

  if (promoted || failed) {
    console.log(`[attachments] uploader tick: ${promoted} promoted, ${failed} failed`);
  }
  return { promoted, failed };
}

export function startAttachmentUploader(): void {
  if (timer) return;

  // With no remote tier, ingest already writes straight to the configured
  // store and nothing is ever 'buffered'. Running a promoter would be a timer
  // that exists only to find nothing.
  if (!remoteTierEnabled()) {
    console.log('[attachments] STORAGE_DRIVER is not s3 — no second hop, uploader not started');
    return;
  }

  const runTick = () => {
    heartbeat('attachment-upload');
    return runScheduledJob('attachments.upload', 300, async () => {
      await processAttachmentUploads();
    });
  };

  void runTick();
  timer = setInterval(() => { void runTick(); }, CHECK_INTERVAL_MS);
  console.log(`[attachments] uploader started (every ${Math.round(CHECK_INTERVAL_MS / 1000)}s)`);
}

export function stopAttachmentUploader(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/**
 * Queue depth, for the Ops dashboard and the documentation-pending indicator.
 * Cheap enough to call on a page load.
 */
export async function attachmentQueueDepth(): Promise<{
  buffered: number;
  failed: number;
  oldestPendingAt: Date | null;
}> {
  const [buffered, failed, oldest] = await Promise.all([
    prisma.attachment.count({ where: { storageState: 'buffered' } }),
    prisma.attachment.count({ where: { storageState: 'failed' } }),
    prisma.attachment.findFirst({
      where: { storageState: { in: ['buffered', 'failed'] } },
      orderBy: { capturedAt: 'asc' },
      select: { capturedAt: true },
    }),
  ]);
  return { buffered, failed, oldestPendingAt: oldest?.capturedAt ?? null };
}
