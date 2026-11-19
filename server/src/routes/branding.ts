import { Router } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { prisma } from '../db.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { AppError } from '../middleware/errorHandler.js';
import { createAuditLog } from '../utils/auditLog.js';
import { getFileStore } from '../services/fileStore.js';
import { getBranding, publicBranding } from '../services/branding.js';

export const brandingRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// Login and email clients need public access to these presentation assets.
brandingRouter.get('/', async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(publicBranding(await getBranding()));
});
brandingRouter.get('/logo', async (_req, res) => {
  const { logoKey } = await getBranding();
  if (!logoKey) return res.redirect('/servicepro-logo.png');
  const bytes = await getFileStore().read(logoKey);
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(bytes);
});

brandingRouter.use(authenticate, requirePermission('system:config'));
brandingRouter.put('/', async (req, res) => {
  const companyName = typeof req.body.companyName === 'string' ? req.body.companyName.trim() : '';
  if (!companyName || companyName.length > 100 || /[\x00-\x1f\x7f]/.test(companyName)) {
    throw new AppError(400, 'Company name must be between 1 and 100 characters without control characters');
  }
  await prisma.brandingConfig.upsert({ where: { id: 'singleton' }, create: { companyName }, update: { companyName } });
  await createAuditLog({ userId: req.user!.userId, entityType: 'branding', entityId: 'singleton', action: 'update', changes: { companyName } });
  res.json(publicBranding(await getBranding()));
});
brandingRouter.post('/logo', upload.single('file'), async (req, res) => {
  if (!req.file) throw new AppError(400, 'Choose a PNG, JPEG, or WebP logo');
  let bytes: Buffer;
  try {
    const image = sharp(req.file.buffer, { limitInputPixels: 16_000_000 });
    const metadata = await image.metadata();
    if (!['png', 'jpeg', 'webp'].includes(metadata.format ?? '') || (metadata.pages ?? 1) > 1) throw new Error('Unsupported image');
    bytes = await image.resize({ width: 1024, height: 512, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
  } catch { throw new AppError(400, 'Choose a valid, non-animated PNG, JPEG, or WebP image up to 16 megapixels'); }
  const previous = await getBranding();
  const logoKey = `branding/${randomUUID()}.png`;
  const store = getFileStore();
  await store.write(logoKey, bytes, 'image/png');
  try {
    await prisma.brandingConfig.upsert({ where: { id: 'singleton' }, create: { logoKey }, update: { logoKey } });
  } catch (err) { await store.remove(logoKey).catch(() => {}); throw err; }
  if (previous.logoKey) await store.remove(previous.logoKey).catch(err => console.warn('[branding] Old logo cleanup failed', err));
  await createAuditLog({ userId: req.user!.userId, entityType: 'branding', entityId: 'singleton', action: 'update', changes: { logoUploaded: true } });
  res.json(publicBranding(await getBranding()));
});
brandingRouter.delete('/logo', async (req, res) => {
  const previous = await getBranding();
  await prisma.brandingConfig.upsert({ where: { id: 'singleton' }, create: {}, update: { logoKey: null } });
  if (previous.logoKey) await getFileStore().remove(previous.logoKey).catch(err => console.warn('[branding] Old logo cleanup failed', err));
  await createAuditLog({ userId: req.user!.userId, entityType: 'branding', entityId: 'singleton', action: 'update', changes: { logoRemoved: true } });
  res.json(publicBranding(await getBranding()));
});
