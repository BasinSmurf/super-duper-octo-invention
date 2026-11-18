import { beforeEach, describe, expect, it, vi } from 'vitest';
const prisma = vi.hoisted(() => ({
  serviceTicket: { findUnique: vi.fn() },
  invoiceLineItem: { findFirst: vi.fn() },
  workPoint: { findUnique: vi.fn(), updateMany: vi.fn(), update: vi.fn(), create: vi.fn() },
  workPointVerificationConfig: { findUnique: vi.fn(), upsert: vi.fn() },
  airSystemInspection: { updateMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  auditLog: { create: vi.fn() }, $transaction: vi.fn(),
}));
vi.mock('../db.js', async importOriginal => ({ ...await importOriginal<typeof import('../db.js')>(), ...(() => ({ prisma }))() }));
import { ticketsRouter } from './tickets.js';
import { locationsRouter } from './locations.js';
import { syncRouter } from './sync.js';

const point = { id: 'wp1', name: 'Tank Battery', isActive: true, verified: true, dateVerified: new Date('2025-01-01'), workPointType: 'air_system_location', customData: { cylinders: [{ serialNumber: 'C1', hydroDate: '2024-01-01' }], notes: 'Keep' } };
async function call(router: any, path: string, method: string, body: any = {}, role = 'field_tech', userId = 'u1') {
  const route = router.stack.find((layer: any) => layer.route?.path === path && layer.route.methods[method]).route;
  const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };
  const next = vi.fn();
  const req = { params: { id: 't1', workPointId: 'wp1' }, body, user: { userId, role } };
  // Run permission middleware as well as the endpoint.
  for (const layer of route.stack) {
    next.mockClear();
    await layer.handle(req, res, next);
    if (next.mock.calls[0]?.[0] || res.status.mock.calls.length) break;
  }
  return { res, next };
}
beforeEach(() => {
  vi.clearAllMocks();
  prisma.$transaction.mockImplementation(async run => run(prisma));
  prisma.serviceTicket.findUnique.mockResolvedValue({ id: 't1', status: 'in_progress', assignedTechId: 'u1', createdById: 'u1', workPointId: null, airSystemInspections: [{ workPointId: 'wp1' }] });
  prisma.workPoint.findUnique.mockResolvedValue(point);
  prisma.workPoint.updateMany.mockResolvedValue({ count: 1 });
  prisma.workPointVerificationConfig.findUnique.mockResolvedValue(null);
  prisma.invoiceLineItem.findFirst.mockResolvedValue(null);
  prisma.airSystemInspection.findUnique.mockResolvedValue(null);
  prisma.airSystemInspection.create.mockImplementation(async ({ data }) => data);
});

describe('offline ticket verification sync', () => {
  async function push(payload: any) {
    const route = syncRouter.stack.find((layer: any) => layer.route?.path === '/push')!.route;
    const res = { json: vi.fn() }; const next = vi.fn();
    await route.stack[0].handle({ user: { userId: 'u1', role: 'field_tech' }, body: { mutations: [{ queueId: 1, table: 'airSystemRecords', action: 'create', entityId: 'as1', payload: { ticketId: 't1', workPointId: 'wp1', workPointName: 'Tank Battery', ...payload } }] } }, res, next);
    return { res, next };
  }
  it('commits an explicit offline check with the inspection and retains its original check date', async () => {
    const changedAt = '2025-01-01T00:00:00Z';
    const { res } = await push({ verificationUpdate: { verified: true, changedAt }, cylinders: [{ serialNumber: 'C1', hydroDate: '2024-01-01' }] });
    expect(res.json).toHaveBeenCalledWith({ results: [{ queueId: 1, status: 'ok', serverId: 'as1', ticketId: 't1' }] });
    expect(prisma.airSystemInspection.create.mock.calls[0][0].data).toMatchObject({ verified: true, dateVerified: new Date(changedAt) });
    expect(prisma.workPoint.updateMany.mock.calls[0][0].data).toMatchObject({ verified: true, dateVerified: new Date(changedAt) });
    expect(prisma.$transaction).toHaveBeenCalledOnce();
  });
  it('does not refresh the work point when saving a previous verification snapshot', async () => {
    await push({ verified: true, dateVerified: '2025-01-01T00:00:00Z' });
    expect(prisma.airSystemInspection.create).toHaveBeenCalledOnce();
    expect(prisma.workPoint.updateMany).not.toHaveBeenCalled();
  });
  it('allows a manually named system without a linked work point', async () => {
    const { res } = await push({ workPointId: undefined, verified: false, dateVerified: null });
    expect(res.json).toHaveBeenCalledWith({ results: [{ queueId: 1, status: 'ok', serverId: 'as1', ticketId: 't1' }] });
    expect(prisma.workPoint.updateMany).not.toHaveBeenCalled();
  });
  it('does not replay verification on an already-synced inspection', async () => {
    prisma.airSystemInspection.findUnique.mockResolvedValue({ id: 'as1' });
    await push({ verificationUpdate: { verified: true, changedAt: '2025-01-01T00:00:00Z' } });
    expect(prisma.airSystemInspection.create).not.toHaveBeenCalled();
    expect(prisma.workPoint.updateMany).not.toHaveBeenCalled();
  });
});

