import type { PrismaClient, Prisma } from '../db.js';

/** Two devices/tabs can replay a create concurrently. The unique offline ID
 * chooses one winner; the loser acknowledges that same ticket without running
 * create side-effects again. Unrelated constraint failures remain errors.
 */
export async function createSyncTicket(db: PrismaClient, data: Prisma.ServiceTicketUncheckedCreateInput) {
  try {
    return { ticket: await db.serviceTicket.create({ data }), created: true };
  } catch (error) {
    if (data.offlineId && (error as { code?: string }).code === 'P2002') {
      const ticket = await db.serviceTicket.findFirst({ where: { offlineId: data.offlineId } });
      if (ticket) return { ticket, created: false };
    }
    throw error;
  }
}

/** A child may retry in a later request, after its parent's successful create
 * has left the queue. Resolve the persisted offline identity on every such retry.
 */
export async function resolveSyncTicketId(db: PrismaClient, ticketId: string): Promise<string> {
  const existing = await db.serviceTicket.findUnique({ where: { id: ticketId }, select: { id: true } });
  if (existing) return existing.id;
  const parent = await db.serviceTicket.findFirst({ where: { offlineId: ticketId }, select: { id: true } });
  if (!parent) throw new Error('Parent ticket has not synced yet. Retry after the ticket is saved.');
  return parent.id;
}
