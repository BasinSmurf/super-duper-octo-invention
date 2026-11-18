import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoiceListQuery } from '../../../client/src/lib/invoiceList';
const prisma = vi.hoisted(() => ({ invoice: { findMany: vi.fn(), count: vi.fn() } }));
vi.mock('../db.js', async importOriginal => ({ ...await importOriginal<typeof import('../db.js')>(), ...(() => ({ prisma }))() }));
vi.mock('../services/invoiceQbStatus.js', () => ({ invoiceQbErrors: vi.fn(async () => new Map()) }));
import { invoicesRouter } from './invoices.js';
const fixtures = Array.from({ length: 251 }, (_, i) => ({ id: String(i), invoiceNumber: `INV-SYNTHETIC-${i}`, status: i === 250 ? 'approved' : 'draft', lineItems: [] }));
beforeEach(() => {
  vi.clearAllMocks();
  prisma.invoice.findMany.mockImplementation(async ({ where, take, skip }) => {
    let data = fixtures;
    if (where.status) data = data.filter(i => where.status.in ? where.status.in.includes(i.status) : i.status === where.status);
    if (where.OR) data = data.filter(i => i.invoiceNumber.includes(where.OR[0].invoiceNumber.contains));
    return data.slice(skip, skip + take);
  });
  prisma.invoice.count.mockResolvedValue(251);
});
async function list(url: string) {
  const query = Object.fromEntries(new URL(url, 'http://synthetic.invalid').searchParams);
  const route = invoicesRouter.stack.find(l => l.route?.path === '/' && l.route.methods.get)!.route;
  const res = { json: vi.fn() };
  await route.stack[0].handle({ query }, res);
  return res.json.mock.calls[0][0];
}
describe('billing list beyond the first 200 invoices', () => {
  it('searches an older draft on the server instead of filtering the newest page', async () => {
    const result = await list(invoiceListQuery('drafts', ' INV-SYNTHETIC-249 '));
    expect(result.data.map((i: any) => i.id)).toEqual(['249']);
  });
  it('filters grouped statuses before pagination', async () => {
    const result = await list(invoiceListQuery('approved', ''));
    expect(result.data.map((i: any) => i.id)).toEqual(['250']);
    expect(prisma.invoice.findMany.mock.calls[0][0].where.status).toEqual({ in: ['approved', 'awaiting_signature'] });
  });
  it('keeps queued invoices with sales orders in the QB pipeline', async () => {
    await list(invoiceListQuery('in_qb', ''));
    expect(prisma.invoice.findMany.mock.calls[0][0].where.status).toEqual({ in: ['queued', 'so_created'] });
  });
  it('loads subsequent pages in a stable order', async () => {
    const result = await list(invoiceListQuery('all', '', 200));
    expect(result.data).toHaveLength(51);
    expect(prisma.invoice.findMany.mock.calls[0][0]).toMatchObject({ skip: 200, take: 200, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  });
  it('preserves creator-name search and bounds page size', async () => {
    await list('/invoices?search=SYNTHETIC&limit=100000&offset=-5');
    expect(prisma.invoice.findMany.mock.calls[0][0]).toMatchObject({ take: 200, skip: 0, where: { OR: expect.arrayContaining([{ createdBy: { name: { contains: 'SYNTHETIC', mode: 'insensitive' } } }]) } });
  });
});
