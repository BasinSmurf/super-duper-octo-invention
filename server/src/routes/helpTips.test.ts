import { beforeEach, expect, it, vi } from 'vitest';
const prisma = vi.hoisted(() => ({ user: { update: vi.fn() } }));
vi.mock('../db.js', async importOriginal => ({ ...await importOriginal<typeof import('../db.js')>(), ...(() => ({ prisma }))() }));
import { authRouter } from './auth.js';
const route = authRouter.stack.find(entry => entry.route?.path === '/me/help-tips')!.route;
async function save(body: unknown) {
  const json = vi.fn(), next = vi.fn();
  await route.stack[1].handle({ body, user: { userId: 'self' } }, { json }, next);
  return { json, next };
}
beforeEach(() => vi.clearAllMocks());
it.each([true, false, null])('saves own preference %s without resetting the start date', async enabled => {
  prisma.user.update.mockResolvedValue({ helpTipsEnabled: enabled });
  const result = await save({ enabled, userId: 'someone-else' });
  expect(result.next).not.toHaveBeenCalled();
  expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'self' }, data: { helpTipsEnabled: enabled }, select: { helpTipsStartedAt: true, helpTipsEnabled: true } });
});
it.each([{}, { enabled: 'true' }, { enabled: 90 }, null])('rejects malformed preference %s', async body => {
  const result = await save(body);
  expect(result.next.mock.calls[0][0].statusCode).toBe(400);
  expect(prisma.user.update).not.toHaveBeenCalled();
});
it('requires authentication', () => {
  const json = vi.fn(), next = vi.fn();
  route.stack[0].handle({ headers: {} }, { status: () => ({ json }) }, next);
  expect(json).toHaveBeenCalledWith({ error: 'Missing or invalid authorization header' });
  expect(next).not.toHaveBeenCalled();
});
