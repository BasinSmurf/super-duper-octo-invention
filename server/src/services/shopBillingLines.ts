/**
 * shopBillingLines.ts — shop work order → invoice line shaping.
 *
 * A closed shop WO bills WO-direct: `/api/invoices/generate/from-shop-wo` builds
 * the invoice from ALL the WO's billable units in one pass (no per-unit sweep,
 * no intermediate "RP" repair ticket — that path is retired). This module owns
 * the line SHAPES only; invoices.ts calls it, then runs the Price Level / Tier 1
 * resolver over the result before creating the Invoice.
 *
 * Four line shapes (spec §4):
 *   - Visual-only / roll-up : a unit that passed with no billable detail (or an
 *                             explicit rollup override) → ONE "N × rate" line
 *                             per product, serials in the detail — not N lines.
 *                             Parts + misc on a rolled-up unit still bill.
 *   - In-house labor        : structured `billing.labor.{hours,rate}` when
 *                             present, else the legacy flat product-rate charge
 *                             when parts were used with no time entered.
 *   - Vendor passthrough    : a unit sent to an outside vendor → cost + freight
 *                             + markup% (+ attachment note), read from
 *                             `billing.vendor` (falls back to the legacy
 *                             `customData.vendorBilling` shape).
 *   - Condemned             : inspection labor only, rolled up (condemn stays
 *                             billable; only `isWarranty` suppresses billing).
 * Plus WO-level extras (mileage/trip charge + order-level misc) via
 * `buildWoExtraLines`, appended once per invoice.
 */

import { CLOSING_STATES } from './shopSoftClose.js';
import { isCustomerBillableDisposition } from './shopVendorReceive.js';
import type { ShopVendorDisposition } from '../db.js';

// Terminal-billable item states. The route itself already gates on
// `wo.status === 'closed'` before calling this, so by the time we get here
// every top-level unit should be in one of these — kept as a defensive filter.
//
// Sourced from shopSoftClose's CLOSING_STATES rather than re-typed: "a unit is
// settled" and "a unit is closed" have to be the same statement, and two hand-
// maintained copies of a set like this drift the first time one is edited.
const BILLABLE_STATES = new Set<string>(CLOSING_STATES);

export type LineInput = {
  lineNumber: number;
  lineType: 'labor' | 'part' | 'misc_charge' | 'travel';
  productId: string | null;
  description: string;
  quantity: number;
  unitOfMeasure: string;
  rate: number;
  total: number;
  partNumber: string | null;
  sortOrder: number;
  sourceShopItemId?: string | null;
  serialNumber?: string | null;
  chargeKind?: 'part' | 'labor' | 'service' | 'vendor' | 'misc' | 'travel';
};

/** Per-unit structured billing chunk (item.billing JSONB). All fields optional
 *  — a unit with no billing block falls back to the legacy shapes below. */
type ItemBilling = {
  services?: Array<{ productId: string; partNumber: string; name: string; quantity: number; rate: number; unitOfMeasure?: string }>;
  labor?: { hours?: number | string; rate?: number | string } | null;
  misc?: Array<{ description?: string; amount?: number | string }> | null;
  vendor?: {
    mode?: 'passthrough' | 'catalog_service';
    serviceProductId?: string;
    cost?: number | string;
    freight?: number | string;
    markupPct?: number | string;
    attachmentKey?: string;
    attachmentName?: string;
  } | null;
  rollup?: { enabled?: boolean; rate?: number | string; productId?: string } | null;
};

/** WO-level billing extras (wo.billingExtras JSONB) — mileage + order-level misc. */
export type WoBillingExtras = {
  mileage?: { miles?: number | string; rate?: number | string; flat?: number | string } | null;
  misc?: Array<{ description?: string; amount?: number | string }> | null;
};

