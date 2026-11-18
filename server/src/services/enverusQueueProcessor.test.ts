vi.mock('./enverusQueueReconciliation.js', () => ({ reconcileEnverusFailures: vi.fn(async () => 0) }));
import { beforeEach, describe, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({ enverusSyncQueue: { findFirst: vi.fn(), update: vi.fn() }, invoice: { update: vi.fn() } }));
const submit = vi.hoisted(() => vi.fn());
const rebuild = vi.hoisted(() => vi.fn());
vi.mock('../db.js', () => ({ prisma: db }));
vi.mock('./enverusInvoiceSubmission.js', () => ({ rebuildInvoiceSubmission: rebuild }));
vi.mock('./enverusClient.js', () => ({ submitReceiptWithAttachment: submit, EnverusApiError: class extends Error {} }));
vi.mock('./jobs.js', () => ({ runScheduledJob: vi.fn() }));
vi.mock('./supervisor.js', () => ({ heartbeat: vi.fn() }));
vi.mock('./eventBus.js', () => ({ emitEvent: vi.fn() }));
vi.mock('./billingObservations.js', () => ({ recordObservation: vi.fn(), recordDocRefObservationByDocNumber: vi.fn() }));
vi.mock('../utils/ticketPdfBuffer.js', () => ({ getInvoicePdfBuffer: async () => ({ buffer: Buffer.from('PDF'), fileName: 'invoice.pdf' }) }));
import { processNextSubmission } from './enverusQueueProcessor.js';

beforeEach(() => {
  vi.clearAllMocks();
  db.enverusSyncQueue.update.mockResolvedValue({});
  db.invoice.update.mockResolvedValue({});
  submit.mockResolvedValue({ statusCode: 200, body: {} });
});
describe('queued Enverus retries', () => {
  it('preserves a complete large success response so trailing warnings remain readable', async () => {
    db.enverusSyncQueue.findFirst.mockResolvedValue({ id: 'q1', entityId: 'i1', entityType: 'field_ticket', action: 'submit', retryCount: 0,
      endpointUrl: '/events/supply-chain/v1/receipt.submit', requestPayload: '{}' });
    rebuild.mockResolvedValue({ payload: {}, requestPayload: '{}' });
    const body = { receipt: { description: 'x'.repeat(12000) }, confirmMessage: { resourceMessages: [
      { processMessages: [{ messageTypeCode: { codeValue: 'warning' }, developerMessage: { messageTxt: 'Keep this warning' } }] },
    ] } };
    submit.mockResolvedValue({ statusCode: 200, body });
    await processNextSubmission();
    const saved = db.enverusSyncQueue.update.mock.calls.find(([args]) => args.data.responsePayload)?.[0].data.responsePayload;
    expect(JSON.parse(saved)).toEqual(body);
  });
  it.each(['invoice', 'field_ticket'])('rebuilds %s immediately before sending and never transmits internal metadata', async entityType => {
    const entry = { id: 'q1', entityId: 'i1', entityType, action: 'submit', retryCount: 1,
      endpointUrl: '/events/supply-chain/v1/receipt.submit', requestPayload: '{"events":["STALE"]}' };
    db.enverusSyncQueue.findFirst.mockResolvedValue(entry);
    const payload = { events: ['CURRENT'] };
    const requestPayload = JSON.stringify({ ...payload, _sundogSubmission: { version: 1 } });
    rebuild.mockResolvedValue({ payload, requestPayload });
    await processNextSubmission();
    expect(rebuild).toHaveBeenCalledWith(db, entry);
    expect(submit).toHaveBeenCalledWith(payload, expect.any(Buffer), 'invoice.pdf');
    expect(db.enverusSyncQueue.update).toHaveBeenCalledWith({ where: { id: 'q1' }, data: { requestPayload } });
  });
  it('records a rebuild failure without sending the old snapshot', async () => {
    db.enverusSyncQueue.findFirst.mockResolvedValue({ id: 'q1', entityId: 'gone', entityType: 'field_ticket', action: 'submit', retryCount: 1, requestPayload: '{}' });
    rebuild.mockRejectedValue(new Error('Cannot rebuild: missing invoice'));
    await processNextSubmission();
    expect(submit).not.toHaveBeenCalled();
    expect(db.enverusSyncQueue.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'error', errorMessage: 'Cannot rebuild: missing invoice' }) }));
  });
});
