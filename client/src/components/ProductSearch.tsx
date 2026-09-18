import { useState, useEffect, useRef } from 'react'
import { db } from '@/lib/db'
import { api } from '@/lib/api'
import { priceLine, type PriceLevel } from '@/lib/priceLevels'
import { Search, Package, Clock, HardDrive, Tag } from 'lucide-react'

interface Product {
  id: string
  partNumber: string
  name: string
  category: string
  unitOfMeasure: string | null
  defaultSellPrice: number | null
  /** QB ListID — what a customer's contract pricebook matches on. */
  qbItemListId?: string | null
}

interface ProductSearchProps {
  onSelect: (product: Product) => void
  placeholder?: string
  autoFocus?: boolean
  /**
   * Scope results to a parts-numbering division (0–9). Division 00
   * (cross-business admin items) and legacy un-numbered parts always pass
   * the filter, so lists tighten as the QB renumber lands. Null/undefined =
   * unscoped.
   */
  division?: number | null
  /**
   * The customer's contract pricebook, when they have one. Results show what
   * THIS customer pays rather than list, so the price the picker promises is
   * the price the line lands at.
   */
  priceLevels?: PriceLevel[]
}

const RECENT_KEY = 'sundog_recent_products'
const MAX_RECENT = 8

function getRecentProducts(): Product[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]')
  } catch {
    return []
  }
}

function addRecentProduct(product: Product) {
  const recent = getRecentProducts().filter(p => p.id !== product.id)
  recent.unshift(product)
  localStorage.setItem(RECENT_KEY, JSON.stringify(recent.slice(0, MAX_RECENT)))
}

/**
 * Search Dexie first (instant, works offline), then try API as fallback.
 * Returns a `source` flag so we can show a subtle indicator.
 */
async function searchProducts(query: string, division?: number | null): Promise<{ results: Product[]; source: 'local' | 'api' }> {
  const q = query.toLowerCase()
  const inDivision = (p: { division?: number | null }) =>
    division == null || p.division == null || p.division === 0 || p.division === division

  // 1. Always search Dexie first (instant, offline-safe)
  try {
    const localResults = await db.products
      .filter(p =>
        p.isActive &&
        inDivision(p) &&
        (p.name.toLowerCase().includes(q) || p.partNumber.toLowerCase().includes(q))
      )
      .limit(15)
      .toArray()

    if (localResults.length > 0) {
      return {
        results: localResults.map(p => ({
          id: p.id,
          partNumber: p.partNumber,
          name: p.name,
          category: p.category,
          unitOfMeasure: p.unitOfMeasure ?? null,
          defaultSellPrice: p.defaultSellPrice != null ? Number(p.defaultSellPrice) : null,
          qbItemListId: p.qbItemListId ?? null,
        })),
        source: 'local',
      }
    }
  } catch {
    // Dexie empty or error — fall through to API
  }

  // 2. Fallback to API (online only)
  try {
    const params = new URLSearchParams({ search: query, limit: '15', active: 'true' })
    if (division != null) params.set('division', String(division))
    const data = await api.get<{ data: Product[] }>(`/products?${params}`)
    return { results: data.data, source: 'api' }
  } catch {
    return { results: [], source: 'api' }
  }
}

