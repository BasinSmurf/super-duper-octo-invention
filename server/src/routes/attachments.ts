/**
 * attachments.ts — the unified attachment API.
 *
 *   GET    /api/attachments?shopItemId=|inspectionId=|ticketId=   list
 *   POST   /api/attachments                                       upload (multipart)
 *   GET    /api/attachments/:id/content                           stream the bytes
 *   DELETE /api/attachments/:id                                   remove
 *
 * The online counterpart to the offline path in sync.ts; both funnel into
 * services/attachmentStore.ts so there is exactly one implementation of the
 * two-hop custody rule.
 */

import { Router, Request, Response } from 'express';
import { basename } from 'node:path';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { prisma } from '../index.js';
import { AppError } from '../middleware/errorHandler.js';
import { requirePermission } from '../middleware/rbac.js';
import { createAuditLog } from '../utils/auditLog.js';
import type { AttachmentKind } from '../db.js';
import {
  attachmentKey,
  ingestAttachmentBytes,
  readAttachmentBytes,
  removeAttachmentBytes,
  ChecksumMismatchError,
} from '../services/attachmentStore.js';
import { enqueueAttachment } from '../services/blueLionEnqueue.js';

export const attachmentsRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  // 25MB: photos from a modern phone + PDF reports. This is also EXACTLY
  // BlueLion's per-document ceiling (SERVICEPRO-INTEGRATION.md §3.4), which is
  // what keeps every file SP accepts pushable. Raising it here without raising
  // it there turns oversized captures into 413s at the Vault boundary.
  limits: { fileSize: 25 * 1024 * 1024 },
});

const KINDS: AttachmentKind[] = [
  'photo', 'ue_report', 'pozi_report', 'vendor_invoice', 'packing_slip',
  'test_paperwork', 'signature', 'document', 'other',
];

const PUBLIC_FIELDS = {
  id: true, shopItemId: true, inspectionId: true, ticketId: true,
  serialNumber: true, serializedEquipmentId: true, kind: true,
  fileName: true, mimeType: true, fileSizeBytes: true, sha256: true,
  storageState: true, uploadAttempts: true, lastUploadError: true,
  uploadedAt: true, capturedAt: true, offlineBlobId: true,
  uploadedBy: { select: { id: true, name: true } },
} as const;

/** Pull exactly one parent out of a query/body, or explain why not. */
function readParent(src: Record<string, unknown>): {
  shopItemId: string | null; inspectionId: string | null; ticketId: string | null;
} {
  const shopItemId = typeof src.shopItemId === 'string' && src.shopItemId ? src.shopItemId : null;
  const inspectionId = typeof src.inspectionId === 'string' && src.inspectionId ? src.inspectionId : null;
  const ticketId = typeof src.ticketId === 'string' && src.ticketId ? src.ticketId : null;
  const count = [shopItemId, inspectionId, ticketId].filter(Boolean).length;
  if (count !== 1) {
    throw new AppError(400, 'Exactly one of shopItemId, inspectionId or ticketId is required');
  }
  return { shopItemId, inspectionId, ticketId };
}

// GET /api/attachments?shopItemId=…
attachmentsRouter.get('/', async (req: Request, res: Response, next) => {
  try {
    const parent = readParent(req.query as Record<string, unknown>);
    const attachments = await prisma.attachment.findMany({
      where: {
        ...(parent.shopItemId ? { shopItemId: parent.shopItemId } : {}),
        ...(parent.inspectionId ? { inspectionId: parent.inspectionId } : {}),
        ...(parent.ticketId ? { ticketId: parent.ticketId } : {}),
      },
      orderBy: { capturedAt: 'asc' },
      select: PUBLIC_FIELDS,
    });
    res.json({ attachments });
  } catch (err) { next(err); }
});

