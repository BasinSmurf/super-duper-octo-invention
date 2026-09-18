/**
 * Compute the billingGroupKey for a service ticket.
 *
 * Field-service tickets are grouped for consolidated invoicing by:
 *   customer  +  field  +  calendar month
 *
 * Format:  "co:{companyId}|fld:{fieldId}|mo:{YYYY-MM}"
 *
 * Returns null when there's not enough info to form a key
 * (e.g. missing companyId or serviceDate), or when the ticket
 * type doesn't participate in stacked billing (rentals have
 * their own grouping via RentalAgreement).
 */

/** Ticket types eligible for auto billing-group keying. */
const ELIGIBLE_TYPES = new Set([
  'field_service',
  'inspection',  // IH testing tickets
  'training',    // fit test + training class tickets
]);

interface BillingGroupKeyInput {
  ticketType?: string | null;
  companyId?: string | null;
  fieldId?: string | null;
  serviceDate?: Date | string | null;
}

export function computeBillingGroupKey(input: BillingGroupKeyInput): string | null {
  const { ticketType, companyId, fieldId, serviceDate } = input;

  // Only eligible ticket types get a grouping key
  if (!ticketType || !ELIGIBLE_TYPES.has(ticketType)) return null;

  // Must have at least a company
  if (!companyId) return null;

  // Parse the month from the service date (or fall back to today)
  let month: string;
  if (serviceDate) {
    const d = serviceDate instanceof Date ? serviceDate : new Date(serviceDate);
    if (isNaN(d.getTime())) return null;
    month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  } else {
    const now = new Date();
    month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }

  // field may be null for shop-based tickets, fit tests, etc. — use "none"
  const fld = fieldId || 'none';

  return `co:${companyId}|fld:${fld}|mo:${month}`;
}
