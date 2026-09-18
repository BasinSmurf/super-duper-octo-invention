import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '@/lib/api'
import { Search, Wrench, ChevronRight, X, Plus, Loader2, Layers } from 'lucide-react'
import { cn } from '@/lib/cn'

interface EquipmentProduct {
  id: string
  partNumber: string
  name: string
  category: string
  isAssembly: boolean
}

interface Equipment {
  id: string
  serialNumber: string
  safeCoreSerial?: string | null
  status: string
  parentEquipmentId?: string | null
  product: EquipmentProduct
  currentPad?: { id: string; name: string } | null
  currentWell?: { id: string; wellName: string } | null
  currentCustomer?: { id: string; name: string } | null
  /** Set while the unit is out on a rental — the agreement to chase it down on. */
  currentRental?: { id: string; agreementNumber: string | null; status: string } | null
  _count?: { childEquipment: number }
}

interface ProductOption {
  id: string
  partNumber: string
  name: string
  category: string
  isSerialized: boolean
  isAssembly: boolean
}

// Cylinders use Hydro/UE terminology instead of "calibration" — see EquipmentDetailPage.
function isCylinder(product: { category: string; name: string; partNumber?: string }): boolean {
  if (product.category !== 'supplied_air_component') return false
  const hay = `${product.name} ${product.partNumber ?? ''}`.toLowerCase()
  return hay.includes('cylinder') || hay.includes('bottle')
}

const STATUS_COLORS: Record<string, string> = {
  available: 'bg-green-100 text-green-700',
  deployed: 'bg-blue-100 text-blue-700',
  rented: 'bg-purple-100 text-purple-700',
  in_repair: 'bg-amber-100 text-amber-700',
  repair: 'bg-amber-100 text-amber-700',
  in_transit: 'bg-cyan-100 text-cyan-700',
  lost: 'bg-red-100 text-red-700',
  retired: 'bg-slate-200 text-slate-500',
}

const STATUS_OPTIONS = ['', 'available', 'deployed', 'rented', 'repair', 'in_transit', 'lost', 'retired', 'out_of_service', 'condemned']

