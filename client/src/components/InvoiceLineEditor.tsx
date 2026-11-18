import { useState, useEffect, useRef, useCallback } from 'react'
import { api } from '@/lib/api'
import { Search, Trash2, Plus, AlertTriangle, CheckCircle } from 'lucide-react'
import { QuantityInput } from '@/components/QuantityInput'

export interface EditableLineItem {
  id?: string
  description: string
  productId: string | null
  partNumber: string | null
  qbItemFullName: string | null
  qbItemListId: string | null
  quantity: number
  unitOfMeasure: string
  rate: number
  amount: number
  isTaxable: boolean
  sourceTicketId: string | null
  sourceTicketNumber: string | null
  sourceShopItemId: string | null
  sourceRentalItemId: string | null
  notes: string | null
}

interface ProductResult {
  isTaxable: boolean
  id: string
  partNumber: string
  name: string
  defaultSellPrice: number | null
  qbItemFullName: string | null
  qbItemListId: string | null
  unitOfMeasure: string | null
}

interface Props {
  taxExempt?: boolean
  companyId?: string
  lineItems: EditableLineItem[]
  onChange: (items: EditableLineItem[]) => void
}

export function InvoiceLineEditor({ companyId, lineItems, onChange, taxExempt = false }: Props) {
  const [customerDescriptions, setCustomerDescriptions] = useState<{ qbItemListId: string; description: string }[]>([])
  const [descriptionError, setDescriptionError] = useState('')
  const [descriptionsLoading, setDescriptionsLoading] = useState(!!companyId)
  useEffect(() => {
    let cancelled = false
    setCustomerDescriptions([])
    setDescriptionError('')
    setDescriptionsLoading(!!companyId)
    if (companyId) api.get<{ data: { qbItemListId: string; description: string }[] }>(`/companies/${companyId}/customer-descriptions`)
      .then(result => { if (!cancelled) setCustomerDescriptions(result.data) })
      .catch(() => { if (!cancelled) setDescriptionError('Customer Alt Text could not load. Retry by reopening the invoice before choosing a replacement item.') })
      .finally(() => { if (!cancelled) setDescriptionsLoading(false) })
    return () => { cancelled = true }
  }, [companyId])
  const unmappedCount = lineItems.filter(
    li => li.amount > 0 && !li.qbItemFullName
  ).length

  const taxableSubtotal = lineItems
    .filter(li => li.isTaxable)
    .reduce((sum, li) => sum + (Number(li.amount) || 0), 0)

  function updateLine(index: number, updates: Partial<EditableLineItem>) {
    const updated = [...lineItems]
    updated[index] = { ...updated[index], ...updates }
    // Auto-calc amount when qty or rate changes
    if ('quantity' in updates || 'rate' in updates) {
      const qty = updates.quantity ?? updated[index].quantity
      const rate = updates.rate ?? updated[index].rate
      updated[index].amount = Math.round(qty * rate * 100) / 100
    }
    onChange(updated)
  }

  function removeLine(index: number) {
    onChange(lineItems.filter((_, i) => i !== index))
  }

  function addLine() {
    onChange([
      ...lineItems,
      {
        description: '',
        productId: null,
        partNumber: null,
        qbItemFullName: null,
        qbItemListId: null,
        quantity: 1,
        unitOfMeasure: 'EA',
        rate: 0,
        amount: 0,
        isTaxable: false,
        sourceTicketId: null,
        sourceTicketNumber: null,
        sourceShopItemId: null,
        sourceRentalItemId: null,
        notes: null,
      },
    ])
  }

  function onProductSelect(index: number, product: ProductResult) {
    if (descriptionsLoading || descriptionError) return
    updateLine(index, {
      productId: product.id,
      partNumber: product.partNumber,
      qbItemFullName: product.qbItemFullName,
      qbItemListId: product.qbItemListId,
      description: customerDescriptions.find(row => row.qbItemListId === product.qbItemListId)?.description || product.name,
      isTaxable: !taxExempt && product.isTaxable,
      rate: product.defaultSellPrice ?? lineItems[index].rate,
      unitOfMeasure: product.unitOfMeasure || 'EA',
      amount: Math.round(
        lineItems[index].quantity *
          (product.defaultSellPrice ?? lineItems[index].rate) *
          100
      ) / 100,
    })
  }

  return (
    <div>
      {descriptionsLoading && <p role="status" className="mb-2 text-sm text-slate-600">Loading customer Alt Text…</p>}
      {descriptionError && <p role="alert" className="mb-2 text-sm text-red-700">{descriptionError}</p>}
      {/* Warning banner */}
      {unmappedCount > 0 ? (
        <div className="flex items-center gap-2 mb-3 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-700">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          {unmappedCount} line{unmappedCount > 1 ? 's' : ''} missing QuickBooks item mapping
        </div>
      ) : lineItems.filter(li => li.amount > 0).length > 0 ? (
        <div className="flex items-center gap-2 mb-3 px-3 py-2 bg-emerald-50 border border-emerald-200 rounded-lg text-sm text-emerald-700">
          <CheckCircle className="w-4 h-4 shrink-0" />
          All billable lines mapped to QuickBooks
        </div>
      ) : null}

      {/* Header */}
      <div className="hidden lg:grid grid-cols-12 gap-2 px-2 py-1.5 text-[10px] text-slate-400 font-medium uppercase tracking-wider">
        <div className="col-span-4">Description / Part #</div>
        <div className="col-span-2">QB Item</div>
        <div className="col-span-1 text-right">Qty</div>
        <div className="col-span-2 text-right">Rate</div>
        <div className="col-span-2 text-right">Amount</div>
        <div className="col-span-1"></div>
      </div>

      {/* Lines */}
      <div className="space-y-2">
        {lineItems.map((li, idx) => (
          <LineRow
            key={idx}
            line={li}
            index={idx}
            onChange={updateLine}
            onRemove={removeLine}
            onProductSelect={onProductSelect}
            mappingDisabled={descriptionsLoading || !!descriptionError}
          />
        ))}
      </div>

      {/* Add line + taxable summary */}
      <div className="mt-3 flex items-center justify-between">
        <button
          onClick={addLine}
          className="flex items-center gap-1.5 text-sm text-blue-600 hover:text-blue-800 font-medium"
        >
          <Plus className="w-4 h-4" />
          Add Line
        </button>
        <span className="text-xs text-slate-400">
          Taxable subtotal: ${taxableSubtotal.toFixed(2)}
          <span className="hidden sm:inline"> — sales tax recalculates on save</span>
        </span>
      </div>
    </div>
  )
}

