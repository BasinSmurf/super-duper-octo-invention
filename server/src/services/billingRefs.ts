// #3 Structured billing references.
//
// A ticket's billing references are captured as a repeating list of typed rows
// ({ type: 'po' | 'afe' | 'cost_code', value }). The flat columns
// poNumber/afeNumber/costCenter remain the wire contract for QuickBooks and
// Enverus, so we DERIVE them from the list (first non-empty value per type).
//
// The server is authoritative: whenever billingRefs is present on a write, it
// recomputes the flats and ignores any client-sent flats (prevents drift from
// older app versions, the portal, or integrations sending stale values).

export type BillingRefType = 'po' | 'afe' | 'cost_code';

export interface BillingRef {
  id?: string;
  type: BillingRefType;
  value: string;
  required?: boolean;
}

export interface FlatBillingRefs {
  poNumber: string | null;
  afeNumber: string | null;
  costCenter: string | null;
}

/** First non-empty value for each type, or null. */
export function deriveFlatBillingRefs(refs: unknown): FlatBillingRefs {
  const out: FlatBillingRefs = { poNumber: null, afeNumber: null, costCenter: null };
  if (!Array.isArray(refs)) return out;
  for (const raw of refs) {
    const r = raw as BillingRef;
    if (!r || typeof r.value !== 'string') continue;
    const v = r.value.trim();
    if (!v) continue;
    if (r.type === 'po' && out.poNumber === null) out.poNumber = v;
    else if (r.type === 'afe' && out.afeNumber === null) out.afeNumber = v;
    else if (r.type === 'cost_code' && out.costCenter === null) out.costCenter = v;
  }
  return out;
}

/**
 * Given an incoming write payload, return the flat-field overrides to apply.
 * When billingRefs is present, the derived flats win (authoritative). When it
 * is absent (old clients), returns {} so the caller leaves flats as sent.
 */
export function flatOverridesFromPayload(payload: { billingRefs?: unknown }): Partial<FlatBillingRefs> {
  if (payload.billingRefs === undefined || payload.billingRefs === null) return {};
  return deriveFlatBillingRefs(payload.billingRefs);
}
