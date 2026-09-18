// ND sales tax — per-item, destination-based.
//
// Rule of thumb (North Dakota): tangible personal property is sales-taxable;
// separately-stated services (labor, mileage/travel) are not. Equipment rental
// is a lease of tangible personal property and IS taxable. Tax is computed on
// the taxable lines only, at the rate for the jurisdiction where the
// deliverable was received — auto-resolved from the service location's county.
//
// SP is canonical: we compute the tax amount and freeze the rate on the
// invoice. QuickBooks recomputes from the mapped Sales Tax Item (it picks a
// rate per transaction, "None" included) and should land on the same number.

import { prisma } from '../db.js';

// Line types that represent tangible goods / leased property → taxable by default.
// Everything else (labor, service, travel/mileage, fit_test, monitor_*, bump/cal,
// misc_charge) is a service → non-taxable by default. All overridable per line.
const TAXABLE_LINE_TYPES = new Set(['part', 'assembly', 'rental']);

export function defaultTaxableForLineType(lineType?: string | null): boolean {
  if (!lineType) return false;
  return TAXABLE_LINE_TYPES.has(lineType);
}

export interface ResolvedJurisdiction {
  id: string;
  rate: number;
}

// The unincorporated/county-default rate for a county (most well sites), with a
// state-only (nd_state) fallback for counties not in the table or unknown.
export async function resolveJurisdictionForCounty(
  county?: string | null,
): Promise<ResolvedJurisdiction | null> {
  if (county && county.trim()) {
    const match = await prisma.salesTaxRate.findFirst({
      where: {
        county: { equals: county.trim(), mode: 'insensitive' },
        isCountyDefault: true,
        active: true,
      },
    });
    if (match) return { id: match.id, rate: Number(match.rate) };
  }
  const fallback = await prisma.salesTaxRate.findUnique({ where: { id: 'nd_state' } });
  return fallback ? { id: fallback.id, rate: Number(fallback.rate) } : null;
}

// Look up a jurisdiction's rate by id (for explicit selection / recompute).
export async function getJurisdictionRate(id?: string | null): Promise<ResolvedJurisdiction | null> {
  if (!id) return null;
  const row = await prisma.salesTaxRate.findUnique({ where: { id } });
  return row ? { id: row.id, rate: Number(row.rate) } : null;
}

// Pick the most-specific county available on a ticket's linked locations.
export function countyFromTicketLocations(t: {
  well?: { county?: string | null } | null;
  pad?: { county?: string | null } | null;
  field?: { county?: string | null } | null;
  facility?: { county?: string | null } | null;
}): string | null {
  return t.well?.county ?? t.pad?.county ?? t.field?.county ?? t.facility?.county ?? null;
}

// taxAmount = Σ(taxable line amounts) × rate, rounded to cents.
export function computeTaxAmount(
  lineItems: Array<{ amount: number; isTaxable: boolean }>,
  rate: number,
): number {
  const taxableSubtotal = lineItems
    .filter(li => li.isTaxable)
    .reduce((sum, li) => sum + li.amount, 0);
  return Math.round(taxableSubtotal * rate * 100) / 100;
}
