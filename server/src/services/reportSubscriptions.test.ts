import { describe, expect, it, vi } from 'vitest';
vi.mock('../db.js', () => ({ prisma: {} }));
import { canReceiveReport, saveReportPreference, validateReportPreference, reportPreferences, selectReport } from './reportSubscriptions.js';

describe('report subscriptions', () => {
  it('defaults to opt-out and enforces recipient capabilities', () => {
    expect(reportPreferences({ default: { cadence: 'daily' } })).toEqual({});
    expect(canReceiveReport('field_tech', 'billing')).toBe(false);
    expect(canReceiveReport('customer', 'operations')).toBe(false);
    expect(canReceiveReport('field_super', 'operations')).toBe(true);
    expect(canReceiveReport('field_super', 'billing')).toBe(false);
    expect(() => validateReportPreference('unknown', 'daily')).toThrow();
    expect(() => validateReportPreference('operations', 'immediate')).toThrow();
  });
  it('rejects assigning forbidden reports and permits unsubscribing inactive users', async () => {
    const db = { user: { findUnique: vi.fn().mockResolvedValue({ role: 'field_tech', isActive: false }) }, $executeRaw: vi.fn() };
    await expect(saveReportPreference(db as any, 'synthetic', 'admin', 'billing', 'daily')).rejects.toThrow();
    expect(db.$executeRaw).not.toHaveBeenCalled();
    await saveReportPreference(db as any, 'synthetic', 'admin', 'billing', 'off');
    expect(db.$executeRaw).toHaveBeenCalledOnce();
  });
  it('omits financial totals from operational reports and limits training to training records', () => {
    const report = { amounts: { paid: 20 }, jobs: [], coverage: [], exceptions: [{ href: '/billing/1' }, { href: '/tickets/1', category: 'training' }, { href: '/shop/1' }] } as any;
    expect(selectReport(report, 'operations').amounts).toEqual({});
    expect(selectReport(report, 'operations').exceptions).toHaveLength(2);
    expect(selectReport(report, 'training').exceptions).toEqual([{ href: '/tickets/1', category: 'training' }]);
  });
});