export type ShopBillingItem = {
  id: string;
  status: string;
  isWarranty: boolean;
  parentItemId: string | null;
  serialNumber: string;
  equipmentCategory: string;
  equipmentDescription: string | null;
  serviceType: string;
  productId: string | null;
  partsUsed: unknown;
  billing: unknown;
  customData: unknown;
  /** WI-05: null for pre-feature rows, future while the soft window is open. */
  hardClosesAt?: Date | null;

  // ── WI-09: outside-vendor receive ──────────────────────────────────────
  /** Which of the four dispositions the receive step recorded. Null on rows
   *  that predate WI-09, which keep behaving exactly as they did. */
  vendorDisposition?: ShopVendorDisposition | null;
  /** The keyed invoice total. THE source of a passthrough amount. */
  vendorInvoiceTotal?: unknown;

  // NOT HERE, ON PURPOSE: `vendorBillingNotes`.
  //
  // WI-09 requires that the billing notes be impossible to consume in a
  // calculation, rather than merely discouraged. This type is where that is
  // enforced: it is the projection buildShopBillingLines is handed, and the
  // notes are simply not in it. Someone who wants to scrape dollar amounts out
  // of the notes has to widen this type first, in a diff that says so.
  //
  // Do not add it. There is a test that fails if the notes ever change a line.
  product: { id: string; partNumber: string | null; name: string; defaultSellPrice: unknown } | null;
};

type PartCatalogProduct = {
  id: string;
  partNumber: string | null;
  name: string;
  defaultSellPrice: unknown;
  unitOfMeasure?: string | null;
};

/**
 * The ONLY supported way to turn a database row into a ShopBillingItem.
 *
 * This exists because "the billing derivation cannot read the notes" has to be
 * true at RUNTIME, not just in the type checker. The invoice route loads its
 * work order with `include`, so every scalar column is on the object — the
 * notes included. A cast would hide them from the compiler while leaving them
 * sitting there for anyone who casts back.
 *
 * So the row is not cast, it is COPIED, field by field, into a value that
 * genuinely does not contain `vendorBillingNotes`. Adding it back means editing
 * this function and the type above, in a diff that says exactly what it is
 * doing. That is the difference between a rule and a wall.
 */
export function toBillingItem(row: Record<string, unknown>): ShopBillingItem {
  return {
    id: row.id as string,
    status: row.status as string,
    isWarranty: row.isWarranty as boolean,
    parentItemId: (row.parentItemId as string | null) ?? null,
    serialNumber: row.serialNumber as string,
    equipmentCategory: row.equipmentCategory as string,
    equipmentDescription: (row.equipmentDescription as string | null) ?? null,
    serviceType: row.serviceType as string,
    productId: (row.productId as string | null) ?? null,
    partsUsed: row.partsUsed,
    billing: row.billing,
    customData: row.customData,
    hardClosesAt: (row.hardClosesAt as Date | null) ?? null,
    vendorDisposition: (row.vendorDisposition as ShopVendorDisposition | null) ?? null,
    vendorInvoiceTotal: row.vendorInvoiceTotal,
    product: (row.product as ShopBillingItem['product']) ?? null,
    // vendorBillingNotes is NOT copied. That is the entire point of this
    // function; see the note on ShopBillingItem.
  };
}

/**
 * Is this unit billable right now?
 *
 * WI-05 adds the last clause: a unit is billable only once it is HARD closed.
 * The 48-hour soft window exists so the shop can correct what it just did, and
 * an invoice raised against a record still being corrected is worse than one
 * raised two days later. `hardClosesAt` in the future means the window is still
 * open, so the unit is deliberately invisible to billing.
 *
 * Units with no close stamp at all still bill: those predate the feature and
 * the migration backfills them as already hard-closed. Failing open here would
 * be the wrong safety — it would pull historical units OUT of billing.
 */
export function isBillableShopItem(item: ShopBillingItem, now: Date = new Date()): boolean {
  if (!isChargeableShopItem(item)) return false;
  if (!BILLABLE_STATES.has(item.status)) return false;
  if (item.hardClosesAt && item.hardClosesAt.getTime() > now.getTime()) return false;
  // WI-09: three of the four vendor dispositions are non-billable to the
  // customer. A null disposition is "not stated" — every row before WI-09 —
  // and deliberately changes nothing: those units keep being decided by
  // isWarranty and their billing chunk, exactly as they were yesterday.
  if (suppressesVendorBilling(item)) return false;
  return true;
}