export function EquipmentPage() {
  const navigate = useNavigate()
  const [equipment, setEquipment] = useState<Equipment[]>([])
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [loading, setLoading] = useState(true)
  const [showAddForm, setShowAddForm] = useState(false)

  useEffect(() => {
    loadEquipment()
  }, [search, statusFilter])

  async function loadEquipment() {
    setLoading(true)
    try {
      const params = new URLSearchParams({ limit: '50' })
      if (search) params.set('search', search)
      if (statusFilter) params.set('status', statusFilter)
      const data = await api.get<{ data: Equipment[] }>(`/equipment?${params}`)
      setEquipment(data.data)
    } catch {
      setEquipment([])
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="relative">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-slate-900">Equipment</h1>
        <button
          onClick={() => setShowAddForm(true)}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium"
        >
          <Plus className="w-4 h-4" />
          New Unit
        </button>
      </div>

      {/* Search + Status Filter */}
      <div className="flex gap-2 mb-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by serial number..."
            className="w-full pl-10 pr-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
          />
        </div>
        <select
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value)}
          className="px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
        >
          <option value="">All statuses</option>
          {STATUS_OPTIONS.filter(Boolean).map(s => (
            <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>
          ))}
        </select>
      </div>

      {loading ? (
        <div className="text-center py-12 text-slate-400">Loading...</div>
      ) : (
        <div className="space-y-2">
          {equipment.map(item => (
            <div
              key={item.id}
              onClick={() => navigate(`/equipment/${item.id}`)}
              className="bg-white rounded-lg border border-slate-200 hover:border-slate-300 p-4 transition-colors cursor-pointer"
            >
              <div className="flex items-center gap-3">
                <div className={cn(
                  'w-10 h-10 rounded-lg flex items-center justify-center',
                  item.product.isAssembly ? 'bg-indigo-50' : 'bg-amber-50'
                )}>
                  {item.product.isAssembly
                    ? <Layers className="w-5 h-5 text-indigo-600" />
                    : <Wrench className="w-5 h-5 text-amber-600" />
                  }
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="font-medium text-slate-900 font-mono">{item.serialNumber}</p>
                    {item.product.isAssembly && (
                      <span className="px-1.5 py-0.5 text-[10px] font-bold bg-indigo-100 text-indigo-700 rounded">
                        ASSEMBLY
                      </span>
                    )}
                    {(item._count?.childEquipment ?? 0) > 0 && (
                      <span className="text-xs text-slate-400">
                        ({item._count!.childEquipment} items)
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-slate-500">{item.product.name}</p>
                  {item.safeCoreSerial && (
                    <p className="text-xs text-slate-400 font-mono">Core: {item.safeCoreSerial}</p>
                  )}
                  {item.currentCustomer && (
                    <p className="text-xs text-slate-400 mt-0.5">
                      {item.currentCustomer.name}
                      {item.currentPad ? ` \u2022 ${item.currentPad.name}` : ''}
                    </p>
                  )}
                  {/* Filtering this list to rented/deployed is the "what gear
                      is in use" view; without the agreement it could only say
                      a unit was out, never on what. Click through instead of
                      making someone search the rentals list for it. */}
                  {item.currentRental && (
                    <button
                      onClick={e => { e.stopPropagation(); navigate(`/rentals/${item.currentRental!.id}`) }}
                      className="text-xs font-mono text-purple-700 hover:underline mt-0.5"
                      title="Open the rental this unit is out on"
                    >
                      {item.currentRental.agreementNumber || 'rental'} &rarr;
                    </button>
                  )}
                </div>
                <span className={cn('px-2 py-0.5 rounded-full text-xs font-medium', STATUS_COLORS[item.status] || 'bg-slate-100')}>
                  {item.status.replace(/_/g, ' ')}
                </span>
                <ChevronRight className="w-4 h-4 text-slate-400" />
              </div>
            </div>
          ))}
          {equipment.length === 0 && (
            <div className="text-center py-12 text-slate-400">No equipment found</div>
          )}
        </div>
      )}

      {/* Add New Unit Modal */}
      {showAddForm && (
        <AddEquipmentModal
          onClose={() => setShowAddForm(false)}
          onCreated={(newId) => { setShowAddForm(false); if (newId) navigate(`/equipment/${newId}`); else loadEquipment() }}
        />
      )}
    </div>
  )
}

// ============================================================
// Enhanced Add Equipment Modal
// ============================================================

function AddEquipmentModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id?: string) => void }) {
  const [serialNumber, setSerialNumber] = useState('')
  const [productSearch, setProductSearch] = useState('')
  const [products, setProducts] = useState<ProductOption[]>([])
  const [selectedProduct, setSelectedProduct] = useState<ProductOption | null>(null)
  const [showDropdown, setShowDropdown] = useState(false)
  const [ownership, setOwnership] = useState('basin_safety')
  const [status, setStatus] = useState('available')
  const [calibrationDueDate, setCalibrationDueDate] = useState('')
  const [purchaseDate, setPurchaseDate] = useState('')
  const [conditionNotes, setConditionNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const dropdownRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (productSearch.length < 1) { setProducts([]); return }
    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ search: productSearch, limit: '15', active: 'true' })
        const res = await api.get<{ data: ProductOption[] }>(`/products?${params}`)
        setProducts(res.data.filter(p => p.isSerialized))
        setShowDropdown(true)
      } catch { setProducts([]) }
    }, 200)
    return () => clearTimeout(timer)
  }, [productSearch])

  function pickProduct(p: ProductOption) {
    setSelectedProduct(p)
    setProductSearch(`${p.partNumber} \u2014 ${p.name}`)
    setShowDropdown(false)
  }

  async function handleSave() {
    if (!selectedProduct || !serialNumber.trim()) return
    setSaving(true)
    setError('')
    try {
      const payload: Record<string, any> = {
        serialNumber: serialNumber.trim(),
        productId: selectedProduct.id,
        ownership,
        status,
      }
      if (calibrationDueDate) payload.calibrationDueDate = new Date(calibrationDueDate).toISOString()
      if (purchaseDate) payload.purchaseDate = new Date(purchaseDate).toISOString()
      if (conditionNotes.trim()) payload.conditionNotes = conditionNotes.trim()

      const result = await api.post<{ id: string }>('/equipment', payload)
      onCreated(result.id)
    } catch (err: any) {
      setError(err?.message || 'Failed to create equipment')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl max-w-md w-full max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200">
          <h2 className="text-lg font-bold text-slate-900">New Equipment Unit</h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-100">
            <X className="w-5 h-5 text-slate-500" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          {/* Product search */}
          <div className="relative" ref={dropdownRef}>
            <label className="block text-sm font-medium text-slate-700 mb-1">Product *</label>
            <input
              type="text"
              value={productSearch}
              onChange={e => { setProductSearch(e.target.value); setSelectedProduct(null) }}
              onFocus={() => products.length > 0 && setShowDropdown(true)}
              placeholder="Search product name or part #..."
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
            />
            {selectedProduct && (
              <div className="mt-1 flex items-center gap-2">
                <span className="text-xs px-1.5 py-0.5 bg-blue-50 text-blue-700 rounded font-mono">{selectedProduct.partNumber}</span>
                {selectedProduct.isAssembly && (
                  <span className="text-[9px] px-1 py-0.5 bg-indigo-100 text-indigo-700 rounded font-bold">ASSEMBLY</span>
                )}
              </div>
            )}
            {showDropdown && products.length > 0 && (
              <div className="absolute z-20 mt-1 w-full bg-white border border-slate-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
                {products.map(p => (
                  <button
                    key={p.id}
                    onClick={() => pickProduct(p)}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-blue-50 border-b border-slate-50 last:border-0"
                  >
                    <span className="font-mono font-medium text-slate-900">{p.partNumber}</span>
                    <span className="text-slate-500 ml-2">{p.name}</span>
                    {p.isAssembly && (
                      <span className="ml-2 text-[9px] px-1 py-0.5 bg-indigo-100 text-indigo-700 rounded font-bold">ASSEMBLY</span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Serial number */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Serial Number *</label>
            <input
              type="text"
              value={serialNumber}
              onChange={e => setSerialNumber(e.target.value)}
              placeholder="e.g. ESC-2025-005"
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none font-mono"
            />
          </div>

          {/* Ownership + Status */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Ownership</label>
              <select
                value={ownership}
                onChange={e => setOwnership(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
              >
                <option value="basin_safety">Basin Safety</option>
                <option value="customer_owned">Customer Owned</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Status</label>
              <select
                value={status}
                onChange={e => setStatus(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
              >
                <option value="available">Available</option>
                <option value="deployed">Deployed</option>
                <option value="rented">Rented</option>
                <option value="repair">Repair</option>
                <option value="in_transit">In Transit</option>
              </select>
            </div>
          </div>

          {/* Dates */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                {selectedProduct && isCylinder(selectedProduct) ? 'Hydro/UE Due' : 'Calibration Due'}
              </label>
              <input type="date" value={calibrationDueDate} onChange={e => setCalibrationDueDate(e.target.value)} className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Purchase Date</label>
              <input type="date" value={purchaseDate} onChange={e => setPurchaseDate(e.target.value)} className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none" />
            </div>
          </div>

          {/* Condition Notes */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Condition Notes</label>
            <textarea
              value={conditionNotes}
              onChange={e => setConditionNotes(e.target.value)}
              rows={2}
              placeholder="Optional notes about condition..."
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
            />
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-slate-200">
          <button onClick={onClose} className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-lg">
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !selectedProduct || !serialNumber.trim()}
            className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            Create Unit
          </button>
        </div>
      </div>
    </div>
  )
}
