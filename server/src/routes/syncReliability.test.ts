import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = vi.hoisted(() => {
  const child = () => ({ findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), deleteMany: vi.fn() });
  return {
    $transaction: vi.fn(),
    product: { findMany: vi.fn() },
    serviceTicket: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
    invoiceLineItem: { findFirst: vi.fn() },
    rentalAgreement: { update: vi.fn() },
    ticketAttachment: child(), fitTestRecord: child(), airSystemInspection: child(), ihTestRecord: child(),
    gasDetectionRecord: child(), trainingRosterRecord: child(),
  };
});
vi.mock('../db.js', async importOriginal => ({ ...await importOriginal<typeof import('../db.js')>(), ...(() => ({ prisma }))() }));
vi.mock('../services/fileStore.js', () => ({
  getFileStore: () => ({ write: vi.fn() }),
  ticketKey: (ticketId: string, fileName: string) => `${ticketId}/${fileName}`,
}));
vi.mock('../services/rentalLifecycle.js', () => ({
  withRental: async (id: string, fn: any) => fn(prisma, { id, status: 'active', startDate: new Date('2026-06-15') }),
  closeRental: vi.fn(), deployRentalItem: vi.fn(), returnRentalItem: vi.fn(),
}));
import { syncRouter } from './sync.js';
import { closeRental } from '../services/rentalLifecycle.js';

async function push(mutations: unknown[], role = 'field_tech') {
  const route = syncRouter.stack.find(layer => layer.route?.path === '/push')!.route;
  const res = { json: vi.fn() }, next = vi.fn();
  await route.stack.at(-1).handle({ body: { mutations }, user: { userId: 'tech', role } }, res, next);
  expect(next).not.toHaveBeenCalled();
  return res.json.mock.calls[0][0].results;
}

beforeEach(() => {
  vi.resetAllMocks();
  prisma.$transaction.mockImplementation((fn: any) => fn(prisma));
  prisma.serviceTicket.findUnique.mockImplementation(async ({ where }: any) => where.id === 'server-parent' ? { id: 'server-parent', status: 'supervisor_review', assignedTechId: 'tech' } : null);
  prisma.serviceTicket.findFirst.mockResolvedValue({ id: 'server-parent' });
  for (const [key, value] of Object.entries(prisma)) {
    if ('create' in value) (value as typeof prisma.fitTestRecord).create.mockResolvedValue({ id: 'child' });
  }
});