describe('ticket work point verification endpoint', () => {
  const path = '/:id/work-points/:workPointId/verification';
  it('persists the checkbox and check date on the work point and ticket inspection', async () => {
    const { next, res } = await call(ticketsRouter, path, 'put', { verified: true });
    expect(next).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ success: true });
    expect(prisma.workPoint.updateMany.mock.calls[0][0].data).toMatchObject({ verified: true, dateVerified: expect.any(Date) });
    expect(prisma.airSystemInspection.updateMany).toHaveBeenCalledWith({ where: { ticketId: 't1', workPointId: 'wp1' }, data: { verified: true, dateVerified: expect.any(Date) } });
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(2);
  });
  it('can remove verification', async () => {
    await call(ticketsRouter, path, 'put', { verified: false });
    expect(prisma.airSystemInspection.updateMany.mock.calls[0][0].data).toEqual({ verified: false, dateVerified: null });
  });
  it('checks permissions and ownership', async () => {
    expect((await call(ticketsRouter, path, 'put', { verified: true }, 'billing_ar')).res.status).toHaveBeenCalledWith(403);
    expect((await call(ticketsRouter, path, 'put', { verified: true }, 'field_tech', 'other')).next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
    expect(prisma.workPoint.updateMany).not.toHaveBeenCalled();
  });
  it('rejects a work point outside the ticket', async () => {
    prisma.serviceTicket.findUnique.mockResolvedValue({ assignedTechId: 'u1', airSystemInspections: [] });
    expect((await call(ticketsRouter, path, 'put', { verified: true })).next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    expect(prisma.workPoint.updateMany).not.toHaveBeenCalled();
  });
  it('rejects missing tickets, void tickets, and non-boolean values', async () => {
    expect((await call(ticketsRouter, path, 'put', { verified: 'true' })).next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    prisma.serviceTicket.findUnique.mockResolvedValueOnce(null);
    expect((await call(ticketsRouter, path, 'put', { verified: true })).next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    prisma.serviceTicket.findUnique.mockResolvedValueOnce({ status: 'void' });
    expect((await call(ticketsRouter, path, 'put', { verified: true })).next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
  });
});

describe('verification policy and location edits', () => {
  it('defaults to never expire and saves an audited admin policy', async () => {
    expect((await call(locationsRouter, '/work-point-verification-settings', 'get')).res.json).toHaveBeenCalledWith({ expiryDays: 0 });
    await call(locationsRouter, '/work-point-verification-settings', 'put', { expiryDays: 365 }, 'platform_admin');
    expect(prisma.workPointVerificationConfig.upsert).toHaveBeenCalledWith({ where: { id: 'default' }, create: { id: 'default', expiryDays: 365 }, update: { expiryDays: 365 } });
    expect(prisma.auditLog.create).toHaveBeenCalledOnce();
  });
  it('blocks non-admin policy changes and invalid day values', async () => {
    expect((await call(locationsRouter, '/work-point-verification-settings', 'put', { expiryDays: 365 })).res.status).toHaveBeenCalledWith(403);
    expect((await call(locationsRouter, '/work-point-verification-settings', 'put', { expiryDays: -1 }, 'platform_admin')).next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    expect(prisma.workPointVerificationConfig.upsert).not.toHaveBeenCalled();
  });
  it('updates the existing work point and clears verification after serial or hydro edits', async () => {
    const customData = { ...point.customData, cylinders: [{ serialNumber: 'C1', hydroDate: '2026-01-01' }] };
    await call(locationsRouter, '/work-points/:id', 'put', { customData }, 'platform_admin');
    expect(prisma.workPoint.update).toHaveBeenCalledWith({ where: { id: 'wp1' }, data: { customData, verified: false, dateVerified: null, verificationChangedAt: expect.any(Date) } });
    expect(prisma.workPoint.create).not.toHaveBeenCalled();
  });
  it('preserves verification on deactivation and prevents direct verification forgery', async () => {
    await call(locationsRouter, '/work-points/:id', 'put', { isActive: false, verified: true, dateVerified: '2099-01-01' }, 'platform_admin');
    expect(prisma.workPoint.update).toHaveBeenCalledWith({ where: { id: 'wp1' }, data: { isActive: false } });
  });
});
