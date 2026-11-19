import { describe, expect, it, vi } from 'vitest';
import { invoiceQbErrors } from './invoiceQbStatus.js';

describe('invoice QB error presentation', () => {
  it('shows rejection reasons but clears them on retry or acceptance', async () => {
    const findMany = vi.fn().mockResolvedValue([
      { entityId: 'rejected', status: 'error', errorMessage: 'QB 3070: FOB is too long', errorCode: '3070' },
      { entityId: 'retry', status: 'pending', errorMessage: 'old error', errorCode: '3070' },
      { entityId: 'accepted', status: 'success', errorMessage: 'old error', errorCode: '3070' },
    ]);
    const errors = await invoiceQbErrors({ qbSyncQueue: { findMany } } as any,
      ['rejected', 'retry', 'accepted'].map(id => ({ id, status: 'queued' })));
    expect([...errors]).toEqual([['rejected', 'QB 3070: FOB is too long']]);
    // Selecting only errors would resurrect an old rejection after a new attempt.
    expect(findMany.mock.calls[0][0]).toMatchObject({
      where: { entityType: { in: ['invoice', 'sales_order'] }, action: 'add', entityId: { in: ['rejected', 'retry', 'accepted'] } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], distinct: ['entityId'],
    });
    expect(findMany.mock.calls[0][0].where).not.toHaveProperty('status');
  });

  it('does not mask an invoiced, voided, or recalled invoice with old queue failures', async () => {
    const findMany = vi.fn();
    const errors = await invoiceQbErrors({ qbSyncQueue: { findMany } } as any,
      ['invoiced', 'void', 'draft', 'approved', 'so_created'].map(status => ({ id: status, status })));
    expect(errors.size).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('still displays an error when QB supplies no message', async () => {
    const findMany = vi.fn().mockResolvedValue([
      { entityId: 'a', status: 'error', errorMessage: null, errorCode: '3070' },
      { entityId: 'b', status: 'error', errorMessage: null, errorCode: null },
    ]);
    const errors = await invoiceQbErrors({ qbSyncQueue: { findMany } } as any,
      ['a', 'b'].map(id => ({ id, status: 'queued' })));
    expect(errors.get('a')).toBe('QuickBooks error 3070');
    expect(errors.get('b')).toContain('QuickBooks export failed');
  });
});
