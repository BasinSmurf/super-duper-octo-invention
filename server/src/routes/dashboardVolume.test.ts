import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ groupBy: vi.fn() }));
vi.mock('../db.js', async () => ({
  Prisma: (await import('../generated/prisma/client.js')).Prisma,
  prisma: { serviceTicket: { groupBy: mocks.groupBy } },
}));
import { dashboardRouter } from './dashboard.js';

const route = dashboardRouter.stack.find(layer => layer.route?.path === '/ticket-volume')!.route;
beforeEach(() => { vi.clearAllMocks(); mocks.groupBy.mockResolvedValue([]); });
afterEach(() => { vi.useRealTimers(); });

it.each([undefined, 'field_tech', 'customer'])('denies broad ticket counts to %s before querying', role => {
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
  const next = vi.fn();
  route.stack[0].handle({ user: role ? { role } : undefined }, res, next);
  expect(res.status).toHaveBeenCalledWith(role ? 403 : 401);
  expect(next).not.toHaveBeenCalled();
  expect(mocks.groupBy).not.toHaveBeenCalled();
});

it.each(['dispatch', 'field_super', 'boss', 'platform_admin'])('allows the ticket-volume role %s', role => {
  const next = vi.fn();
  route.stack[0].handle({ user: { role } }, {}, next);
  expect(next).toHaveBeenCalledOnce();
});

it('uses the Central business day after UTC midnight and prevents caching', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-17T01:30:00Z'));
  const res = { set: vi.fn(), json: vi.fn() };
  await route.stack[1].handle({}, res);
  expect(res.set).toHaveBeenCalledWith('Cache-Control', 'no-store');
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ from: '2026-10-18', to: '2026-11-16' }));
});
