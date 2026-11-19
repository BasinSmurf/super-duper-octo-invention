import type { Prisma } from '../db.js';

// Read the latest add attempt, including retries/successes. Old rejections and
// unrelated reconciliation queries must not leave a stale Error badge.
export async function invoiceQbErrors(
  db: Pick<Prisma.TransactionClient, 'qbSyncQueue'>,
  invoices: Array<{ id: string; status: string }>,
): Promise<Map<string, string>> {
  const ids = invoices.filter(i => i.status === 'queued').map(i => i.id);
  if (!ids.length) return new Map();
  const attempts = await db.qbSyncQueue.findMany({
    where: { entityType: { in: ['invoice', 'sales_order'] }, action: 'add', entityId: { in: ids } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    distinct: ['entityId'],
    select: { entityId: true, status: true, errorMessage: true, errorCode: true },
  });
  return new Map(attempts.filter(a => a.status === 'error').map(a => [
    a.entityId,
    a.errorMessage || (a.errorCode ? `QuickBooks error ${a.errorCode}` : 'QuickBooks export failed. Review the sync log for details.'),
  ]));
}
