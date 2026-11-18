import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = vi.hoisted(() => ({
  billingDocRef: { findMany: vi.fn(), count: vi.fn() },
  serviceTicket: { findMany: vi.fn(), count: vi.fn(), findUnique: vi.fn() },
  billingDocLineRef: { findMany: vi.fn() },
  billingSubmission: { findMany: vi.fn() },
  billingObservation: { findMany: vi.fn() },
  invoice: { findMany: vi.fn(), groupBy: vi.fn(), count: vi.fn() },
  shopWorkOrderItem: { findMany: vi.fn() },
}));
vi.mock('../db.js', async importOriginal => ({ ...await importOriginal<typeof import('../db.js')>(), ...(() => ({ prisma }))() }));
vi.mock('../middleware/rbac.js', () => ({ requirePermission: () => (_req: unknown, _res: unknown, next: () => void) => next() }));
vi.mock('../services/billingObservations.js', () => ({ recordObservation: vi.fn() }));
vi.mock('../utils/auditLog.js', () => ({ createAuditLog: vi.fn() }));

import { billingRouter } from './billing.js';

async function get(path: string, query: Record<string, string>) {
  const layer = billingRouter.stack.find((entry) => entry.route?.path === path);
  const json = vi.fn();
  const next = vi.fn();
  await layer!.route.stack[0].handle({ query }, { json }, next);
  return { body: json.mock.calls[0]?.[0], error: next.mock.calls[0]?.[0] };
}

beforeEach(() => {
  vi.resetAllMocks();
  prisma.billingDocRef.findMany.mockResolvedValue([]);
  prisma.serviceTicket.findMany.mockResolvedValue([]);
  prisma.billingDocRef.count.mockResolvedValue(0);
  prisma.serviceTicket.count.mockResolvedValue(0);
  prisma.billingDocLineRef.findMany.mockResolvedValue([]);
  prisma.billingSubmission.findMany.mockResolvedValue([]);
  prisma.billingObservation.findMany.mockResolvedValue([]);
  prisma.invoice.findMany.mockResolvedValue([]);
  prisma.invoice.groupBy.mockResolvedValue([]);
  prisma.invoice.count.mockResolvedValue(0);
  prisma.shopWorkOrderItem.findMany.mockResolvedValue([]);
});

describe('rebilling totals and invoice drilldown', () => {
  it('aggregates the entire matching history while paging invoice details', async () => {
    prisma.invoice.groupBy.mockResolvedValueOnce([{ companyId: 'chord', companyName: 'Chord',
      qbCustomerOverride: 'Pale Horse Service Inc', _count: { _all: 301 }, _sum: { total: '115960.25' } }]);
    prisma.invoice.count.mockResolvedValue(351);
    const result = await get('/rebilling', { search: 'Chord', page: '2' });
    expect(result.error).toBeUndefined();
    expect(result.body).toMatchObject({ total: 351, hasMore: true,
      groups: [{ customer: 'Chord', qbInvoiceCount: 301, qbInvoiceTotal: 115960.25, pendingCount: 0 }] });
    expect(prisma.invoice.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 50, skip: 100 }));
    expect(prisma.invoice.groupBy).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: expect.objectContaining({ status: { not: 'void' }, qbCustomerOverride: { not: null }, qbInvoiceTxnId: { not: null } }),
    }));
    expect(prisma.invoice.groupBy).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: expect.objectContaining({ qbInvoiceTxnId: null }),
    }));
    expect(prisma.invoice.groupBy.mock.calls.every(([args]) => args.take === undefined && args.skip === undefined)).toBe(true);
  });
  it('rejects bad pagination and dates without querying invoices', async () => {
    for (const query of [{ page: '-1' }, { page: '1.5' }, { from: '2026-02-30' }]) {
      expect((await get('/rebilling', query)).error).toBeDefined();
    }
    expect(prisma.invoice.groupBy).not.toHaveBeenCalled();
  });
});

