import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ permissionConfig: { findFirst: vi.fn() } }));
vi.mock('../db.js', () => ({ prisma: db }));

vi.mock('../utils/auditLog.js', () => ({ createAuditLog: vi.fn() }));
import { companiesRouter } from './companies.js';
import { CAPABILITY_CATALOG, DEFAULT_PERMISSIONS, invalidateMatrix, loadMatrix, roleHasCapability } from '../services/permissions.js';

const cap = 'rentals:edit_packages';
const routes = [
  ['post', '/:id/rental-boms'],
  ['put', '/:companyId/rental-boms/:id'],
  ['delete', '/:companyId/rental-boms/:id'],
] as const;

function gate(method: string, path: string, role: string) {
  const route = companiesRouter.stack.find(l => l.route?.path === path && l.route.methods[method])!.route;
  const next = vi.fn(), res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
  route.stack[0].handle({ user: { role } }, res, next);
  return { next, res };
}
beforeEach(() => { vi.resetAllMocks(); invalidateMatrix(); });

describe('selectable rental package permission', () => {
  it('appears in the permission catalog and defaults Dispatch and Field Super on', () => {
    expect(CAPABILITY_CATALOG).toContainEqual(expect.objectContaining({ key: cap, label: 'Edit rental packages', group: 'Rentals' }));
    for (const role of ['dispatch', 'field_super', 'billing_ar', 'platform_admin']) expect(roleHasCapability(role, cap)).toBe(true);
    expect(roleHasCapability('dispatch', 'billing:profiles')).toBe(false);
    expect(roleHasCapability('field_super', 'billing:profiles')).toBe(false);
  });
  it.each(routes)('%s %s enforces the new capability', (method, path) => {
    for (const role of ['dispatch', 'field_super', 'billing_ar', 'platform_admin']) expect(gate(method, path, role).next).toHaveBeenCalledOnce();
    for (const role of ['field_tech', 'trainer', 'boss']) {
      const { res, next } = gate(method, path, role);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    }
  });
  it('honors saved grants and revocations independently of billing profiles', async () => {
    db.permissionConfig.findFirst.mockResolvedValue({ matrix: { ...DEFAULT_PERMISSIONS, [cap]: ['field_tech'] } });
    await loadMatrix();
    for (const [method, path] of routes) {
      expect(gate(method, path, 'field_tech').next).toHaveBeenCalledOnce();
      expect(gate(method, path, 'dispatch').res.status).toHaveBeenCalledWith(403);
      expect(gate(method, path, 'field_super').res.status).toHaveBeenCalledWith(403);
      expect(gate(method, path, 'billing_ar').res.status).toHaveBeenCalledWith(403);
      expect(gate(method, path, 'platform_admin').next).toHaveBeenCalledOnce();
    }
    expect(roleHasCapability('billing_ar', 'billing:profiles')).toBe(true);
    expect(roleHasCapability('field_tech', 'billing:profiles')).toBe(false);
  });
  it('uses the new defaults with an existing saved matrix that predates this capability', async () => {
    const { [cap]: _newCapability, ...oldMatrix } = DEFAULT_PERMISSIONS;
    db.permissionConfig.findFirst.mockResolvedValue({ matrix: oldMatrix });
    await loadMatrix();
    expect(roleHasCapability('dispatch', cap)).toBe(true);
    expect(roleHasCapability('field_super', cap)).toBe(true);
  });
});
