// #C Rental composition helpers.
//
// The redesigned Create Rental flow captures a stackable composition (Trailer
// +manned, Gas Monitor product specs, Other items, Drilling Rig BOM) instead of
// the three classification booleans. Those booleans are informational-only
// (display + v1 API), so we keep them populated by DERIVING them from the
// composition on every write — no downstream consumer changes.

// #5 Each composition line carries a per-unit `rate` (in the agreement's
// billingRateType units), set at creation. Billing reads rate × qty × periods.
export interface RentalComposition {
  trailer?: { manned: boolean; rate?: number | null } | null;
  gasMonitors?: { id?: string; productId: string; productName?: string; qty?: number; rate?: number | null }[];
  other?: { id?: string; label: string; qty?: number; productId?: string | null; rate?: number | null }[];
  drillingRig?: boolean;
  // Baseline BOM snapshot resolved from the customer's saved package at
  // dispatch. DESCRIPTIVE — the roster of what the package covers, and the axis
  // the deploy-diff compares scanned gear against. It does NOT bill (the single
  // `bomPackage` line below does), so it stays out of unpricedCompositionLines.
  // equipmentCategory = ProductCategory. Stored raw (composition is JSONB).
  bom?: { label: string; qty?: number; rate?: number | null; equipmentCategory?: string; productId?: string | null }[];
  bomType?: 'standard' | 'manned' | 'unmanned' | 'other' | 'rig' | 'drilling' | null;
  // The package itself, as ONE billable line — "Standard Package @ daily rate",
  // qty 1 per billing period. This is what a customer with an MSA actually pays
  // for the baseline; the individual `bom` rows above are the contents, not
  // charges. productId is what lets the customer's price level reach this line
  // (the invoice resolver matches on qbItemListId), so a bound package bills at
  // the MSA rate rather than list.
  bomPackage?: {
    label: string;
    bomType?: 'standard' | 'manned' | 'unmanned' | 'other' | 'rig' | 'drilling' | null;
    productId?: string | null;
    productName?: string | null;
    qty?: number;
    rate?: number | null;
  } | null;
  // Gear deployed ABOVE the baseline, resolved at deploy time by diffing scanned
  // serials against `bom` per equipmentCategory. A baseline of 4 area monitors
  // against 5 scanned yields one row: 1× area monitor at that row's own rate.
  // Under-deploys don't appear here — the package bills whole either way.
  bomExtras?: {
    id?: string;
    label: string;
    equipmentCategory?: string;
    productId?: string | null;
    qty?: number;
    rate?: number | null;
  }[];
}

// #5 A rate is "set" when it's an actual number — INCLUDING 0, which means the
// line is deliberately free/included (a loaner, a waived charge). `null`/absent
// means "not priced yet", which is an error state we fail on rather than guess.
// (Don't collapse 0 and null with `> 0`: that loses the free-vs-forgotten signal.)
export const hasRate = (r?: number | null): r is number => typeof r === 'number';

/**
 * #5 True when the composition carries at least one rated line — the signal to
 * bill from the composition (rate × qty × periods) instead of per serialized
 * item. Legacy rentals + walk-ins (no rated composition) fall back to item rates.
 */
export function hasRatedComposition(composition: unknown): boolean {
  if (!composition || typeof composition !== 'object') return false;
  const c = composition as RentalComposition;
  if (c.trailer && hasRate(c.trailer.rate)) return true;
  if (Array.isArray(c.gasMonitors) && c.gasMonitors.some(g => hasRate(g.rate))) return true;
  if (Array.isArray(c.other) && c.other.some(o => hasRate(o.rate))) return true;
  if (Array.isArray(c.bom) && c.bom.some(b => hasRate(b.rate))) return true;
  if (c.bomPackage && hasRate(c.bomPackage.rate)) return true;
  if (Array.isArray(c.bomExtras) && c.bomExtras.some(e => hasRate(e.rate))) return true;
  return false;
}

