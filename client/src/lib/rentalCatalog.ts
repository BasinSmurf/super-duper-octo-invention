import { api } from './api'
import { db } from './db'
import { productRateFor, type RentalBomProduct } from './rentalBom'
import { resolvePriceLevelRate, type PriceLevel } from './priceLevels'
import type { RateType } from './rentalRates'

export interface RentalCatalogProduct extends RentalBomProduct {
  isActive?: boolean
  productType?: string
  unitOfMeasure?: string | null
}

export function isRentalMonitor(product: RentalCatalogProduct): boolean {
  if (product.isActive === false) return false
  if (product.productType === 'rental') return true
  // QB rental SKUs can be service or non-inventory items; equipment sale
  // prices and combined trailer packages are not monitor rental rates.
  return !!product.qbItemListId
    && /monitor/i.test(product.name) && /rental/i.test(product.name)
    && !/trailer|package/i.test(product.name)
}

/** Office users need the API catalog; mobile devices retain an offline fallback. */
export async function loadRentalMonitors(): Promise<RentalCatalogProduct[]> {
  let products: RentalCatalogProduct[]
  try {
    const groups = await Promise.all(['monitor_personal', 'monitor_area'].map(async category => {
      const rows: RentalCatalogProduct[] = []
      while (true) {
        const response = await api.get<{ data: RentalCatalogProduct[]; total: number }>(
          `/products?active=true&category=${category}&limit=200&offset=${rows.length}`,
        )
        rows.push(...response.data)
        if (rows.length >= response.total) return rows
        if (!response.data.length) throw new Error('Incomplete monitor catalog')
      }
    }))
    products = groups.flat()
  } catch {
    products = await db.products.where('category').anyOf('monitor_personal', 'monitor_area').toArray()
  }
  return [...new Map(products.filter(isRentalMonitor).map(p => [p.id, p])).values()]
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function rentalCatalogRate(product: RentalCatalogProduct, rateType: RateType, levels: PriceLevel[] = []): number | null {
  const explicit = rateType === 'weekly' ? product.defaultRentalRateWeekly
    : rateType === 'monthly' ? product.defaultRentalRateMonthly : product.defaultRentalRateDaily
  if (explicit == null && product.productType === 'sale' && !/rental/i.test(product.name)) return null
  const itemPeriod = ({ DAY: 'daily', DAILY: 'daily', WK: 'weekly', WEEK: 'weekly', WEEKLY: 'weekly', MO: 'monthly', MONTH: 'monthly', MONTHLY: 'monthly' } as Record<string, RateType>)[product.unitOfMeasure?.toUpperCase() ?? '']
  // A daily QB SKU's price is not a weekly price. Leave that unit unpriced
  // unless it has an explicit rental rate, rather than silently underbilling.
  if (explicit == null && itemPeriod && itemPeriod !== rateType) return null
  const list = productRateFor(product, rateType)
  const contract = resolvePriceLevelRate(levels, product.qbItemListId, list ?? 0)
  // A percentage cannot establish a price without a list price. A real fixed
  // contract price (including an explicit zero) can.
  if (list == null) {
    const rule = levels.flatMap(level => {
      const item = level.items?.find(i => i.qbItemListId === product.qbItemListId)
        ?? level.items?.find(i => i.qbItemListId === '*')
      return item ? [item] : []
    })[0]
    return rule?.customPrice != null ? contract?.rate ?? null : null
  }
  return contract?.rate ?? list
}

export function repriceRentalRows<T extends { productId: string; rate: number | null; manualRate?: boolean }>(
  rows: T[], products: RentalCatalogProduct[], rateType: RateType, levels: PriceLevel[],
): T[] {
  return rows.map(row => {
    if (row.manualRate) return row
    const product = products.find(p => p.id === row.productId)
    return product ? { ...row, rate: rentalCatalogRate(product, rateType, levels) } : row
  })
}
