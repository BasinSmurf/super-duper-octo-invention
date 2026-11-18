import { v4 as uuidv4 } from 'uuid'
import { api } from './api'
import { getDefaultLineItems } from './defaultLineItems'
import { priceLine, type PriceLevel } from './priceLevels'
import type { LineItem } from '@/components/LineItemEditor'

/** Use the standard D4 defaults, including for staff without a cached catalog. */
export async function loadSwapBillingLines(priceLevels: PriceLevel[]): Promise<LineItem[]> {
  const lines = await getDefaultLineItems('general', 4, priceLevels)
  if (['labor', 'travel'].some(type => !lines.some(line => line.lineType === type))) {
    const { defaults } = await api.get<{ defaults: Record<string, {
      id: string; name: string; partNumber: string; defaultSellPrice: number | null; unitOfMeasure: string | null; qbItemListId?: string | null
    }> }>('/products/defaults?division=4')
    for (const lineType of ['labor', 'travel']) {
      if (lines.some(line => line.lineType === lineType)) continue
      const product = defaults[lineType]
      if (!product) continue
      const pricing = priceLine(priceLevels, product, product.defaultSellPrice == null ? null : Number(product.defaultSellPrice))
      lines.push({ id: uuidv4(), lineType, productId: product.id, partNumber: product.partNumber,
        description: product.name, quantity: 1, unitOfMeasure: product.unitOfMeasure ?? undefined,
        rate: pricing.rate, total: pricing.rate, listRate: pricing.listRate,
        priceLevelName: pricing.priceLevelName, contractRate: pricing.priceLevelName ? pricing.rate : null,
      })
    }
  }
  return lines.map(line => line.lineType === 'labor' ? { ...line, notes: 'Equipment swap' } : line)
}
