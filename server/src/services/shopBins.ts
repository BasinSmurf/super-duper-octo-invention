import type { Prisma } from '../db.js';
import { AppError } from '../middleware/errorHandler.js';

export function binLocationOf(customData: unknown): string | null {
  if (customData && typeof customData === 'object' && !Array.isArray(customData)) {
    const value = (customData as Record<string, unknown>).binLocation;
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

// Bins belong to jobs, not individual units. Hold each bin's lock until the
// assignment commits so concurrent intake cannot put two jobs in one bin.
export async function assertShopBinsAvailable(
  tx: Prisma.TransactionClient,
  items: Array<{ equipmentCategory?: string; customData?: unknown }>,
  workOrderId?: string,
) {
  const bins = [...new Set(items.filter(i => i.equipmentCategory === 'personal_monitor')
    .map(i => binLocationOf(i.customData)).filter((b): b is string => !!b))].sort();
  if (!bins.length) return;
  for (const bin of bins) {
    await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', `shop-bin:${bin}`);
  }
  const occupied = await tx.shopWorkOrderItem.findMany({
    where: {
      equipmentCategory: 'personal_monitor',
      status: { notIn: ['returned', 'condemned'] },
      ...(workOrderId ? { workOrderId: { not: workOrderId } } : {}),
    },
    select: { customData: true, workOrder: { select: { workOrderNumber: true } } },
  });
  for (const item of occupied) {
    const bin = binLocationOf(item.customData);
    if (bin && bins.includes(bin)) {
      throw new AppError(409, `${bin} is already assigned on WO ${item.workOrder.workOrderNumber} — choose a bin belonging to this job or an available bin.`);
    }
  }
}
