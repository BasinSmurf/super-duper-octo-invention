import { resolveWebhook, validateWebhookUrl, type RingCentralChannel } from './webhookSettings.js';
export type { RingCentralChannel } from './webhookSettings.js';

export async function isConfigured(channel: RingCentralChannel): Promise<boolean> {
  try {
    const config = await resolveWebhook(channel);
    return config.enabled && !!config.url;
  } catch {
    console.error(`[RingCentral] unable to load settings (${channel})`);
    return false;
  }
}

/** Shared by live events and the explicit test action. Never returns URL secrets. */
export async function sendNotification(channel: RingCentralChannel, text: string): Promise<void> {
  const { enabled, url } = await resolveWebhook(channel);
  if (!enabled) throw new Error('This channel is disabled. Enable and save it before testing.');
  if (!url) throw new Error('No webhook is configured for this channel.');
  validateWebhookUrl(url);
  const body: Record<string, string> = { activity: 'ServicePRO', text };
  if (process.env.RINGCENTRAL_ICON_URL) body.iconUri = process.env.RINGCENTRAL_ICON_URL;
  const timeout = Number(process.env.RINGCENTRAL_TIMEOUT_MS || 10000);
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Number.isFinite(timeout) && timeout > 0 ? Math.min(timeout, 30000) : 10000),
    });
  } catch {
    throw new Error('Could not reach RingCentral. Check the webhook URL and try again.');
  }
  // Do not echo response bodies: they may contain the credential-bearing URL.
  if (!response.ok) throw new Error(`RingCentral rejected the notification (HTTP ${response.status}).`);
}

/** Delivery errors must never fail the business operation that triggered them. */
export async function notify(channel: RingCentralChannel, text: string): Promise<void> {
  try {
    if (await isConfigured(channel)) await sendNotification(channel, text);
  } catch {
    console.error(`[RingCentral] notification failed (${channel})`);
  }
}
