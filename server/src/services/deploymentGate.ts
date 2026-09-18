// Deployment-rental gate + manned-rental record-only bypass.
//
// Two distinct populations of "rides on a rental" tickets:
//   1. A rental/on-site job DEPLOYED with no rental linked yet → surfaces in the
//      Approvals → Deployments queue and is blocked from billing until a rental
//      is attached.
//   2. A ticket linked to a MANNED rental → non-billable "record of work":
//      submitting it appends a note to the rental's daily log and closes it,
//      rather than entering the approval/billing pipeline.

export interface RentalGateTicketShape {
  ticketType: string;
  serviceSubtype: string | null;
  division: string | null;
}

// A ticket is "expected to ride on a rental" — rental or on-site/manned work.
// Plain field service (D3), training, fit-test and shop tickets are exempt, so
// the Deployments queue doesn't fill up with routine one-off service calls.
export function needsRental(t: RentalGateTicketShape): boolean {
  return (
    t.ticketType === 'rental' ||
    t.serviceSubtype === 'on_site_services' ||
    t.division === 'D4'
  );
}

// Statuses where a rental/on-site job is "deployed but not yet billed" — the
// window in which a missing rental should show up in the Deployments queue.
// (Excludes draft, billing_queue, invoiced, closed, void.)
export const DEPLOYED_PREBILLING_STATUSES = [
  'dispatched',
  'in_progress',
  'completed',
  'supervisor_review',
] as const;

// Target statuses that count as "moving toward billing" — blocked for a gated
// job until a rental is attached.
export function isBillingWardStatus(status: string): boolean {
  return status === 'billing_queue' || status === 'invoiced';
}
