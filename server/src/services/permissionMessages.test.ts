import { describe, expect, it } from 'vitest';
import { permissionDeniedMessage } from './permissionMessages.js';
import { canTransition, transitionDeniedMessage } from './ticketStateMachine.js';

describe('actionable permission messages', () => {
  it('names the actual approving roles for the dashboard error', () => {
    expect(canTransition('supervisor_review', 'billing_queue', 'billing_ar')).toBe(false);
    expect(transitionDeniedMessage('supervisor_review', 'billing_queue')).toBe(
      'Cannot approve tickets due to permissions. Must be Field Supervisor or Platform Admin to continue.',
    );
    expect(canTransition('supervisor_review', 'billing_queue', 'field_super')).toBe(true);
  });
  it('uses different roles when billing confirms a signed ticket', () => {
    expect(transitionDeniedMessage('awaiting_signature', 'billing_queue')).toContain('Must be Billing / AR, AR Supervisor, or Platform Admin');
  });
  it('does not claim that a different role can perform an invalid workflow change', () => {
    expect(transitionDeniedMessage('draft', 'invoiced')).toBe('Cannot move ticket from draft to invoiced. This status change is not allowed.');
  });
  it('formats and deduplicates roles without changing their names', () => {
    expect(permissionDeniedMessage('Manage locations', ['dispatch', 'field_super', 'platform_admin', 'platform_admin']))
      .toBe('Cannot manage locations due to permissions. Must be Dispatch, Field Supervisor, or Platform Admin to continue.');
  });
});
