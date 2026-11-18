// Deployment-rental gate + manned-rental record-only bypass.
//
// Two distinct populations of "rides on a rental" tickets:
//   1. A rental-required job DEPLOYED with no rental linked yet → surfaces in the
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

// D4 service visits may bill independently, including manned-trailer shifts.
// Keep the query and transition gate aligned so those visits aren't stranded
// in Deployments while actual rental deployments still require an agreement.
export const RENTAL_REQUIRED_WHERE = {
  OR: [
    { ticketType: 'rental' },
    { serviceSubtype: 'on_site_services' },
    { division: 'D4' },
  ],
  AND: [{ OR: [
    // Nullable fields must remain eligible for the legacy deployment gate.
    { division: null },
    { serviceSubtype: null },
    { NOT: {
      ticketType: 'field_service',
      division: 'D4',
      serviceSubtype: { in: ['on_site_services', 'general'] },
    } },
  ] }],
};

export function needsRental(t: RentalGateTicketShape): boolean {
  if (t.ticketType === 'field_service' && t.division === 'D4' &&
      (t.serviceSubtype === 'on_site_services' || t.serviceSubtype === 'general')) return false;
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
