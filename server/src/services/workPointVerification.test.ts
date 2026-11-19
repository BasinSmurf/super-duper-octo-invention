import { describe, expect, it, vi } from 'vitest';
import { applyWorkPointVerification, isVerificationCurrent, validateExpiryDays, verificationUpdate, workPointIdentityChanged } from './workPointVerification.js';

describe('work point verification', () => {
  const date = new Date('2025-01-01T00:00:00Z');
  it('defaults to a permanent verification and requires an actual check date', () => {
    expect(isVerificationCurrent(true, date, 0, Date.UTC(2035, 0, 1))).toBe(true);
    expect(isVerificationCurrent(false, date, 0)).toBe(false);
    expect(isVerificationCurrent(true, null, 0)).toBe(false);
  });
  it('expires exactly at the configured interval and can be re-enabled by setting zero', () => {
    const expires = date.getTime() + 365 * 86400000;
    expect(isVerificationCurrent(true, date, 365, expires - 1)).toBe(true);
    expect(isVerificationCurrent(true, date, 365, expires)).toBe(false);
    expect(isVerificationCurrent(true, date, 0, expires)).toBe(true);
  });
  it.each([-1, 1.5, '365', null, 36501, NaN])('rejects invalid expiry %s', value => {
    expect(() => validateExpiryDays(value)).toThrow();
  });
  it('accepts never expire and whole-day policies', () => {
    expect(validateExpiryDays(0)).toBe(0);
    expect(validateExpiryDays(365)).toBe(365);
  });
  it('keeps verification for notes, metadata, and normalized legacy cylinders', () => {
    const before = { name: 'System', customData: { bottles: [{ serialNumber: 'C1', hydroDate: '2025-01-01T00:00:00Z' }], notes: 'Old' } };
    expect(workPointIdentityChanged(before, { customData: { cylinders: [{ serialNumber: 'C1', hydroDate: '2025-01-01', isActive: true }], notes: 'New' } })).toBe(false);
    expect(workPointIdentityChanged(before, { customData: { cylinders: [{ serialNumber: 'C1', hydroDate: '2026-01-01' }] } })).toBe(true);
    expect(workPointIdentityChanged(before, { name: 'New name' })).toBe(true);
  });
  it('stores a boolean and check date, and clears the date when unchecked', () => {
    expect(verificationUpdate({ verified: true, changedAt: date.toISOString() })).toEqual({ verified: true, dateVerified: date, verificationChangedAt: date });
    expect(verificationUpdate({ verified: false, changedAt: date.toISOString() }).dateVerified).toBeNull();
  });
  it.each([{ verified: 'true', changedAt: date.toISOString() }, { verified: true, changedAt: 'invalid' }, { verified: true, changedAt: '2099-01-01' }, {}])('rejects malformed verification', value => {
    expect(() => verificationUpdate(value)).toThrow();
  });
  function transaction(count = 1) {
    return {
      workPoint: { findUnique: vi.fn().mockResolvedValue({ isActive: true, customData: { source: 'imported', notes: 'Keep this' }, reelSerialNumber: 'R1' }), updateMany: vi.fn().mockResolvedValue({ count }) },
      auditLog: { create: vi.fn() },
    };
  }
  it('protects newer checks against old offline mutations and audits successful changes', async () => {
    const tx = transaction();
    await applyWorkPointVerification(tx as any, 'wp1', { verified: true, changedAt: date.toISOString() }, 'user1');
    expect(tx.workPoint.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: {
      id: 'wp1', OR: [{ verificationChangedAt: null }, { verificationChangedAt: { lt: date } }],
    } }));
    expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ userId: 'user1', changes: { verified: true, dateVerified: date.toISOString() } }) }));
    const stale = transaction(0);
    await applyWorkPointVerification(stale as any, 'wp1', { verified: true, changedAt: date.toISOString() }, 'user1');
    expect(stale.auditLog.create).not.toHaveBeenCalled();
  });
  it('saves verified serials and replacement hydros for the next visit, preserving other data', async () => {
    const tx = transaction();
    await applyWorkPointVerification(tx as any, 'wp1', { verified: true, changedAt: date.toISOString() }, 'user1', {
      reelSerialNumber: 'R2', cylinders: [{ serialNumber: 'OLD', replaced: true, replacedNewSerial: 'NEW', replacedNewHydroDate: '2025-02-01' }],
    });
    expect(tx.workPoint.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ reelSerialNumber: 'R2', customData: {
      source: 'imported', notes: 'Keep this', cylinders: [{ serialNumber: 'NEW', hydroDate: '2025-02-01', expiryDate: null, isActive: true }],
    } }) }));
  });
  it('does not replace cylinder data when removing verification', async () => {
    const tx = transaction();
    await applyWorkPointVerification(tx as any, 'wp1', { verified: false, changedAt: date.toISOString() }, 'user1', { cylinders: [] });
    expect(tx.workPoint.updateMany.mock.calls[0][0].data).not.toHaveProperty('customData');
  });
  it('rejects missing or inactive work points', async () => {
    const tx = transaction();
    tx.workPoint.findUnique.mockResolvedValue(null);
    await expect(applyWorkPointVerification(tx as any, 'wp1', { verified: true, changedAt: date.toISOString() }, 'user1')).rejects.toThrow('Select an active work point');
    expect(tx.workPoint.updateMany).not.toHaveBeenCalled();
  });
});
