// Shared rental rate helpers. Kept in one place so the dispatch dialog, the
// rental detail/edit views, and the deploy wizard can't drift on how a rate
// type is labelled or what counts as "priced".

export type RateType = 'daily' | 'weekly' | 'monthly'

/** Short unit suffix for a rate type — "day" | "wk" | "mo" (for "$35/day"). */
export function rateUnitAbbrev(rateType?: string | null): string {
  return rateType === 'weekly' ? 'wk' : rateType === 'monthly' ? 'mo' : 'day'
}

/** Long unit word for a rate type — "day" | "week" | "month". */
export function rateUnitLong(rateType?: string | null): string {
  return rateType === 'weekly' ? 'week' : rateType === 'monthly' ? 'month' : 'day'
}

/**
 * A composition/line rate is "set" when it's an actual number — INCLUDING 0,
 * which means deliberately free/included. null/undefined = not priced yet.
 * Mirrors the server's hasRate() in services/rentalComposition.ts.
 */
export const hasRate = (r?: number | null): r is number => typeof r === 'number'
