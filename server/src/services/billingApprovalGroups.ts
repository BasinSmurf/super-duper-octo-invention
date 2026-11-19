import { AppError } from '../middleware/errorHandler.js';
import { selectBillingProfile, type SelectableProfile } from './billingProfileSelector.js';
import { defaultDivisionForWork } from '../utils/qbClass.js';

export interface BillingWork {
  ticketType?: string | null;
  serviceSubtype?: string | null;
  division?: string | null;
  serviceDate?: Date | string | null;
  billingProfileId?: string | null;
  customData?: unknown;
  ihTestRecords?: { testType: string }[];
}

export function ihWorkTypes(work: BillingWork): string[] {
  const data = work.customData as { ihSubtypes?: unknown } | null;
  return [...new Set([
    ...(work.serviceSubtype?.startsWith('ih_') ? [work.serviceSubtype] : []),
    ...(Array.isArray(data?.ihSubtypes) ? data.ihSubtypes.filter((v): v is string => typeof v === 'string' && v.startsWith('ih_')) : []),
    ...(work.ihTestRecords || []).map(record => record.testType),
  ])];
}

function profileAt<T extends SelectableProfile>(profiles: T[], work: BillingWork, serviceSubtype = work.serviceSubtype) {
  return selectBillingProfile(profiles, { ...work, serviceSubtype, division: work.division || defaultDivisionForWork({ ...work, serviceSubtype }),
    serviceDate: work.serviceDate ? new Date(work.serviceDate) : undefined });
}

/** Legacy invoices without a bound profile must be split by billing before submission. */
export function assertSingleApprovalGroup<T extends SelectableProfile>(profiles: T[], work: BillingWork): void {
  const types = ihWorkTypes(work);
  if (!types.includes('ih_sampling') || !types.some(type => type !== 'ih_sampling')) return;
  const destinations = new Set(types.map(type => profileAt(profiles, work, type)?.id || 'unconfigured'));
  if (destinations.size > 1) throw new AppError(400,
    'This combined ticket needs approval-group allocation during ticket approval before invoice submission.');
}

export function profileForBillingWork<T extends SelectableProfile>(profiles: T[], work: BillingWork): T | null {
  const subtype = ihWorkTypes(work).includes('ih_sampling') ? 'ih_sampling' : work.serviceSubtype;
  const selected = profileAt(profiles, work, subtype);
  const assigned = profiles.find(profile => profile.id === work.billingProfileId);
  // A narrower Sampling scope wins over a generic assignment after a work-type edit.
  if (assigned && profileAt([assigned], work, subtype) &&
      !(subtype === 'ih_sampling' && Array.isArray(selected?.appliesToTicketTypes) && selected.appliesToTicketTypes.includes('ih_sampling') &&
        !(Array.isArray(assigned.appliesToTicketTypes) && assigned.appliesToTicketTypes.includes('ih_sampling')))) return assigned;
  return selected;
}

export function invoiceApprovalProfile<T extends SelectableProfile>(profiles: T[], tickets: BillingWork[]): T | null {
  tickets.forEach(ticket => assertSingleApprovalGroup(profiles, ticket));
  const picked = tickets.map(ticket => profileForBillingWork(profiles, ticket));
  if (new Set(picked.map(profile => profile?.id || 'unconfigured')).size > 1) throw new AppError(400,
    'These tickets use different billing approval groups. Create a separate invoice for each approval group.');
  return picked[0] || null;
}
