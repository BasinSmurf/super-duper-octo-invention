import { AppError } from '../middleware/errorHandler.js';

// Use the saved invoice attribution, not today's location flags. A later
// customer/location edit must not rewrite who historical work was billed for.
export function rebillingReportFilter(query: Record<string, unknown>) {
  const where: any = { status: { not: 'void' }, qbCustomerOverride: { not: null } };
  const dates: { gte?: Date; lt?: Date } = {};
  for (const key of ['from', 'through'] as const) {
    const value = query[key];
    if (value == null || value === '') continue;
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new AppError(400, 'Invalid invoice date');
    const date = new Date(`${value}T00:00:00.000Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new AppError(400, 'Invalid invoice date');
    if (key === 'from') dates.gte = date;
    else { date.setUTCDate(date.getUTCDate() + 1); dates.lt = date; }
  }
  if (dates.gte && dates.lt && dates.gte >= dates.lt) throw new AppError(400, 'From date must not be after through date');
  if (Object.keys(dates).length) where.invoiceDate = dates;
  const search = typeof query.search === 'string' ? query.search.trim() : '';
  if (search) where.OR = ['companyName', 'qbCustomerOverride'].map(field => ({ [field]: { contains: search, mode: 'insensitive' } }));
  return where;
}

type AggregateRow = {
  companyId: string; companyName: string; qbCustomerOverride: string | null;
  _count: { _all: number }; _sum: { total: unknown };
};

export function combineRebillingTotals(posted: AggregateRow[], pending: AggregateRow[]) {
  const groups = new Map<string, {
    companyId: string; customer: string; billedTo: string;
    qbInvoiceCount: number; qbInvoiceTotal: number; pendingCount: number; pendingTotal: number;
  }>();
  for (const [rows, confirmed] of [[posted, true], [pending, false]] as const) {
    for (const row of rows) {
      const key = JSON.stringify([row.companyId, row.qbCustomerOverride]);
      const group = groups.get(key) ?? { companyId: row.companyId, customer: row.companyName,
        billedTo: row.qbCustomerOverride!, qbInvoiceCount: 0, qbInvoiceTotal: 0, pendingCount: 0, pendingTotal: 0 };
      if (confirmed) { group.qbInvoiceCount += row._count._all; group.qbInvoiceTotal += Number(row._sum.total ?? 0); }
      else { group.pendingCount += row._count._all; group.pendingTotal += Number(row._sum.total ?? 0); }
      groups.set(key, group);
    }
  }
  return [...groups.values()].map(group => ({ ...group,
    qbInvoiceTotal: Math.round(group.qbInvoiceTotal * 100) / 100,
    pendingTotal: Math.round(group.pendingTotal * 100) / 100,
  })).sort((a, b) => a.customer.localeCompare(b.customer) || a.billedTo.localeCompare(b.billedTo));
}
