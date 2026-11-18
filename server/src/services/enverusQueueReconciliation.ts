import type { prisma as database } from '../db.js';

interface Attempt {
  id: string;
  entityId: string;
  entityType: string;
  target: string;
  action: string;
  endpointUrl: string | null;
  status: string;
  createdAt: Date;
  respondedAt: Date | null;
  submittedAt: Date | null;
  responseStatusCode: number | null;
  enverusItemId: string | null;
}

/** A successful submit resolves only older technical failures for the same operation. */
export function supersedesFailure(failure: Attempt, success: Attempt): boolean {
  return failure.status === 'error' && failure.action === 'submit' && success.action === 'submit' &&
    failure.id !== success.id && failure.entityId === success.entityId && failure.entityType === success.entityType &&
    failure.target === success.target && failure.endpointUrl === success.endpointUrl &&
    ['submitted', 'accepted'].includes(success.status) && !!success.enverusItemId?.trim() &&
    success.responseStatusCode !== null && success.responseStatusCode >= 200 && success.responseStatusCode < 300 &&
    success.createdAt > failure.createdAt && !!success.submittedAt &&
    success.submittedAt >= (failure.respondedAt || failure.createdAt);
}

type Database = Pick<typeof database, 'enverusSyncQueue' | '$transaction'>;

/** Preserve the original response/error and link each recovered attempt to its successful replacement. */
export async function reconcileEnverusFailures(db: Database): Promise<number> {
  const failures = await db.enverusSyncQueue.findMany({ where: { status: 'error', action: 'submit' } });
  if (!failures.length) return 0;
  const successes = await db.enverusSyncQueue.findMany({ where: {
    entityId: { in: [...new Set(failures.map(entry => entry.entityId))] }, action: 'submit',
    status: { in: ['submitted', 'accepted'] }, responseStatusCode: { gte: 200, lt: 300 },
    enverusItemId: { not: null },
  }, orderBy: { submittedAt: 'desc' } });
  let recovered = 0;
  for (const failure of failures) {
    const success = successes.find(entry => supersedesFailure(failure, entry));
    if (!success) continue;
    recovered += await db.$transaction(async tx => {
      const updated = await tx.enverusSyncQueue.updateMany({ where: { id: failure.id, status: 'error', respondedAt: failure.respondedAt }, data: {
        status: 'superseded', supersededAt: new Date(), supersededById: success.id,
      } });
      if (!updated.count) return 0;
      await tx.auditLog.create({ data: {
        userId: null, entityType: 'enverus_queue', entityId: failure.id, action: 'update',
        changes: { action: 'recovered_by_later_submission', previousStatus: 'error', status: 'superseded',
          supersededById: success.id, enverusItemId: success.enverusItemId },
      } });
      return 1;
    });
  }
  return recovered;
}
