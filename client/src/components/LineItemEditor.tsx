import { v4 as uuidv4 } from 'uuid'
import { useState, useEffect, useRef } from 'react'
import { cn } from '@/lib/cn'
import { api } from '@/lib/api'
import { SerialInput } from '@/components/SerialInput'
import { ProductSearch } from '@/components/ProductSearch'
import { QuantityInput } from '@/components/QuantityInput'
import { ContractPricingBanner, ContractPriceBadge } from '@/components/ContractPriceBadge'
import { priceLine, priceLineByProductId, repriceLines, priceLevelKey as priceLevelKeyOf, type PriceLevel } from '@/lib/priceLevels'
import { DIVISIONS } from '@/lib/divisions'
import {
  ArrowLeftRight,
  Activity,
  Upload,
  Download,
  Gauge,
  Package,
  Clock,
  Navigation,
  Trash2,
  ChevronDown,
  ChevronUp,
  ClipboardCheck,
  X,
} from 'lucide-react'

export interface LineItem {
  id: string
  fieldInspectionId?: string
  lineType: string
  description: string
  partNumber?: string
  productId?: string
  quantity: number
  rate?: number | null
  total?: number | null
  unitOfMeasure?: string
  serialNumberInstalled?: string
  serialNumberRemoved?: string
  testResult?: 'pass' | 'fail' | null
  calGasLotNumber?: string
  notes?: string
  /**
   * Contract-pricing provenance, stamped when the rate was resolved. Present
   * only when the customer's pricebook actually set this line's rate — it is
   * display + audit, never an input to a calculation.
   */
  priceLevelName?: string | null
  /** Catalog list rate the contract rate replaced (may equal it). */
  listRate?: number | null
  /**
   * What the pricebook said. Kept alongside `rate` rather than folded into it
   * so an edited rate stays visibly OFF contract instead of quietly becoming
   * the new truth — the invoice will bill this number regardless.
   */
  contractRate?: number | null
}

interface LineItemEditorProps {
  setupOnly?: boolean
  items: LineItem[]
  onChange: (items: LineItem[]) => void
  serviceType?: string
  /**
   * Default parts-numbering division (0–9) for the catalog picker — seeds
   * the Div dropdown from the work type / ticket division. The tech can
   * switch it freely (catalog scoping only; revenue class stays on the
   * ticket). Omit to leave the picker unscoped.
   */
  division?: number | null
  /**
   * The customer's contract pricebook (empty/omitted = list pricing). Every
   * rate this editor fills in is resolved through it, so what the tech sees
   * on the ticket is what the invoice will bill — see lib/priceLevels.ts.
   */
  priceLevels?: PriceLevel[]
}

// 'monitor' / 'bump_test' / 'calibration' kept for legacy tickets only.
// 'gas_detection' (Phase B) captures monitor work via GasDetectionEditor —
// the line-item editor under it is just for labor / mileage / parts, so
// the monitor-specific types are NOT exposed to gas_detection.
const LINE_TYPES = [
  { type: 'monitor_deploy', label: 'Deploy', icon: Upload, color: 'bg-green-50 text-green-700 border-green-200', services: ['monitor'] },
  { type: 'monitor_swap', label: 'Swap', icon: ArrowLeftRight, color: 'bg-blue-50 text-blue-700 border-blue-200', services: ['monitor'] },
  { type: 'monitor_pickup', label: 'Pickup', icon: Download, color: 'bg-orange-50 text-orange-700 border-orange-200', services: ['monitor'] },
  { type: 'bump_test', label: 'Bump Test', icon: Activity, color: 'bg-purple-50 text-purple-700 border-purple-200', services: ['monitor', 'bump_test', 'calibration'] },
  { type: 'calibration', label: 'Calibration', icon: Gauge, color: 'bg-indigo-50 text-indigo-700 border-indigo-200', services: ['monitor', 'bump_test', 'calibration'] },
  { type: 'fit_test', label: 'Fit Test', icon: Activity, color: 'bg-teal-50 text-teal-700 border-teal-200', services: ['fit_test'] },
  // Cascade Air: the inspection is usually its own charge, and which charge
  // depends on the visit — the catalog carries a primary/additional pair, a
  // monthly compliance item, and a site-pack item. So this opens the product
  // search rather than pinning one part number.
  { type: 'inspection', label: 'Inspection', icon: ClipboardCheck, color: 'bg-emerald-50 text-emerald-700 border-emerald-200', services: ['cascade_air'] },
  { type: 'labor', label: 'Labor', icon: Clock, color: 'bg-amber-50 text-amber-700 border-amber-200', services: ['*'] },
  { type: 'travel', label: 'Mileage', icon: Navigation, color: 'bg-cyan-50 text-cyan-700 border-cyan-200', services: ['*'] },
  { type: 'part', label: 'Part / Other', icon: Package, color: 'bg-slate-50 text-slate-700 border-slate-200', services: ['*'] },
]

