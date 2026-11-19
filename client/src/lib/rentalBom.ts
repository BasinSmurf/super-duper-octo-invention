// Per-customer rental BOM (Bill of Materials) — the baseline gear a customer's
// flat rig-up + daily rate covers. Standard is the default; Drilling is the
// package the rig-job toggle resolves to. Shared by the customer-profile editor
// (CompanyDetailPage), dispatch pre-fill (DispatchRentalDialog), and the
// deploy-diff in the rental wizard (TicketWizard).
//
// Billing model: the package bills as ONE line at the package rate. The rows
// below are its CONTENTS, not charges — they exist to say what a job must
// deploy, and to give the deploy-diff something to compare scanned gear
// against. Only gear ABOVE the baseline generates its own line.

export type RentalBomType = 'standard' | 'manned' | 'unmanned' | 'other' | 'rig' | 'drilling'

/** The slice of a Product a BOM needs: enough to price a line and to let the
 *  customer's price level reach it at invoice time (matched on qbItemListId). */
export interface RentalBomProduct {
  id: string
  name: string
  partNumber?: string | null
  category?: string | null
  qbItemListId?: string | null
  qbItemFullName?: string | null
  // Prisma Decimal columns serialize to STRINGS over JSON, so a rate coming
  // straight off the API is "275", not 275. Typed honestly here and normalized
  // by productRateFor — hasRate() tests `typeof === 'number'`, so a string rate
  // reads as "not priced" and silently blocks dispatch.
  defaultRentalRateDaily?: number | string | null
  defaultRentalRateWeekly?: number | string | null
  defaultRentalRateMonthly?: number | string | null
  // The QuickBooks price, synced from SalesPrice by the item pull
  // (routes/qbwc.ts). For the rental catalog this IS the rate — the SKU encodes
  // its own period ("… (Daily)", "… (Weekly)", "… (Monthly)") — and it's the
  // only price the real catalog carries.
  defaultSellPrice?: number | string | null
}

export interface RentalBomItem {
  id: string
  // Equipment TYPE — a ProductCategory value (the axis deployed gear resolves
  // to via Product.category), NOT a specific product/serial. This is what the
  // deploy-diff groups on.
  equipmentCategory: string
  label: string | null
  qty: number
  sortOrder: number
  // The item an OVERAGE of this row bills as. Optional: an unbound row still
  // diffs, it just can't auto-price the extra.
  productId?: string | null
  product?: RentalBomProduct | null
}

export interface RentalBom {
  id: string
  bomType: RentalBomType
  // A customer can hold several packages of one type — the variants their MSA
  // prices separately ("w/ gas detection" vs "no monitors"). name tells them
  // apart; isDefault is the one dispatch preselects for the type.
  name?: string | null
  isDefault?: boolean
  manned: boolean
  includedTechs: number
  notes: string | null
  isActive: boolean
  items: RentalBomItem[]
  // The item the package as a whole bills as. Unbound → the package stays
  // descriptive and nothing auto-prices, exactly as before this existed.
  packageProductId?: string | null
  packageProduct?: RentalBomProduct | null
  // What THIS customer pays for the package item, resolved server-side through
  // their QuickBooks price level — the same helper the invoice bills with, so
  // the quote and the bill agree. null = no level touches the item, list stands.
  packageRate?: number | string | null
  packagePriceLevel?: string | null
}

export type RentalRateType = 'daily' | 'weekly' | 'monthly'

// Equipment types a rental BOM can list — the rental-relevant subset of the
// ProductCategory enum. Labels are field-facing.
export const RENTAL_EQUIPMENT_CATEGORIES: { value: string; label: string }[] = [
  { value: 'monitor_area', label: 'Area Monitor' },
  { value: 'monitor_personal', label: 'Personal Monitor' },
  { value: 'supplied_air_component', label: 'Supplied Air / SCBA' },
  { value: 'accessory', label: 'Accessory / Case' },
  { value: 'assembly', label: 'Assembly' },
  { value: 'consumable', label: 'Consumable' },
  { value: 'misc', label: 'Misc' },
]

export const EQUIP_CAT_LABEL: Record<string, string> = Object.fromEntries(
  RENTAL_EQUIPMENT_CATEGORIES.map(c => [c.value, c.label]),
)

export const BOM_TYPE_LABELS: Record<RentalBomType, string> = {
  standard: 'Standard',
  manned: 'Manned',
  unmanned: 'Unmanned',
  other: 'Other',
  rig: 'Rig',
  drilling: 'Drilling',
}

/** Coerce a rate that may have arrived as a Decimal-serialized string. Blank
 *  and non-numeric both mean "no rate", NOT 0 — 0 is a deliberate free line. */
