import 'express-async-errors';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { encodeCursor } from './respond.js';

const mocks = vi.hoisted(() => {
  const list = () => ({ findMany: vi.fn(), findUnique: vi.fn() });
  return {
    verifyApiKey: vi.fn(),
    db: {
      serviceTicket: list(), invoice: list(), serializedEquipment: list(), equipmentInspection: list(),
      rentalAgreement: list(), rentalDailyLog: list(), field: list(), pad: list(), well: list(),
      facility: list(), company: list(), blueLionSyncQueue: list(),
    },
  };
});
vi.mock('../db.js', () => ({ prisma: mocks.db }));
vi.mock('./apiKeyStore.js', () => ({ verifyApiKey: mocks.verifyApiKey }));
vi.mock('../services/invoicePdfGenerator.js', () => ({ generateInvoicePdf: vi.fn() }));
vi.mock('../services/blueLionEnqueue.js', () => ({ enqueueTrainingRosterForTicket: vi.fn() }));
vi.mock('../services/eventBus.js', () => ({ emitEvent: vi.fn() }));
import { v1Router } from './index.js';

let server: Server;
let url: string;
beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const app = express();
  app.use('/api/v1', v1Router);
  server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  vi.restoreAllMocks();
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.verifyApiKey.mockResolvedValue({ id: 'query-test-key', scopes: ['*'] });
  for (const delegate of Object.values(mocks.db)) {
    delegate.findMany.mockResolvedValue([]);
    delegate.findUnique.mockResolvedValue({ id: 'rental' });
  }
});
const get = (path: string, token = 'sp_query-test') => fetch(`${url}${path}`, {
  headers: token ? { Authorization: `Bearer ${token}` } : {},
});

it.each([
  ['/tickets?status=unknown', 'status'],
  ['/invoices?status=unknown', 'status'],
  ['/trainings?status=unknown', 'status'],
  ['/companies?companyType=unknown', 'companyType'],
  ['/tickets?ticketType=shop_service', 'ticketType'],
  ['/tickets?ticketType=direct_sale', 'ticketType'],
  ['/bluelion/queue?status=ambiguous', 'status'],
  ['/equipment?ownership=unknown', 'ownership'],
  ['/equipment-inspections?outcome=unknown', 'outcome'],
  ['/rentals?status=unknown', 'status'],
  ['/facilities?facilityType=unknown', 'facilityType'],
  ['/fields?isActive=yes', 'isActive'],
  ['/pads?isActive=1', 'isActive'],
  ['/companies?isActive=False', 'isActive'],
  ['/fields?isActive=', 'isActive'],
  ['/tickets?status=draft&status=closed', 'status'],
  ['/invoices?companyId[a]=b', 'companyId'],
  ['/equipment?serialNumber=a&serialNumber=b', 'serialNumber'],
  ['/wells?operatorId=', 'operatorId'],
  ['/rentals/rental/daily-logs?from=invalid', 'from'],
  ['/rentals/rental/daily-logs?to=2026-02-30', 'to'],
  ['/rentals/rental/daily-logs?from=2026-10-02&to=2026-10-01', 'to'],
  ['/tickets?updatedSince=2026-02-30T12:00:00Z', 'updatedSince'],
  ['/tickets?updatedSince=2026-01-01', 'updatedSince'],
  ['/tickets?updatedSince=2026-01-01T12:00:00', 'updatedSince'],
  ['/tickets?updatedSince=2026-01-01T24:00:00Z', 'updatedSince'],
  ['/tickets?updatedSince=2026-01-01T12:00:00%2B24:00', 'updatedSince'],
  ['/tickets?updatedSince[a]=b', 'updatedSince'],
  ['/tickets?limit=10junk', 'limit'],
  ['/tickets?limit=1.5', 'limit'],
  ['/tickets?limit=1e2', 'limit'],
  ['/tickets?limit=-1', 'limit'],
  ['/tickets?limit=0', 'limit'],
  ['/tickets?limit=201', 'limit'],
  ['/tickets?limit=9007199254740993', 'limit'],
  ['/tickets?limit=5&limit=10', 'limit'],
  ['/tickets?cursor=a&cursor=b', 'cursor'],
  ['/tickets?cursor=', 'cursor'],
  ['/bluelion/queue?limit=501', 'limit'],
  ['/rentals/rental/daily-logs?limit=invalid', 'limit'],
])('rejects malformed filters before querying the DB: %s', async (path, param) => {
  const response = await get(path);
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: { code: 'invalid_parameter', details: { param } } });
  for (const delegate of Object.values(mocks.db)) {
    expect(delegate.findMany).not.toHaveBeenCalled();
    expect(delegate.findUnique).not.toHaveBeenCalled();
  }
});

