/**
 * Customer contract pricing, resolved at the moment a line is added.
 *
 * Most of our larger operators bill off a negotiated pricebook — a QuickBooks
 * Price Level, pulled down by the QBWC sync and assigned to the customer
 * (Company.qbPriceLevelId). Until now that pricebook was only consulted when
 * the invoice was generated, days later: a tech wrote $250 on a Conoco ticket
 * and the invoice quietly billed $175. The ticket and the bill disagreed, and
 * nobody found out until someone compared them.
 *
 * So the same lookup now runs in the field, offline, at the instant the line
 * is added. `resolvePriceLevelRate` below is a deliberate MIRROR of
 * `resolvePriceLevelRate` in server/src/services/billingRules.ts — same
 * precedence, same rounding, same "null means list price stands". If you
 * change one, change the other; a quote that disagrees with the bill is the
 * exact failure this file exists to prevent.
 */

import { useEffect, useState } from 'react'
import { db } from './db'
import { api } from './api'
import type { OfflinePriceLevel, OfflinePriceLevelItem } from './db-types'

export type PriceLevel = OfflinePriceLevel
export type PriceLevelRule = OfflinePriceLevelItem

/** Whole-level percentage sentinel (QB's PriceLevelFixedPercentage). */
const PL_WHOLE_LEVEL_SENTINEL = '*'

