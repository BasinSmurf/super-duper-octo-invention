/**
 * billingRules.ts — Wave 5 Slices 5A + 5C
 *
 * Centralized resolver for invoice-time billing rules. Today it owns:
 *   - Tier 1 reservation surcharge (5A)
 *   - Per-customer Price Level adjustments (5C)
 * Future rules (hazmat fees, per-customer markups, etc.) layer in here
 * without scattering `if (something) ...` checks across invoice routes.
 *
 * Pattern:
 *   1. Caller builds line items the way it always has.
 *   2. Caller pre-fetches PriceLevels matching the invoice's customer
 *      (resolver stays pure — no DB lookups).
 *   3. Caller invokes resolveInvoiceRules() with the context.
 *   4. Resolver returns:
 *        - lineAdjustments[]: rate/amount changes to apply to existing
 *          line items by index (Price Level)
 *        - extraLines[]: net-new lines to append (Tier 1 fee)
 *        - qbCustomerOverride: invoice-level QB customer swap
 *        - appliedRules[]: names of rules that fired (for audit)
 *   5. Caller applies adjustments, appends extras, recomputes subtotal,
 *      persists.
 *
 * Order of operations inside the resolver matters:
 *   1. Price Level adjustments apply FIRST (changes the line amounts)
 *   2. Tier 1 fee calculated on the post-adjustment subtotal
 *      (a 5% surcharge on a discounted invoice is 5% of the discounted
 *      total, not the gross)
 */

const TIER1_FEE_RATE = 0.05;
const TIER1_FEE_DESCRIPTION = 'Tier 1 reservation fee (5%)';
// Default matches the actual QB Customer record ("Pale Horse Service Inc"
// — singular Service, with Inc) so the QBWC override name lookup hits.
// Tunable via TIER1_BILLING_CUSTOMER_NAME env var if QB ever renames it.
const TIER1_OVERRIDE_CUSTOMER = process.env.TIER1_BILLING_CUSTOMER_NAME || 'Pale Horse Service Inc';

// Sentinel used by parsePriceLevelQueryResponse for whole-level percentage
// adjustments (PriceLevelFixedPercentage on QB side — applies to all items).
const PL_WHOLE_LEVEL_SENTINEL = '*';

export interface BillingRuleTicketContext {
  id: string;
  ticketNumber: string | null;
  pad?: { id: string; tier1: boolean } | null;
  // Tier 1 also lives on the well, because a pad-less well is the majority
  // case — see Well.tier1 in schema.prisma. Either side flagged is enough.
  well?: { id: string; tier1: boolean } | null;
}

export interface BillingRuleLineInput {
  // Identity for Price Level matching. qbItemListId is the primary key
  // QB-side; partNumber is a fallback for legacy/unmapped lines.
  qbItemListId?: string | null;
  partNumber?: string | null;
  // Pricing
  rate: number;
  quantity: number;
  amount: number;
  qbSkip?: boolean;
}

/** Pre-fetched Price Level candidate (caller queries for the customer). */
export interface BillingRulePriceLevel {
  id: string;
  name: string;
  items: Array<{
    qbItemListId: string;          // '*' = whole-level percent
    customPrice: number | null;
    adjustPercent: number | null;
  }>;
}

export interface BillingRuleContext {
  invoiceCompanyId: string;
  invoiceCompanyName: string;
  tickets: BillingRuleTicketContext[];
  lineItems: BillingRuleLineInput[];
  /** Pre-fetched price levels matching this customer (Wave 5C). When
   *  empty/omitted, no per-line adjustments are applied. */
  priceLevels?: BillingRulePriceLevel[];
}

/**
 * One resolved extra line. Matches the shape the invoice routes already
 * pass to `prisma.invoice.create({ lineItems: { create: [...] } })` so the
 * caller can merge it directly.
 */
export interface BillingRuleExtraLine {
  description: string;
  productId: string | null;
  partNumber: string | null;
  quantity: number;
  unitOfMeasure: string;
  rate: number;
  amount: number;
  isTaxable: boolean;
  sourceTicketId: string | null;
  sourceTicketNumber: string | null;
  qbItemListId: string | null;
  qbItemFullName: string | null;
  qbSkip: boolean;
  notes: string | null;
}

export interface BillingRuleLineAdjustment {
  /** Index into ctx.lineItems[] */
  index: number;
  newRate: number;
  newAmount: number;
  /** Human-readable origin: e.g. "price_level:ConocoPhillips Custom Pricing" */
  source: string;
}

export interface BillingRuleResult {
  /** Per-line rate/amount adjustments to apply by index (5C Price Levels). */
  lineAdjustments: BillingRuleLineAdjustment[];
  /** Net-new lines to append (5A Tier 1 surcharge). */
  extraLines: BillingRuleExtraLine[];
  qbCustomerOverride: string | null;
  /** Names of rules that fired — for audit logs + admin visibility. */
  appliedRules: string[];
}

/** What a price level did to a rate, and which level did it. */
export interface PriceLevelResolution {
  rate: number;
  /** Human-readable origin, e.g. "price_level:Continental". */
  source: string;
  priceLevelName: string;
}

