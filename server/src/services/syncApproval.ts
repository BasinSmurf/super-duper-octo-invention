/** Offline submission is available to techs; approval and later billing states
 * require office/supervisory authority, including on a create/replayed payload.
 */
export function assertSyncApprovalRole(role: string, payload: Record<string, unknown>): void {
  const approvalStatuses = ['awaiting_signature', 'billing_queue', 'invoiced', 'closed'];
  if (!approvalStatuses.includes(String(payload.status))) return;
  if (!['dispatch', 'billing_ar', 'ar_supervisor', 'field_super', 'boss', 'platform_admin'].includes(role)) {
    throw new Error('Ticket approval through sync requires dispatch, billing, supervisor, boss, or administrator access. Submit to supervisor_review instead.');
  }
}
