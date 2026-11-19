// Buyer billing codes that live on the well/pad a ticket was worked at, so billers
// don't retype them per invoice. Whether a profile uses them is per field:
// CustomerBillingProfile.afeNumberSource / costCenterSource / buyerSiteSource /
// buyerDepartmentSource ('fixed' | 'location').

type Source = 'fixed' | 'location';

interface LocationCodes {
  facilityCode?: string | null;
  costCenter?: string | null;
  buyerSiteUuid?: string | null;
  buyerDepartment?: string | null;
}

export interface LocationCodeSource {
  afeNumber?: string | null;
  costCenter?: string | null;
  well?: LocationCodes | null;
  pad?: LocationCodes | null;
}

export interface ProfileCodeConfig {
  afeNumberSource?: Source | null;
  costCenterSource?: Source | null;
  buyerSiteSource?: Source | null;
  buyerDepartmentSource?: Source | null;
  defaultAfeNumber?: string | null;
  defaultCostCenter?: string | null;
}

export interface BillingCodes {
  afeNumber: string | null;
  costCenter: string | null;
  buyerSiteUuid: string | null;
  buyerDepartment: string | null;
}

const clean = (v: string | null | undefined) => v?.trim() || null;

function agreed(values: (string | null)[]): string | null {
  const codes = new Set(values.filter((v): v is string => !!v));
  return codes.size === 1 ? [...codes][0] : null;
}

/** One ticket's codes under its profile's sources. Null = nothing better than the profile default. */
export function ticketBillingCodes(profile: ProfileCodeConfig | null | undefined, ticket: LocationCodeSource): BillingCodes {
  // The wizard pre-fills required refs with the profile default; that isn't a
  // human choice, so it must not mask the location's code.
  const typed = (value: string | null | undefined, profileDefault: string | null | undefined) => {
    const v = clean(value);
    return v && v !== clean(profileDefault) ? v : null;
  };
  const here = (key: keyof LocationCodes) => clean(ticket.well?.[key]) ?? clean(ticket.pad?.[key]);
  const afeFromLocation = profile?.afeNumberSource === 'location';
  const ccFromLocation = profile?.costCenterSource === 'location';
  return {
    afeNumber: afeFromLocation
      ? typed(ticket.afeNumber, profile?.defaultAfeNumber) ?? here('facilityCode')
      : clean(ticket.afeNumber),
    // A cost center typed on the ticket always carries; the location's only when the profile asks.
    costCenter: ccFromLocation
      ? typed(ticket.costCenter, profile?.defaultCostCenter) ?? here('costCenter')
      : clean(ticket.costCenter),
    // Tickets don't capture these; they come from the location or the profile's fixed value.
    buyerSiteUuid: profile?.buyerSiteSource === 'location' ? here('buyerSiteUuid') : null,
    buyerDepartment: profile?.buyerDepartmentSource === 'location' ? here('buyerDepartment') : null,
  };
}

/** Invoice header codes: each set only when every coded source ticket agrees. */
export function invoiceBillingCodes(profile: ProfileCodeConfig | null | undefined, tickets: LocationCodeSource[]): BillingCodes {
  const codes = tickets.map(t => ticketBillingCodes(profile, t));
  return {
    afeNumber: agreed(codes.map(c => c.afeNumber)),
    costCenter: agreed(codes.map(c => c.costCenter)),
    buyerSiteUuid: agreed(codes.map(c => c.buyerSiteUuid)),
    buyerDepartment: agreed(codes.map(c => c.buyerDepartment)),
  };
}

export interface ProfileRequirements {
  requiresPo?: boolean | null;
  requiresAfe?: boolean | null;
  requiresCostCenter?: boolean | null;
  requiresBuyerSite?: boolean | null;
  requiresBuyerDepartment?: boolean | null;
}

/** Labels of the fields this profile requires that are still empty. */
export function missingRequiredBillingFields(
  profile: ProfileRequirements | null | undefined,
  values: { poNumber?: string | null; afeNumber?: string | null; costCenter?: string | null; buyerSiteUuid?: string | null; buyerDepartment?: string | null },
): string[] {
  if (!profile) return [];
  const checks: [boolean | null | undefined, string | null | undefined, string][] = [
    [profile.requiresPo, values.poNumber, 'PO number'],
    [profile.requiresAfe, values.afeNumber, 'AFE'],
    [profile.requiresCostCenter, values.costCenter, 'cost center'],
    [profile.requiresBuyerSite, values.buyerSiteUuid, 'subcompany'],
    [profile.requiresBuyerDepartment, values.buyerDepartment, 'department'],
  ];
  return checks.filter(([required, value]) => required && !clean(value)).map(([, , label]) => label);
}
