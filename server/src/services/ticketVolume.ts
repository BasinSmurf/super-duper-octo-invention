import type { PrismaClient } from '../db.js';

const DAY = 86_400_000;

/** Thirty business-calendar service dates, including zero-ticket days. */
export async function getTicketVolume(db: PrismaClient, through: Date) {
  const end = new Date(`${through.toISOString().slice(0, 10)}T00:00:00.000Z`);
  const start = new Date(+end - 29 * DAY);
  const grouped = await db.serviceTicket.groupBy({
    by: ['serviceDate'],
    where: { serviceDate: { gte: start, lt: new Date(+end + DAY) }, status: { notIn: ['draft', 'void'] } },
    _count: { id: true },
  });
  const counts = new Map(grouped.map(row => [row.serviceDate.toISOString().slice(0, 10), row._count.id]));
  const days = Array.from({ length: 30 }, (_, offset) => {
    const date = new Date(+start + offset * DAY).toISOString().slice(0, 10);
    return { date, count: counts.get(date) ?? 0 };
  });
  return { from: days[0].date, to: days[29].date, total: days.reduce((sum, day) => sum + day.count, 0), days };
}