function toRate(v: number | string | null | undefined): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/**
 * The product's rate in the agreement's billing unit, as a real number.
 *
 * Falls back to the QuickBooks price when no unit-specific rental rate is set,
 * because on the real catalog that's where the rate actually lives: every
 * QB-synced item carries defaultSellPrice, and essentially none carry
 * defaultRentalRate* (those only ever held seed/demo fixtures). QB is the
 * pricing authority — copying its numbers into a second column would just
 * create something to go stale the next time AR reprices.
 *
 * The period comes from the item, not this function: the rental SKUs are split
 * by term ("Air Trailer — Base Rental (Daily)" vs "(Weekly)" vs "(Monthly)"),
 * so choosing the item chooses the unit. Whatever it returns is a seed the
 * dispatcher still sees and can overwrite before dispatching.
 */
export function productRateFor(p: RentalBomProduct | null | undefined, rateType: RentalRateType): number | null {
  if (!p) return null
  const unitRate =
    rateType === 'weekly' ? p.defaultRentalRateWeekly
    : rateType === 'monthly' ? p.defaultRentalRateMonthly
    : p.defaultRentalRateDaily
  return toRate(unitRate) ?? toRate(p.defaultSellPrice)
}

/** "Unmanned · w/ gas detection" — how a package is named on pickers. */
export function bomDisplayName(bom: RentalBom): string {
  const type = BOM_TYPE_LABELS[bom.bomType]
  const name = bom.name?.trim() || bom.packageProduct?.name
  return name ? `${type} · ${name}` : `${type} package`
}

/** Default first, then by name — the order every picker lists variants in. */
function byDefaultThenName(a: RentalBom, b: RentalBom): number {
  if (!!a.isDefault !== !!b.isDefault) return a.isDefault ? -1 : 1
  return (a.name || '').localeCompare(b.name || '')
}

/**
 * Every package variant that fits a rental: drilling/rig packages stay tied to
 * the rig toggle; ordinary trailer packages split on the manned flag. Legacy
 * Standard/Drilling rows remain fallbacks during rollout. The first group with
 * anything in it wins, default variant first — so [0] is what dispatch
 * preselects and the rest are what the dispatcher can switch to.
 */
export function packageVariants(boms: RentalBom[], drilling: boolean, manned = true): RentalBom[] {
  const groups: ((b: RentalBom) => boolean)[] = drilling
    ? [b => b.bomType === 'rig', b => b.bomType === 'drilling']
    : [
        b => b.bomType === (manned ? 'manned' : 'unmanned'),
        b => b.bomType === 'standard' && b.manned === manned,
        b => b.bomType === 'standard',
      ]
  for (const match of groups) {
    const hit = boms.filter(match)
    if (hit.length) return hit.sort(byDefaultThenName)
  }
  return []
}


/**
 * Flatten a BOM into the baseline snapshot stored on a rental's composition —
 * the roster of what the package covers, frozen with the agreement. Carries
 * equipmentCategory (the deploy-diff axis) and productId (so an overage of a
 * row can be priced at deploy without re-fetching the customer's BOM).
 */
export function bomBaselineItems(bom: RentalBom | null): {
  label: string; qty: number; equipmentCategory: string; productId: string | null
}[] {
  if (!bom) return []
  return bom.items.map(i => ({
    label: i.label || EQUIP_CAT_LABEL[i.equipmentCategory] || i.equipmentCategory,
    qty: i.qty,
    equipmentCategory: i.equipmentCategory,
    productId: i.productId ?? null,
  }))
}

export interface RentalBomPackageLine {
  label: string
  bomType: RentalBomType
  productId: string | null
  productName: string | null
  qty: number
  rate: number | null
  /** Which price level set the rate, when one did. Shown so a dispatcher can
   *  see the number is the customer's negotiated rate and not a list price. */
  priceLevel: string | null
}

/**
 * The single billable line for the package itself, seeded from the bound
 * package product's rental rate in the agreement's unit. rate comes back null
 * when the package has no product bound (or that product has no rate for this
 * unit) — the dispatcher fills it in, and dispatch won't submit until they do.
 */
export function bomPackageLine(bom: RentalBom | null, rateType: RentalRateType): RentalBomPackageLine | null {
  if (!bom) return null
  // The customer's own rate wins over any list price: the package part is
  // generic, so list is the same number for everyone and only the price level
  // says what this customer actually pays.
  const negotiated = toRate(bom.packageRate)
  return {
    // The QB item's own name: it's what prints on the invoice and what AR
    // reconciles against the price level, so the line reads the same in both.
    label: bom.packageProduct?.name || (bom.name?.trim() ? `${BOM_TYPE_LABELS[bom.bomType]} Package — ${bom.name.trim()}` : `${BOM_TYPE_LABELS[bom.bomType]} Package`),
    bomType: bom.bomType,
    productId: bom.packageProductId ?? null,
    productName: bom.packageProduct?.name ?? null,
    qty: 1,
    rate: negotiated ?? productRateFor(bom.packageProduct, rateType),
    priceLevel: negotiated != null ? (bom.packagePriceLevel ?? null) : null,
  }
}

