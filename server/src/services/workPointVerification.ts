import { AppError } from '../middleware/errorHandler.js';
import type { Prisma } from '../db.js';

export function validateExpiryDays(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 36500) {
    throw new AppError(400, 'Expiry must be a whole number of days from 0 to 36500');
  }
  return value;
}

export function isVerificationCurrent(verified: boolean, dateVerified: Date | null, expiryDays: number, now = Date.now()) {
  return verified && !!dateVerified && (expiryDays === 0 || now < dateVerified.getTime() + expiryDays * 86400000);
}

export function verificationUpdate(value: any) {
  if (!value || typeof value.verified !== 'boolean' || typeof value.changedAt !== 'string') {
    throw new AppError(400, 'Verification requires a checkbox value and date');
  }
  const changedAt = new Date(value.changedAt);
  if (!Number.isFinite(changedAt.getTime()) || changedAt.getTime() > Date.now() + 300000) {
    throw new AppError(400, 'Invalid verification date');
  }
  return { verified: value.verified, dateVerified: value.verified ? changedAt : null, verificationChangedAt: changedAt };
}

export function workPointIdentityChanged(before: any, updates: any) {
  const identity = (point: any) => ({
    name: point.name, workPointType: point.workPointType,
    reelSerialNumber: point.reelSerialNumber ?? null, standSerialNumber: point.standSerialNumber ?? null,
    airSystemType: point.airSystemType ?? null,
    cylinders: (point.customData?.cylinders || point.customData?.bottles || []).map((c: any) => ({
      serialNumber: c.serialNumber || '', hydroDate: c.hydroDate?.slice(0, 10) || null,
      expiryDate: c.expiryDate?.slice(0, 10) || null, isActive: c.isActive ?? true,
    })),
  });
  return JSON.stringify(identity(before)) !== JSON.stringify(identity({ ...before, ...updates }));
}

// An explicit action is required: saving an old inspection must not re-verify
// a work point or overwrite a more recent check from another device.
export async function applyWorkPointVerification(tx: Prisma.TransactionClient, workPointId: string, value: unknown, userId: string, snapshot?: any) {
  const data = verificationUpdate(value);
  const point = await tx.workPoint.findUnique({ where: { id: workPointId } });
  if (!point || !point.isActive) throw new AppError(400, 'Select an active work point');
  const customData = (point.customData as any) || {};
  const cylinders = Array.isArray(snapshot?.cylinders) ? snapshot.cylinders.map((c: any) => {
    const serialNumber = c.replaced ? c.replacedNewSerial : c.serialNumber;
    const original = (customData.cylinders || customData.bottles || []).find((known: any) => known.serialNumber === serialNumber);
    return {
      ...original, serialNumber,
      hydroDate: (c.replaced ? c.replacedNewHydroDate : c.hydroDate) || null,
      expiryDate: (c.replaced ? c.replacedNewExpiryDate : c.expiryDate) || null,
      isActive: true,
    };
  }) : null;
  const serialData = data.verified && snapshot ? {
    reelSerialNumber: snapshot.reelSerialNumber ?? point.reelSerialNumber,
    standSerialNumber: snapshot.standSerialNumber ?? point.standSerialNumber,
    ...(cylinders ? { customData: { ...customData, cylinders, ...(customData.bottles ? { bottles: cylinders } : {}) } } : {}),
  } : {};
  const result = await tx.workPoint.updateMany({
    where: { id: workPointId, OR: [{ verificationChangedAt: null }, { verificationChangedAt: { lt: data.verificationChangedAt } }] },
    data: { ...data, ...serialData },
  });
  if (result.count) await tx.auditLog.create({ data: {
    userId, entityType: 'WorkPoint', entityId: workPointId, action: 'update',
    changes: { verified: data.verified, dateVerified: data.dateVerified?.toISOString() ?? null },
  } });
  return data;
}