// Line types that should show product search
const PRODUCT_SEARCH_TYPES = new Set([
  'part', 'monitor_deploy', 'monitor_swap', 'monitor_pickup',
  'bump_test', 'calibration', 'labor', 'travel', 'inspection',
])


interface DefaultProduct {
  id: string
  partNumber: string
  name: string
  defaultSellPrice: number | null
  unitOfMeasure: string | null
  qbItemListId?: string | null
}

export function LineItemEditor({ items, onChange, serviceType, division = null, priceLevels, setupOnly = false }: LineItemEditorProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [defaults, setDefaults] = useState<Record<string, DefaultProduct>>({})
  // Per-line catalog scope: each product-search line has its OWN Div filter,
  // seeded from the ticket/work-type division but switchable per line — one
  // ticket can pull parts from several divisions (e.g. a D5 sale item on a
  // D3 field job). This filters the searchable part list ONLY; revenue class
  // stays on the ticket's division. Keyed by line id; falls back to `division`.
  const [lineDivisions, setLineDivisions] = useState<Record<string, number | null>>({})
  const divisionFor = (id: string) => (id in lineDivisions ? lineDivisions[id] : division)

  // Fetch default products; division-scoped labor/mileage when available.
  // Defaults follow the ticket's seed division (the work-type default), which
  // is what auto-fills when a tech taps Labor / Mileage.
  useEffect(() => {
    const qs = division != null ? `?division=${division}` : ''
    api.get<{ defaults: Record<string, DefaultProduct> }>(`/products/defaults${qs}`)
      .then(res => setDefaults(res.defaults))
      .catch(() => { /* non-critical — techs can still pick products manually */ })
  }, [division])

  // Re-price everything when the pricebook itself changes — the customer was
  // swapped, or the levels finished loading after the wizard had already seeded
  // its default labor/mileage lines. Keyed on the level ids only: it must not
  // re-run on every keystroke in a rate field, or it would fight the typist.
  const priceLevelKey = priceLevelKeyOf(priceLevels)
  // Latest items/onChange, kept in a ref so the reprice effect below can read
  // them without re-running on every keystroke. Written in an effect (not
  // during render) and declared FIRST, so it has already run by the time the
  // reprice effect fires.
  const latest = useRef({ items, onChange })
  useEffect(() => { latest.current = { items, onChange } })
  useEffect(() => {
    let cancelled = false
    void repriceLines(priceLevels, latest.current.items).then(({ lines, changed }) => {
      if (cancelled || !changed) return
      latest.current.onChange(lines)
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [priceLevelKey])

  const visibleTypes = LINE_TYPES.filter(t =>
    t.services.includes('*') || !serviceType || t.services.includes(serviceType)
  )

  function addItem(lineType: string) {
    const typeDef = LINE_TYPES.find(t => t.type === lineType)

    // Try to auto-fill from defaults map
    const defaultProduct = defaults[lineType]

    // Price it the way the invoice will: the customer's pricebook first, list
    // only when it's silent. Doing this here rather than at invoice time is the
    // whole point — a tech tapping "Labor" on a Conoco job should see Conoco's
    // labor rate, not ours.
    const pricing = priceLine(priceLevels, defaultProduct)

    const newItem: LineItem = {
      id: uuidv4(),
      lineType,
      description: defaultProduct?.name || typeDef?.label || lineType,
      partNumber: defaultProduct?.partNumber,
      productId: defaultProduct?.id,
      quantity: 1,
      rate: pricing.rate,
      total: pricing.rate,
      unitOfMeasure: defaultProduct?.unitOfMeasure ?? undefined,
      priceLevelName: pricing.priceLevelName,
      listRate: pricing.listRate,
      contractRate: pricing.priceLevelName ? pricing.rate : null,
    }
    const updated = [...items, newItem]
    onChange(updated)
    setExpandedId(newItem.id)
  }

  function updateItem(id: string, updates: Partial<LineItem>) {
    onChange(items.map(item => item.id === id ? { ...item, ...updates } : item))
  }

  function removeItem(id: string) {
    onChange(items.filter(item => item.id !== id))
    if (expandedId === id) setExpandedId(null)
  }

  const contractLevel = priceLevels?.[0] ?? null
  const contractLineCount = items.filter(i => i.priceLevelName).length

  return (
    <div className="space-y-4">
      <label className="block text-sm font-medium text-slate-700">Line Items</label>

      {/* Say it once, up top: this customer isn't on list pricing. */}
      <ContractPricingBanner level={contractLevel} appliedCount={contractLineCount} />

      {/* Action buttons — big touch targets */}
      <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
        {visibleTypes.map(({ type, label, icon: Icon, color }) => (
          <button
            key={type}
            type="button"
            onClick={() => addItem(type)}
            className={cn(
              'flex flex-col items-center gap-1.5 p-3 rounded-lg border-2 transition-colors font-medium text-sm',
              color,
              'hover:shadow-sm active:scale-[0.98]',
            )}
          >
            <Icon className="w-6 h-6" />
            {label}
          </button>
        ))}
      </div>

      {/* Item list */}
      {items.length > 0 && (
        <div className="space-y-2">
          {items.map((item, index) => {
            const typeDef = LINE_TYPES.find(t => t.type === item.lineType)
            const Icon = typeDef?.icon || Package
            const isExpanded = expandedId === item.id
            const showProductSearch = PRODUCT_SEARCH_TYPES.has(item.lineType)

            return (
              <div key={item.id} className="bg-white rounded-lg border border-slate-200 overflow-hidden">
                {/* Header row */}
                <button
                  type="button"
                  onClick={() => setExpandedId(isExpanded ? null : item.id)}
                  className="w-full flex items-center gap-3 p-3 hover:bg-slate-50 transition-colors"
                >
                  <span className="text-xs font-mono text-slate-400 w-5">{index + 1}</span>
                  <Icon className="w-5 h-5 text-slate-500 shrink-0" />
                  <div className="flex-1 min-w-0 text-left">
                    <p className="font-medium text-slate-900 text-sm truncate">{item.description}</p>
                    <div className="flex items-center gap-2 flex-wrap">
                      {item.partNumber && (
                        <span className="text-xs text-slate-500 font-mono">{item.partNumber}</span>
                      )}
                      {item.serialNumberInstalled && (
                        <span className="text-xs text-slate-500 font-mono">S/N: {item.serialNumberInstalled}</span>
                      )}
                      <ContractPriceBadge
                        priceLevelName={item.priceLevelName}
                        listRate={item.listRate}
                        contractRate={item.contractRate}
                        currentRate={item.rate}
                      />
                    </div>
                  </div>
                  <span className="text-xs text-slate-400 text-right">
                    {item.total != null ? `$${Number(item.total).toFixed(2)}` : `qty ${item.quantity}`}
                  </span>
                  {isExpanded ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
                </button>

                {/* Expanded detail */}
                {isExpanded && (
                  <div className="px-3 pb-3 pt-1 border-t border-slate-100 space-y-3">
                    {/* Product search OR plain description */}
                    {showProductSearch ? (
                      <div>
                        <label className="block text-xs font-medium text-slate-500 mb-1">Product</label>
                        {item.productId ? (
                          <div className="flex items-center gap-2 p-2 bg-blue-50 border border-blue-200 rounded-lg">
                            <Package className="w-4 h-4 text-blue-600 shrink-0" />
                            <div className="flex-1 min-w-0">
                              <p className="font-medium text-slate-900 text-sm truncate">{item.description}</p>
                              <p className="text-xs text-slate-500 font-mono">{item.partNumber}</p>
                            </div>
                            <button
                              type="button"
                              onClick={() => updateItem(item.id, {
                                productId: undefined, partNumber: undefined,
                                description: typeDef?.label || item.lineType,
                                // The pricebook rule belonged to the product
                                // that just went away.
                                priceLevelName: null, listRate: null, contractRate: null,
                              })}
                              className="p-1 text-slate-400 hover:text-slate-600"
                            >
                              <X className="w-4 h-4" />
                            </button>
                          </div>
                        ) : (
                          <>
                            {/* Div filter (20%) + part search (80%). The Div
                                dropdown scopes THIS line's searchable part list
                                only — mix divisions freely across lines. */}
                            <div className="flex gap-2">
                              <select
                                value={divisionFor(item.id) ?? ''}
                                onChange={e => setLineDivisions(prev => ({
                                  ...prev,
                                  [item.id]: e.target.value === '' ? null : Number(e.target.value),
                                }))}
                                title="Filter searchable part numbers by division"
                                className="w-1/5 min-w-0 px-2 py-2.5 border border-slate-300 rounded-lg text-xs font-medium text-slate-700 bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                              >
                                <option value="">All</option>
                                {DIVISIONS.map(d => (
                                  <option key={d.code} value={d.code}>{d.short}</option>
                                ))}
                              </select>
                              <div className="flex-1 min-w-0">
                                <ProductSearch
                                  autoFocus
                                  division={divisionFor(item.id)}
                                  priceLevels={priceLevels}
                                  onSelect={async (product) => {
                                    const listRate = product.defaultSellPrice ?? item.rate ?? null
                                    // One write, after the rate is settled —
                                    // updateItem rebuilds from the `items`
                                    // closure, so two calls in a row would drop
                                    // the first one's product fields.
                                    //
                                    // The catalog re-read covers a product that
                                    // arrived without its QB ListID: a
                                    // "recently used" entry saved to
                                    // localStorage before contract pricing
                                    // shipped has no qbItemListId, and quoting
                                    // list off a stale cache is the exact
                                    // failure this feature exists to remove.
                                    const pricing = product.qbItemListId == null && priceLevels?.length
                                      ? await priceLineByProductId(priceLevels, product.id, listRate)
                                      : priceLine(priceLevels, product, listRate)
                                    updateItem(item.id, {
                                      productId: product.id,
                                      partNumber: product.partNumber,
                                      description: product.name,
                                      unitOfMeasure: product.unitOfMeasure ?? undefined,
                                      rate: pricing.rate,
                                      total: pricing.rate != null ? pricing.rate * (item.quantity || 1) : item.total,
                                      priceLevelName: pricing.priceLevelName,
                                      listRate: pricing.listRate,
                                      contractRate: pricing.priceLevelName ? pricing.rate : null,
                                    })
                                  }}
                                />
                              </div>
                            </div>
                            <p className="text-xs text-slate-400 mt-1">Or type a custom description below</p>
                            <input
                              type="text"
                              value={item.description}
                              onChange={e => updateItem(item.id, { description: e.target.value })}
                              placeholder="Custom description"
                              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none mt-1"
                            />
                          </>
                        )}
                      </div>
                    ) : (
                      <div>
                        <label className="block text-xs font-medium text-slate-500 mb-1">Description</label>
                        <input
                          type="text"
                          value={item.description}
                          onChange={e => updateItem(item.id, { description: e.target.value })}
                          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                        />
                      </div>
                    )}

                    {/* Quantity + Rate + Total */}
                    <div className="flex gap-3">
                      <div>
                        <label className="block text-xs font-medium text-slate-500 mb-1">Qty</label>
                        <QuantityInput
                          min={0}
                          value={item.quantity}
                          onChange={qty => {
                            const total = item.rate != null ? item.rate * qty : item.total
                            updateItem(item.id, { quantity: qty, total })
                          }}
                          className="w-20 px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-500 mb-1">Rate</label>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          value={item.rate ?? ''}
                          onChange={e => {
                            const rate = e.target.value ? parseFloat(e.target.value) : null
                            const total = rate != null ? rate * (item.quantity || 1) : null
                            // Provenance survives the edit on purpose — see
                            // LineItem.contractRate.
                            updateItem(item.id, { rate, total })
                          }}
                          placeholder="$0.00"
                          className={cn(
                            'w-28 px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none',
                            item.contractRate != null && item.rate != null
                              && Math.abs(item.rate - item.contractRate) > 0.005
                              ? 'border-amber-300 bg-amber-50'
                              : 'border-slate-300',
                          )}
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-500 mb-1">Total</label>
                        <div className="px-3 py-2 text-sm text-slate-700 font-medium">
                          {item.total != null ? `$${Number(item.total).toFixed(2)}` : '—'}
                        </div>
                      </div>
                    </div>

                    {/* Where the rate came from, and a way back to it. */}
                    {item.contractRate != null && item.priceLevelName && (
                      <div className="flex items-center gap-2 flex-wrap">
                        <ContractPriceBadge
                          priceLevelName={item.priceLevelName}
                          listRate={item.listRate}
                          contractRate={item.contractRate}
                          currentRate={item.rate}
                        />
                        {item.rate != null && Math.abs(item.rate - item.contractRate) > 0.005 && (
                          <button
                            type="button"
                            onClick={() => updateItem(item.id, {
                              rate: item.contractRate,
                              total: item.contractRate! * (item.quantity || 1),
                            })}
                            className="text-[10px] font-medium text-violet-700 underline underline-offset-2 hover:text-violet-900"
                          >
                            Use contract rate
                          </button>
                        )}
                      </div>
                    )}

                    {/* Serial numbers for deploy/swap/pickup/bump/cal */}
                    {!setupOnly && ['monitor_deploy', 'monitor_swap', 'bump_test', 'calibration'].includes(item.lineType) && (
                      <SerialInput
                        label={`S/N ${item.lineType === 'monitor_swap' ? 'Installed' : ''}`}
                        value={item.serialNumberInstalled || ''}
                        onChange={val => updateItem(item.id, { serialNumberInstalled: val })}
                      />
                    )}

                    {!setupOnly && item.lineType === 'monitor_swap' && (
                      <SerialInput
                        label="S/N Removed"
                        value={item.serialNumberRemoved || ''}
                        onChange={val => updateItem(item.id, { serialNumberRemoved: val })}
                      />
                    )}

                    {!setupOnly && ['monitor_pickup'].includes(item.lineType) && (
                      <SerialInput
                        label="S/N Picked Up"
                        value={item.serialNumberRemoved || ''}
                        onChange={val => updateItem(item.id, { serialNumberRemoved: val })}
                      />
                    )}

                    {/* Bump test / calibration result */}
                    {!setupOnly && ['bump_test', 'calibration'].includes(item.lineType) && (
                      <div className="flex gap-3">
                        <div className="flex-1">
                          <label className="block text-xs font-medium text-slate-500 mb-1">Result</label>
                          <div className="flex gap-2">
                            <button
                              type="button"
                              onClick={() => updateItem(item.id, { testResult: 'pass' })}
                              className={cn(
                                'flex-1 py-2 rounded-lg text-sm font-medium border-2 transition-colors',
                                item.testResult === 'pass' ? 'bg-green-100 border-green-400 text-green-800' : 'border-slate-200 text-slate-500',
                              )}
                            >
                              Pass
                            </button>
                            <button
                              type="button"
                              onClick={() => updateItem(item.id, { testResult: 'fail' })}
                              className={cn(
                                'flex-1 py-2 rounded-lg text-sm font-medium border-2 transition-colors',
                                item.testResult === 'fail' ? 'bg-red-100 border-red-400 text-red-800' : 'border-slate-200 text-slate-500',
                              )}
                            >
                              Fail
                            </button>
                          </div>
                        </div>
                        <div className="flex-1">
                          <label className="block text-xs font-medium text-slate-500 mb-1">Cal Gas Lot #</label>
                          <input
                            type="text"
                            value={item.calGasLotNumber || ''}
                            onChange={e => updateItem(item.id, { calGasLotNumber: e.target.value })}
                            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                          />
                        </div>
                      </div>
                    )}

                    {/* Notes are optional, including on labor lines. */}
                    <div>
                      <label className="block text-xs font-medium text-slate-500 mb-1">Notes (optional)</label>
                      <input
                        type="text"
                        value={item.notes || ''}
                        onChange={e => updateItem(item.id, { notes: e.target.value })}
                        placeholder="Optional notes"
                        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                      />
                    </div>

                    {/* Delete */}
                    <button
                      type="button"
                      onClick={() => removeItem(item.id)}
                      className="flex items-center gap-1 text-sm text-red-500 hover:text-red-700 font-medium"
                    >
                      <Trash2 className="w-4 h-4" />
                      Remove
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {items.length === 0 && (
        <div className="text-center py-6 text-sm text-slate-400 border border-dashed border-slate-300 rounded-lg">
          Tap an action above to add work items
        </div>
      )}

    </div>
  )
}
