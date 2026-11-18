import { describe, expect, it, vi } from 'vitest';
import { reconcileEnverusFailures, supersedesFailure } from './enverusQueueReconciliation.js';

const failure = { id: 'old', entityId: 'invoice1', entityType: 'field_ticket', target: 'openticket', action: 'submit',
  endpointUrl: '/events/supply-chain/v1/receipt.submit', status: 'error', createdAt: new Date('2026-10-20'),
  respondedAt: new Date('2026-10-20T00:01Z'), submittedAt: null, responseStatusCode: 400, enverusItemId: null };
const success = { ...failure, id: 'success', status: 'submitted', createdAt: new Date('2026-10-21'),
  submittedAt: new Date('2026-10-21T00:01Z'), responseStatusCode: 200, enverusItemId: '359238' };

describe('Enverus recovered submission alerts', () => {
  it('resolves an older API failure after a later successful receipt submission, including buyer acceptance', () => {
    expect(supersedesFailure(failure, success)).toBe(true);
    expect(supersedesFailure(failure, { ...success, status: 'accepted' })).toBe(true);
  });
  it.each([
    { entityId: 'other-invoice' }, { entityType: 'invoice' }, { target: 'openinvoice' },
    { action: 'cancel' }, { endpointUrl: '/supply-chain/v3/invoices' }, { status: 'error' },
    { status: 'rejected' }, { enverusItemId: null }, { enverusItemId: '' },
    { responseStatusCode: 400 }, { responseStatusCode: null }, { submittedAt: null },
    { createdAt: new Date('2026-10-19') }, { submittedAt: new Date('2026-10-19') },
  ])('does not clear a failure using unrelated or unproven success %j', patch => {
    expect(supersedesFailure(failure, { ...success, ...patch })).toBe(false);
  });
  it('keeps buyer rejection and cancellation failures actionable', () => {
    expect(supersedesFailure({ ...failure, status: 'rejected' }, success)).toBe(false);
    expect(supersedesFailure({ ...failure, action: 'cancel' }, success)).toBe(false);
  });
  it('does not hide a failure whose response arrived after the successful submission', () => {
    expect(supersedesFailure({ ...failure, respondedAt: new Date('2026-10-22') }, success)).toBe(false);
  });
  it('marks only recovered attempts, preserves their error responses, and audits the replacement', async () => {
    const unresolved = { ...failure, id: 'unresolved', entityId: 'invoice2' };
    const tx = { enverusSyncQueue: { updateMany: vi.fn(async () => ({ count: 1 })) }, auditLog: { create: vi.fn() } };
    const db = { enverusSyncQueue: { findMany: vi.fn().mockResolvedValueOnce([failure, unresolved]).mockResolvedValueOnce([success]) },
      $transaction: vi.fn(async callback => callback(tx)) };
    expect(await reconcileEnverusFailures(db as any)).toBe(1);
    expect(tx.enverusSyncQueue.updateMany).toHaveBeenCalledTimes(1);
    const update = tx.enverusSyncQueue.updateMany.mock.calls[0]![0] as any;
    expect(update.where).toEqual({ id: 'old', status: 'error', respondedAt: failure.respondedAt });
    expect(update.data).toMatchObject({ status: 'superseded', supersededById: 'success' });
    expect(update.data).not.toHaveProperty('errorMessage');
    expect(update.data).not.toHaveProperty('responsePayload');
    expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      entityId: 'old', changes: expect.objectContaining({ supersededById: 'success', enverusItemId: '359238' }),
    }) }));
  });
  it('does not duplicate an audit if another reconciler already recovered the attempt', async () => {
    const tx = { enverusSyncQueue: { updateMany: vi.fn(async () => ({ count: 0 })) }, auditLog: { create: vi.fn() } };
    const db = { enverusSyncQueue: { findMany: vi.fn().mockResolvedValueOnce([failure]).mockResolvedValueOnce([success]) },
      $transaction: vi.fn(async callback => callback(tx)) };
    expect(await reconcileEnverusFailures(db as any)).toBe(0);
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
});
