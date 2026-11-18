import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ permissionConfig: { findFirst: vi.fn() } }));
vi.mock('../db.js', () => ({ prisma: db }));
import { ALL_ROLES, CAPABILITY_CATALOG, invalidateMatrix, loadMatrix, roleHasCapability } from './permissions.js';
import { canTransition, getAvailableTransitions } from './ticketStateMachine.js';
import { WIDGET_CATALOG } from './widgetCatalog.js';

beforeEach(() => { vi.resetAllMocks(); invalidateMatrix(); });

// AR Supervisor is billing_ar plus override actions. The failure this guards
// against is the quiet one: a hardcoded role list somewhere admits billing_ar
// but not ar_supervisor, and the supervisor can do less than their own team.
describe('ar_supervisor is a superset of billing_ar', () => {
  it('is a staff role', () => {
    expect(ALL_ROLES).toContain('ar_supervisor');
  });
  it('holds every default capability billing_ar holds', () => {
    const missing = CAPABILITY_CATALOG
      .filter(c => c.defaults.includes('billing_ar') && !c.defaults.includes('ar_supervisor'))
      .map(c => c.key);
    expect(missing).toEqual([]);
  });
  it('can make every ticket transition billing_ar can', () => {
    const statuses = ['draft', 'dispatched', 'in_progress', 'completed', 'supervisor_review',
      'awaiting_signature', 'billing_queue', 'invoiced', 'closed', 'void'] as const;
    for (const from of statuses) {
      for (const to of getAvailableTransitions(from, 'billing_ar' as any)) {
        expect(canTransition(from, to as any, 'ar_supervisor' as any), `${from} -> ${to}`).toBe(true);
      }
    }
  });
  it('can add every dashboard widget billing_ar can', () => {
    const missing = WIDGET_CATALOG
      .filter(w => w.roles.includes('billing_ar') && !w.roles.includes('ar_supervisor'))
      .map(w => w.type);
    expect(missing).toEqual([]);
  });
  it('inherits what billing_ar was granted in a saved matrix that predates the role', async () => {
    // An admin granted AR ticket creation and revoked its product editing
    // before ar_supervisor existed. The supervisor follows AR on both.
    db.permissionConfig.findFirst.mockResolvedValue({ matrix: {
      'tickets:create': ['dispatch', 'field_super', 'billing_ar', 'platform_admin'],
      'products:manage': ['platform_admin'],
    } });
    await loadMatrix();
    expect(roleHasCapability('ar_supervisor', 'tickets:create')).toBe(true);
    expect(roleHasCapability('ar_supervisor', 'products:manage')).toBe(false);
    // Capabilities the saved matrix never mentions still fall back to defaults.
    expect(roleHasCapability('ar_supervisor', 'billing:create_invoice')).toBe(true);
  });
  it('stops inheriting once the saved matrix has seen the role', async () => {
    db.permissionConfig.findFirst.mockResolvedValue({ matrix: {
      'page:billing': ['billing_ar', 'ar_supervisor', 'platform_admin'],
      'tickets:create': ['dispatch', 'billing_ar', 'platform_admin'],
    } });
    await loadMatrix();
    expect(roleHasCapability('billing_ar', 'tickets:create')).toBe(true);
    expect(roleHasCapability('ar_supervisor', 'tickets:create')).toBe(false);
  });
});