describe('persisted offline ticket identity at the sync boundary', () => {
  it('includes the complete product ID set in delta pulls so replaced catalog rows can be pruned', async () => {
    prisma.product.findMany.mockImplementation(async ({ where }: any) => where ? [] : [{ id: 'current-product' }]);
    const route = syncRouter.stack.find(layer => layer.route?.path === '/pull')!.route;
    const res = { json: vi.fn() }, next = vi.fn();
    await route.stack.at(-1).handle({ query: { tables: 'products', since: '2026-10-27T00:00:00Z' }, user: { userId: 'tech', role: 'field_tech' } }, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.json.mock.calls[0][0].tables.products).toEqual({ data: [], count: 0, allIds: ['current-product'] });
  });
  it('recovers a legacy photo collision and acknowledges a lost-response retry without changing the other ticket', async () => {
    const rows = new Map<string, any>([['photo_1', { id: 'photo_1', ticketId: 'other-ticket' }]]);
    prisma.ticketAttachment.findUnique.mockImplementation(async ({ where }: any) => rows.get(where.id) ?? null);
    prisma.ticketAttachment.create.mockImplementation(async ({ data }: any) => { rows.set(data.id, data); return data; });
    const mutation = { queueId: 162, table: 'ticketAttachments', action: 'create', entityId: 'photo_1', payload: {
      id: 'photo_1', ticketId: 'server-parent', fileName: 'photo_1.jpg', fileType: 'photo', dataUrl: 'data:image/jpeg;base64,aGVsbG8=',
    } };
    const first = (await push([structuredClone(mutation)]))[0];
    expect(first.status).toBe('ok');
    expect(first.serverId).not.toBe('photo_1');
    expect(rows.get(first.serverId)).toMatchObject({ ticketId: 'server-parent', filePath: `tickets/server-parent/${first.serverId}/photo_1.jpg`, fileSizeBytes: 5 });
    expect((await push([structuredClone(mutation)]))[0]).toMatchObject({ status: 'ok', serverId: first.serverId });
    expect(prisma.ticketAttachment.create).toHaveBeenCalledTimes(1);
    expect(rows.get('photo_1')).toEqual({ id: 'photo_1', ticketId: 'other-ticket' });
  });
  it('stores same-name result reports and calibration certificates independently and retries without duplicates', async () => {
    const rows = new Map<string, any>();
    prisma.ticketAttachment.findUnique.mockImplementation(async ({ where }: any) => rows.get(where.id) ?? null);
    prisma.ticketAttachment.create.mockImplementation(async ({ data }: any) => { rows.set(data.id, data); return data; });
    const mutations = ['fit_test_report', 'fit_test_report', 'calibration_cert'].map((fileType, index) => ({
      queueId: index + 1, table: 'ticketAttachments', action: 'create', entityId: `capture-${index}`, payload: {
        ticketId: 'server-parent', fileName: 'results.pdf', fileType, dataUrl: `data:application/pdf;base64,${Buffer.from(`report-${index}`).toString('base64')}`,
      },
    }));
    expect((await push(structuredClone(mutations))).every((r: any) => r.status === 'ok')).toBe(true);
    expect(new Set([...rows.values()].map(row => row.filePath)).size).toBe(3);
    expect([...rows.values()].every(row => row.fileName === 'results.pdf')).toBe(true);
    expect((await push(structuredClone(mutations))).every((r: any) => r.status === 'ok')).toBe(true);
    expect(prisma.ticketAttachment.create).toHaveBeenCalledTimes(3);
  });
  it.each(['create', 'delete'])('still rejects a non-legacy photo %s targeting another ticket', async action => {
    prisma.ticketAttachment.findUnique.mockResolvedValue({ id: 'unique-photo', ticketId: 'other-ticket' });
    expect((await push([{ queueId: 1, table: 'ticketAttachments', action, entityId: 'unique-photo', payload: { ticketId: 'server-parent' } }]))[0]).toMatchObject({ status: 'error', error: expect.stringContaining('another ticket') });
    expect(prisma.ticketAttachment.create).not.toHaveBeenCalled();
    expect(prisma.ticketAttachment.delete).not.toHaveBeenCalled();
  });
  it.each(['supervisor_review', 'billing_queue', 'invoiced'])('acknowledges an identical roster retry after %s without writing a locked row', async status => {
    prisma.serviceTicket.findUnique.mockResolvedValue({ id: 'server-parent', status, assignedTechId: 'tech' });
    prisma.trainingRosterRecord.findUnique.mockResolvedValue({ id: 'child', ticketId: 'server-parent', employeeName: 'SYNTHETIC STUDENT', passed: true, trainedAt: new Date('2026-09-25') });
    const results = await push([{ queueId: 1, table: 'trainingRosterRecords', action: 'update', entityId: 'child', payload: { ticketId: 'server-parent', employeeName: 'SYNTHETIC STUDENT', passed: true, trainedAt: '2026-09-25T00:00:00.000Z' } }]);
    expect(results[0].status).toBe('ok');
    expect(prisma.trainingRosterRecord.update).not.toHaveBeenCalled();
  });
  it.each([{ passed: false }, { trainedAt: '2026-09-26' }, { unexpected: 'value' }, { ticketId: 'different-parent' }])('rejects changed or unrecognized roster retries after invoicing: %j', async changed => {
    prisma.serviceTicket.findUnique.mockImplementation(async ({ where }: any) => ({ id: where.id, status: 'invoiced', assignedTechId: 'tech' }));
    prisma.trainingRosterRecord.findUnique.mockResolvedValue({ id: 'child', ticketId: 'server-parent', passed: true, trainedAt: new Date('2026-09-25') });
    const results = await push([{ queueId: 1, table: 'trainingRosterRecords', action: 'update', entityId: 'child', payload: { ticketId: 'server-parent', ...changed } }]);
    expect(results[0].status).toBe('error');
    expect(prisma.trainingRosterRecord.update).not.toHaveBeenCalled();
  });
  it('does not acknowledge another technician’s roster, even when the values match', async () => {
    prisma.serviceTicket.findUnique.mockResolvedValue({ id: 'server-parent', status: 'invoiced', assignedTechId: 'other-tech' });
    prisma.trainingRosterRecord.findUnique.mockResolvedValue({ id: 'child', ticketId: 'server-parent', passed: true });
    expect((await push([{ queueId: 1, table: 'trainingRosterRecords', action: 'update', entityId: 'child', payload: { ticketId: 'server-parent', passed: true } }]))[0].status).toBe('error');
    expect(prisma.trainingRosterRecord.update).not.toHaveBeenCalled();
  });
  it.each([false, true])('retains calendar origin through an offline edit and retry (notes=%s)', async withNotes => {
    let ticket: any = { id: 'server-parent', status: 'in_progress', assignedTechId: 'tech', customData: {
      classproSessionId: 'original-session', autoGeneratedFrom: 'classpro_session', wizardDraft: { stale: true },
    } };
    prisma.serviceTicket.findUnique.mockImplementation(async () => ticket);
    prisma.serviceTicket.update.mockImplementation(async ({ data }: any) => (ticket = { ...ticket, ...data }));
    const mutation = { queueId: 1, table: 'tickets', action: 'update', entityId: 'server-parent', payload: {
      customData: { courseName: 'Corrected course', autoGeneratedFrom: null },
      ...(withNotes ? { workDescription: 'Trainer closeout' } : {}),
    } };
    for (let attempt = 0; attempt < 2; attempt++) {
      expect((await push([structuredClone(mutation)]))[0].status).toBe('ok');
      expect(ticket.customData).toEqual({ courseName: 'Corrected course', classproSessionId: 'original-session', autoGeneratedFrom: 'classpro_session' });
    }
  });
  it('acknowledges a retried roster deletion after the original row has already gone', async () => {
    prisma.trainingRosterRecord.findUnique.mockResolvedValue(null);
    const result = await push([{ queueId: 538, table: 'trainingRosterRecords', action: 'delete', entityId: 'removed', payload: {} }]);
    expect(result[0]).toMatchObject({ status: 'ok', serverId: 'removed' });
    expect(prisma.trainingRosterRecord.deleteMany).not.toHaveBeenCalled();
  });
  it('validates ownership for a live roster deletion and tolerates another deletion after validation', async () => {
    prisma.serviceTicket.findUnique.mockResolvedValue({ id: 'server-parent', status: 'in_progress', assignedTechId: 'tech' });
    prisma.trainingRosterRecord.findUnique.mockResolvedValue({ id: 'child', ticketId: 'server-parent' });
    prisma.trainingRosterRecord.delete.mockRejectedValue(Object.assign(new Error('Record to delete does not exist'), { code: 'P2025' }));
    prisma.trainingRosterRecord.deleteMany.mockResolvedValue({ count: 0 });
    expect((await push([{ queueId: 1, table: 'trainingRosterRecords', action: 'delete', entityId: 'child', payload: { ticketId: 'server-parent' } }]))[0].status).toBe('ok');
    expect(prisma.trainingRosterRecord.deleteMany).toHaveBeenCalledWith({ where: { id: 'child' } });
    prisma.serviceTicket.findUnique.mockResolvedValue({ id: 'server-parent', status: 'in_progress', assignedTechId: 'other-tech' });
    expect((await push([{ queueId: 2, table: 'trainingRosterRecords', action: 'delete', entityId: 'child', payload: { ticketId: 'server-parent' } }]))[0].status).toBe('error');
    expect(prisma.trainingRosterRecord.deleteMany).toHaveBeenCalledTimes(1);
  });
  it('validates an offline rental close against its saved start date', async () => {
    prisma.rentalAgreement.update.mockResolvedValue({ id: 'rental' });
    const results = await push([{ queueId: 1, table: 'rentalAgreements', action: 'update', entityId: 'rental', payload: { status: 'completed', endDate: '2026-07-05' } }]);
    expect(results[0]).toMatchObject({ status: 'ok', serverId: 'rental' });
    expect(closeRental).toHaveBeenCalledWith(prisma, expect.objectContaining({ id: 'rental' }), 'completed', undefined, '2026-07-05');
  });
  it('rejects a pickup before the saved rental start without closing it', async () => {
    const results = await push([{ queueId: 1, table: 'rentalAgreements', action: 'update', entityId: 'rental', payload: { status: 'completed', endDate: '2026-06-14' } }]);
    expect(results[0]).toMatchObject({ status: 'error', error: expect.stringContaining('endDate') });
    expect(closeRental).not.toHaveBeenCalled();
    expect(prisma.rentalAgreement.update).not.toHaveBeenCalled();
  });
  it.each([
    ['fitTestRecords', 'fitTestRecord'], ['airSystemRecords', 'airSystemInspection'],
    ['ihTestRecords', 'ihTestRecord'], ['gasDetectionRecords', 'gasDetectionRecord'],
    ['trainingRosterRecords', 'trainingRosterRecord'],
  ] as const)('recovers %s after the parent is no longer in the batch, and replays once', async (table, model) => {
    const mutation = { queueId: 1, table, action: 'create', entityId: 'child', payload: { ticketId: 'old-offline-parent', ...(table === 'fitTestRecords' ? { employeeName: 'Test Employee' } : {}) } };
    expect(await push([structuredClone(mutation)])).toEqual([{ queueId: 1, status: 'ok', serverId: 'child', ticketId: 'server-parent' }]);
    expect(prisma[model].create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ ticketId: 'server-parent' }) }));
    prisma[model].findUnique.mockResolvedValue({ id: 'child', ticketId: 'server-parent' });
    expect((await push([structuredClone(mutation)]))[0].status).toBe('ok');
    expect(prisma[model].create).toHaveBeenCalledTimes(1);
  });
  it('keeps a missing-parent mutation retryable', async () => {
    prisma.serviceTicket.findFirst.mockResolvedValue(null);
    const results = await push([{ queueId: 1, table: 'fitTestRecords', action: 'create', entityId: 'child', payload: { ticketId: 'missing' } }]);
    expect(results[0]).toMatchObject({ status: 'error', error: expect.stringContaining('Parent ticket has not synced') });
    expect(prisma.fitTestRecord.create).not.toHaveBeenCalled();
  });
  it.each(['create', 'update'])('rejects field-tech approval in a %s without dropping other mutations', async action => {
    const results = await push([
      { queueId: 1, table: 'tickets', action, entityId: 'parent', payload: { status: 'billing_queue' } },
      { queueId: 2, table: 'fitTestRecords', action: 'create', entityId: 'child', payload: { ticketId: 'old-offline-parent', employeeName: 'Test Employee' } },
    ]);
    expect(results[0]).toMatchObject({ status: 'error', error: expect.stringContaining('requires dispatch') });
    expect(results[1].status).toBe('ok');
    expect(prisma.serviceTicket.update).not.toHaveBeenCalled();
  });
});

