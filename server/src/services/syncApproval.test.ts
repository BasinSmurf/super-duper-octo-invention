import { describe, expect, it } from 'vitest';
import { assertSyncApprovalRole } from './syncApproval.js';

describe('sync approval authority', () => {
  it.each(['dispatch', 'billing_ar', 'field_super', 'boss', 'platform_admin'])('allows %s to approve', role => {
    expect(() => assertSyncApprovalRole(role, { status: 'billing_queue' })).not.toThrow();
  });
  it.each(['field_tech', 'trainer', 'train_admin', 'customer', '', 'unknown'])('blocks %s from creating or updating approved/post-approval tickets', role => {
    for (const status of ['awaiting_signature', 'billing_queue', 'invoiced', 'closed']) {
      expect(() => assertSyncApprovalRole(role, { status })).toThrow('requires dispatch');
    }
  });
  it('retains offline drafts, field work and submission for review', () => {
    for (const status of [undefined, 'draft', 'in_progress', 'completed', 'supervisor_review']) {
      expect(() => assertSyncApprovalRole('field_tech', { status })).not.toThrow();
    }
  });
});
