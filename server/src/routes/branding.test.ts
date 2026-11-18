import { beforeEach, expect, it, vi } from 'vitest';
import sharp from 'sharp';
const mocks = vi.hoisted(() => ({
  db: { brandingConfig: { findUnique: vi.fn(), upsert: vi.fn() } },
  write: vi.fn(), read: vi.fn(), remove: vi.fn(), audit: vi.fn(),
}));
vi.mock('../db.js', () => ({ prisma: mocks.db }));
vi.mock('../services/fileStore.js', () => ({ getFileStore: () => ({ write: mocks.write, read: mocks.read, remove: mocks.remove }) }));
vi.mock('../utils/auditLog.js', () => ({ createAuditLog: mocks.audit }));
import { brandingRouter } from './branding.js';
import { getBranding, publicBranding } from '../services/branding.js';

function handler(path: string, method: string) {
  return brandingRouter.stack.find(layer => layer.route?.path === path && layer.route.methods[method])!.route.stack.at(-1).handle;
}
const response = () => ({ json: vi.fn(), setHeader: vi.fn(), send: vi.fn(), redirect: vi.fn() });
beforeEach(() => { vi.resetAllMocks(); mocks.db.brandingConfig.findUnique.mockResolvedValue(null); mocks.remove.mockResolvedValue(undefined); });
it('has usable defaults before any admin config is saved and never exposes storage keys', async () => {
  expect(publicBranding(await getBranding())).toEqual({ companyName: 'Basin Safety', logoUrl: '/servicepro-logo.png', hasCustomLogo: false });
  mocks.db.brandingConfig.findUnique.mockResolvedValue({ companyName: 'Acme', logoKey: 'private/b2/key', updatedAt: new Date(1000) });
  expect(publicBranding(await getBranding())).toEqual({ companyName: 'Acme', logoUrl: '/api/branding/logo?v=1000', hasCustomLogo: true });
});
it.each(['', ' '.repeat(5), 'x'.repeat(101), 'Name\r\nInjected'])('rejects invalid company name', async companyName => {
  await expect(handler('/', 'put')({ body: { companyName } }, response())).rejects.toMatchObject({ statusCode: 400 });
  expect(mocks.db.brandingConfig.upsert).not.toHaveBeenCalled();
});
it('saves the trimmed name and records the actor', async () => {
  await handler('/', 'put')({ body: { companyName: ' Acme Services ' }, user: { userId: 'admin' } }, response());
  expect(mocks.db.brandingConfig.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: { companyName: 'Acme Services' } }));
  expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ userId: 'admin', changes: { companyName: 'Acme Services' } }));
});
it('normalizes the uploaded logo into a PNG before writing to the configured store', async () => {
  const input = await sharp({ create: { width: 1600, height: 600, channels: 3, background: '#123456' } }).jpeg().toBuffer();
  await handler('/logo', 'post')({ file: { buffer: input }, user: { userId: 'admin' } }, response());
  const [key, bytes, type] = mocks.write.mock.calls[0];
  expect(key).toMatch(/^branding\/.+\.png$/); expect(type).toBe('image/png');
  expect(await sharp(bytes).metadata()).toMatchObject({ format: 'png', width: 1024, height: 384 });
  expect(mocks.db.brandingConfig.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: { logoKey: key } }));
});
it('rejects executable or corrupt uploads without writing to storage', async () => {
  await expect(handler('/logo', 'post')({ file: { buffer: Buffer.from('<svg onload="alert(1)"></svg>') } }, response())).rejects.toMatchObject({ statusCode: 400 });
  expect(mocks.write).not.toHaveBeenCalled();
});
it('removes a new object if the database cannot commit the logo reference', async () => {
  const input = await sharp({ create: { width: 1, height: 1, channels: 3, background: 'white' } }).png().toBuffer();
  mocks.db.brandingConfig.upsert.mockRejectedValue(new Error('DB unavailable'));
  await expect(handler('/logo', 'post')({ file: { buffer: input }, user: { userId: 'admin' } }, response())).rejects.toThrow('DB unavailable');
  expect(mocks.remove).toHaveBeenCalledWith(mocks.write.mock.calls[0][0]);
});
it('protects mutations with user authentication and the configuration permission', () => {
  const gate = brandingRouter.stack.find(layer => !layer.route && layer.handle.name === 'authenticate')!;
  const json = vi.fn(), next = vi.fn();
  gate.handle({ headers: {} }, { status: () => ({ json }) }, next);
  expect(json).toHaveBeenCalledWith({ error: 'Missing or invalid authorization header' });
  expect(next).not.toHaveBeenCalled();
  const permissionGate = brandingRouter.stack[brandingRouter.stack.indexOf(gate) + 1];
  expect(() => permissionGate.handle({ user: { role: 'field_tech' } }, {}, next)).toThrow();
});
