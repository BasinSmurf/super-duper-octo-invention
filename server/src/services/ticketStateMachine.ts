/**
 * Ticket Status State Machine
 *
 * Defines valid status transitions and who can perform them.
 * Based on blueprint Section 5.4 status flow:
 *
 *   draft → dispatched → in_progress → completed → supervisor_review
 *   → [awaiting_signature] → billing_queue → invoiced → closed
 *
 * With shortcuts:
 *   draft → in_progress (self-created, skip dispatch)
 *   completed → billing_queue (auto if no supervisor review needed)
 *
 * Signature gate (optional per billing profile, email-based):
 *   supervisor_review → awaiting_signature → billing_queue
 *   awaiting_signature can be cancelled back to supervisor_review
 */

import type { TicketStatus, UserRole } from '../db.js';
import { permissionDeniedMessage } from './permissionMessages.js';

interface Transition {
  to: TicketStatus;
  allowedRoles: UserRole[];
}

const TRANSITIONS: Record<string, Transition[]> = {
  draft: [
    { to: 'dispatched', allowedRoles: ['dispatch', 'field_super', 'platform_admin'] },
    { to: 'in_progress', allowedRoles: ['field_tech', 'dispatch', 'field_super', 'platform_admin'] },
  ],
  dispatched: [
    { to: 'in_progress', allowedRoles: ['field_tech', 'field_super', 'platform_admin'] },
    { to: 'draft', allowedRoles: ['dispatch', 'field_super', 'platform_admin'] }, // un-dispatch
  ],
  in_progress: [
    { to: 'completed', allowedRoles: ['field_tech', 'field_super', 'platform_admin'] },
    { to: 'draft', allowedRoles: ['field_tech', 'field_super', 'platform_admin'] }, // back to draft
    // Wizard "Finish" shortcut: field techs can send a ticket straight into
    // the supervisor review queue without parking it at 'completed' first.
    { to: 'supervisor_review', allowedRoles: ['field_tech', 'field_super', 'platform_admin'] },
  ],
  completed: [
    { to: 'supervisor_review', allowedRoles: ['field_tech', 'field_super', 'platform_admin'] },
    { to: 'billing_queue', allowedRoles: ['field_super', 'platform_admin'] }, // skip review
    { to: 'in_progress', allowedRoles: ['field_super', 'platform_admin'] }, // reopen
  ],
  supervisor_review: [
    { to: 'billing_queue', allowedRoles: ['field_super', 'platform_admin'] },
    { to: 'awaiting_signature', allowedRoles: ['field_super', 'billing_ar', 'ar_supervisor', 'platform_admin'] }, // send for signature
    { to: 'in_progress', allowedRoles: ['field_super', 'platform_admin'] }, // reject back
  ],
  awaiting_signature: [
    { to: 'billing_queue', allowedRoles: ['billing_ar', 'ar_supervisor', 'platform_admin'] },     // signed (webhook or manual)
    { to: 'supervisor_review', allowedRoles: ['field_super', 'platform_admin'] }, // cancel signature
  ],
  billing_queue: [
    { to: 'invoiced', allowedRoles: ['billing_ar', 'ar_supervisor', 'platform_admin'] },
    { to: 'supervisor_review', allowedRoles: ['billing_ar', 'ar_supervisor', 'platform_admin'] }, // kick back
  ],
  invoiced: [
    { to: 'closed', allowedRoles: ['billing_ar', 'ar_supervisor', 'platform_admin'] },
    { to: 'billing_queue', allowedRoles: ['billing_ar', 'ar_supervisor', 'platform_admin'] }, // reopen for rebill
  ],
  closed: [
    { to: 'billing_queue', allowedRoles: ['platform_admin'] }, // emergency reopen
  ],
};

export function canTransition(
  currentStatus: TicketStatus,
  targetStatus: TicketStatus,
  userRole: UserRole,
): boolean {
  const allowed = TRANSITIONS[currentStatus];
  if (!allowed) return false;

  const transition = allowed.find(t => t.to === targetStatus);
  if (!transition) return false;

  return transition.allowedRoles.includes(userRole);
}

/** Explain a denied transition using the same role list that enforces it. */
export function transitionDeniedMessage(currentStatus: TicketStatus, targetStatus: TicketStatus): string {
  const transition = TRANSITIONS[currentStatus]?.find(t => t.to === targetStatus);
  const statusLabel = (status: string) => status.replace(/_/g, ' ');
  if (!transition) return `Cannot move ticket from ${statusLabel(currentStatus)} to ${statusLabel(targetStatus)}. This status change is not allowed.`;
  const actions: Record<string, string> = {
    billing_queue: ['supervisor_review', 'completed'].includes(currentStatus) ? 'approve tickets' : 'return tickets to billing',
    awaiting_signature: 'send tickets for signature',
    invoiced: 'mark tickets invoiced', closed: 'close tickets',
    in_progress: currentStatus === 'supervisor_review' ? 'return tickets to work' : 'start or reopen tickets',
    supervisor_review: 'send tickets for review', dispatched: 'dispatch tickets',
    completed: 'complete tickets', draft: 'return tickets to draft',
  };
  return permissionDeniedMessage(actions[targetStatus] ?? 'change ticket status', transition.allowedRoles);
}

export function getAvailableTransitions(
  currentStatus: TicketStatus,
  userRole: UserRole,
): TicketStatus[] {
  const allowed = TRANSITIONS[currentStatus];
  if (!allowed) return [];

  return allowed
    .filter(t => t.allowedRoles.includes(userRole))
    .map(t => t.to);
}
