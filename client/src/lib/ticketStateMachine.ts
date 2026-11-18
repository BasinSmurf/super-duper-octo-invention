/**
 * Client-side ticket state machine.
 * Mirror of server/src/services/ticketStateMachine.ts so we can compute
 * available transitions offline without an API call.
 */

interface Transition {
  to: string
  allowedRoles: string[]
}

const TRANSITIONS: Record<string, Transition[]> = {
  draft: [
    { to: 'dispatched', allowedRoles: ['dispatch', 'field_super', 'platform_admin'] },
    { to: 'in_progress', allowedRoles: ['field_tech', 'dispatch', 'field_super', 'platform_admin'] },
  ],
  dispatched: [
    { to: 'in_progress', allowedRoles: ['field_tech', 'field_super', 'platform_admin'] },
    { to: 'draft', allowedRoles: ['dispatch', 'field_super', 'platform_admin'] },
  ],
  in_progress: [
    { to: 'completed', allowedRoles: ['field_tech', 'field_super', 'platform_admin'] },
    { to: 'draft', allowedRoles: ['field_tech', 'field_super', 'platform_admin'] },
  ],
  completed: [
    { to: 'supervisor_review', allowedRoles: ['field_tech', 'field_super', 'platform_admin'] },
    { to: 'billing_queue', allowedRoles: ['field_super', 'platform_admin'] },
    { to: 'in_progress', allowedRoles: ['field_super', 'platform_admin'] },
  ],
  supervisor_review: [
    { to: 'billing_queue', allowedRoles: ['field_super', 'platform_admin'] },
    { to: 'awaiting_signature', allowedRoles: ['field_super', 'billing_ar', 'ar_supervisor', 'platform_admin'] },
    { to: 'in_progress', allowedRoles: ['field_super', 'platform_admin'] },
  ],
  awaiting_signature: [
    { to: 'billing_queue', allowedRoles: ['billing_ar', 'ar_supervisor', 'platform_admin'] },
    { to: 'supervisor_review', allowedRoles: ['field_super', 'platform_admin'] },
  ],
  billing_queue: [
    { to: 'invoiced', allowedRoles: ['billing_ar', 'ar_supervisor', 'platform_admin'] },
    { to: 'supervisor_review', allowedRoles: ['billing_ar', 'ar_supervisor', 'platform_admin'] },
  ],
  invoiced: [
    { to: 'closed', allowedRoles: ['billing_ar', 'ar_supervisor', 'platform_admin'] },
    { to: 'billing_queue', allowedRoles: ['billing_ar', 'ar_supervisor', 'platform_admin'] },
  ],
  closed: [
    { to: 'billing_queue', allowedRoles: ['platform_admin'] },
  ],
}

/** Get the list of statuses this user can transition the ticket to */
export function getAvailableTransitions(currentStatus: string, userRole: string): string[] {
  const allowed = TRANSITIONS[currentStatus]
  if (!allowed) return []
  return allowed
    .filter(t => t.allowedRoles.includes(userRole))
    .map(t => t.to)
}

/** Whether the current user is allowed to edit this ticket's fields */
export function canEditTicket(status: string, userRole: string, isOwnTicket: boolean): boolean {
  // Field techs can only edit their own draft/in_progress tickets
  if (userRole === 'field_tech') {
    return isOwnTicket && ['draft', 'in_progress'].includes(status)
  }
  // Supervisors and admins can correct active and completed work.
  if (['field_super', 'platform_admin'].includes(userRole)) {
    return ['draft', 'dispatched', 'in_progress', 'completed'].includes(status)
  }
  // Dispatch corrects customer/job details while work is active, too.
  if (userRole === 'dispatch') {
    return ['draft', 'dispatched', 'in_progress'].includes(status)
  }
  return false
}

/**
 * Human-readable labels and colors for transition buttons.
 * Key format: "fromStatus→toStatus"
 */
export const TRANSITION_LABELS: Record<string, { label: string; color: string; primary: boolean }> = {
  'draft→in_progress':                { label: 'Start Work',        color: 'bg-blue-700 hover:bg-blue-600 text-white',     primary: true },
  'draft→dispatched':                 { label: 'Dispatch',          color: 'bg-blue-600 hover:bg-blue-500 text-white',     primary: true },
  'dispatched→in_progress':           { label: 'Start Work',        color: 'bg-blue-700 hover:bg-blue-600 text-white',     primary: true },
  'dispatched→draft':                 { label: 'Un-dispatch',       color: 'bg-slate-200 hover:bg-slate-300 text-slate-700', primary: false },
  'in_progress→completed':            { label: 'Complete',          color: 'bg-green-700 hover:bg-green-600 text-white',   primary: true },
  'in_progress→draft':                { label: 'Back to Draft',     color: 'bg-slate-200 hover:bg-slate-300 text-slate-700', primary: false },
  'completed→supervisor_review':      { label: 'Send for Review',   color: 'bg-purple-600 hover:bg-purple-500 text-white', primary: true },
  'completed→billing_queue':          { label: 'Send to Billing',   color: 'bg-indigo-600 hover:bg-indigo-500 text-white', primary: true },
  'completed→in_progress':            { label: 'Reopen',            color: 'bg-amber-600 hover:bg-amber-500 text-white',   primary: false },
  'supervisor_review→billing_queue':  { label: 'Approve → Billing', color: 'bg-indigo-600 hover:bg-indigo-500 text-white', primary: true },
  'supervisor_review→awaiting_signature': { label: 'Send for Signature', color: 'bg-yellow-600 hover:bg-yellow-500 text-white', primary: false },
  'supervisor_review→in_progress':    { label: 'Reject → Reopen',   color: 'bg-red-600 hover:bg-red-500 text-white',       primary: false },
  'awaiting_signature→billing_queue': { label: 'Mark Signed → Billing', color: 'bg-indigo-600 hover:bg-indigo-500 text-white', primary: true },
  'awaiting_signature→supervisor_review': { label: 'Cancel Signature', color: 'bg-amber-600 hover:bg-amber-500 text-white', primary: false },
  'billing_queue→invoiced':           { label: 'Mark Invoiced',     color: 'bg-emerald-600 hover:bg-emerald-500 text-white', primary: true },
  'billing_queue→supervisor_review':  { label: 'Kick Back',         color: 'bg-amber-600 hover:bg-amber-500 text-white',   primary: false },
  'invoiced→closed':                  { label: 'Close Ticket',      color: 'bg-slate-700 hover:bg-slate-600 text-white',   primary: true },
  'invoiced→billing_queue':           { label: 'Reopen for Rebill', color: 'bg-amber-600 hover:bg-amber-500 text-white',   primary: false },
  'closed→billing_queue':             { label: 'Emergency Reopen',  color: 'bg-red-700 hover:bg-red-600 text-white',       primary: false },
}
