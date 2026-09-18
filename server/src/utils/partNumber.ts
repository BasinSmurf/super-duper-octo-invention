/**
 * Basin parts-numbering scheme (2026 company-wide renumber).
 *
 * New-scheme part numbers are 7-digit zero-padded strings encoding:
 *   DIVISION (2 digits, 00–09) + FAMILY (1) + SUBGROUP (1) + PART (3)
 * e.g. "0300002" = Division 03 (Field Services), family 0, subgroup 0, part 002.
 *
 * Fixed rules from the numbering key:
 *   [DIV]00001 is ALWAYS that division's Mileage
 *   [DIV]00002 is ALWAYS that division's Labor
 *
 * A conforming number always starts with '0' (divisions only go to 09), which
 * also cleanly separates new-scheme numbers from legacy ones ("406", "11009").
 *
 * These facets scope the catalog picker only. Revenue attribution (QB Class)
 * stays on the ticket's division — a D5-by-nature part installed on a D3 job
 * still bills as D3.
 */

export interface PartNumberFacets {
  division: number;
  family: number;
  subgroup: number;
}

const NEW_SCHEME_RE = /^0[0-9]{6}$/;

/**
 * Parse a part number (or QB item FullName — subitem paths are
 * colon-delimited, the item's own name is the last segment) into its
 * division facets. Returns null for legacy / non-conforming numbers.
 */
export function parsePartNumber(partNumber: string | null | undefined): PartNumberFacets | null {
  if (!partNumber) return null;
  const segments = partNumber.split(':');
  const candidate = (segments[segments.length - 1] ?? '').trim();
  if (!NEW_SCHEME_RE.test(candidate)) return null;
  return {
    division: parseInt(candidate.slice(0, 2), 10),
    family: parseInt(candidate.slice(2, 3), 10),
    subgroup: parseInt(candidate.slice(3, 4), 10),
  };
}

/**
 * Prisma-shaped column values for a product's division facets, derived from
 * its part number. Facets are always derived, never hand-set — call this on
 * every write that touches partNumber so they can't drift.
 */
export function partNumberFacetColumns(partNumber: string | null | undefined): {
  division: number | null;
  partFamily: number | null;
  partSubgroup: number | null;
} {
  const parsed = parsePartNumber(partNumber);
  return {
    division: parsed?.division ?? null,
    partFamily: parsed?.family ?? null,
    partSubgroup: parsed?.subgroup ?? null,
  };
}

/**
 * 'D3' | 3 → 3. The QB class division and the parts-numbering division are the
 * same number; only the spelling differs between the two systems.
 */
export function divisionNumber(division: string | number | null | undefined): number | null {
  if (division == null) return null;
  if (typeof division === 'number') return Number.isFinite(division) ? division : null;
  const n = parseInt(String(division).replace(/^D/i, ''), 10);
  return Number.isNaN(n) ? null : n;
}

/** The division's fixed Labor part number ([DIV]00002). */
export function divisionLaborPartNumber(division: number): string {
  return `${String(division).padStart(2, '0')}00002`;
}

/** The division's fixed Mileage part number ([DIV]00001). */
export function divisionMileagePartNumber(division: number): string {
  return `${String(division).padStart(2, '0')}00001`;
}