export function ProductSearch({ onSelect, placeholder = 'Search by part # or description...', autoFocus = false, division = null, priceLevels }: ProductSearchProps) {
  const [search, setSearch] = useState('')
  const [results, setResults] = useState<Product[]>([])
  const [source, setSource] = useState<'local' | 'api'>('local')
  const [recent] = useState(getRecentProducts)
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (autoFocus && inputRef.current) {
      inputRef.current.focus()
    }
  }, [autoFocus])

  useEffect(() => {
    if (!search || search.length < 2) {
      setResults([])
      return
    }
    const timer = setTimeout(async () => {
      setLoading(true)
      try {
        const { results: r, source: s } = await searchProducts(search, division)
        setResults(r)
        setSource(s)
      } catch {
        setResults([])
      } finally {
        setLoading(false)
      }
    }, 150) // Slightly faster since Dexie is local
    return () => clearTimeout(timer)
  }, [search, division])

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  function select(product: Product) {
    addRecentProduct(product)
    onSelect(product)
    setSearch('')
    setOpen(false)
  }

  const showList = open && (search.length >= 2 ? results.length > 0 || loading : recent.length > 0)

  return (
    <div ref={ref} className="relative">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
        <input
          ref={inputRef}
          type="text"
          value={search}
          onChange={e => { setSearch(e.target.value); setOpen(true) }}
          onFocus={() => setOpen(true)}
          placeholder={placeholder}
          className="w-full pl-10 pr-4 py-2.5 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none text-sm"
        />
      </div>

      {showList && (
        <div className="absolute z-30 left-0 right-0 mt-1 bg-white rounded-lg border border-slate-200 shadow-lg max-h-64 overflow-y-auto">
          {/* Recent products when no search */}
          {search.length < 2 && recent.length > 0 && (
            <>
              <div className="px-3 py-2 text-xs font-semibold text-slate-400 flex items-center gap-1">
                <Clock className="w-3 h-3" /> Recently Used
              </div>
              {recent.map(p => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => select(p)}
                  className="w-full text-left px-3 py-2.5 hover:bg-slate-50 flex items-center gap-3 transition-colors"
                >
                  <Package className="w-4 h-4 text-slate-400 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-slate-900 text-sm truncate">{p.name}</p>
                    <p className="text-xs text-slate-500 font-mono">{p.partNumber}</p>
                  </div>
                </button>
              ))}
            </>
          )}

          {/* Search results */}
          {search.length >= 2 && loading && (
            <div className="px-3 py-4 text-center text-sm text-slate-400">Searching...</div>
          )}
          {search.length >= 2 && !loading && results.length > 0 && (
            <>
              {/* Source indicator */}
              {source === 'local' && (
                <div className="px-3 py-1 text-[10px] text-slate-400 flex items-center gap-1 border-b border-slate-100">
                  <HardDrive className="w-2.5 h-2.5" /> Offline results
                </div>
              )}
              {results.map(p => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => select(p)}
                  className="w-full text-left px-3 py-2.5 hover:bg-slate-50 flex items-center gap-3 transition-colors"
                >
                  <Package className="w-4 h-4 text-slate-400 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-slate-900 text-sm truncate">{p.name}</p>
                    <p className="text-xs text-slate-500 flex items-center gap-2">
                      <span className="font-mono">{p.partNumber}</span>
                      {p.unitOfMeasure && <span className="text-slate-400">({p.unitOfMeasure})</span>}
                      {(() => {
                        // Quote what this customer pays, right in the picker —
                        // seeing list here and a contract rate on the line
                        // afterwards reads as a bug.
                        const pricing = priceLine(priceLevels, p)
                        if (pricing.rate == null) return null
                        return pricing.priceLevelName ? (
                          <span className="inline-flex items-center gap-1 text-violet-700 font-medium">
                            <Tag className="w-2.5 h-2.5" />
                            ${pricing.rate.toFixed(2)}
                            {pricing.listRate != null && Math.abs(pricing.listRate - pricing.rate) > 0.005 && (
                              <s className="text-slate-400 font-normal">${pricing.listRate.toFixed(2)}</s>
                            )}
                          </span>
                        ) : (
                          <span className="text-slate-400">${pricing.rate.toFixed(2)}</span>
                        )
                      })()}
                    </p>
                  </div>
                </button>
              ))}
            </>
          )}
          {search.length >= 2 && !loading && results.length === 0 && (
            <div className="px-3 py-4 text-center text-sm text-slate-400">No products found</div>
          )}
        </div>
      )}
    </div>
  )
}
