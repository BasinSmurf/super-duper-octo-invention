import { useState, useCallback, useEffect, useRef } from 'react'
import { api } from '@/lib/api'
import { X, Loader2, Plus, Search, MapPin, CheckCircle2, Database } from 'lucide-react'

interface AddWellModalProps {
  /** Pre-selected pad context — omit to create a standalone, unattached asset */
  padId?: string
  padName?: string
  operatorId?: string | null
  onCreated: (well: any) => void
  onClose: () => void
}

interface DmrWell {
  id: string
  apiNumber: string
  wellName: string | null
  operatorName: string | null
  fieldName: string | null
  section: number | null
  township: number | null
  range: number | null
  latitude: number | null
  longitude: number | null
  wellType: string | null
  wellStatus: string | null
  county: string | null
  totalDepth: number | null
  matchedWellId: string | null
}

const WELL_TYPES = [
  { value: '', label: 'Select...' },
  { value: 'OG', label: 'Oil & Gas' },
  { value: 'SWD', label: 'Salt Water Disposal' },
  { value: 'WI', label: 'Water Injection' },
  { value: 'GI', label: 'Gas Injection' },
  { value: 'OB', label: 'Observation' },
  { value: 'ST', label: 'Stratigraphic Test' },
]

const WELL_STATUSES = [
  { value: '', label: 'Select...' },
  { value: 'A', label: 'Active' },
  { value: 'LOC', label: 'Location' },
  { value: 'WC', label: 'Waiting Completion' },
  { value: 'DC', label: 'Drilling Complete' },
  { value: 'SI', label: 'Shut In' },
  { value: 'IA', label: 'Inactive' },
  { value: 'TA', label: 'Temp Abandoned' },
  { value: 'PA', label: 'Plugged & Abandoned' },
  { value: 'DRY', label: 'Dry Hole' },
]

type Tab = 'dmr' | 'manual'

