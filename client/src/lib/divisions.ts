/**
 * Basin parts-numbering divisions (2026 company-wide renumber).
 *
 * New-scheme part numbers are 7-digit zero-padded strings encoding
 * DIVISION(2, 00–09) + FAMILY(1) + SUBGROUP(1) + PART(3). The division facet
 * scopes the line-item picker to a reasonable list ("what shelf does this
 * part live on"). It is NOT revenue attribution — QB Class stays on the
 * ticket's division: a D5-by-nature part installed on a D3 job bills as D3.
 *
 * Division 00 (Admin & General) holds intentionally cross-business items
 * (freight, discounts, card fees) and is always included in scoped searches,
 * as are legacy part numbers that haven't been renumbered yet.
 */

export interface Division {
  code: number
  short: string
  label: string
}

export const DIVISIONS: Division[] = [
  { code: 0, short: 'D0', label: 'Admin & General' },
  { code: 1, short: 'D1', label: 'Training' },
  { code: 2, short: 'D2', label: 'Consulting' },
  { code: 3, short: 'D3', label: 'Field Services' },
  { code: 4, short: 'D4', label: 'Rental & Emergency' },
  { code: 5, short: 'D5', label: 'Direct Sales' },
  { code: 6, short: 'D6', label: 'Service Center' },
  { code: 7, short: 'D7', label: 'SkyShield Drones' },
  { code: 8, short: 'D8', label: 'Occupational Health' },
  { code: 9, short: 'D9', label: 'SaaS & Development' },
]


/**
 * Default catalog division per wizard work type. Seeds the picker's Div
 * dropdown — the tech can always switch (e.g. grab a D5 sale item on a D3
 * field job). air_fill → D6 per the numbering taxonomy (06-2-1 "Air refill").
 */
export const WORK_TYPE_DIVISION: Record<string, number> = {
  field_service: 3,
  field_inspection: 6,
  fit_test: 1,
  ih_testing: 3,
  training: 1,
  repair: 6,
  rental: 4,
  air_fill: 6,
  direct_sale: 5,
}

/** The division's fixed Labor part number ([DIV]00002). */
export function divisionLaborPartNumber(division: number): string {
  return `${String(division).padStart(2, '0')}00002`
}

/** The division's fixed Mileage part number ([DIV]00001). */
export function divisionMileagePartNumber(division: number): string {
  return `${String(division).padStart(2, '0')}00001`
}
