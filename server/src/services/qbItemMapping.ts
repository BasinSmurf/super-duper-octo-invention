/**
 * QuickBooks item → Sundog product mapping.
 *
 * Two paths bring QB's item list into the catalog and both need the same
 * guesses: the one-off CSV import (`POST /api/products/import-qb-csv`) and the
 * QBWC item pull. QB is the authority for the number, the name and the price;
 * everything else (our equipment category, UoM shorthand) is inferred here.
 */

import type { ProductCategory, ProductType, QbItemType } from '../db.js';

/**
 * A QB item's own name. Sub-items come back as colon-delimited paths
 * ("Rentals:Monitors:0400100") — the item's name is the last segment, which is
 * also what the tech types into the parts picker and what parsePartNumber
 * reads.
 */
export function qbItemLeafName(fullName: string): string {
  return (fullName.split(':').pop() ?? fullName).trim();
}

/** QB's item type → how we sell it. */
export const PRODUCT_TYPE_FOR_QB_ITEM_TYPE: Record<QbItemType, ProductType> = {
  service: 'service',
  inventory: 'sale',
  non_inventory: 'sale',
  inventory_assembly: 'sale',
  other_charge: 'service',
};

/**
 * Best-effort equipment category from what QB tells us. Description keywords
 * first (they're the most specific), then the income account, then the item
 * type. Falls back to `misc` — a wrong-ish category is cosmetic (it scopes
 * pickers), so this never blocks an import.
 */
export function guessProductCategory(opts: {
  description?: string | null;
  account?: string | null;
  isAssembly?: boolean;
  isPart?: boolean;
}): ProductCategory {
  const desc = (opts.description || '').toLowerCase();
  const acct = (opts.account || '').toLowerCase();

  if (opts.isAssembly) return 'assembly';
  // Area monitors are checked BEFORE personal ones: "area monitor" also contains
  // "monitor", so the broad personal-monitor test would otherwise swallow every
  // area unit (it did, in the CSV importer this was lifted from).
  if (desc.includes('area monitor') || desc.includes('rae guard')) return 'monitor_area';
  if (desc.includes('monitor') || desc.includes('g7') || desc.includes('mx6') || desc.includes('ibrid') || desc.includes('altair') || desc.includes('bw ') || desc.includes('ventis') || desc.includes('gas detect'))
    return 'monitor_personal';
  if (desc.includes('scba') || desc.includes('supplied air') || desc.includes('respirator') || desc.includes('regulator') || desc.includes('cascade'))
    return 'supplied_air_component';
  if (desc.includes('sensor') && !desc.includes('motion sensor')) return 'sensor';
  if (desc.includes('calibration') || desc.includes('cal gas') || desc.includes('bump gas') || desc.includes('4-gas') || desc.includes('zero air'))
    return 'calibration_gas';
  if (acct.includes('training')) return 'labor';
  if (acct.includes('consulting')) return 'labor';
  if (acct.includes('service income')) return 'labor';
  if (acct.includes('remediation')) return 'labor';
  if (opts.isPart) return 'consumable';
  return 'misc';
}

/** QB's free-text U/M → our short codes. */
export function normalizeUoM(raw: string | null | undefined): string {
  if (!raw) return 'EA';
  const lower = raw.toLowerCase();
  if (lower.includes('hour') || lower === 'hr') return 'HR';
  if (lower.includes('day')) return 'DAY';
  if (lower.includes('mile') || lower === 'mi') return 'MI';
  if (lower.includes('each') || lower === 'ea') return 'EA';
  if (lower.includes('case')) return 'CS';
  if (lower.includes('box')) return 'BX';
  if (lower.includes('pair')) return 'PR';
  if (lower.includes('pack')) return 'PK';
  if (lower.includes('roll')) return 'RL';
  if (lower.includes('ft') || lower.includes('foot') || lower.includes('feet')) return 'FT';
  return raw.substring(0, 10).toUpperCase();
}

/** Marks rows the QBWC pull created, so they're findable (and undoable). */
export const QB_PULL_PROVENANCE = 'qbwc-item-pull';

export interface QbPulledItem {
  listId: string;
  fullName: string;
  isActive: boolean;
  description: string | null;
  price: number | null;
  unitOfMeasure: string | null;
  itemType: string;
}

/**
 * The product row for a QB item that has no counterpart in Sundog yet.
 *
 * Part number is QB's own item name (the leaf), not the sub-item path — QB owns
 * the numbering, and the leaf is what the picker searches. Division facets are
 * derived by the caller from the part number so they can't drift.
 */
export function productCreateFromQbItem(item: QbPulledItem, pulledAt: Date) {
  const qbItemType = (
    ['service', 'inventory', 'non_inventory', 'inventory_assembly', 'other_charge'].includes(item.itemType)
      ? item.itemType
      : 'non_inventory'
  ) as QbItemType;
  const partNumber = qbItemLeafName(item.fullName);

  return {
    partNumber,
    name: item.description || partNumber,
    category: guessProductCategory({
      description: item.description,
      isAssembly: qbItemType === 'inventory_assembly',
      isPart: qbItemType === 'inventory' || qbItemType === 'non_inventory',
    }),
    productType: PRODUCT_TYPE_FOR_QB_ITEM_TYPE[qbItemType],
    unitOfMeasure: normalizeUoM(item.unitOfMeasure),
    defaultSellPrice: item.price != null && item.price > 0 ? item.price : null,
    qbItemListId: item.listId,
    qbItemFullName: item.fullName,
    qbItemType,
    isActive: item.isActive,
    // Provenance: `custom_data->>'createdBy' = 'qbwc-item-pull'` finds every row
    // this pull minted, so a bad batch can be reviewed or removed as a set.
    customData: { createdBy: QB_PULL_PROVENANCE, pulledAt: pulledAt.toISOString() },
  };
}