/** Preview includes unfinished work, but never warranty/no-charge units or children. */
export function isChargeableShopItem(item: ShopBillingItem): boolean {
  return !item.parentItemId && !item.isWarranty && !suppressesVendorBilling(item);
}

/** True when an explicit vendor disposition says the customer pays nothing. */
function suppressesVendorBilling(item: ShopBillingItem): boolean {
  const d = item.vendorDisposition;
  return d != null && !isCustomerBillableDisposition(d);
}

function unitRate(item: ShopBillingItem): number {
  return item.product?.defaultSellPrice ? parseFloat(String(item.product.defaultSellPrice)) : 0;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function hasUsableNumber(v: unknown): boolean {
  return v !== null && v !== undefined && String(v).trim() !== '' && Number.isFinite(Number(v));
}

/** Fill incomplete saved part rows from the product catalog. Older shop rows
 * can have `{ productId, name, partNumber }` but no unitCost because the UI did
 * not expose a price field; without this, the invoice line exists at $0. */
export function hydrateShopPartCatalogPrices(
  items: ShopBillingItem[],
  products: PartCatalogProduct[],
): ShopBillingItem[] {
  const byId = new Map(products.map(p => [p.id, p]));
  return items.map(item => {
    if (!Array.isArray(item.partsUsed)) return item;
    const parts = (item.partsUsed as Array<Record<string, unknown>>).map(part => {
      const productId = typeof part.productId === 'string' ? part.productId : null;
      const product = productId ? byId.get(productId) : undefined;
      if (!product) return part;

      const next: Record<string, unknown> = { ...part };
      if (!next.partNumber && product.partNumber) next.partNumber = product.partNumber;
      if (!next.name && product.name) next.name = product.name;
      if (!next.unitOfMeasure && product.unitOfMeasure) next.unitOfMeasure = product.unitOfMeasure;
      if (!hasUsableNumber(next.unitCost) && hasUsableNumber(product.defaultSellPrice)) {
        next.unitCost = num(product.defaultSellPrice);
      }
      return next;
    });
    return { ...item, partsUsed: parts };
  });
}

/** Read the structured billing chunk off an item (or {} when absent). */
function itemBilling(item: ShopBillingItem): ItemBilling {
  return item.billing && typeof item.billing === 'object' ? (item.billing as ItemBilling) : {};
}

function categoryLabel(cat: string): string {
  return cat.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function hasParts(item: ShopBillingItem): boolean {
  return Array.isArray(item.partsUsed) && (item.partsUsed as unknown[]).length > 0;
}

/** Outside-vendor passthrough: cost (+ freight, + markup%) we bill through when
 *  a unit went to an outside vendor. Prefers the structured billing.vendor
 *  block; falls back to the legacy customData.vendorBilling shape. Returns null
 *  when no positive cost is recorded. `attachmentName` carries the scanned
 *  vendor invoice for the line note. */
function vendorBilling(
  item: ShopBillingItem,
): { cost: number; freight: number; markupPct: number; attachmentName: string | null } | null {
  const b = itemBilling(item).vendor;
  const cd = item.customData as Record<string, unknown> | null;
  const legacy = cd?.vendorBilling as Record<string, unknown> | undefined;
  const vb = (b && typeof b === 'object' ? b : legacy) as Record<string, unknown> | undefined;

  // A disposition that says the customer pays nothing emits no passthrough
  // line, even if a cost is recorded. Belt and braces: isBillableShopItem
  // already filters these out upstream, but a warranty unit's vendor cost is
  // exactly the kind of number that must never reach an invoice by a route
  // nobody remembered to guard.
  if (suppressesVendorBilling(item)) return null;
  if (vb?.mode === 'catalog_service') {
    if (!itemBilling(item).services?.some(s => s.productId === vb.serviceProductId)) {
      throw new Error(`Vendor billing for S/N ${item.serialNumber} needs its linked catalog service`);
    }
    // Cost remains on the unit for internal accounting. The linked service
    // already emits the customer charge, with our SKU and selling price.
    return null;
  }

  // WI-09: the total keyed at receive. Where the cost comes from when nobody
  // has since overridden it on the billing card — which is the normal case, and
  // the point of keying it: billing gets a number without opening the PDF.
  //
  // PRECEDENCE, and why this way round: an explicit billing-card cost wins.
  // The keyed total is what the vendor charged; the billing-card figure is what
  // a biller decided to charge through, which is a later and more specific
  // decision (partial allocation, a line split across tickets). In the ordinary
  // case they are the same number and the question never arises.
  const keyed = num(item.vendorInvoiceTotal);
  const cost = num(vb?.cost) > 0 ? num(vb?.cost) : keyed;
  if (cost <= 0) return null;
  return {
    cost,
    freight: num(vb?.freight),
    markupPct: num(vb?.markupPct),
    attachmentName: typeof vb?.attachmentName === 'string' ? vb.attachmentName : null,
  };
}

/** True when a unit should roll into an "N units × rate" inspection/visual
 *  line rather than getting its own itemized labor. Explicit via
 *  billing.rollup.enabled, or implicit for a pass with no billing detail at
 *  all (the legacy visual-only shape). */
function isRolledUp(item: ShopBillingItem, b: ItemBilling): boolean {
  if (b.rollup?.enabled) return true;
  const hasDetail =
    (b.services?.length ?? 0) > 0 ||
    (b.labor && (num(b.labor.hours) > 0 || num(b.labor.rate) > 0)) ||
    hasParts(item) ||
    vendorBilling(item) !== null ||
    (Array.isArray(b.misc) && b.misc.length > 0);
  return !hasDetail;
}

/** Build the billing lines for a settled subset, applying the four shapes.
 *  Exported for unit testing of the roll-up / shape logic. */
export function buildShopBillingLines(items: ShopBillingItem[]): LineInput[] {
  const lines: LineInput[] = [];
  let n = 1;
  const push = (l: Omit<LineInput, 'lineNumber' | 'sortOrder'>) => {
    lines.push({ ...l, lineNumber: n, sortOrder: n });
    n++;
  };

  // Buckets for the roll-up shapes, keyed by product so each rate rolls into one
  // line with serials in the detail.
  const visualGroups = new Map<string, { rate: number; productId: string | null; partNumber: string | null; serials: string[]; category: string }>();
  const condemnGroups = new Map<string, { rate: number; productId: string | null; partNumber: string | null; serials: string[]; category: string }>();

  const label = (item: ShopBillingItem) =>
    `${item.serialNumber}${item.equipmentDescription ? ` (${item.equipmentDescription})` : ''}`;
  const partLines = (item: ShopBillingItem) => {
    for (const part of (item.partsUsed as Array<Record<string, unknown>>) ?? []) {
      const pRate = num(part.unitCost);
      const qty = num(part.quantity) || 1;
      push({
        lineType: 'part',
        productId: (part.productId as string) || null,
        description: `${(part.description as string) || (part.name as string) || (part.partNumber as string) || 'Part'} — used on S/N ${item.serialNumber}`,
        sourceShopItemId: item.id,
        serialNumber: item.serialNumber,
        chargeKind: 'part',
        quantity: qty,
        unitOfMeasure: (part.unitOfMeasure as string) || 'EA',
        rate: pRate,
        total: round2(pRate * qty),
        partNumber: (part.partNumber as string) || null,
      });
    }
  };
  const miscLines = (item: ShopBillingItem, b: ItemBilling) => {
    for (const m of b.misc ?? []) {
      const amount = num(m?.amount);
      if (amount === 0 && !m?.description) continue;
      push({
        lineType: 'misc_charge',
        sourceShopItemId: item.id,
        serialNumber: item.serialNumber,
        chargeKind: 'misc',
        productId: null,
        description: m?.description ? `${m.description} — ${label(item)}` : `Misc — ${label(item)}`,
        quantity: 1,
        unitOfMeasure: 'EA',
        rate: round2(amount),
        total: round2(amount),
        partNumber: null,
      });
    }
  };

  for (const item of items) {
    const rate = unitRate(item);
    const b = itemBilling(item);

    // Explicit catalog services replace the implicit inspection/condemn fee.
    // They remain separate from any entered repair labor and vendor invoice.
    for (const service of b.services ?? []) {
      const quantity = num(service.quantity);
      const serviceRate = num(service.rate);
      push({ lineType: 'labor', chargeKind: 'service', productId: service.productId,
        sourceShopItemId: item.id, serialNumber: item.serialNumber,
        description: `${service.name} — S/N ${item.serialNumber}`,
        partNumber: service.partNumber, quantity, unitOfMeasure: service.unitOfMeasure || 'EA',
        rate: serviceRate, total: round2(quantity * serviceRate) });
    }

    if (item.status === 'condemned' && !b.services?.length && !b.labor && !vendorBilling(item)) {
      // Condemned → inspection labor only (no parts), rolled up. A per-unit rate
      // override on the roll-up block wins over the product default.
      const rRate = b.rollup?.rate != null ? num(b.rollup.rate) : rate;
      const key = `${item.productId ?? 'none'}|${rRate}`;
      const g = condemnGroups.get(key) ?? { rate: rRate, productId: item.productId, partNumber: item.product?.partNumber ?? null, serials: [], category: item.equipmentCategory };
      g.serials.push(item.serialNumber);
      condemnGroups.set(key, g);
      continue;
    }

    // Roll-up (explicit or the legacy visual-only pass): the inspection/service
    // charge groups into one "N × rate" line. Parts + misc STILL bill for the
    // unit — a rolled-up inspection can carry replaced parts (e.g. a $20 FEX
    // inspection that also swapped a CO sensor). A pure visual pass simply has
    // no parts/misc, so nothing extra emits.
    if (!b.services?.length && isRolledUp(item, b)) {
      const rRate = b.rollup?.rate != null ? num(b.rollup.rate) : rate;
      const pid = b.rollup?.productId ?? item.productId;
      const key = `${pid ?? 'none'}|${rRate}`;
      const g = visualGroups.get(key) ?? { rate: rRate, productId: pid, partNumber: item.product?.partNumber ?? null, serials: [], category: item.equipmentCategory };
      g.serials.push(item.serialNumber);
      visualGroups.set(key, g);
      partLines(item);
      miscLines(item, b);
      // A roll-up may also carry a vendor invoice; emit it below without
      // repeating the parts or adding an implicit labor charge.
    }

    const vb = vendorBilling(item);

    if (vb) {
      // Vendor passthrough — structurally distinct from in-house labor.
      const marked = vb.cost * (1 + vb.markupPct / 100) + vb.freight;
      push({
        lineType: 'misc_charge',
        chargeKind: 'vendor', sourceShopItemId: item.id, serialNumber: item.serialNumber,
        productId: null,
        description: `Outside vendor service — ${label(item)} [vendor cost ${vb.cost.toFixed(2)}${vb.markupPct ? ` +${vb.markupPct}%` : ''}${vb.freight ? ` +freight ${vb.freight.toFixed(2)}` : ''}${vb.attachmentName ? ` — invoice: ${vb.attachmentName}` : ''}]`,
        quantity: 1,
        unitOfMeasure: 'EA',
        rate: round2(marked),
        total: round2(marked),
        partNumber: null,
      });
    }

    if (!b.services?.length && isRolledUp(item, b)) continue;

    // In-house: a labor line + parts + misc.
    if (b.labor && (num(b.labor.hours) > 0 || num(b.labor.rate) > 0)) {
      // Structured time: hours × rate.
      const hours = num(b.labor.hours) || 1;
      const lRate = num(b.labor.rate);
      push({
        lineType: 'labor',
        chargeKind: 'labor', sourceShopItemId: item.id, serialNumber: item.serialNumber,
        productId: item.productId,
        description: `${item.serviceType.replace(/_/g, ' ')} — ${label(item)}`,
        quantity: hours,
        unitOfMeasure: 'HR',
        rate: lRate,
        total: round2(hours * lRate),
        partNumber: item.product?.partNumber ?? null,
      });
    } else if (hasParts(item) && !vb && !b.services?.length) {
      // Parts issued but no time entered → keep the legacy flat labor charge so
      // the repair carries a service line at the product default rate.
      push({
        lineType: 'labor',
        chargeKind: 'labor', sourceShopItemId: item.id, serialNumber: item.serialNumber,
        productId: item.productId,
        description: `${item.serviceType.replace(/_/g, ' ')} — ${label(item)}`,
        quantity: 1,
        unitOfMeasure: 'EA',
        rate,
        total: rate,
        partNumber: item.product?.partNumber ?? null,
      });
    }
    partLines(item);
    miscLines(item, b);
  }

  // Emit rolled-up visual-only lines (188 × rate, serials in detail — not 188 lines).
  for (const g of visualGroups.values()) {
    const qty = g.serials.length;
    push({
      lineType: 'labor',
      productId: g.productId,
      description: `Visual inspection — ${categoryLabel(g.category)} (${qty} unit${qty === 1 ? '' : 's'}) [${g.serials.join(', ')}]`,
      quantity: qty,
      unitOfMeasure: 'EA',
      rate: g.rate,
      total: round2(g.rate * qty),
      partNumber: g.partNumber,
    });
  }

  // Emit rolled-up condemned inspection-labor lines.
  for (const g of condemnGroups.values()) {
    const qty = g.serials.length;
    push({
      lineType: 'labor',
      productId: g.productId,
      description: `Inspection (condemned) — ${categoryLabel(g.category)} (${qty} unit${qty === 1 ? '' : 's'}) [${g.serials.join(', ')}]`,
      quantity: qty,
      unitOfMeasure: 'EA',
      rate: g.rate,
      total: round2(g.rate * qty),
      partNumber: g.partNumber,
    });
  }

  return lines;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Build the WO-level extra lines (mileage/trip + order-level misc). These
 *  belong to the whole order, not a single unit. `startAt` is the next line
 *  number after the per-unit lines. Returns [] when nothing is set. Bills
 *  exactly once since WO-direct invoicing only ever runs a single pass at
 *  close (no re-sweep, so no billedTicketId-style dedupe needed here).
 *
 *  `travelProduct` is the shop's division mileage part (D6 → 0600001). Without
 *  it the per-mile line carries no product at all, so the QB push falls back to
 *  the catch-all Misc item and the miles land nowhere useful. The flat trip
 *  charge is deliberately left unmapped — it isn't mileage. */
export function buildWoExtraLines(
  extras: WoBillingExtras | null | undefined,
  startAt: number,
  travelProduct?: { id: string; partNumber: string } | null,
): LineInput[] {
  if (!extras) return [];
  const lines: LineInput[] = [];
  let n = startAt;
  const push = (l: Omit<LineInput, 'lineNumber' | 'sortOrder'>) => {
    lines.push({ ...l, lineNumber: n, sortOrder: n });
    n++;
  };

  const m = extras.mileage;
  if (m) {
    const miles = num(m.miles);
    const rate = num(m.rate);
    const flat = num(m.flat);
    if (miles > 0 && rate > 0) {
      push({
        lineType: 'travel',
        productId: travelProduct?.id ?? null,
        description: travelProduct ? `${travelProduct.partNumber} Mileage` : 'Mileage',
        quantity: miles,
        unitOfMeasure: 'MI',
        rate,
        total: round2(miles * rate),
        partNumber: travelProduct?.partNumber ?? null,
      });
    } else if (flat > 0) {
      push({ lineType: 'travel', productId: null, description: 'Trip charge', quantity: 1, unitOfMeasure: 'EA', rate: flat, total: flat, partNumber: null });
    }
  }

  for (const item of extras.misc ?? []) {
    const amount = num(item?.amount);
    if (amount === 0 && !item?.description) continue;
    push({ lineType: 'misc_charge', productId: null, description: item?.description || 'Misc', quantity: 1, unitOfMeasure: 'EA', rate: round2(amount), total: round2(amount), partNumber: null });
  }

  return lines;
}
