// QB Class divisions — the client-side mirror of server/src/utils/qbClass.ts.
//
// ADR-0017: the division is a property of the work PATH, not a tech decision.
// The wizard tile the tech taps declares it (see pages/wizard/divisions.tsx),
// the shell stamps it onto the hand-off URL, and TicketWizard carries it onto
// the ticket. Flows that don't come through the division picker (Training, Occ
// Health and Direct Sale live on app-switcher surfaces) fall back to the
// work-type map below. The server derives the same thing independently on write
// — this side exists so the ticket carries a division offline and the tech can
// see which QB class their work will land on.
//
// Keep QB_CLASS_PREVIEW in step with the server's QB_CLASS_MAP. QB rejects a
// ClassRef that doesn't match character-for-character (3140), including its own
// inconsistent plurals and spacing.

export type QbDivision = 'D1' | 'D2' | 'D3' | 'D4' | 'D5' | 'D6' | 'D7' | 'D8'

export const QB_DIVISIONS: QbDivision[] = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8']

export function isQbDivision(val: unknown): val is QbDivision {
  return typeof val === 'string' && (QB_DIVISIONS as string[]).includes(val)
}

/** `dickinson: null` = company-wide, no Dickinson child class in QB (D7/D8). */
export const QB_CLASS_PREVIEW: Record<QbDivision, { base: string; dickinson: string | null }> = {
  D1: { base: 'D1 Basin Safety Training', dickinson: 'Dickinson:Dickinson1 Training' },
  D2: { base: 'D2 Basin Consulting', dickinson: 'Dickinson:Dickinson2 Consulting' },
  D3: { base: 'D3 Basin Safety Service', dickinson: 'Dickinson:Dickinson3 Safety Service' },
  D4: { base: 'D4 Basin On Site Services', dickinson: 'Dickinson:Dickinson4 On Site Service' },
  D5: { base: 'D5 Basin Safety Store', dickinson: 'Dickinson:Dickinson5 Store' },
  D6: { base: 'D6 - FEX Services', dickinson: 'Dickinson:Dickinson6 FEX' },
  D7: { base: 'D7 Sky Shield', dickinson: null },
  D8: { base: 'D8 Occupational Health', dickinson: null },
}

export function qbClassPreview(division: QbDivision | null, isDickinson: boolean): string | null {
  if (!division) return null
  const entry = QB_CLASS_PREVIEW[division]
  return (isDickinson && entry.dickinson) || entry.base
}

/**
 * Division per wizard work type — the fallback for flows entered outside the
 * division picker. Mirrors the server's defaultDivisionForWork().
 *
 * Occ Health (fit_test) is D8 and Training is D1: both test people, not
 * equipment. Shop/FEX work (field inspection, shop repair) is D6.
 */
export const WORK_TYPE_QB_DIVISION: Record<string, QbDivision> = {
  field_service: 'D3',
  ih_testing: 'D3',
  field_inspection: 'D6',
  // ADR-0017: in-shop air fills bill as safety service, not FEX.
  air_fill: 'D3',
  repair: 'D6',
  rental: 'D4',
  training: 'D1',
  fit_test: 'D8',
  direct_sale: 'D5',
}