/**
 * #5 Labels of composition lines that are PRESENT but have no rate set — the
 * lines that would silently vanish under composition billing. The `bom` roster
 * is excluded: it lists what the package CONTAINS, bundled under the package
 * (or rig/other) rate rather than priced row by row. The package line itself
 * and any over-baseline extras are NOT excluded — those are real charges. Used
 * to fail invoice generation loud instead of under-billing the job.
 */
export function unpricedCompositionLines(composition: unknown): string[] {
  if (!composition || typeof composition !== 'object') return [];
  const c = composition as RentalComposition;
  const missing: string[] = [];
  if (c.trailer && !hasRate(c.trailer.rate)) {
    missing.push(`Trailer (${c.trailer.manned ? 'Manned' : 'Unmanned'})`);
  }
  for (const g of c.gasMonitors || []) {
    if (g.productId && !hasRate(g.rate)) missing.push(g.productName || 'Gas Monitor');
  }
  for (const o of c.other || []) {
    if (o.label?.trim() && !hasRate(o.rate)) missing.push(o.label.trim());
  }
  // The package line and any deploy-time overage ARE charges, so an unpriced one
  // is the same silent-under-bill this guard exists to prevent. The `bom` roster
  // stays exempt — it's the contents of the package, not a charge.
  if (c.bomPackage && !hasRate(c.bomPackage.rate)) {
    missing.push(c.bomPackage.label || 'Rental package');
  }
  for (const e of c.bomExtras || []) {
    // Deploy already names extras "<item> (over baseline)"; don't say it twice.
    const label = e.label?.trim();
    if (label && !hasRate(e.rate)) missing.push(/\(over baseline\)$/i.test(label) ? label : `${label} (over baseline)`);
  }
  return missing;
}

/** Stable key for an over-baseline extra; older rows may carry no id. */
export const bomExtraKey = (e: { id?: string }, index: number) => e.id || `extra-${index}`;

export interface BomExtraCorrection { key: string; rate: number | null; qty: number }

/**
 * The office's correction of what deploy resolved as over-baseline: price it,
 * change the count, or drop it (absent from `corrections`). A correction, not a
 * dated change — it describes what went out on day one — so callers apply it to
 * every composition window, not only the current one.
 *
 * `scope` = the keys the office was actually looking at (the current
 * window's extras). An extra outside it belongs to an earlier window — e.g.
 * monitors that were overages before an on-job package switch folded them in —
 * and is left alone rather than read as "dropped".
 */
export function correctBomExtras<T extends RentalComposition | Record<string, any>>(
  composition: T, corrections: BomExtraCorrection[], scope?: Set<string>,
): T {
  const extras = ((composition as RentalComposition).bomExtras || []);
  const byKey = new Map(corrections.map(c => [c.key, c]));
  const kept = extras.flatMap((e, i) => {
    const key = bomExtraKey(e, i);
    if (scope && !scope.has(key)) return [e];
    const c = byKey.get(key);
    return c ? [{ ...e, rate: c.rate, qty: c.qty }] : [];
  });
  const { bomExtras: _drop, ...rest } = composition as RentalComposition;
  return (kept.length ? { ...rest, bomExtras: kept } : rest) as T;
}

export interface RentalFlags {
  isManned: boolean;
  isRigJob: boolean;
  monitorsIncluded: boolean;
}

/**
 * Derive the legacy classification booleans from a composition.
 * Returns null when there's no composition (caller keeps client-sent booleans).
 */
export function deriveRentalFlags(composition: unknown): RentalFlags | null {
  if (!composition || typeof composition !== 'object') return null;
  const c = composition as RentalComposition;
  return {
    // Manned only means anything when a trailer is on the job.
    isManned: c.trailer ? !!c.trailer.manned : false,
    isRigJob: !!c.drillingRig,
    monitorsIncluded: Array.isArray(c.gasMonitors) && c.gasMonitors.length > 0,
  };
}

// Rentals are always D4 today ("not forever") — keep it a single configurable
// default rather than a literal scattered across the codebase. Applied to
// rental deploy tickets; the UI choice is hidden for now.
export const RENTAL_DEFAULT_DIVISION = 'D4';