/**
 * Drop from the deployed list the gear dispatch already put on its own priced
 * line (a gas-monitor or other spec), so it can't ALSO read as over-baseline
 * and bill a second time. Consumes up to `alreadyLined` entries per category,
 * in scan order; anything past that count still counts toward the baseline.
 */
export function netAlreadyLined(
  deployedCategories: (string | null | undefined)[],
  alreadyLined: Map<string, number>,
): (string | null)[] {
  const remaining = new Map(alreadyLined)
  const out: (string | null)[] = []
  for (const cat of deployedCategories) {
    const left = cat ? remaining.get(cat) || 0 : 0
    if (cat && left > 0) {
      remaining.set(cat, left - 1)
      continue
    }
    out.push(cat ?? null)
  }
  return out
}

/** One category's baseline-vs-deployed count. `over`/`short` are never both >0. */
export interface BomDiffRow {
  equipmentCategory: string
  label: string
  productId: string | null
  expected: number
  deployed: number
  over: number
  short: number
}

/**
 * Compare what's actually going out against the package baseline, grouped by
 * equipment category — the axis both sides share (BOM rows carry it directly,
 * deployed serials resolve to it via Product.category).
 *
 * Categories deployed that the baseline never mentioned show up too, with
 * expected 0: gear outside the package is over-baseline by definition. Rows
 * short of baseline are reported but don't reduce anything — the package bills
 * whole either way, so a short-deploy is a field question, not a credit.
 */
export function diffDeployedAgainstBaseline(
  baseline: { label: string; qty?: number; equipmentCategory?: string; productId?: string | null }[],
  deployedCategories: (string | null | undefined)[],
): BomDiffRow[] {
  const deployedCounts = new Map<string, number>()
  for (const c of deployedCategories) {
    if (!c) continue
    deployedCounts.set(c, (deployedCounts.get(c) || 0) + 1)
  }

  const rows: BomDiffRow[] = []
  const seen = new Set<string>()

  // Baseline rows can repeat a category (two rows of area monitors); collapse
  // to one row per category so the counts compare like-for-like.
  for (const b of baseline) {
    const cat = b.equipmentCategory
    if (!cat || seen.has(cat)) continue
    seen.add(cat)
    const expected = baseline
      .filter(x => x.equipmentCategory === cat)
      .reduce((sum, x) => sum + (x.qty || 1), 0)
    const deployed = deployedCounts.get(cat) || 0
    // Price an overage off the first row of that category that names a product.
    const productId = baseline.find(x => x.equipmentCategory === cat && x.productId)?.productId ?? null
    rows.push({
      equipmentCategory: cat,
      label: b.label || EQUIP_CAT_LABEL[cat] || cat,
      productId,
      expected,
      deployed,
      over: Math.max(0, deployed - expected),
      short: Math.max(0, expected - deployed),
    })
  }

  for (const [cat, deployed] of deployedCounts) {
    if (seen.has(cat)) continue
    rows.push({
      equipmentCategory: cat,
      label: EQUIP_CAT_LABEL[cat] || cat,
      productId: null,
      expected: 0,
      deployed,
      over: deployed,
      short: 0,
    })
  }

  return rows
}

export interface RentalBomExtraLine {
  id: string
  label: string
  equipmentCategory: string
  productId: string | null
  qty: number
  rate: number | null
}

/**
 * What switching a running rental to another package writes into its next
 * composition window: the new roster, the new package line, and the extras
 * re-diffed against the NEW baseline. Re-diffing is the point — moving from
 * "no monitors" to "w/ 2 monitors" must stop billing those two monitors as
 * overages, or the job pays for them twice.
 *
 * `deployedCategories` = what's on site now (returned gear excluded), already
 * netted of anything carried on its own priced line (see netAlreadyLined).
 * Overages price off the bound product the same way deploy does; anything
 * unbound arrives unrated and the invoice guard refuses to bill it blind.
 */
export function switchPackageComposition(
  bom: RentalBom,
  rateType: RentalRateType,
  deployedCategories: (string | null | undefined)[],
): {
  bom: ReturnType<typeof bomBaselineItems>
  bomType: RentalBomType
  bomPackage: RentalBomPackageLine | null
  bomExtras: RentalBomExtraLine[]
} {
  const baseline = bomBaselineItems(bom)
  const productsById = new Map(bom.items.filter(i => i.product).map(i => [i.product!.id, i.product!]))
  const bomExtras = diffDeployedAgainstBaseline(baseline, deployedCategories)
    .filter(r => r.over > 0)
    .map(r => {
      const prod = r.productId ? productsById.get(r.productId) : undefined
      return {
        id: `bomx-${r.equipmentCategory}`,
        label: `${prod?.name || r.label} (over baseline)`,
        equipmentCategory: r.equipmentCategory,
        productId: r.productId,
        qty: r.over,
        rate: productRateFor(prod, rateType),
      }
    })
  return { bom: baseline, bomType: bom.bomType, bomPackage: bomPackageLine(bom, rateType), bomExtras }
}