export interface PriceLevelResolution {
  /** What this customer pays. */
  rate: number
  /** The level that decided it, for display ("Conoco"). */
  priceLevelName: string
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Resolve one item's rate against a customer's price levels.
 *
 * Precedence (mirrors the server): a per-item entry beats the whole-level
 * percentage, and the first matching level wins. customPrice replaces the rate
 * outright; adjustPercent scales the list rate. Returns null when no level
 * touches the item — meaning "list price stands", never "free".
 */
export function resolvePriceLevelRate(
  levels: PriceLevel[] | undefined | null,
  qbItemListId: string | null | undefined,
  listRate: number,
): PriceLevelResolution | null {
  if (!levels?.length || !qbItemListId) return null

  let matched: { pl: PriceLevel; item: PriceLevelRule } | null = null
  for (const pl of levels) {
    const itemMatch = pl.items?.find(it => it.qbItemListId === qbItemListId)
    if (itemMatch) { matched = { pl, item: itemMatch }; break }
    const wholeMatch = pl.items?.find(it => it.qbItemListId === PL_WHOLE_LEVEL_SENTINEL)
    if (wholeMatch) { matched = { pl, item: wholeMatch }; break }
  }
  if (!matched) return null

  let rate: number | null = null
  if (matched.item.customPrice != null) {
    rate = round2(Number(matched.item.customPrice))
  } else if (matched.item.adjustPercent != null) {
    rate = round2(listRate * (1 + Number(matched.item.adjustPercent) / 100))
  }
  if (rate == null) return null

  return { rate, priceLevelName: matched.pl.name }
}

/**
 * The active pricebooks for a customer — offline catalog first, API second.
 *
 * Both paths are load-bearing, and for different people. Field-mobile roles
 * have the whole `priceLevels` table on the device and must resolve with no
 * network at all. Office and shop roles never get a Dexie hydrate (ADR-0005
 * keys offline on role mobility, see lib/roleMobility.ts) — and they are the
 * ones keying shop labor rates, so without the fetch the shop would quote list
 * to a contract customer while the field screens quoted the contract.
 *
 * Returns an array (rather than the single level a company can be assigned)
 * purely so the signature matches the server resolver's. Empty = list pricing.
 */
export async function loadCompanyPriceLevels(
  companyId: string | null | undefined,
): Promise<PriceLevel[]> {
  if (!companyId) return []

  try {
    const company = await db.companies.get(companyId)
    if (company) {
      // The offline record is authoritative about whether this customer has a
      // pricebook at all — including "no, they're on list", which is an answer,
      // not a miss. Only fall through when the company itself isn't cached.
      if (!company.qbPriceLevelId) return []
      const level = await db.priceLevels.get(company.qbPriceLevelId)
      if (level?.isActive) return [level]
    }
  } catch {
    // Dexie unavailable (private mode, storage blocked) — try the network.
  }

  try {
    const res = await api.get<{ data: PriceLevel | null }>(`/companies/${companyId}/price-level`)
    return res.data ? [res.data] : []
  } catch {
    // Offline with nothing cached — list pricing stands.
    return []
  }
}

/**
 * The customer's pricebook, loaded once per customer and held for the screen.
 *
 * `levels` is what you hand the resolver; `level` is the single assigned one,
 * for naming it in the UI. `loaded` distinguishes "this customer has no
 * contract" from "we haven't looked yet" — worth showing differently, since
 * the second one means a rate on screen might still change.
 */
// One shared empty array, so "this customer has no pricebook" keeps a stable
// identity across renders and doesn't retrigger every effect that depends on it.
const NO_LEVELS: PriceLevel[] = []

export function useCompanyPriceLevels(companyId: string | null | undefined) {
  // Resolved levels are stored WITH the customer they belong to. Anything else
  // needs a synchronous "clear" the moment the customer changes, and that means
  // a setState in the effect body — a cascading render, and a window in which
  // the previous customer's pricebook is still on screen.
  const [resolved, setResolved] = useState<{ companyId: string | null; levels: PriceLevel[] }>(
    { companyId: null, levels: NO_LEVELS },
  )
  const key = companyId ?? null

  useEffect(() => {
    let cancelled = false
    // Async even for a null id, so nothing here runs during the effect body.
    loadCompanyPriceLevels(key).then(next => {
      if (!cancelled) setResolved({ companyId: key, levels: next.length ? next : NO_LEVELS })
    })
    return () => { cancelled = true }
  }, [key])

  const loaded = resolved.companyId === key
  const levels = loaded ? resolved.levels : NO_LEVELS

  return { levels, level: levels[0] ?? null, loaded }
}

/**
 * What a line should cost, given the catalog product behind it.
 *
 * The one entry point the UI should use when it adds or re-products a line.
 * Falls back to the list rate whenever the customer has no contract, the
 * product isn't mapped into QuickBooks yet, or the pricebook is silent on it.
 */
export interface LinePricing {
  /** The rate to put on the line. */
  rate: number | null
  /** Catalog list rate, kept so the UI can show what the contract replaced. */
  listRate: number | null
  /** Set only when a contract rate actually applied. */
  priceLevelName: string | null
}

/**
 * A stable key for "which pricebook, in which revision".
 *
 * Effects that re-price on a pricebook change key on THIS rather than on the
 * level ids alone: a QB pull can replace a level's item rules wholesale while
 * keeping the same id, and an id-only key would leave a screen quoting the
 * rules it happened to load first.
 */
export function priceLevelKey(levels: PriceLevel[] | undefined | null): string {
  return (levels ?? []).map(l => `${l.id}@${l.updatedAt}`).join(',')
}

export function priceLine(
  levels: PriceLevel[] | undefined | null,
  product: { qbItemListId?: string | null; defaultSellPrice?: number | null } | null | undefined,
  fallbackRate?: number | null,
): LinePricing {
  const listRate = product?.defaultSellPrice != null
    ? Number(product.defaultSellPrice)
    : (fallbackRate ?? null)
  const hit = resolvePriceLevelRate(levels, product?.qbItemListId, listRate ?? 0)
  if (!hit) return { rate: listRate, listRate, priceLevelName: null }
  return { rate: hit.rate, listRate, priceLevelName: hit.priceLevelName }
}

/** What the pricing code needs to know about a catalog product. */
interface CatalogRef {
  qbItemListId?: string | null
  defaultSellPrice?: number | null
}

// Products fetched over the wire, kept for the life of the page. The catalog
// does not change mid-shift, and re-fetching the same three part numbers every
// time a customer is swapped is pure latency.
const remoteProductCache = new Map<string, CatalogRef | null>()

/**
 * Look products up by id — offline catalog first, API for anything missing.
 *
 * The API leg is not a nicety: office and shop roles have no Dexie hydrate at
 * all, so on those screens EVERY product is a miss, and a Dexie-only lookup
 * would report "not in the catalog" for the entire catalog and quietly quote
 * list to a contract customer.
 */
async function lookupProducts(ids: string[]): Promise<Map<string, CatalogRef>> {
  const found = new Map<string, CatalogRef>()
  const missing: string[] = []

  try {
    const rows = await db.products.bulkGet(ids)
    rows.forEach((row, i) => {
      if (row) found.set(ids[i]!, row)
      else missing.push(ids[i]!)
    })
  } catch {
    missing.push(...ids)
  }

  for (const id of missing) {
    if (remoteProductCache.has(id)) {
      const cached = remoteProductCache.get(id)
      if (cached) found.set(id, cached)
      continue
    }
    try {
      const product = await api.get<CatalogRef>(`/products/${id}`)
      remoteProductCache.set(id, product ?? null)
      if (product) found.set(id, product)
    } catch {
      // Offline and uncached. Recorded as a miss so callers leave the line be
      // rather than re-deriving a rate from nothing.
      remoteProductCache.set(id, null)
    }
  }

  return found
}

/**
 * Price a line when all you have is a product id — the case where the product
 * came from somewhere that doesn't carry qbItemListId (a localStorage
 * "recently used" entry written before this feature, say). Looks the missing
 * key up rather than silently quoting list.
 */
export async function priceLineByProductId(
  levels: PriceLevel[] | undefined | null,
  productId: string | null | undefined,
  listRate: number | null,
): Promise<LinePricing> {
  if (!levels?.length || !productId) return { rate: listRate, listRate, priceLevelName: null }
  const found = await lookupProducts([productId])
  const product = found.get(productId)
  if (!product) return { rate: listRate, listRate, priceLevelName: null }
  return priceLine(levels, { qbItemListId: product.qbItemListId, defaultSellPrice: listRate }, listRate)
}

/**
 * The stamp we persist on a priced line (TicketLineItem.customData.priceLevel /
 * the shop item's billing chunk). Small on purpose: enough for a screen or a
 * dispute to answer "where did this number come from", nothing a calculation
 * would ever be tempted to read back.
 */
export interface PriceLevelStamp {
  name: string
  listRate: number | null
  contractRate: number
}

export function stampFor(pricing: LinePricing): PriceLevelStamp | null {
  if (!pricing.priceLevelName || pricing.rate == null) return null
  return {
    name: pricing.priceLevelName,
    listRate: pricing.listRate,
    contractRate: pricing.rate,
  }
}

/**
 * The minimum a line has to look like to be re-priced.
 *
 * Structural rather than an import of `LineItem`, so this module stays free of
 * a cycle back into the editor that uses it.
 */
export interface PriceableLine {
  productId?: string
  quantity: number
  rate?: number | null
  total?: number | null
  listRate?: number | null
  contractRate?: number | null
  priceLevelName?: string | null
}

/**
 * Re-price an existing list of lines against a (possibly new) pricebook.
 *
 * Needed because the customer is not always settled when the lines are: a
 * wizard seeds defaults the moment a work type is picked, the pricebook loads
 * a tick later, and the tech can go back and change the customer entirely.
 * Without this pass, whichever happened first would win, and the ticket would
 * show a rate for the wrong customer.
 *
 * A rate someone has typed over is left ALONE — but its stamp is refreshed, so
 * the "off contract" warning names the customer who is actually being billed.
 */
export async function repriceLines<T extends PriceableLine>(
  levels: PriceLevel[] | undefined | null,
  lines: T[],
): Promise<{ lines: T[]; changed: boolean }> {
  const productIds = Array.from(new Set(lines.filter(l => l.productId).map(l => l.productId!)))
  if (productIds.length === 0) return { lines, changed: false }

  const byId = await lookupProducts(productIds)

  let changed = false
  const next = lines.map(line => {
    if (!line.productId) return line
    const product = byId.get(line.productId)
    // No catalog entry means we don't know this line's QB ListID, which is not
    // the same as knowing no contract applies. Leave it exactly as it is rather
    // than stripping a stamp that was correct when it was set.
    if (!product) return line
    const pricing = priceLine(
      levels,
      { qbItemListId: product.qbItemListId, defaultSellPrice: product.defaultSellPrice ?? line.listRate ?? line.rate ?? null },
      line.listRate ?? line.rate ?? null,
    )

    const wasOverridden = line.contractRate != null && line.rate != null
      && Math.abs(line.rate - line.contractRate) > 0.005
    const nextContract = pricing.priceLevelName ? pricing.rate : null
    const nextRate = wasOverridden ? (line.rate ?? null) : pricing.rate

    const same = (a?: number | null, b?: number | null) =>
      (a == null && b == null) || (a != null && b != null && Math.abs(a - b) < 0.005)
    if (
      same(line.rate, nextRate)
      && same(line.contractRate, nextContract)
      && same(line.listRate, pricing.listRate)
      && (line.priceLevelName ?? null) === pricing.priceLevelName
    ) return line

    changed = true
    return {
      ...line,
      rate: nextRate,
      total: nextRate != null ? Math.round(nextRate * (line.quantity || 1) * 100) / 100 : line.total ?? null,
      listRate: pricing.listRate,
      contractRate: nextContract,
      priceLevelName: pricing.priceLevelName,
    }
  })

  return { lines: next, changed }
}

/**
 * What this customer pays for a division's Labor and Mileage parts.
 *
 * The shop bills labor as hours × rate and travel as miles × rate, with no
 * product picker in sight — so those two rates have to be looked up by part
 * number ([DIV]00002 / [DIV]00001, legacy 406 / 101) rather than chosen. Used
 * to pre-fill the shop's rate boxes with the contract number instead of
 * leaving them blank for someone to guess at.
 */
export function useDivisionContractRates(
  levels: PriceLevel[] | undefined | null,
  division: number,
) {
  const [rates, setRates] = useState<{ labor: LinePricing | null; mileage: LinePricing | null }>({
    labor: null, mileage: null,
  })
  const levelKey = priceLevelKey(levels)

  useEffect(() => {
    let cancelled = false
    const pad = String(division).padStart(2, '0')

    // Offline catalog first, same as loadCompanyPriceLevels. The API fallback
    // is what makes this work for office and shop roles, who have no Dexie
    // hydrate — and who are exactly the people typing shop rates.
    const fromDexie = async (candidates: string[]) => {
      for (const partNumber of candidates) {
        const product = await db.products.where('partNumber').equals(partNumber).first()
        if (product) return priceLine(levels, product)
      }
      return null
    }
    const resolve = async () => {
      try {
        const [labor, mileage] = await Promise.all([
          fromDexie([`${pad}00002`, '406']),
          fromDexie([`${pad}00001`, '101']),
        ])
        if (labor || mileage) return { labor, mileage }
      } catch { /* fall through to the API */ }

      // Same division-scoped resolution the server already does for the
      // wizard's quick-add buttons — reused rather than re-derived.
      const res = await api.get<{
        defaults: Record<string, { qbItemListId?: string | null; defaultSellPrice: number | null }>
      }>(`/products/defaults?division=${division}`)
      return {
        labor: res.defaults?.labor ? priceLine(levels, res.defaults.labor) : null,
        mileage: res.defaults?.travel ? priceLine(levels, res.defaults.travel) : null,
      }
    }

    resolve()
      .then(next => { if (!cancelled) setRates(next) })
      .catch(() => { /* no catalog either way — rate boxes stay empty */ })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [levelKey, division])

  return rates
}