export function AddWellModal({ padId, padName, operatorId, onCreated, onClose }: AddWellModalProps) {
  const [tab, setTab] = useState<Tab>('dmr')

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b shrink-0">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
              <Plus className="w-5 h-5 text-blue-600" /> {padId ? 'Add Well' : 'Add Asset'}
            </h2>
            <p className="text-xs text-gray-500 mt-0.5">
              {padId ? `on pad: ${padName}` : 'Unattached — can be assigned to a pad later'}
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b shrink-0">
          <button
            onClick={() => setTab('dmr')}
            className={`flex-1 py-2.5 text-sm font-medium text-center transition-colors ${
              tab === 'dmr'
                ? 'text-blue-600 border-b-2 border-blue-600'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            <Database className="w-4 h-4 inline-block mr-1.5 -mt-0.5" />
            DMR Lookup
          </button>
          <button
            onClick={() => setTab('manual')}
            className={`flex-1 py-2.5 text-sm font-medium text-center transition-colors ${
              tab === 'manual'
                ? 'text-blue-600 border-b-2 border-blue-600'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            <Plus className="w-4 h-4 inline-block mr-1.5 -mt-0.5" />
            Manual Entry
          </button>
        </div>

        {/* Tab Content */}
        <div className="overflow-auto flex-1">
          {tab === 'dmr' ? (
            <DmrLookupTab
              padId={padId}
              operatorId={operatorId}
              onCreated={onCreated}
              onClose={onClose}
            />
          ) : (
            <ManualEntryTab
              padId={padId}
              operatorId={operatorId}
              onCreated={onCreated}
              onClose={onClose}
            />
          )}
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════
//  Operator picker (shared by both tabs)
// ═══════════════════════════════════════════

interface CompanyOption {
  id: string
  name: string
}

/**
 * Who does this well belong to? Asked whenever the surrounding context can't
 * answer it — standalone Add Asset, or a pad that itself has no operator.
 *
 * A well with no operator is filtered out of every operator-scoped picker in
 * the app (the pad builder's well search, AddPadModal's attach step, the
 * company's own location list), so it can never be found or grouped again.
 * That makes this the difference between a usable record and an orphan.
 */
function OperatorPicker({
  value, onChange, required, hint,
}: {
  value: CompanyOption | null
  onChange: (c: CompanyOption | null) => void
  required?: boolean
  hint?: string
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<CompanyOption[]>([])
  const [searching, setSearching] = useState(false)
  const debounce = useRef<ReturnType<typeof setTimeout>>(null)

  function handleQuery(val: string) {
    setQuery(val)
    onChange(null)
    if (debounce.current) clearTimeout(debounce.current)
    if (val.trim().length < 2) { setResults([]); return }
    setSearching(true)
    debounce.current = setTimeout(async () => {
      try {
        const r = await api.get<{ data: CompanyOption[] }>(
          `/companies?search=${encodeURIComponent(val.trim())}&limit=10&active=true`,
        )
        setResults(r.data || [])
      } catch {
        setResults([])
      } finally {
        setSearching(false)
      }
    }, 300)
  }

  return (
    <div>
      <label className="text-sm font-medium text-gray-700 block mb-1">
        Operator{required ? ' *' : ''}
      </label>
      {value ? (
        <div className="flex items-center gap-2">
          <span className="flex-1 truncate text-sm bg-emerald-50 text-emerald-800 border border-emerald-200 rounded-lg px-3 py-2">
            {value.name}
          </span>
          <button
            type="button"
            onClick={() => { onChange(null); setQuery(''); setResults([]) }}
            className="text-gray-400 hover:text-red-600"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      ) : (
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            value={query}
            onChange={e => handleQuery(e.target.value)}
            placeholder="Who operates it? Search customers..."
            className="w-full pl-9 pr-9 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
          {searching && (
            <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 animate-spin text-blue-500" />
          )}
          {results.length > 0 && (
            <div className="absolute z-10 left-0 right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-40 overflow-auto">
              {results.map(c => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => { onChange(c); setResults([]); setQuery(c.name) }}
                  className="w-full text-left px-3 py-2 text-sm hover:bg-blue-50 border-b border-gray-100 last:border-b-0 truncate"
                >
                  {c.name}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {hint && <p className="mt-1 text-[11px] text-gray-500">{hint}</p>}
    </div>
  )
}

// ═══════════════════════════════════════════
//  DMR Lookup Tab
// ═══════════════════════════════════════════

interface DmrLookupTabProps {
  padId?: string
  operatorId?: string | null
  onCreated: (well: any) => void
  onClose: () => void
}

function DmrLookupTab({ padId, operatorId, onCreated, onClose }: DmrLookupTabProps) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<DmrWell[]>([])
  const [total, setTotal] = useState(0)
  const [searching, setSearching] = useState(false)
  const [activating, setActivating] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dmrEmpty, setDmrEmpty] = useState(false)
  const [hasSearched, setHasSearched] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null)

  // Activation needs an operator; ask for one when the context didn't supply it.
  const [operator, setOperator] = useState<CompanyOption | null>(null)
  const effectiveOperatorId = operatorId || operator?.id || null

  // Check if DMR data exists on mount
  useEffect(() => {
    api.get<{ data: DmrWell[]; total: number }>('/locations/dmr?limit=1')
      .then(r => {
        if (r.total === 0) setDmrEmpty(true)
      })
      .catch(() => {})
  }, [])

  const doSearch = useCallback(async (q: string) => {
    if (q.length < 2) {
      setResults([])
      setTotal(0)
      setHasSearched(false)
      return
    }
    setSearching(true)
    setError(null)
    setHasSearched(true)
    try {
      const r = await api.get<{ data: DmrWell[]; total: number }>(
        `/locations/dmr?search=${encodeURIComponent(q)}&limit=20`
      )
      setResults(r.data)
      setTotal(r.total)
    } catch (e: any) {
      setError(e.message || 'Search failed')
    } finally {
      setSearching(false)
    }
  }, [])

  function handleSearchChange(val: string) {
    setQuery(val)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => doSearch(val), 300)
  }

  async function handleActivate(dmr: DmrWell) {
    if (!effectiveOperatorId) {
      setError('Pick the operator this well belongs to first.')
      return
    }
    setActivating(dmr.id)
    setError(null)
    try {
      const payload: Record<string, any> = {
        dmrWellIds: [dmr.id],
        operatorId: effectiveOperatorId,
      }
      if (padId) payload.padId = padId
      const result = await api.post<{ activated: number; wells: any[]; ambiguous?: unknown[] }>('/locations/dmr/activate', payload)
      if (result.wells && result.wells.length > 0) {
        onCreated(result.wells[0])
        return
      }
      // Nothing was created: the row name-matches an existing unattached well,
      // so the server held it back for an explicit same-well-or-not call. That
      // resolver lives in the DMR browser, not here.
      setError(
        (result.ambiguous?.length ?? 0) > 0
          ? 'This well may already exist unattached — confirm it under Locations → DMR Well Database before activating.'
          : 'Nothing was activated — it may already be active.',
      )
      setActivating(null)
    } catch (e: any) {
      setError(e.message || 'Failed to activate well')
      setActivating(null)
    }
  }

  if (dmrEmpty) {
    return (
      <div className="px-5 py-10 text-center">
        <Database className="w-10 h-10 text-gray-300 mx-auto mb-3" />
        <p className="text-sm text-gray-500">No DMR data imported yet.</p>
        <p className="text-xs text-gray-400 mt-1">
          Import via <span className="font-medium">Locations &rarr; DMR Import</span>
        </p>
        <button
          onClick={onClose}
          className="mt-4 px-4 py-2 text-sm text-gray-500 hover:text-gray-700"
        >
          Close
        </button>
      </div>
    )
  }

  return (
    <div className="px-5 py-4">
      {/* DMR's own operatorName is deliberately NOT used to fill this in — it's
          a snapshot that goes stale with every trade, and the well has to end
          up under whoever we actually bill for it. */}
      {!operatorId && (
        <div className="mb-3">
          <OperatorPicker
            value={operator}
            onChange={setOperator}
            required
            hint="Whoever operates it today — the operator DMR lists is often a trade or two out of date."
          />
        </div>
      )}

      {/* Search box */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
        <input
          type="text"
          value={query}
          onChange={e => handleSearchChange(e.target.value)}
          placeholder="Search well name, API #, or operator..."
          autoFocus
          className="w-full pl-9 pr-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
        />
        {searching && (
          <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 animate-spin text-blue-500" />
        )}
      </div>

      {error && (
        <div className="mt-3 bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded text-sm">{error}</div>
      )}

      {/* Results */}
      {hasSearched && !searching && results.length === 0 && (
        <p className="mt-6 text-center text-sm text-gray-400">No matches found</p>
      )}

      {results.length > 0 && (
        <div className="mt-3 space-y-2">
          <p className="text-xs text-gray-400">
            {total > 20 ? `Showing 20 of ${total} results` : `${total} result${total !== 1 ? 's' : ''}`}
          </p>

          {results.map(dmr => {
            const alreadyActive = !!dmr.matchedWellId
            const isActivating = activating === dmr.id

            return (
              <button
                key={dmr.id}
                disabled={alreadyActive || isActivating || !effectiveOperatorId}
                onClick={() => handleActivate(dmr)}
                title={!effectiveOperatorId ? 'Pick an operator first' : undefined}
                className={`w-full text-left border rounded-lg px-3 py-2.5 transition-colors ${
                  alreadyActive
                    ? 'bg-gray-50 border-gray-200 opacity-60 cursor-not-allowed'
                    : !effectiveOperatorId
                    ? 'border-gray-200 opacity-60 cursor-not-allowed'
                    : 'border-gray-200 hover:border-blue-400 hover:bg-blue-50 cursor-pointer'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-gray-900 truncate">
                      {dmr.wellName || 'Unnamed'}
                    </p>
                    <p className="text-xs text-gray-500 font-mono mt-0.5">{dmr.apiNumber}</p>
                    <p className="text-xs text-gray-400 mt-0.5 truncate">
                      {dmr.operatorName}
                      {dmr.fieldName ? ` \u2022 ${dmr.fieldName}` : ''}
                    </p>
                    <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1 text-xs text-gray-400">
                      {dmr.section != null && (
                        <span>
                          S{dmr.section}-T{dmr.township}N-R{dmr.range}W
                        </span>
                      )}
                      {dmr.county && <span>{dmr.county} Co.</span>}
                      {dmr.wellType && <span>{dmr.wellType}</span>}
                      {dmr.wellStatus && <span>Status: {dmr.wellStatus}</span>}
                      {dmr.latitude && dmr.longitude && (
                        <span className="flex items-center gap-0.5">
                          <MapPin className="w-3 h-3" />
                          GPS
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="shrink-0 mt-0.5">
                    {alreadyActive ? (
                      <span className="inline-flex items-center gap-1 text-xs bg-green-100 text-green-700 px-2 py-1 rounded-full">
                        <CheckCircle2 className="w-3 h-3" /> Active
                      </span>
                    ) : isActivating ? (
                      <Loader2 className="w-4 h-4 animate-spin text-blue-500" />
                    ) : (
                      <span className="text-xs text-blue-500 font-medium">+ Add</span>
                    )}
                  </div>
                </div>
              </button>
            )
          })}
        </div>
      )}

      {!hasSearched && !searching && (
        <p className="mt-8 text-center text-sm text-gray-400">
          Type at least 2 characters to search the DMR database
        </p>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════
//  Manual Entry Tab (original form)
// ═══════════════════════════════════════════

interface ManualEntryTabProps {
  padId?: string
  operatorId?: string | null
  onCreated: (well: any) => void
  onClose: () => void
}

interface ExistingWellMatch {
  id: string
  wellName: string | null
  apiNumber: string | null
  assetCategory: string
  currentOperator: { id: string; name: string } | null
}

const ASSET_CATEGORY_LABELS: Record<string, string> = {
  other_mobile: 'Mobile asset',
  gas_plant: 'Gas plant', tank_battery: 'Tank battery', compressor_station: 'Compressor station',
  swd_facility: 'SWD facility', office: 'Office', shop: 'Shop',
}

function ManualEntryTab({ padId, operatorId, onCreated, onClose }: ManualEntryTabProps) {
  const [wellName, setWellName] = useState('')
  const [apiNumber, setApiNumber] = useState('')
  const [wellType, setWellType] = useState('')
  const [wellStatus, setWellStatus] = useState('A')
  const [facilityCode, setFacilityCode] = useState('')
  const [costCenter, setCostCenter] = useState('')
  const [assetCategory, setAssetCategory] = useState('site')
  const [hasSuppliedAir, setHasSuppliedAir] = useState(false)
  const [isHighRisk, setIsHighRisk] = useState(false)
  const [riskNotes, setRiskNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [linking, setLinking] = useState<string | null>(null)

  // Same orphan problem as the DMR tab: with no operator the record can't be
  // found again in any operator-scoped picker. Required for a real wellbore;
  // optional for the off-lease categories, where our own shop/office genuinely
  // has no operator.
  const [operator, setOperator] = useState<CompanyOption | null>(null)
  const effectiveOperatorId = operatorId || operator?.id || null
  const operatorRequired = !operatorId && assetCategory === 'site'

  // "Use this" re-parents the existing well to THIS pad rather than leaving
  // its old padId stale — a floating asset's padId is just "wherever it's
  // being used today," so moving it here on reuse is expected, not a bug.
  // With no pad context (standalone Add Asset), there's nothing to
  // re-parent to — just select the existing record as-is.
  async function selectExistingWell(m: ExistingWellMatch) {
    if (!padId) { onCreated(m); return }
    setLinking(m.id)
    setError(null)
    try {
      const updated = await api.put(`/locations/wells/${m.id}`, { padId })
      onCreated(updated)
    } catch (e: any) {
      setError(e.message || 'Failed to link existing well')
    } finally {
      setLinking(null)
    }
  }

  // Named things (rigs, trucks) get re-created once per operator because
  // nothing here ever checked for an existing well by name across the WHOLE
  // app before creating one. Search ALL operators — not just this one — so
  // "Big Sky 12" under a different operator shows up before a duplicate
  // gets created for it.
  const [existingMatches, setExistingMatches] = useState<ExistingWellMatch[]>([])
  const [searchingExisting, setSearchingExisting] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null)

  function handleNameChange(val: string) {
    setWellName(val)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (val.trim().length < 3) { setExistingMatches([]); return }
    debounceRef.current = setTimeout(async () => {
      setSearchingExisting(true)
      try {
        const r = await api.get<{ data: ExistingWellMatch[] }>(`/locations/wells?search=${encodeURIComponent(val.trim())}&limit=5`)
        setExistingMatches(r.data)
      } catch {
        setExistingMatches([])
      } finally {
        setSearchingExisting(false)
      }
    }, 350)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!wellName.trim()) return
    if (operatorRequired && !effectiveOperatorId) {
      setError('Pick the operator this well belongs to.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const payload: Record<string, any> = {
        wellName: wellName.trim(),
        pendingReview: true,
        assetCategory,
      }
      if (padId) payload.padId = padId
      if (effectiveOperatorId) payload.currentOperatorId = effectiveOperatorId
      if (assetCategory === 'site') {
        if (apiNumber) payload.apiNumber = apiNumber.trim()
        if (wellType) payload.wellType = wellType
        if (wellStatus) payload.wellStatus = wellStatus
      }
      if (facilityCode.trim()) payload.facilityCode = facilityCode.trim()
      if (costCenter.trim()) payload.costCenter = costCenter.trim()
      payload.hasSuppliedAir = hasSuppliedAir
      payload.isHighRisk = isHighRisk
      if (isHighRisk && riskNotes) payload.riskNotes = riskNotes
      const result = await api.post('/locations/wells', payload)
      onCreated(result)
    } catch (e: any) {
      setError(e.message || 'Failed to create well')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="px-5 py-4 space-y-4">
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded text-sm">{error}</div>
      )}

      {/* Well/Asset Name */}
      <div>
        <label className="text-sm font-medium text-gray-700 block mb-1">{padId ? 'Well Name *' : 'Name *'}</label>
        <input
          type="text"
          value={wellName}
          onChange={e => handleNameChange(e.target.value)}
          placeholder="e.g. Deep Creek 43X-05H"
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
        />
        {searchingExisting && (
          <p className="text-xs text-gray-400 mt-1">Checking for an existing match...</p>
        )}
        {existingMatches.length > 0 && (
          <div className="mt-2 space-y-1.5">
            <p className="text-xs font-medium text-amber-700">
              Already exists — use one of these instead of creating a duplicate?
            </p>
            {existingMatches.map(m => (
              <button
                key={m.id}
                type="button"
                disabled={linking === m.id}
                onClick={() => selectExistingWell(m)}
                className="w-full text-left border border-amber-200 bg-amber-50 hover:bg-amber-100 rounded-lg px-3 py-2 transition-colors disabled:opacity-60"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-gray-900 truncate">{m.wellName}</span>
                  {m.assetCategory !== 'site' && (
                    <span className="text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 shrink-0">
                      {ASSET_CATEGORY_LABELS[m.assetCategory] || m.assetCategory}
                    </span>
                  )}
                </div>
                <p className="text-xs text-gray-500 truncate">
                  {linking === m.id ? 'Linking...' : `${m.currentOperator?.name || 'No operator'}${m.apiNumber ? ` · ${m.apiNumber}` : ''}`}
                </p>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Operator — only asked for when the context didn't supply one */}
      {!operatorId && (
        <OperatorPicker
          value={operator}
          onChange={setOperator}
          required={operatorRequired}
          hint={
            operatorRequired
              ? undefined
              : 'Optional for an off-lease asset (our own shop or office has no operator).'
          }
        />
      )}

      {/* Asset type */}
      <div>
        <label className="text-sm font-medium text-gray-700 block mb-1">Asset type</label>
        <select
          value={assetCategory}
          onChange={e => setAssetCategory(e.target.value)}
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
        >
          <option value="site">Normal well</option>
          <option value="other_mobile">Other mobile asset (any operator)</option>
          <optgroup label="Fixed asset — never a DMR wellbore">
            <option value="gas_plant">Gas plant</option>
            <option value="tank_battery">Tank battery</option>
            <option value="compressor_station">Compressor station</option>
            <option value="swd_facility">SWD facility</option>
            <option value="office">Office</option>
            <option value="shop">Shop</option>
          </optgroup>
        </select>
        {assetCategory !== 'site' && (
          <p className="mt-1 text-[11px] text-gray-500">
            Flagged as a non-wellbore asset — future adds for this same name will surface it as a
            match under ANY operator instead of creating a duplicate.
          </p>
        )}
      </div>

      {/* API Number — wellbores only, never applicable to a mobile/fixed asset */}
      {assetCategory === 'site' && (
        <div>
          <label className="text-sm font-medium text-gray-700 block mb-1">API Number</label>
          <input
            type="text"
            value={apiNumber}
            onChange={e => setApiNumber(e.target.value)}
            placeholder="e.g. 33-053-12345"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
        </div>
      )}

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

      {/* Cost Code — the buyer's cost center for work here; stamped onto new invoices */}
      <div>
        <label className="text-sm font-medium text-gray-700 block mb-1">Cost Code</label>
        <input
          type="text"
          value={costCenter}
          onChange={e => setCostCenter(e.target.value)}
          placeholder="e.g. US00098792 — operator cost center (Enverus)"
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
        />
      </div>

      {/* Type and Status — wellbore classification, not meaningful off-site */}
      {assetCategory === 'site' && (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-sm font-medium text-gray-700 block mb-1">Well Type</label>
            <select
              value={wellType}
              onChange={e => setWellType(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            >
              {WELL_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
          <div>
            <label className="text-sm font-medium text-gray-700 block mb-1">Status</label>
            <select
              value={wellStatus}
              onChange={e => setWellStatus(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            >
              {WELL_STATUSES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </div>
        </div>
      )}

      {/* Operational flags */}
      <div className="space-y-2">
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={hasSuppliedAir}
            onChange={e => setHasSuppliedAir(e.target.checked)}
            className="rounded"
          />
          Has Supplied Air
        </label>
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={isHighRisk}
            onChange={e => setIsHighRisk(e.target.checked)}
            className="rounded"
          />
          High Risk Location
        </label>
        {isHighRisk && (
          <textarea
            value={riskNotes}
            onChange={e => setRiskNotes(e.target.value)}
            placeholder="Risk notes (e.g. H2S present, confined space)..."
            rows={2}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 resize-none"
          />
        )}
      </div>

      {/* Submit */}
      <div className="flex items-center gap-3 pt-2">
        <button
          type="submit"
          disabled={saving || !wellName.trim() || (operatorRequired && !effectiveOperatorId)}
          className="flex-1 flex items-center justify-center gap-2 py-2.5 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
          {padId ? 'Create Well' : 'Create Asset'}
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
  )
}