describe('billing lineage search', () => {
  it('searches partial identifiers across documents, transactions, submissions and tickets together', async () => {
    const documents = [{ id: 'd1', docNumber: 'INV-2026-00001' }];
    const tickets = [{ id: 't1', ticketNumber: 'FS-2026-00002' }];
    prisma.billingDocRef.findMany.mockResolvedValue(documents);
    prisma.serviceTicket.findMany.mockResolvedValue(tickets);
    prisma.billingDocRef.count.mockResolvedValue(1);
    prisma.serviceTicket.count.mockResolvedValue(1);
    const result = await get('/lineage/search', { q: ' 2026-0 ' });
    expect(result.error).toBeUndefined();
    expect(result.body).toEqual({ documents, tickets, total: 2, hasMore: false });
    const contains = { contains: '2026-0', mode: 'insensitive' };
    expect(prisma.billingDocRef.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { OR: [{ docNumber: contains }, { qbTxnId: contains }, { submissions: { some: { externalRef: contains } } }] },
    }));
    expect(prisma.serviceTicket.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { ticketNumber: contains } }));
  });

  it('keeps broad matches accessible beyond the first page', async () => {
    prisma.serviceTicket.count.mockResolvedValue(301);
    const result = await get('/lineage/search', { q: '2026-0', page: '2' });
    expect(result.body).toMatchObject({ total: 301, hasMore: true });
    expect(prisma.serviceTicket.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 200, take: 100 }));
    expect((await get('/lineage/search', { q: '2026-0', page: '3' })).body.hasMore).toBe(false);
  });

  it('rejects blank searches and invalid pages', async () => {
    for (const query of [{ q: ' ' }, { q: '2026', page: '-1' }, { q: '2026', page: '1.5' }]) {
      expect((await get('/lineage/search', query)).error).toBeDefined();
    }
    expect(prisma.billingDocRef.findMany).not.toHaveBeenCalled();
  });

  it('returns an empty result list for an unmatched identifier', async () => {
    expect((await get('/lineage/search', { q: 'missing' })).body)
      .toEqual({ documents: [], tickets: [], total: 0, hasMore: false });
  });

  it('opens the selected document by ID instead of reinterpreting the broad query', async () => {
    prisma.billingDocRef.findMany.mockResolvedValueOnce([{ id: 'd1' }]);
    const result = await get('/lineage', { q: '2026-0', docRefId: 'd1' });
    expect(result.error).toBeUndefined();
    expect(prisma.billingDocRef.findMany).toHaveBeenNthCalledWith(1, { where: { id: 'd1' }, select: { id: true } });
    expect(prisma.serviceTicket.findUnique).not.toHaveBeenCalled();
  });

  it('opens a selected unbilled ticket without resolving a colliding document number', async () => {
    prisma.serviceTicket.findUnique.mockResolvedValue({ id: 't1' });
    prisma.serviceTicket.findMany.mockResolvedValue([{ id: 't1', ticketNumber: 'SW-2026-00001', companyId: 'c1', offlineId: null }]);
    const result = await get('/lineage', { q: '2026-0', ticketId: 't1' });
    expect(result.error).toBeUndefined();
    expect(result.body).toMatchObject({ resolvedVia: 'ticket_number', docRefs: [], lines: [],
      tickets: [{ ticketId: 't1', ticketNumber: 'SW-2026-00001' }] });
    expect(prisma.serviceTicket.findUnique).toHaveBeenCalledWith({ where: { id: 't1' }, select: { id: true } });
    expect(prisma.billingDocRef.findMany.mock.calls.every(([args]) => 'id' in args.where)).toBe(true);
  });

  it('returns every associated ticket once with its current serial for downloading', async () => {
    const tickets = Array.from({ length: 10 }, (_, i) => ({ id: `t${i}`,
      ticketNumber: `SW-2026-${String(i + 1).padStart(5, '0')}`, companyId: 'c1', offlineId: null }));
    prisma.billingDocRef.findMany.mockResolvedValueOnce([{ id: 'd1' }]);
    prisma.billingDocLineRef.findMany.mockResolvedValue([
      ...tickets.map(t => ({ id: `line-${t.id}`, ticketId: t.id })),
      { id: 'repeat-line', ticketId: tickets[0].id },
    ]);
    prisma.serviceTicket.findMany.mockResolvedValue(tickets);
    const result = await get('/lineage', { q: 'INV-1', docRefId: 'd1' });
    expect(result.error).toBeUndefined();
    expect(result.body.tickets).toEqual(tickets.map(t => ({ ticketId: t.id, ticketNumber: t.ticketNumber })));
    expect(prisma.serviceTicket.findMany).toHaveBeenCalledWith({
      where: { id: { in: tickets.map(t => t.id) } },
      select: { id: true, ticketNumber: true, offlineId: true, companyId: true },
    });
  });
});
