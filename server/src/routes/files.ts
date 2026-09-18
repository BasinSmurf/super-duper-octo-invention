/**
 * File storage routes — auth-gated file serving and upload.
 *
 * GET  /api/files/:key(*)  — download/stream a stored file
 * POST /api/files/upload   — upload a file (multer)
 */

import { Router, Request, Response } from 'express';
import { basename, extname } from 'path';
import multer from 'multer';
import { getFileStore, ticketKey, invoiceKey } from '../services/fileStore.js';
import { AppError } from '../middleware/errorHandler.js';
import { requirePermission } from '../middleware/rbac.js';

export const filesRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
});

// MIME type lookup
const MIME_MAP: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
};

// GET /api/files/*  — serve a stored file
// The key is everything after /api/files/, e.g. /api/files/tickets/abc-123/ticket.pdf
filesRouter.get('/*', async (req: Request, res: Response, next) => {
  try {
    // Extract the storage key from the URL path (everything after /api/files/)
    const key = (req.params as any)[0] as string;
    if (!key || key.includes('..')) {
      throw new AppError(400, 'Invalid file path');
    }

    const store = getFileStore();
    if (!(await store.exists(key))) {
      throw new AppError(404, 'File not found');
    }

    const ext = extname(key).toLowerCase();
    const contentType = MIME_MAP[ext] || 'application/octet-stream';
    const fileName = basename(key);

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
    // Stop the browser from MIME-sniffing an upload into something executable,
    // and sandbox the response so a stored SVG with an inline <script> can't run
    // scripts in our origin against the viewer's session.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', 'sandbox; default-src \'none\'');

    // Stream rather than buffer — works the same on disk or S3.
    (await store.createReadStream(key)).pipe(res);
  } catch (err) {
    next(err);
  }
});

// POST /api/files/upload — upload a file to storage
// Body: multipart form with "file" field + "entityType" + "entityId" fields
filesRouter.post(
  '/upload',
  requirePermission('tickets:create'),
  upload.single('file'),
  async (req: Request, res: Response, next) => {
    try {
      if (!req.file) throw new AppError(400, 'No file provided');

      const { entityType, entityId, subPath } = req.body;
      if (!entityType || !entityId) {
        throw new AppError(400, 'entityType and entityId required');
      }

      // Reject any path-traversal in the key components before they get joined
      // onto the storage root. Without this, a subPath like "../../.." escapes
      // STORAGE_DIR and turns upload into a write-anywhere primitive.
      const rejectTraversal = (label: string, val: string) => {
        if (/[\\/]|\.\./.test(val)) throw new AppError(400, `Invalid ${label}`);
      };
      rejectTraversal('entityType', String(entityType));
      rejectTraversal('entityId', String(entityId));

      // Only ever trust the basename of the client-supplied name — never a path.
      const rawName = (subPath || req.file.originalname || 'upload') as string;
      const fileName = basename(rawName);
      if (!fileName || fileName === '.' || fileName === '..') {
        throw new AppError(400, 'Invalid file name');
      }
      let key: string;
      switch (entityType) {
        case 'ticket':
          key = ticketKey(entityId, fileName);
          break;
        case 'invoice':
          key = invoiceKey(entityId, fileName);
          break;
        default:
          key = `${entityType}/${entityId}/${fileName}`;
      }

      const store = getFileStore();
      await store.write(key, req.file.buffer, req.file.mimetype);

      const size = await store.size(key);
      res.status(201).json({
        key,
        fileName: basename(key),
        mimeType: req.file.mimetype,
        size,
      });
    } catch (err) {
      next(err);
    }
  },
);
