import { prisma } from '../db.js';
import type { AuditAction } from '../db.js';
import { Prisma } from '../db.js';

export async function createAuditLog(params: {
  userId?: string;
  entityType: string;
  entityId: string;
  action: AuditAction;
  changes?: Prisma.InputJsonValue;
  ipAddress?: string;
}) {
  return prisma.auditLog.create({
    data: {
      userId: params.userId,
      entityType: params.entityType,
      entityId: params.entityId,
      action: params.action,
      changes: params.changes ?? Prisma.JsonNull,
      ipAddress: params.ipAddress,
    },
  });
}