/**
 * Resolve one item's rate against a customer's price levels.
 *
 * THE single implementation of "what does this customer pay for this item".
 * Invoice generation calls it per line; dispatch calls it to quote a package
 * before the job goes out. They must not each grow their own copy — a quote
 * that disagrees with the bill is the worst failure this code can have.
 *
 * Precedence, unchanged from the invoice path: a per-item entry beats the
 * whole-level percentage, and the first matching level wins (the caller
 * controls fetch order). customPrice replaces the rate outright; adjustPercent
 * scales the list rate. Returns null when no level touches the item, meaning
 * "list price stands" rather than "free".
 */
export function resolvePriceLevelRate(
  priceLevels: BillingRulePriceLevel[] | undefined,
  qbItemListId: string | null | undefined,
  listRate: number,
): PriceLevelResolution | null {
  if (!priceLevels?.length || !qbItemListId) return null;

  let matched: { pl: BillingRulePriceLevel; item: BillingRulePriceLevel['items'][number] } | null = null;
  for (const pl of priceLevels) {
    const itemMatch = pl.items.find(it => it.qbItemListId === qbItemListId);
    if (itemMatch) { matched = { pl, item: itemMatch }; break; }
    const wholeMatch = pl.items.find(it => it.qbItemListId === PL_WHOLE_LEVEL_SENTINEL);
    if (wholeMatch) { matched = { pl, item: wholeMatch }; break; }
  }
  if (!matched) return null;

  let rate: number | null = null;
  if (matched.item.customPrice != null) {
    rate = round2(matched.item.customPrice);
  } else if (matched.item.adjustPercent != null) {
    rate = round2(listRate * (1 + matched.item.adjustPercent / 100));
  }
  if (rate == null) return null;

  return { rate, source: `price_level:${matched.pl.name}`, priceLevelName: matched.pl.name };
}

export function resolveInvoiceRules(ctx: BillingRuleContext): BillingRuleResult {
  const lineAdjustments: BillingRuleLineAdjustment[] = [];
  const extraLines: BillingRuleExtraLine[] = [];
  let qbCustomerOverride: string | null = null;
  const appliedRules: string[] = [];

  // ─────────────────────────────────────────────────────────────────────
  // Rule (5C): Price Level apply
  // ─────────────────────────────────────────────────────────────────────
  // For each non-skip line, find the FIRST matching PriceLevelItem from the
  // pre-fetched levels. customPrice replaces the rate; adjustPercent scales
  // it; the whole-level percent sentinel ('*') applies to any line in the
  // level that doesn't have a per-item rule. Results in lineAdjustments
  // entries the caller applies by index.
  //
  // We build a working "current amounts" array so the Tier 1 calc downstream
  // sees post-adjustment subtotals.
  const adjustedAmounts = ctx.lineItems.map(li => li.amount || 0);

  if (ctx.priceLevels && ctx.priceLevels.length > 0) {
    for (let i = 0; i < ctx.lineItems.length; i++) {
      const line = ctx.lineItems[i]!;
      if (line.qbSkip) continue;
      if (!line.qbItemListId) continue;

      // Shared with the dispatch-time quote — see resolvePriceLevelRate.
      const resolved = resolvePriceLevelRate(ctx.priceLevels, line.qbItemListId, line.rate);
      if (!resolved) continue;
      const newRate = resolved.rate;
      if (newRate === line.rate) continue; // no-op

      const newAmount = round2(newRate * line.quantity);
      lineAdjustments.push({
        index: i,
        newRate,
        newAmount,
        source: resolved.source,
      });
      adjustedAmounts[i] = newAmount;
      if (!appliedRules.includes('price_level_apply')) {
        appliedRules.push('price_level_apply');
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // Rule (5A): Tier 1 reservation surcharge
  // ─────────────────────────────────────────────────────────────────────
  // Fires when ANY source ticket's pad OR well is flagged tier1. Adds a
  // single 5% line on the post-adjustment subtotal of NON-skip lines. Sets
  // the QB customer override to Pale Horse Services and marks the fee line
  // qbSkip so it stays out of QB.
  //
  // Pad-or-well, not pad-only: almost every reservation well we service has
  // no pad record at all, so a pad-only check silently skipped the fee on
  // the bulk of Tier 1 work. Still ONE fee line per invoice no matter how
  // many of the source tickets (or how many of their pads/wells) qualify.
  const tier1Tickets = ctx.tickets.filter(t => t.pad?.tier1 === true || t.well?.tier1 === true);
  if (tier1Tickets.length > 0) {
    const billableSubtotal = ctx.lineItems
      .reduce((sum, li, i) => (li.qbSkip ? sum : sum + adjustedAmounts[i]!), 0);
    const feeAmount = round2(billableSubtotal * TIER1_FEE_RATE);
    if (feeAmount > 0) {
      extraLines.push({
        description: TIER1_FEE_DESCRIPTION,
        productId: null,
        partNumber: null,
        quantity: 1,
        unitOfMeasure: 'EA',
        rate: feeAmount,
        amount: feeAmount,
        isTaxable: false,
        sourceTicketId: tier1Tickets[0]!.id,
        sourceTicketNumber: tier1Tickets[0]!.ticketNumber,
        qbItemListId: null,
        qbItemFullName: null,
        qbSkip: true,
        notes: `Auto-applied: ${tier1Tickets.length} Tier 1 ticket${tier1Tickets.length === 1 ? '' : 's'}`,
      });
      qbCustomerOverride = TIER1_OVERRIDE_CUSTOMER;
      appliedRules.push('tier1_reservation_fee');
    }
  }

  return { lineAdjustments, extraLines, qbCustomerOverride, appliedRules };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
