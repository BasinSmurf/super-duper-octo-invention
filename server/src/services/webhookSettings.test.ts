import { beforeEach, describe, expect, it, vi } from 'vitest';
const prisma = vi.hoisted(() => ({ webhookNotification: { findUnique: vi.fn(), findMany: vi.fn() } }));
vi.mock('../db.js', async importOriginal => ({ ...await importOriginal<typeof import('../db.js')>(), ...(() => ({ prisma }))() }));
import { resolveWebhook, validateWebhookUrl, webhookSettings } from './webhookSettings.js';
import { isConfigured, notify, sendNotification } from './ringcentralNotify.js';

const url = 'https://hooks.ringcentral.com/webhook/v2/secret-token';
beforeEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
  prisma.webhookNotification.findUnique.mockResolvedValue(null);
  prisma.webhookNotification.findMany.mockResolvedValue([]);
  for (const key of ['RINGCENTRAL_WEBHOOK_URL', 'RINGCENTRAL_BILLING_WEBHOOK_URL', 'RINGCENTRAL_DISPATCH_WEBHOOK_URL', 'RINGCENTRAL_DISPATCH_D3_WEBHOOK_URL', 'RINGCENTRAL_RENTALS_WEBHOOK_URL', 'RINGCENTRAL_INTAKE_WEBHOOK_URL']) vi.stubEnv(key, '');
});

describe('webhook configuration and delivery', () => {
  it('exposes distinct rental and field destinations and resolves their environment URLs independently', async () => {
    vi.stubEnv('RINGCENTRAL_DISPATCH_WEBHOOK_URL', `${url}-d4`);
    vi.stubEnv('RINGCENTRAL_DISPATCH_D3_WEBHOOK_URL', `${url}-d3`);
    vi.stubEnv('RINGCENTRAL_RENTALS_WEBHOOK_URL', `${url}-rentals`);
    expect((await webhookSettings()).map(row => row.channel)).toEqual(['billing', 'dispatch', 'dispatch_d3', 'rentals', 'intake']);
    expect((await resolveWebhook('dispatch')).url).toBe(`${url}-d4`);
    expect((await resolveWebhook('dispatch_d3')).url).toBe(`${url}-d3`);
    expect((await resolveWebhook('rentals')).url).toBe(`${url}-rentals`);
  });
  it('preserves channel-specific and shared environment fallback', async () => {
    vi.stubEnv('RINGCENTRAL_WEBHOOK_URL', url);
    vi.stubEnv('RINGCENTRAL_BILLING_WEBHOOK_URL', `${url}-billing`);
    expect((await resolveWebhook('billing')).url).toBe(`${url}-billing`);
    expect((await resolveWebhook('dispatch')).url).toBe(url);
  });
  it('reads overrides on each call and honors disabled channels even with environment URLs', async () => {
    vi.stubEnv('RINGCENTRAL_WEBHOOK_URL', url);
    prisma.webhookNotification.findUnique.mockResolvedValue({ enabled: true, url: `${url}-saved` });
    expect((await resolveWebhook('billing')).url).toBe(`${url}-saved`);
    prisma.webhookNotification.findUnique.mockResolvedValue({ enabled: false, url: null });
    expect(await isConfigured('billing')).toBe(false);
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await notify('billing', 'No delivery');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('never returns saved or environment URLs in settings', async () => {
    vi.stubEnv('RINGCENTRAL_WEBHOOK_URL', url);
    prisma.webhookNotification.findMany.mockResolvedValue([{ channel: 'billing', enabled: true, url: `${url}-saved` }]);
    const result = await webhookSettings();
    expect(result[0]).toMatchObject({ source: 'custom', configured: true, hasSavedUrl: true });
    expect(JSON.stringify(result)).not.toContain('secret-token');
  });
  it.each(['https://hooks.glip.com/webhooks/v2/token', url, 'https://hooks.ringcentral.com/webhook/token'])('accepts RingCentral endpoint %s', value => {
    expect(validateWebhookUrl(value)).toBe(value);
  });
  it.each(['http://hooks.glip.com/webhook/token', 'https://localhost/webhook/token', 'https://hooks.glip.com.evil.test/webhook/token', 'https://user@hooks.glip.com/webhook/token', 'https://hooks.glip.com:444/webhook/token', 'https://hooks.glip.com/webhook/token?redirect=x', 'https://hooks.glip.com/other/token', '', null])('rejects invalid destinations %s', value => {
    expect(() => validateWebhookUrl(value)).toThrow();
  });
  it('posts the existing payload with redirects disabled', async () => {
    prisma.webhookNotification.findUnique.mockResolvedValue({ enabled: true, url });
    const fetch = vi.fn().mockResolvedValue({ ok: true }); vi.stubGlobal('fetch', fetch);
    await sendNotification('billing', 'Ready to invoice');
    expect(fetch).toHaveBeenCalledWith(url, expect.objectContaining({ method: 'POST', redirect: 'error', body: expect.stringContaining('Ready to invoice') }));
  });
  it('reports failed delivery without exposing transport secrets and keeps business events safe', async () => {
    prisma.webhookNotification.findUnique.mockResolvedValue({ enabled: true, url });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error(url)));
    await expect(sendNotification('billing', 'test')).rejects.toThrow('Could not reach RingCentral');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(notify('billing', 'test')).resolves.toBeUndefined();
    expect(console.error).not.toHaveBeenCalledWith(expect.stringContaining('secret-token'));
  });
  it('reports rejected HTTP responses as failures', async () => {
    prisma.webhookNotification.findUnique.mockResolvedValue({ enabled: true, url });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403 }));
    await expect(sendNotification('billing', 'test')).rejects.toThrow('HTTP 403');
  });
});
