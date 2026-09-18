// #4 Pick the right billing profile for a ticket's job type.
//
// A customer can have several active profiles, each optionally scoped to ticket
// types and/or divisions. Selection is most-specific-wins, deterministic:
//   - disqualify any profile whose non-empty scope EXCLUDES the ticket's value
//   - score the rest (+2 ticketType match, +1 division match)
//   - tiebreak by narrower scope, then most recent effectiveFrom
//   - fall back to an unscoped default, then the first active profile
// This preserves the legacy `companyProfiles[0]` behavior for customers whose
// profiles carry no scope.

export interface SelectableProfile {
  id: string;
  isActive?: boolean;
  effectiveFrom?: Date | string | null;
  effectiveTo?: Date | string | null;
  appliesToTicketTypes?: unknown; // string[] | null
  appliesToDivisions?: unknown;   // string[] | null
}

export interface ProfileSelectContext {
  ticketType?: string | null;
  division?: string | null;
  serviceDate?: Date | null;
}

function asTokens(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function inScope(scope: string[], value: string | null | undefined): boolean {
  return scope.length === 0 || (value != null && scope.includes(value));
}

function effectiveOn(p: SelectableProfile, date: Date): boolean {
  const from = p.effectiveFrom ? new Date(p.effectiveFrom) : null;
  const to = p.effectiveTo ? new Date(p.effectiveTo) : null;
  if (from && from > date) return false;
  if (to && to < date) return false;
  return true;
}

export function selectBillingProfile<T extends SelectableProfile>(
  profiles: T[],
  ctx: ProfileSelectContext,
): T | null {
  if (!profiles || profiles.length === 0) return null;
  const date = ctx.serviceDate ?? new Date();

  const eligible = profiles.filter(p => (p.isActive ?? true) && effectiveOn(p, date));
  if (eligible.length === 0) return null;

  let best: T | null = null;
  let bestScore = -1;
  let bestSpecificity = -1;
  let bestFrom = -Infinity;

  for (const p of eligible) {
    const types = asTokens(p.appliesToTicketTypes);
    const divisions = asTokens(p.appliesToDivisions);
    if (!inScope(types, ctx.ticketType)) continue;
    if (!inScope(divisions, ctx.division)) continue;

    const score = (types.length > 0 ? 2 : 0) + (divisions.length > 0 ? 1 : 0);
    const specificity = types.length + divisions.length;
    const from = p.effectiveFrom ? new Date(p.effectiveFrom).getTime() : 0;

    if (
      score > bestScore ||
      (score === bestScore && specificity > bestSpecificity) ||
      (score === bestScore && specificity === bestSpecificity && from > bestFrom)
    ) {
      best = p;
      bestScore = score;
      bestSpecificity = specificity;
      bestFrom = from;
    }
  }

  // No scoped match → first eligible (matches legacy companyProfiles[0]).
  return best ?? eligible[0];
}
