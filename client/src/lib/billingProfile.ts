import type { BillingProfileSeed } from './db-types'

export interface ProfileMatchContext {
  ticketType?: string | null
  division?: string | null
}

/**
 * Client mirror of the server's billing-profile selector. Picks the best
 * active profile for a ticket's job type. Most-specific scope wins; profiles
 * with no scope are company-wide defaults. Falls back to the first active
 * profile (matching the legacy `companyProfiles[0]` behavior).
 *
 * #3 ships the fallback; #4 adds the job-type scoring below.
 */
export function selectBillingProfileSeed(
  profiles: BillingProfileSeed[] | undefined,
  ctx: ProfileMatchContext,
): BillingProfileSeed | null {
  if (!profiles || profiles.length === 0) return null

  const inScope = (arr: string[] | null | undefined, value: string | null | undefined) =>
    !arr || arr.length === 0 || (value != null && arr.includes(value))

  let best: BillingProfileSeed | null = null
  let bestScore = -1
  for (const p of profiles) {
    // Disqualify if a non-empty scope excludes this ticket's value.
    if (!inScope(p.appliesToTicketTypes, ctx.ticketType)) continue
    if (!inScope(p.appliesToDivisions, ctx.division)) continue
    let score = 0
    if (p.appliesToTicketTypes && p.appliesToTicketTypes.length > 0) score += 2
    if (p.appliesToDivisions && p.appliesToDivisions.length > 0) score += 1
    if (score > bestScore) { bestScore = score; best = p }
  }
  return best ?? profiles[0]
}
