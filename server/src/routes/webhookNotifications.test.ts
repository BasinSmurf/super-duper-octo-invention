import { beforeEach, describe, expect, it, vi } from 'vitest';
const prisma = vi.hoisted(() => ({
  webhookNotification: { findUnique: vi.fn(), findMany: vi.fn(), upsert: vi.fn() },
  auditLog: { create: vi.fn() }, $transaction: vi.fn(),
}));
vi.mock('../db.js', async importOriginal => ({ ...await importOriginal<typeof import('../db.js')>(), ...(() => ({ prisma }))() }));
vi.mock('../services/permissions.js', () => ({
  CAPABILITY_CATALOG: [{ key: 'system:config', label: 'System configuration' }],
  getEffectiveMatrix: () => ({ 'system:config': ['platform_admin'] }),
  roleHasCapability: (role: string) => role === 'platform_admin',
}));
vi.mock('../services/ringcentralNotify.js', () => ({ sendNotification: vi.fn() }));
import { webhookNotificationsRouter } from './webhookNotifications.js';
import { sendNotification } from '../services/ringcentralNotify.js';

async function call(method: string, path: string, body?: unknown, channel = 'billing') {
  const route = webhookNotificationsRouter.stack.find(layer => layer.route?.path === path && layer.route.methods[method])!.route;
  const res = { json: vi.fn() }; const next = vi.fn();
  await route.stack[0].handle({ params: { channel }, body, user: { userId: 'admin' } }, res, next);
  return { res, next };
}
beforeEach(() => {
  vi.clearAllMocks();
  prisma.$transaction.mockImplementation(async fn => fn(prisma));
  prisma.webhookNotification.findMany.mockResolvedValue([]);
  prisma.webhookNotification.findUnique.mockResolvedValue({ url: 'https://hooks.glip.com/webhook/existing' });
  prisma.webhookNotification.upsert.mockResolvedValue({});
});

describe('webhook settings API', () => {
  it.each([undefined, 'field_tech', 'billing_ar'])('blocks unauthorized access for %s', role => {
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }; const next = vi.fn();
    webhookNotificationsRouter.stack[0].handle({ user: role ? { role } : undefined }, res, next);
    expect(res.status).toHaveBeenCalledWith(role ? 403 : 401);
    if (role) expect(res.json).toHaveBeenCalledWith({
      error: 'Cannot access system configuration due to permissions. Must be Platform Admin to continue.',
    });
    expect(next).not.toHaveBeenCalled();
  });
  it('allows platform administrators', () => {
    const next = vi.fn();
    webhookNotificationsRouter.stack[0].handle({ user: { role: 'platform_admin' } }, {}, next);
    expect(next).toHaveBeenCalledOnce();
  });
  it('saves a destination atomically with a redacted audit record', async () => {
    const url = 'https://hooks.glip.com/webhook/new-secret';
    const { next } = await call('put', '/:channel', { enabled: true, source: 'custom', url });
    expect(next).not.toHaveBeenCalled();
    expect(prisma.webhookNotification.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: { enabled: true, url } }));
    expect(JSON.stringify(prisma.auditLog.create.mock.calls)).not.toContain('new-secret');
    expect(prisma.auditLog.create).toHaveBeenCalledOnce();
  });
  it('preserves the URL when editing enabled state', async () => {
    await call('put', '/:channel', { enabled: false, source: 'custom' });
    expect(prisma.webhookNotification.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: { enabled: false } }));
  });
  it('clears an override when restoring environment settings', async () => {
    await call('put', '/:channel', { enabled: true, source: 'environment' });
    expect(prisma.webhookNotification.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: { enabled: true, url: null } }));
  });
  it.each([{}, { enabled: 'yes', source: 'environment' }, { enabled: true, source: 'custom', url: '' }, { enabled: true, source: 'custom', url: 'https://localhost/' }])('rejects malformed updates', async body => {
    expect((await call('put', '/:channel', body)).next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    expect(prisma.webhookNotification.upsert).not.toHaveBeenCalled();
  });
  it('rejects a missing URL on initial setup and invalid channels', async () => {
    prisma.webhookNotification.findUnique.mockResolvedValue(null);
    expect((await call('put', '/:channel', { enabled: true, source: 'custom' })).next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    expect((await call('put', '/:channel', {}, 'other')).next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
  });
  it('redacts database write errors before passing them to the logger', async () => {
    prisma.webhookNotification.upsert.mockRejectedValueOnce(new Error('query contained secret-token'));
    const { next } = await call('put', '/:channel', { enabled: true, source: 'environment' });
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'Unable to save webhook settings' }));
  });
  it('returns test delivery failures as errors', async () => {
    vi.mocked(sendNotification).mockRejectedValueOnce(new Error('RingCentral rejected the notification (HTTP 403).'));
    expect((await call('post', '/:channel/test')).next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 502 }));
  });
  it('confirms accepted test delivery', async () => {
    vi.mocked(sendNotification).mockResolvedValueOnce();
    expect((await call('post', '/:channel/test')).res.json).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('accepted') }));
  });
});
