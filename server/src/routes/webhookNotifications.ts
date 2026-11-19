import { Router } from 'express';
import { prisma } from '../db.js';
import { requirePermission } from '../middleware/rbac.js';
import { AppError } from '../middleware/errorHandler.js';
import { WEBHOOK_CHANNELS, validateWebhookUrl, webhookSettings, type RingCentralChannel } from '../services/webhookSettings.js';
import { sendNotification } from '../services/ringcentralNotify.js';

export const webhookNotificationsRouter = Router();
webhookNotificationsRouter.use(requirePermission('system:config'));

function channelParam(value: unknown): RingCentralChannel {
  if (!WEBHOOK_CHANNELS.includes(value as RingCentralChannel)) throw new AppError(400, 'Unknown notification channel');
  return value as RingCentralChannel;
}

webhookNotificationsRouter.get('/', async (_req, res, next) => {
  try { res.json({ data: await webhookSettings() }); } catch (error) { next(error); }
});

webhookNotificationsRouter.put('/:channel', async (req, res, next) => {
  try {
    const channel = channelParam(req.params.channel);
    const { enabled, source, url } = req.body ?? {};
    if (typeof enabled !== 'boolean' || !['environment', 'custom'].includes(source)) {
      throw new AppError(400, 'Enabled and destination source are required');
    }
    let destination: string | null | undefined;
    if (source === 'environment') destination = null;
    else if (url !== undefined) destination = validateWebhookUrl(url);
    else {
      const existing = await prisma.webhookNotification.findUnique({ where: { channel } });
      if (!existing?.url) throw new AppError(400, 'Enter a webhook URL for this channel');
    }
    // Omitted URL preserves a saved secret without reading it back into the UI.
    await prisma.$transaction(async tx => {
      await tx.webhookNotification.upsert({
        where: { channel },
        create: { channel, enabled, url: destination },
        update: { enabled, ...(destination !== undefined ? { url: destination } : {}) },
      });
      await tx.auditLog.create({ data: {
        userId: req.user!.userId, entityType: 'WebhookNotification', entityId: channel,
        action: 'update', changes: { enabled, source, destinationChanged: destination !== undefined },
        ipAddress: req.ip,
      } });
    });
    res.json({ data: (await webhookSettings()).find(row => row.channel === channel) });
  } catch (error) {
    // Prisma validation errors can contain write arguments, including the URL.
    next(error instanceof AppError ? error : new AppError(500, 'Unable to save webhook settings'));
  }
});

webhookNotificationsRouter.post('/:channel/test', async (req, res, next) => {
  try {
    const channel = channelParam(req.params.channel);
    try {
      await sendNotification(channel, `ServicePRO test notification — ${channel}. Your webhook connection is working.`);
    } catch (error) {
      // Only known delivery errors are safe to expose; database errors can include secrets.
      const message = error instanceof Error ? error.message : '';
      const safe = /^(This channel is disabled\.|No webhook is configured|Could not reach RingCentral\.|RingCentral rejected)/.test(message);
      throw new AppError(502, safe ? message : 'Unable to send a test notification. Check the saved configuration.');
    }
    res.json({ message: 'Test notification accepted by RingCentral. Check the connected chat.' });
  } catch (error) { next(error); }
});