// POST /api/attachments — multipart: file + parent + kind (+ serialNumber)
attachmentsRouter.post(
  '/',
  requirePermission('tickets:create'),
  upload.single('file'),
  async (req: Request, res: Response, next) => {
    try {
      if (!req.file) throw new AppError(400, 'No file provided');
      const parent = readParent(req.body as Record<string, unknown>);

      const kind = (req.body.kind || 'photo') as AttachmentKind;
      if (!KINDS.includes(kind)) {
        throw new AppError(400, `kind must be one of: ${KINDS.join(', ')}`);
      }

      // basename() so a crafted "../../etc/passwd" filename cannot walk out of
      // the key namespace even before attachmentKey() sanitises it.
      const fileName = basename(req.body.fileName || req.file.originalname || 'upload');
      const id = randomUUID();
      const key = attachmentKey(parent, id, fileName);

      // Hop 1. Throws if the device's checksum disagrees, before we have told
      // anyone the file is safe. A mismatch is the request's problem, not the
      // server's -- answer 400 with the reason so the device retries knowingly
      // instead of reading a 500 as "the server is down, give up".
      let stored;
      try {
        stored = await ingestAttachmentBytes(
          req.file.buffer,
          key,
          req.file.mimetype,
          typeof req.body.sha256 === 'string' ? req.body.sha256 : null,
        );
      } catch (err) {
        if (err instanceof ChecksumMismatchError) throw new AppError(400, err.message);
        throw err;
      }

      const attachment = await prisma.attachment.create({
        data: {
          id,
          ...parent,
          serialNumber: kind === 'vendor_invoice' || kind === 'packing_slip' ? null : req.body.serialNumber || null,
          serializedEquipmentId: kind === 'vendor_invoice' || kind === 'packing_slip' ? null : req.body.serializedEquipmentId || null,
          kind,
          fileName,
          mimeType: req.file.mimetype || null,
          offlineBlobId: req.body.offlineBlobId || null,
          uploadedById: req.user!.userId,
          sha256: stored.sha256,
          fileSizeBytes: stored.fileSizeBytes,
          storageState: stored.storageState,
          bufferKey: stored.bufferKey,
          remoteKey: stored.remoteKey,
          uploadedAt: stored.uploadedAt,
        },
        select: PUBLIC_FIELDS,
      });

      // VaultPRO push is a background errand, never awaited: the capture is
      // already durable on the SP server, and a BlueLion outage must not turn
      // into a failed upload for the tech holding the iPad.
      void enqueueAttachment(attachment.id).catch((e) =>
        console.warn('[attachments] VaultPRO enqueue failed (non-fatal):', e),
      );

      // This response IS the device's cue to delete its local copy, so it says
      // plainly which hop has completed rather than leaving it to be inferred.
      res.status(201).json({
        attachment,
        deviceMayDeleteLocalCopy: true,
        pendingRemoteUpload: stored.storageState === 'buffered',
      });
    } catch (err) { next(err); }
  },
);

// GET /api/attachments/:id/content — stream from wherever the bytes live now.
attachmentsRouter.get('/:id/content', async (req: Request, res: Response, next) => {
  try {
    const attachment = await prisma.attachment.findUnique({
      where: { id: req.params.id as string },
      select: {
        fileName: true, mimeType: true, storageState: true,
        bufferKey: true, remoteKey: true,
      },
    });
    if (!attachment) throw new AppError(404, 'Attachment not found');

    const bytes = await readAttachmentBytes(attachment);
    res.setHeader('Content-Type', attachment.mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${attachment.fileName}"`);
    // Same hardening as /api/files: never let a stored SVG or HTML upload run
    // scripts against a viewer's session on our origin.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
    res.send(bytes);
  } catch (err) { next(err); }
});

// DELETE /api/attachments/:id
attachmentsRouter.delete(
  '/:id',
  requirePermission('tickets:create'),
  async (req: Request, res: Response, next) => {
    try {
      const id = req.params.id as string;
      const attachment = await prisma.attachment.findUnique({
        where: { id },
        select: { id: true, fileName: true, bufferKey: true, remoteKey: true, shopItemId: true, inspectionId: true },
      });
      if (!attachment) throw new AppError(404, 'Attachment not found');

      await prisma.attachment.delete({ where: { id } });
      await removeAttachmentBytes(attachment);

      await createAuditLog({
        userId: req.user!.userId,
        action: 'delete',
        entityType: 'attachment',
        entityId: id,
        changes: { fileName: attachment.fileName },
      });

      res.json({ id });
    } catch (err) { next(err); }
  },
);
