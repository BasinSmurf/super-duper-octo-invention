import { prisma } from '../db.js';
import { AppError } from '../middleware/errorHandler.js';

// Keep the existing dispatch key and its saved destination for D4.
export const WEBHOOK_CHANNELS = ['billing', 'dispatch', 'dispatch_d3', 'rentals', 'intake'] as const;
export type RingCentralChannel = typeof WEBHOOK_CHANNELS[number];

export function environmentUrl(channel: RingCentralChannel): string {
  return process.env[`RINGCENTRAL_${channel.toUpperCase()}_WEBHOOK_URL`]?.trim()
    || process.env.RINGCENTRAL_WEBHOOK_URL?.trim() || '';
}

// Restrict user-supplied destinations to RingCentral's incoming webhook hosts.
// Redirects are also disabled by the sender so credentials cannot leave them.
export function validateWebhookUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) throw new AppError(400, 'Enter a valid RingCentral incoming webhook URL');
  const trimmed = value.trim();
  let url: URL;
  try { url = new URL(trimmed); } catch { throw new AppError(400, 'Enter a valid RingCentral incoming webhook URL'); }
  if (url.protocol !== 'https:' || !['hooks.ringcentral.com', 'hooks.glip.com'].includes(url.hostname)
    || url.port || url.username || url.password || url.hash || url.search
    || !/^\/webhooks?\/(?:v2\/)?[A-Za-z0-9._-]+\/?$/.test(url.pathname)) {
    throw new AppError(400, 'Use an HTTPS incoming webhook URL from hooks.ringcentral.com or hooks.glip.com');
  }
  return trimmed;
}

export async function resolveWebhook(channel: RingCentralChannel) {
  const saved = await prisma.webhookNotification.findUnique({ where: { channel } });
  return { enabled: saved?.enabled ?? true, url: saved?.url ?? environmentUrl(channel) };
}

export async function webhookSettings() {
  const rows = await prisma.webhookNotification.findMany();
  return WEBHOOK_CHANNELS.map(channel => {
    const saved = rows.find(row => row.channel === channel);
    const url = saved?.url ?? environmentUrl(channel);
    return {
      channel, enabled: saved?.enabled ?? true,
      source: saved?.url ? 'custom' : 'environment',
      hasSavedUrl: !!saved?.url, environmentConfigured: !!environmentUrl(channel),
      configured: !!url,
    };
  });
}
