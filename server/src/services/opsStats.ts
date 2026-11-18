/**
 * Activity Summary: closed tickets by service date and QB-accepted invoice
 * value by invoice date. dollarsBilled retains its API name for compatibility;
 * drafts, approvals and queued exports without a QB transaction ID are excluded.
 * The daily operations report separately presents mutually exclusive stages.
 */
import type { PrismaClient } from '../db.js';

export type PeriodKey = 'today' | 'week' | 'month';

export interface PeriodActivity {
  from: string; // ISO date (yyyy-mm-dd), inclusive
  to: string; // ISO date (yyyy-mm-dd), inclusive
  ticketsClosed: number;
  dollarsBilled: number;
}

/**
 * Resolve a named period to a concrete { from, to } date pair (both at local
 * midnight, `to` inclusive). "week" is calendar Sun-Sat, matching the ticket
 * Today/This Week tabs (#58) so the numbers here never disagree with what a
 * user sees by clicking into the ticket list.
 */
export function resolvePeriod(period: PeriodKey, now: Date = new Date()): { from: Date; to: Date } {
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (period === 'today') return { from: to, to };
  if (period === 'week') {
    const from = new Date(to);
    from.setDate(from.getDate() - from.getDay());
    return { from, to };
  }
  const from = new Date(now.getFullYear(), now.getMonth(), 1);
  return { from, to };
}

/**
 * Count tickets closed and dollars billed in [from, to] inclusive. Upper
 * bound is applied as an EXCLUSIVE `to + 1 day` — the same convention the
 * ticket list's dateFrom/dateTo uses (#58 fixed an off-by-one from comparing
 * a date-only `to` with `lte` against UTC midnight, silently dropping
 * same-day records).
 */
export async function getPeriodActivity(
  prisma: PrismaClient,
  from: Date,
  to: Date,
): Promise<PeriodActivity> {
  const toExclusive = new Date(to);
  toExclusive.setDate(toExclusive.getDate() + 1);

  const [ticketsClosed, billed] = await Promise.all([
    prisma.serviceTicket.count({
      where: { status: 'closed', serviceDate: { gte: from, lt: toExclusive } },
    }),
    prisma.invoice.aggregate({
      where: { status: { not: 'void' }, OR: [{ qbSalesOrderTxnId: { not: null } }, { qbInvoiceTxnId: { not: null } }], invoiceDate: { gte: from, lt: toExclusive } },
      _sum: { total: true },
    }),
  ]);

  return {
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
    ticketsClosed,
    dollarsBilled: Number(billed._sum.total ?? 0),
  };
}
