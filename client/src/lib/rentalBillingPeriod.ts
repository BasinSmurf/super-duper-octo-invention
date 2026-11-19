/** Date-only rental windows: first unbilled day through EOM, final pickup, or
 * the date the field sent it through — whichever comes first. AR can still
 * widen the period on the card; this is only the default. */
export function defaultRentalBillingPeriod(rental: { startDate: string; lastBilledThrough?: string | null; endDate?: string | null; releasedThrough?: string | null }) {
  const first = rental.lastBilledThrough ? new Date(+new Date(rental.lastBilledThrough) + 86400000) : new Date(rental.startDate)
  let end = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0))
  for (const cap of [rental.endDate, rental.releasedThrough]) {
    const date = cap ? new Date(cap.slice(0, 10)) : null
    if (date && date >= first && date < end) end = date
  }
  return { start: first.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) }
}
