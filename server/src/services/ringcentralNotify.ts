/**
 * ringcentralNotify.ts
 *
 * Posts plain-text notifications into RingCentral Team Messaging chats via
 * Incoming Webhooks (https://developers.ringcentral.com/guide/team-messaging/manual/webhooks).
 * No OAuth/JWT app registration needed — a webhook URL is minted per-chat from
 * the RingCentral app ("Add Integration" > "Incoming Webhook") and treated as
 * a bearer secret in itself.
 *
 * Three independent channels so billing, dispatch, and shop intake can each
 * post to a different team chat. Each falls back to RINGCENTRAL_WEBHOOK_URL
 * if its own var isn't set, so a single-channel setup works without extra
 * config. Self-skips (silently no-ops) when neither the channel-specific nor
 * fallback URL is configured — matches the BlueLion/mailer "unconfigured
 * means inert" pattern.
 */

export type RingCentralChannel = 'billing' | 'dispatch' | 'intake';

const CHANNEL_ENV_VAR: Record<RingCentralChannel, string> = {
  billing: 'RINGCENTRAL_BILLING_WEBHOOK_URL',
  dispatch: 'RINGCENTRAL_DISPATCH_WEBHOOK_URL',
  intake: 'RINGCENTRAL_INTAKE_WEBHOOK_URL',
};

function webhookUrlFor(channel: RingCentralChannel): string {
  const specific = process.env[CHANNEL_ENV_VAR[channel]];
  return specific || process.env.RINGCENTRAL_WEBHOOK_URL || '';
}

export function isConfigured(channel: RingCentralChannel): boolean {
  return !!webhookUrlFor(channel);
}

const TIMEOUT_MS = parseInt(process.env.RINGCENTRAL_TIMEOUT_MS || '10000', 10);

/**
 * Fire-and-forget notification post. Never throws — a down/misconfigured
 * webhook should never block or fail the request that triggered it.
 *
 * `activity` + `iconUri` are the v2 webhook schema's only levers for
 * branding the post (RingCentral's built-in "Incoming Webhook" app name
 * itself isn't renameable short of registering a full Notification App).
 * iconUri is omitted entirely when unset — RingCentral requires an
 * https:// URL it can fetch, not a data URI.
 */
export async function notify(channel: RingCentralChannel, text: string): Promise<void> {
  const url = webhookUrlFor(channel);
  if (!url) return;

  const iconUri = process.env.RINGCENTRAL_ICON_URL || undefined;
  const body: Record<string, string> = { activity: 'ServicePRO', text };
  if (iconUri) body.iconUri = iconUri;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`[RingCentral] webhook POST (${channel}) failed: HTTP ${res.status}`);
    }
  } catch (err) {
    console.error(
      `[RingCentral] webhook POST (${channel}) errored:`,
      err instanceof Error ? err.message : err,
    );
  }
}
