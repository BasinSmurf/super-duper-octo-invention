import { v4 as uuidv4 } from 'uuid'
/**
 * Default line items per field-service subtype.
 *
 * When a tech selects a service type in the wizard, we pre-populate
 * the line-item list with the billable products that almost always
 * appear on that kind of ticket (labor, mileage, inspection fees, etc.).
 *
 * Products are looked up from the offline Dexie `products` table by
 * `partNumber`.  If a product isn't found (not yet synced, deleted,
 * etc.) that default row is silently skipped.
 */

import { db } from './db'
import type { LineItem } from '@/components/LineItemEditor'
import { divisionLaborPartNumber, divisionMileagePartNumber } from './divisions'
import { priceLine, type PriceLevel } from './priceLevels'

// ── mapping ────────────────────────────────────────────────────

interface DefaultSpec {
  partNumber: string
  lineType: string
  quantity: number
}

/**
 * Service-subtype → default billable items.
 *
 * Keep this list intentionally lean — techs can always add more via
 * the action buttons. The goal is to eliminate the "forgot to add
 * labor" problem, not to guess every possible line item.
 */
// The part numbers below are the PRE-RENUMBER fallbacks (406 labor, 101
// mileage). getDefaultLineItems prefers the ticket division's own pair —
// [DIV]00001 mileage, [DIV]00002 labor — and only reaches these when that pair
// isn't in the offline catalog yet.
const DEFAULTS: Record<string, DefaultSpec[]> = {
  // ── Field Service subtypes ──
  // Phase B types:
  gas_detection: [
    { partNumber: '406', lineType: 'labor', quantity: 1 },
    { partNumber: '101', lineType: 'travel', quantity: 1 },
  ],
  cascade_air: [
    { partNumber: '406', lineType: 'labor', quantity: 1 },
    { partNumber: '101', lineType: 'travel', quantity: 1 },
  ],
  cascade_air_inspection: [
    { partNumber: '0311001', lineType: 'service', quantity: 1 },
  ],
  on_site_services: [
    { partNumber: '406', lineType: 'labor', quantity: 1 },
    { partNumber: '101', lineType: 'travel', quantity: 1 },
  ],
  general: [
    { partNumber: '406', lineType: 'labor', quantity: 1 },
    { partNumber: '101', lineType: 'travel', quantity: 1 },
  ],
  // Legacy types — kept so old draft restores still hydrate defaults:
  air_system: [
    { partNumber: '406', lineType: 'labor', quantity: 1 },
    { partNumber: '101', lineType: 'travel', quantity: 1 },
  ],
  monitor: [
    { partNumber: '406', lineType: 'labor', quantity: 1 },
    { partNumber: '101', lineType: 'travel', quantity: 1 },
  ],
  bump_test: [
    { partNumber: '406', lineType: 'labor', quantity: 1 },
    { partNumber: '101', lineType: 'travel', quantity: 1 },
  ],
  calibration: [
    { partNumber: '406', lineType: 'labor', quantity: 1 },
    { partNumber: '101', lineType: 'travel', quantity: 1 },
  ],

  // ── IH Testing subtypes ──
  // IH test records themselves carry NO automated pricing — samples/readings are
  // never auto-priced; the office adds those by hand on "Additional Charges".
  // Every IH visit still bills the tech's time + the drive, so we seed labor +
  // mileage (qty 1 each — the tech edits to actual hours/miles).
  ih_sampling: [
    { partNumber: '406', lineType: 'labor', quantity: 1 },
    { partNumber: '101', lineType: 'travel', quantity: 1 },
  ],
  ih_h2s: [
    { partNumber: '406', lineType: 'labor', quantity: 1 },
    { partNumber: '101', lineType: 'travel', quantity: 1 },
  ],
  ih_o2_voc: [
    { partNumber: '406', lineType: 'labor', quantity: 1 },
    { partNumber: '101', lineType: 'travel', quantity: 1 },
  ],
  ih_audiometric: [
    { partNumber: '406', lineType: 'labor', quantity: 1 },
    { partNumber: '101', lineType: 'travel', quantity: 1 },
  ],

  // ── Occ Health (fit test) & Training ──
  // Seed LABOR only — NOT mileage. These ticketType='training' visits already
  // capture drive distance in a dedicated on-site mileage field
  // (customData.mileage), which the invoice builder bills per-mile at the
  // division's own mileage part (invoices.ts). Seeding a mileage line here too
  // would double-bill. Per-service fees (fit test, audiometric, course items)
  // are synthesized server-side or added as parts. The tech can still add a
  // manual mileage line if truly needed.
  fit_test: [
    { partNumber: '406', lineType: 'labor', quantity: 1 },
  ],
  safety_training: [
    { partNumber: '406', lineType: 'labor', quantity: 1 },
  ],

  // ── Air fill ──
  // The air-fill service line itself is synced from the PSI readings in the
  // wizard; here we seed the billable labor + mileage alongside it.
  air_fill: [
    { partNumber: '406', lineType: 'labor', quantity: 1 },
    { partNumber: '101', lineType: 'travel', quantity: 1 },
  ],
}

// ── public API ──────────────────────────────────────────────────


/**
 * Build default LineItem[] for the given service subtype.
 * Looks up each part number in the offline Dexie products table so
 * that productId, description, rate, etc. are all filled in.
 *
 * Seeded rates respect the customer's contract pricebook when one is passed:
 * a Conoco ticket seeds labor at their negotiated $85, not the $85-that-happens-
 * to-match list. Pass an empty array (or omit) for list pricing.
 *
 * Returns an empty array when:
 *   • the subtype has no configured defaults, or
 *   • none of the default products exist in the offline DB.
 */
export async function getDefaultLineItems(
  serviceSubtype: string,
  division?: number | null,
  priceLevels?: PriceLevel[],
): Promise<LineItem[]> {
  const specs = DEFAULTS[serviceSubtype]
  if (!specs || specs.length === 0) return []

  const items: LineItem[] = []

  for (const spec of specs) {
    // Parts-numbering scheme: each division has fixed Labor ([DIV]00002) and
    // Mileage ([DIV]00001) part numbers. Prefer those when a division is
    // known, falling back to the legacy numbers until the QB renumber lands.
    const candidates: string[] = []
    if (division != null) {
      if (spec.lineType === 'labor') candidates.push(divisionLaborPartNumber(division))
      if (spec.lineType === 'travel') candidates.push(divisionMileagePartNumber(division))
    }
    candidates.push(spec.partNumber)

    let product = null
    for (const partNumber of candidates) {
      // Look up by partNumber index (set up in Dexie schema)
      product = await db.products.where('partNumber').equals(partNumber).first()
      if (product) break
    }

    if (!product) continue // product not synced yet — skip gracefully

    const pricing = priceLine(priceLevels, product)
    const rate = pricing.rate
    items.push({
      id: uuidv4(),
      lineType: spec.lineType,
      description: product.name,
      partNumber: product.partNumber ?? undefined,
      productId: product.id,
      quantity: spec.quantity,
      rate,
      total: rate != null ? rate * spec.quantity : null,
      unitOfMeasure: product.unitOfMeasure ?? undefined,
      priceLevelName: pricing.priceLevelName,
      listRate: pricing.listRate,
    })
  }

  return items
}