// ── Individual Line Row ──

function LineRow({
  line,
  index,
  onChange,
  onRemove,
  onProductSelect,
  mappingDisabled,
}: {
  line: EditableLineItem
  index: number
  onChange: (index: number, updates: Partial<EditableLineItem>) => void
  onRemove: (index: number) => void
  onProductSelect: (index: number, product: ProductResult) => void
  mappingDisabled: boolean
}) {
  const [partSearch, setPartSearch] = useState(line.partNumber || '')
  const [products, setProducts] = useState<ProductResult[]>([])
  const [showDropdown, setShowDropdown] = useState(false)
  const [, setSearching] = useState(false)
  const searchTimeout = useRef<ReturnType<typeof setTimeout>>(null)
  const desktopDropdownRef = useRef<HTMLDivElement>(null)
  const mobileDropdownRef = useRef<HTMLDivElement>(null)

  // Close dropdown on outside click (check both desktop & mobile refs)
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      const target = e.target as Node
      if (
        desktopDropdownRef.current?.contains(target) ||
        mobileDropdownRef.current?.contains(target)
      ) return
      setShowDropdown(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  const searchProducts = useCallback((query: string) => {
    if (searchTimeout.current) clearTimeout(searchTimeout.current)
    if (!query || query.length < 2) {
      setProducts([])
      setShowDropdown(false)
      return
    }
    searchTimeout.current = setTimeout(async () => {
      setSearching(true)
      try {
        const data = await api.get<{ data: ProductResult[] }>(
          `/products?search=${encodeURIComponent(query)}&limit=8&active=true`
        )
        setProducts(data.data)
        setShowDropdown(data.data.length > 0)
      } catch {
        setProducts([])
      }
      setSearching(false)
    }, 300)
  }, [])

  function handlePartChange(val: string) {
    setPartSearch(val)
    onChange(index, { partNumber: val })
    searchProducts(val)
  }

  function selectProduct(product: ProductResult) {
    setPartSearch(product.partNumber)
    setShowDropdown(false)
    onProductSelect(index, product)
  }

  const isBillable = line.amount > 0

  return (
    <div className={`rounded-lg border p-3 ${!line.qbItemFullName && isBillable ? 'border-amber-300 bg-amber-50/30' : 'border-slate-200 bg-white'}`}>
      {/* Desktop layout */}
      <div className="hidden lg:grid grid-cols-12 gap-2 items-start">
        {/* Description + Part search */}
        <div className="col-span-4 space-y-1.5">
          <input
            type="text"
            value={line.description}
            onChange={e => onChange(index, { description: e.target.value })}
            placeholder="Description"
            className="w-full text-sm px-2 py-1.5 border border-slate-200 rounded focus:ring-1 focus:ring-blue-500 focus:border-blue-500 outline-none"
          />
          <div className="relative" ref={desktopDropdownRef}>
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-400" />
            <input
              type="text"
              value={partSearch}
              onChange={e => handlePartChange(e.target.value)}
              placeholder="Part #"
              className="w-full text-xs pl-7 pr-2 py-1 border border-slate-200 rounded font-mono focus:ring-1 focus:ring-blue-500 focus:border-blue-500 outline-none"
            />
            {showDropdown && (
              <div className="absolute z-20 top-full mt-1 w-72 bg-white border border-slate-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
                {products.map(p => (
                  <button
                    key={p.id}
                    disabled={mappingDisabled}
                    onClick={() => selectProduct(p)}
                    className="w-full text-left px-3 py-2 hover:bg-blue-50 text-xs border-b border-slate-50 last:border-0"
                  >
                    <span className="font-mono font-medium text-slate-900">{p.partNumber}</span>
                    <span className="text-slate-500 ml-2">{p.name}</span>
                    {p.qbItemFullName && (
                      <span className="ml-2 text-emerald-600">QB: {p.qbItemFullName}</span>
                    )}
                    {p.defaultSellPrice != null && Number(p.defaultSellPrice) > 0 && (
                      <span className="ml-2 text-slate-400">${Number(p.defaultSellPrice).toFixed(2)}</span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
          <label className="flex items-center gap-1.5 text-[11px] text-slate-500 cursor-pointer select-none w-fit">
            <input
              type="checkbox"
              checked={line.isTaxable}
              onChange={e => onChange(index, { isTaxable: e.target.checked })}
              className="w-3.5 h-3.5 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
            />
            Sales taxable
          </label>
        </div>

        {/* QB Item (read-only) */}
        <div className="col-span-2 pt-1.5">
          {line.qbItemFullName ? (
            <span className="text-xs px-1.5 py-0.5 bg-emerald-50 text-emerald-700 rounded font-mono">
              {line.qbItemFullName}
            </span>
          ) : isBillable ? (
            <span className="text-xs px-1.5 py-0.5 bg-amber-100 text-amber-700 rounded flex items-center gap-1 w-fit">
              <AlertTriangle className="w-3 h-3" />
              Not mapped
            </span>
          ) : (
            <span className="text-xs text-slate-400">-</span>
          )}
        </div>

        {/* Qty + UOM */}
        <div className="col-span-1 flex gap-1">
          <QuantityInput
            value={line.quantity}
            onChange={quantity => onChange(index, { quantity })}
            min={0}
            className="w-[60%] text-sm text-right px-2 py-1.5 border border-slate-200 rounded focus:ring-1 focus:ring-blue-500 focus:border-blue-500 outline-none"
          />
          <input
            type="text"
            value={line.unitOfMeasure || 'EA'}
            onChange={e => onChange(index, { unitOfMeasure: e.target.value.toUpperCase() })}
            className="w-[40%] text-xs text-center px-1 py-1.5 border border-slate-200 rounded focus:ring-1 focus:ring-blue-500 focus:border-blue-500 outline-none uppercase"
            title="Unit of measure (EA, HR, MI, etc.)"
          />
        </div>

        {/* Rate */}
        <div className="col-span-2">
          <div className="relative">
            <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-slate-400">$</span>
            <input
              type="number"
              value={line.rate}
              onChange={e => onChange(index, { rate: parseFloat(e.target.value) || 0 })}
              min={0}
              step={0.01}
              className="w-full text-sm text-right pl-5 pr-2 py-1.5 border border-slate-200 rounded focus:ring-1 focus:ring-blue-500 focus:border-blue-500 outline-none"
            />
          </div>
        </div>

        {/* Amount (read-only) */}
        <div className="col-span-2 pt-2 text-right text-sm font-medium text-slate-900">
          ${Number(line.amount).toFixed(2)}
        </div>

        {/* Remove */}
        <div className="col-span-1 pt-1.5 text-right">
          <button
            onClick={() => onRemove(index)}
            className="p-1 text-slate-400 hover:text-red-500 rounded"
            title="Remove line"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Mobile layout */}
      <div className="lg:hidden space-y-2">
        <input
          type="text"
          value={line.description}
          onChange={e => onChange(index, { description: e.target.value })}
          placeholder="Description"
          className="w-full text-sm px-2 py-1.5 border border-slate-200 rounded focus:ring-1 focus:ring-blue-500 focus:border-blue-500 outline-none"
        />
        <div className="relative" ref={mobileDropdownRef}>
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-400" />
          <input
            type="text"
            value={partSearch}
            onChange={e => handlePartChange(e.target.value)}
            placeholder="Part #"
            className="w-full text-xs pl-7 pr-2 py-1.5 border border-slate-200 rounded font-mono focus:ring-1 focus:ring-blue-500 focus:border-blue-500 outline-none"
          />
          {showDropdown && (
            <div className="absolute z-20 top-full mt-1 w-full bg-white border border-slate-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
              {products.map(p => (
                <button
                  key={p.id}
                  disabled={mappingDisabled}
                    onClick={() => selectProduct(p)}
                  className="w-full text-left px-3 py-2 hover:bg-blue-50 text-xs border-b border-slate-50 last:border-0"
                >
                  <span className="font-mono font-medium">{p.partNumber}</span>
                  <span className="text-slate-500 ml-2">{p.name}</span>
                  {p.defaultSellPrice != null && Number(p.defaultSellPrice) > 0 && (
                    <span className="ml-1 text-slate-400">${Number(p.defaultSellPrice).toFixed(2)}</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <div className="flex-1">
            <label className="text-[10px] text-slate-400">Qty</label>
            <QuantityInput
              value={line.quantity}
              onChange={quantity => onChange(index, { quantity })}
              min={0}
              className="w-full text-sm px-2 py-1 border border-slate-200 rounded focus:ring-1 focus:ring-blue-500 outline-none"
            />
          </div>
          <div className="w-14">
            <label className="text-[10px] text-slate-400">UOM</label>
            <input
              type="text"
              value={line.unitOfMeasure || 'EA'}
              onChange={e => onChange(index, { unitOfMeasure: e.target.value.toUpperCase() })}
              className="w-full text-xs text-center px-1 py-1 border border-slate-200 rounded focus:ring-1 focus:ring-blue-500 outline-none uppercase"
            />
          </div>
          <div className="flex-1">
            <label className="text-[10px] text-slate-400">Rate</label>
            <input
              type="number"
              value={line.rate}
              onChange={e => onChange(index, { rate: parseFloat(e.target.value) || 0 })}
              className="w-full text-sm px-2 py-1 border border-slate-200 rounded focus:ring-1 focus:ring-blue-500 outline-none"
            />
          </div>
          <div className="flex-1">
            <label className="text-[10px] text-slate-400">Amount</label>
            <p className="text-sm font-medium pt-1">${Number(line.amount).toFixed(2)}</p>
          </div>
          <button onClick={() => onRemove(index)} className="mt-3 p-1 text-slate-400 hover:text-red-500">
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
        {line.qbItemFullName ? (
          <span className="text-[10px] px-1.5 py-0.5 bg-emerald-50 text-emerald-700 rounded font-mono inline-block">
            QB: {line.qbItemFullName}
          </span>
        ) : isBillable ? (
          <span className="text-[10px] px-1.5 py-0.5 bg-amber-100 text-amber-700 rounded inline-flex items-center gap-1">
            <AlertTriangle className="w-3 h-3" /> No QB mapping
          </span>
        ) : null}
        <label className="flex items-center gap-1.5 text-[11px] text-slate-500 cursor-pointer select-none w-fit mt-1">
          <input
            type="checkbox"
            checked={line.isTaxable}
            onChange={e => onChange(index, { isTaxable: e.target.checked })}
            className="w-3.5 h-3.5 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
          />
          Sales taxable
        </label>
      </div>
    </div>
  )
}