it('authenticates before disclosing query errors and enforces scopes', async () => {
  expect((await get('/tickets?status=unknown', '')).status).toBe(401);
  mocks.verifyApiKey.mockResolvedValue({ id: 'limited', scopes: ['companies:read'] });
  expect((await get('/tickets?status=unknown')).status).toBe(403);
  expect(mocks.db.serviceTicket.findMany).not.toHaveBeenCalled();
});

it.each(['sale', 'inspection'])('supports the real ticket type %s', async ticketType => {
  const response = await get(`/tickets?ticketType=${ticketType}&status=void`);
  expect(response.status).toBe(200);
  expect(mocks.db.serviceTicket.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { ticketType, status: 'void' } }));
});

it('supports retrying BlueLion rows and the queue-specific limit', async () => {
  expect((await get('/bluelion/queue?status=retrying&limit=500')).status).toBe(200);
  expect(mocks.db.blueLionSyncQueue.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { status: 'retrying' }, take: 500 }));
  expect((await get('/bluelion/queue')).status).toBe(200);
  expect(mocks.db.blueLionSyncQueue.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ take: 200 }));
});

it('keeps false filters, offset timestamps and requested page size', async () => {
  const since = '2026-11-16T12:30:00.123-06:00';
  expect((await get(`/companies?isActive=false&companyType=parent_only&updatedSince=${encodeURIComponent(since)}&limit=200`)).status).toBe(200);
  expect(mocks.db.company.findMany).toHaveBeenCalledWith(expect.objectContaining({
    where: { isActive: false, companyType: 'parent_only', updatedAt: { gte: new Date(since) } }, take: 201,
  }));
});

it('allows real leap days and includes both daily-log date boundaries', async () => {
  expect((await get('/rentals/rental/daily-logs?from=2028-02-29&to=2028-02-29')).status).toBe(200);
  expect(mocks.db.rentalDailyLog.findMany).toHaveBeenCalledWith(expect.objectContaining({
    where: { rentalAgreementId: 'rental', logDate: { gte: new Date('2028-02-29'), lte: new Date('2028-02-29') } },
  }));
});

it('preserves pagination, returns a usable next cursor, and rejects invalid cursors', async () => {
  const newer = { id: 'newer', updatedAt: new Date('2026-11-16T12:00:00Z') };
  const older = { id: 'older', updatedAt: new Date('2026-11-15T12:00:00Z') };
  mocks.db.company.findMany.mockResolvedValueOnce([newer, older]);
  const response = await get('/companies?limit=1');
  expect(response.status).toBe(200);
  const first = await response.json();
  expect(first.page).toEqual({ hasMore: true, nextCursor: encodeCursor(newer) });
  expect(first.data).toHaveLength(1);
  expect((await get(`/companies?limit=1&cursor=${first.page.nextCursor}`)).status).toBe(200);
  expect(mocks.db.company.findMany).toHaveBeenLastCalledWith(expect.objectContaining({
    where: { AND: [{}, { OR: [{ updatedAt: { lt: newer.updatedAt } }, { AND: [{ updatedAt: newer.updatedAt }, { id: { lt: 'newer' } }] }] }] },
  }));
  const invalid = await get('/companies?cursor=not-a-cursor');
  expect(invalid.status).toBe(400);
  expect(await invalid.json()).toMatchObject({ error: { code: 'bad_cursor' } });
});

it.each(['/tickets', '/invoices', '/equipment', '/equipment-inspections', '/rentals', '/rentals/rental/daily-logs', '/fields', '/pads', '/wells', '/facilities', '/companies', '/trainings'])(
  'keeps default list pagination working: %s', async path => {
    const response = await get(path);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: [], page: { hasMore: false, nextCursor: null } });
  },
);
