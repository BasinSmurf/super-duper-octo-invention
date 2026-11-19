import { beforeEach, describe, expect, it, vi } from 'vitest';
const policy = vi.hoisted(() => ({
  matrix: { 'tickets:approve': ['billing_ar'] as string[] },
  roleHasCapability: vi.fn(() => false),
}));
vi.mock('../services/permissions.js', () => ({
  CAPABILITY_CATALOG: [{ key: 'tickets:approve', label: 'Approve tickets' }, { key: 'rentals:release_billing', label: 'Send rentals for billing' }],
  getEffectiveMatrix: () => policy.matrix,
  roleHasCapability: policy.roleHasCapability,
}));
import { requirePermission, requireRole } from './rbac.js';

function response() { return { status: vi.fn().mockReturnThis(), json: vi.fn() }; }
beforeEach(() => { vi.clearAllMocks(); policy.roleHasCapability.mockReturnValue(false); });
describe('permission denial responses', () => {
  it('uses effective overridden roles and includes the implicit admin role', () => {
    const res = response(), next = vi.fn();
    requirePermission('tickets:approve')({ user: { role: 'field_tech' } } as any, res as any, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Cannot approve tickets due to permissions. Must be Billing / AR or Platform Admin to continue.' });
    expect(next).not.toHaveBeenCalled();
  });
  it('reads a "send" capability as an action, not as something to access', () => {
    policy.matrix['rentals:release_billing'] = ['field_super'];
    const res = response();
    requirePermission('rentals:release_billing')({ user: { role: 'billing_ar' } } as any, res as any, vi.fn());
    expect(res.json).toHaveBeenCalledWith({ error: 'Cannot send rentals for billing due to permissions. Must be Field Supervisor or Platform Admin to continue.' });
  });
  it('lists only the roles accepted by an explicit role gate', () => {
    const res = response();
    requireRole('dispatch')({ user: { role: 'field_tech' } } as any, res as any, vi.fn());
    expect(res.json).toHaveBeenCalledWith({ error: 'Cannot perform this action due to permissions. Must be Dispatch to continue.' });
  });
  it('retains authentication failures and authorized access', () => {
    const res = response(), next = vi.fn();
    requirePermission('tickets:approve')({} as any, res as any, next);
    expect(res.status).toHaveBeenCalledWith(401);
    policy.roleHasCapability.mockReturnValue(true);
    requirePermission('tickets:approve')({ user: { role: 'billing_ar' } } as any, res as any, next);
    expect(next).toHaveBeenCalledOnce();
  });
});
