import { useState, useEffect } from 'react'
import { api } from '@/lib/api'
import { X, Loader2, Plus, Search, CheckSquare, Square, Droplets } from 'lucide-react'

interface OperatorOption {
  id: string
  name: string
  parentCompany?: { id: string; name: string } | null
  childCompanies?: { id: string; name: string }[]
}

interface WellOption {
  id: string
  wellName: string | null
  apiNumber: string | null
  section: number | null
  township: number | null
  range: number | null
}

interface AddPadModalProps {
  onCreated: (pad: any) => void
  onClose: () => void
}

export function AddPadModal({ onCreated, onClose }: AddPadModalProps) {
  const [name, setName] = useState('')
  const [operatorId, setOperatorId] = useState('')
  const [operatorName, setOperatorName] = useState('')
  const [facilityCode, setFacilityCode] = useState('')
  const [tier1, setTier1] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Operator search
  const [operatorSearch, setOperatorSearch] = useState('')
  const [operators, setOperators] = useState<OperatorOption[]>([])

  // Step 2: pad is created, now attach DMR-verified wells (multi-select).
  const [createdPad, setCreatedPad] = useState<{ id: string; name: string } | null>(null)
  const [wellSearch, setWellSearch] = useState('')
  const [wellResults, setWellResults] = useState<WellOption[]>([])
  const [searchingWells, setSearchingWells] = useState(false)
  const [selectedWellIds, setSelectedWellIds] = useState<Set<string>>(new Set())
  const [attaching, setAttaching] = useState(false)

  useEffect(() => {
    if (!operatorSearch || operatorSearch.length < 2) { setOperators([]); return }
    const timer = setTimeout(async () => {
      try {
        const res = await api.get<{ data: OperatorOption[] }>(`/companies?search=${encodeURIComponent(operatorSearch)}&limit=10&active=true`)
        setOperators(res.data || [])
      } catch { setOperators([]) }
    }, 300)
    return () => clearTimeout(timer)
  }, [operatorSearch])

  useEffect(() => {
    if (!createdPad || wellSearch.trim().length < 2) { setWellResults([]); return }
    const timer = setTimeout(async () => {
      setSearchingWells(true)
      try {
        const params = new URLSearchParams({ operatorId, dmrVerified: 'true', search: wellSearch.trim(), limit: '25' })
        const res = await api.get<{ data: WellOption[] }>(`/locations/wells?${params}`)
        setWellResults(res.data || [])
      } catch { setWellResults([]) }
      finally { setSearchingWells(false) }
    }, 300)
    return () => clearTimeout(timer)
  }, [wellSearch, createdPad, operatorId])

  function toggleWell(id: string) {
    setSelectedWellIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function handleAttachWells() {
    if (!createdPad || selectedWellIds.size === 0) return
    setAttaching(true)
    try {
      await api.post('/locations/wells/bulk-reassign', {
        wellIds: [...selectedWellIds],
        padId: createdPad.id,
      })
      onCreated(createdPad)
    } catch (e: any) {
      setError(e.message || 'Failed to attach wells')
    } finally {
      setAttaching(false)
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim() || !operatorId) return
    setSaving(true)
    setError(null)
    try {
      const payload: Record<string, any> = {
        name: name.trim(),
        currentOperatorId: operatorId,
        pendingReview: true,
      }
      if (facilityCode.trim()) payload.facilityCode = facilityCode.trim()
      if (tier1) payload.tier1 = true
      const result = await api.post<{ id: string; name: string }>('/locations/pads', payload)
      setCreatedPad({ id: result.id, name: result.name })
    } catch (e: any) {
      setError(e.message || 'Failed to create pad')
    } finally {
      setSaving(false)
    }
  }

  // Step 2 — pad exists, attach wells (or skip).
  if (createdPad) {
    return (
      <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
        <div className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-auto">
          <div className="flex items-center justify-between px-5 py-4 border-b">
            <h2 className="text-lg font-semibold text-gray-900">Add wells to "{createdPad.name}"</h2>
            <button onClick={() => onCreated(createdPad)} className="text-gray-400 hover:text-gray-600">
              <X className="w-5 h-5" />
            </button>
          </div>
          <div className="px-5 py-4 space-y-3">
            {error && (
              <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded text-sm">{error}</div>
            )}
            <p className="text-xs text-gray-500">
              Only DMR-verified wells for this operator are shown. A pad only matters when it groups more than one well — search and select as many as belong here.
            </p>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
              <input
                type="text"
                value={wellSearch}
                onChange={e => setWellSearch(e.target.value)}
                placeholder="Search wells by name or API#..."
                autoFocus
                className="w-full pl-8 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>
            {searchingWells && (
              <div className="flex items-center gap-2 text-sm text-gray-400 py-2">
                <Loader2 className="w-4 h-4 animate-spin" /> Searching...
              </div>
            )}
            {wellResults.length > 0 && (
              <div className="max-h-64 overflow-y-auto space-y-1 border border-gray-200 rounded-lg p-1">
                {wellResults.map(w => (
                  <button
                    key={w.id}
                    type="button"
                    onClick={() => toggleWell(w.id)}
                    className="w-full text-left px-3 py-2 rounded-md hover:bg-blue-50 text-sm flex items-center gap-2"
                  >
                    {selectedWellIds.has(w.id)
                      ? <CheckSquare className="w-4 h-4 text-blue-600 shrink-0" />
                      : <Square className="w-4 h-4 text-gray-300 shrink-0" />}
                    <Droplets className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                    <span className="flex-1 min-w-0 truncate">{w.wellName || 'Unnamed Well'}</span>
                    {w.apiNumber && <span className="text-xs text-gray-400 shrink-0">API {w.apiNumber}</span>}
                  </button>
                ))}
              </div>
            )}
            {wellSearch.trim().length >= 2 && !searchingWells && wellResults.length === 0 && (
              <p className="text-sm text-gray-400 text-center py-4">No DMR-verified wells found for this operator.</p>
            )}
            <div className="flex items-center gap-3 pt-2">
              <button
                type="button"
                onClick={handleAttachWells}
                disabled={attaching || selectedWellIds.size === 0}
                className="flex-1 flex items-center justify-center gap-2 py-2.5 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors text-sm"
              >
                {attaching ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                Add {selectedWellIds.size || ''} well{selectedWellIds.size === 1 ? '' : 's'}
              </button>
              <button
                type="button"
                onClick={() => onCreated(createdPad)}
                className="px-4 py-2.5 text-gray-500 hover:text-gray-700 text-sm"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-auto">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
            <Plus className="w-5 h-5 text-blue-600" /> Add Pad
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-5 py-4 space-y-4">
          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded text-sm">{error}</div>
          )}

          {/* Operator */}
          <div>
            <label className="text-sm font-medium text-gray-700 block mb-1">Operator *</label>
            {operatorId ? (
              <div className="flex items-center gap-2 text-sm">
                <span className="bg-blue-50 text-blue-700 px-2 py-1 rounded">{operatorName}</span>
                <button type="button" onClick={() => { setOperatorId(''); setOperatorName(''); setOperatorSearch('') }} className="text-gray-400 hover:text-red-600">
                  <X className="w-4 h-4" />
                </button>
              </div>
            ) : (
              <div className="relative">
                <input
                  type="text"
                  value={operatorSearch}
                  onChange={e => setOperatorSearch(e.target.value)}
                  placeholder="Search by company name..."
                  autoFocus
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
                {operators.length > 0 && (
                  <div className="absolute z-10 top-full left-0 right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-72 overflow-auto">
                    {operators.map(op => {
                      const childCount = op.childCompanies?.length ?? 0
                      return (
                        <button
                          key={op.id}
                          type="button"
                          onClick={() => { setOperatorId(op.id); setOperatorName(op.name); setOperatorSearch(op.name) }}
                          className="w-full text-left px-3 py-2 text-sm hover:bg-blue-50 transition-colors border-b border-gray-100 last:border-b-0"
                        >
                          <span className="font-medium text-gray-800 truncate">{op.name}</span>
                          {(op.parentCompany || childCount > 0) && (
                            <div className="text-xs text-gray-500 mt-0.5">
                              {op.parentCompany && <span>under {op.parentCompany.name}</span>}
                              {op.parentCompany && childCount > 0 && <span> · </span>}
                              {childCount > 0 && <span>{childCount} child operator{childCount === 1 ? '' : 's'}</span>}
                            </div>
                          )}
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Name */}
          <div>
            <label className="text-sm font-medium text-gray-700 block mb-1">Pad Name *</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. Deep Creek Federal 43X"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>

          {/* Facility Code */}
          <div>
            <label className="text-sm font-medium text-gray-700 block mb-1">Facility Code</label>
            <input
              type="text"
              value={facilityCode}
              onChange={e => setFacilityCode(e.target.value)}
              placeholder="e.g. FC17708 — operator charge-to (Enverus)"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>

          {/* Tier 1 (reservation) */}
          <label className="flex items-start gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={tier1}
              onChange={e => setTier1(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            <span>
              <span className="text-sm font-medium text-gray-700">Tier 1 (reservation)</span>
              <span className="block text-xs text-gray-500">Pad sits on a Native American reservation. Affects billing rules.</span>
            </span>
          </label>

          {/* Submit */}
          <div className="flex items-center gap-3 pt-2">
            <button
              type="submit"
              disabled={saving || !name.trim() || !operatorId}
              className="flex-1 flex items-center justify-center gap-2 py-2.5 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm"
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              Create Pad
            </button>
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2.5 text-gray-500 hover:text-gray-700 text-sm"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
