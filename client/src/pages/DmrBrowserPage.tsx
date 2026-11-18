import { DmrAmbiguityChoices } from '@/components/DmrAmbiguityChoices'
import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '@/contexts/AuthContext'
import { api } from '@/lib/api'
import { hasPermission } from '@/lib/permissions'
import { WellBackfillPanel } from '@/components/WellBackfillPanel'
import { DmrOperatorActivatePanel } from '@/components/DmrOperatorActivatePanel'
import {
  Search,
  Database,
  Upload,
  Loader2,
  ChevronLeft,
  ChevronDown,
  ChevronUp,
  CheckCircle2,
  MapPin,
  Filter,
  X,
  AlertCircle,
  AlertTriangle,
  FileSpreadsheet,
  CloudDownload,
  Layers,
} from 'lucide-react'

// ── Types ──

interface DmrWell {
  id: string
  apiNumber: string
  wellName: string | null
  operatorName: string | null
  fieldName: string | null
  section: number | null
  township: number | null
  range: number | null
  // Prisma Decimal columns serialize to JSON as strings — coerce before .toFixed
  latitude: number | string | null
  longitude: number | string | null
  wellType: string | null
  wellStatus: string | null
  county: string | null
  totalDepth: number | string | null
  matchedWellId: string | null
}

interface ImportStatus {
  totalRecords: number
  matchedToActive: number
  lastImportDate: string | null
}

interface ImportResult {
  totalRows: number
  created: number
  updated: number
  skipped: number
  errors: number
  mergedInFile?: number
  deduped?: { renamed: number; groupsMerged: number; duplicatesRemoved: number }
  errorSamples?: string[]
  importDate: string
  // Only on "Get newest from DMR":
  sourceLastModified?: string | null
  wellStatus?: {
    activeWellsChecked: number
    statusUpdated: number
    statusChanges: Record<string, number>
    unmappedStatusSkipped: number
  }
}

interface PadOption {
  id: string
  name: string
  currentOperator?: { id: string; name: string } | null
}

interface CompanyOption {
  id: string
  name: string
}

// mirror server/src/services/wellDmrMatch.ts ExistingWellCandidate
interface ExistingWellCandidate {
  id: string; wellName: string | null; apiNumber: string | null
  fieldName: string | null; padName: string | null; operatorName: string | null
  score: number; exact: boolean
}
interface AmbiguousActivation {
  dmrWellId: string; wellName: string | null; apiNumber: string | null; fieldName: string | null
  candidates: ExistingWellCandidate[]
}
type Resolution = { action: 'link'; wellId: string } | { action: 'create' }

// ── Component ──

export function DmrBrowserPage() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const canImport = hasPermission(user?.role, 'locations:import_dmr')
  const canManage = hasPermission(user?.role, 'locations:manage')

  // Import section
  const [importOpen, setImportOpen] = useState(false)
  const [importStatus, setImportStatus] = useState<ImportStatus | null>(null)
  const [uploading, setUploading] = useState(false)
  const [fetchingLatest, setFetchingLatest] = useState(false)
  const [importResult, setImportResult] = useState<ImportResult | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Search & browse
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<DmrWell[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [hasSearched, setHasSearched] = useState(false)
  const [operatorFilter, setOperatorFilter] = useState('')
  const [showFilters, setShowFilters] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null)

  // Multi-select & activate.
  // An operator is REQUIRED — either inherited from the pad you attach to, or
  // picked outright. Wells used to be activatable with neither, and a well with
  // no operator is invisible to every operator-scoped picker afterward, so it
  // could never be found or grouped again. Pad itself stays optional (it's only
  // a grouping for when D3 works several wells at one site).
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [activateError, setActivateError] = useState<string | null>(null)
  const [activating, setActivating] = useState(false)
  const [activatePadId, setActivatePadId] = useState('')
  const [activatePadName, setActivatePadName] = useState('')
  const [padOperator, setPadOperator] = useState<CompanyOption | null>(null)

  // Pad search for the activate bar (free search — not Field-gated)
  const [padSearch, setPadSearch] = useState('')
  const [padsOptions, setPadsOptions] = useState<PadOption[]>([])

  // Operator override for the activate bar. Wins over the pad's operator —
  // this is how a well gets activated under a company DIFFERENT from the one
  // DMR lists for it, which is the normal case after a trade.
  const [activateOperator, setActivateOperator] = useState<CompanyOption | null>(null)
  const [companySearch, setCompanySearch] = useState('')
  const [companyOptions, setCompanyOptions] = useState<CompanyOption[]>([])
  const [companySearching, setCompanySearching] = useState(false)
  // "Change" on a pad-inherited operator: shows the search without throwing the
  // pad's operator away, so backing out returns to it instead of dead-ending.
  const [overridingOperator, setOverridingOperator] = useState(false)
  const seededOperatorFor = useRef<string>('')

  // Ambiguous — DMR wells whose name matches an existing unattached well.
  // Held back from creation until each is explicitly confirmed same-well or not.
  const [ambiguous, setAmbiguous] = useState<AmbiguousActivation[]>([])
  const [resolutions, setResolutions] = useState<Map<string, Resolution>>(new Map())

  // ── Load import status ──
  const loadImportStatus = useCallback(async () => {
    if (!canImport) return
    try {
      const s = await api.get<ImportStatus>('/locations/dmr/import/status')
      setImportStatus(s)
    } catch { /* ok */ }
  }, [canImport])

  useEffect(() => { loadImportStatus() }, [loadImportStatus])

  // ── Search pads for the activate bar (free search, no Field gating) ──
  useEffect(() => {
    if (padSearch.trim().length < 2) { setPadsOptions([]); return }
    const t = setTimeout(() => {
      api.get<{ data: PadOption[] }>(`/locations/pads?search=${encodeURIComponent(padSearch.trim())}&limit=20&active=true`)
        .then(r => setPadsOptions((r.data || []).map(p => ({ id: p.id, name: p.name, currentOperator: p.currentOperator }))))
        .catch(() => setPadsOptions([]))
    }, 300)
    return () => clearTimeout(t)
  }, [padSearch])

  // ── Company search for the activate bar's operator picker ──
  useEffect(() => {
    if (companySearch.trim().length < 2) { setCompanyOptions([]); return }
    setCompanySearching(true)
    const t = setTimeout(() => {
      api.get<{ data: CompanyOption[] }>(`/companies?search=${encodeURIComponent(companySearch.trim())}&limit=10&active=true`)
        .then(r => setCompanyOptions(r.data || []))
        .catch(() => setCompanyOptions([]))
        .finally(() => setCompanySearching(false))
    }, 250)
    return () => { clearTimeout(t); setCompanySearching(false) }
  }, [companySearch])

  // Seed the operator box with the DMR-listed operator when the selection
  // agrees on one — one click to accept it, or type over it when the well has
  // since changed hands. Seeds the SEARCH only, never the selection: DMR
  // operator data is stale often enough that auto-accepting it is how wrong
  // operators get stamped on wells.
  useEffect(() => {
    if (selected.size === 0) { seededOperatorFor.current = ''; return }
    const key = [...selected].sort().join(',')
    if (seededOperatorFor.current === key) return
    seededOperatorFor.current = key
    if (activateOperator || activatePadId) return
    const names = new Set(
      results.filter(r => selected.has(r.id)).map(r => r.operatorName).filter(Boolean) as string[],
    )
    if (names.size === 1) setCompanySearch([...names][0])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, results])

  // ── CSV Upload ──
  async function handleFileUpload(file: File) {
    setUploading(true)
    setImportError(null)
    setImportResult(null)
    try {
      const formData = new FormData()
      formData.append('file', file)

      const token = localStorage.getItem('sundog_token')
      const res = await fetch('/api/locations/dmr/import', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: formData,
      })

      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: 'Upload failed' }))
        throw new Error(body.error || `Upload failed (${res.status})`)
      }

      const result: ImportResult = await res.json()
      setImportResult(result)
      loadImportStatus()
    } catch (e: any) {
      setImportError(e.message || 'Upload failed')
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  // ── Get newest: server downloads OGD_Wells.zip from the ND DMR and upserts ──
  async function handleFetchLatest() {
    setFetchingLatest(true)
    setImportError(null)
    setImportResult(null)
    try {
      const result = await api.post<ImportResult>('/locations/dmr/import/fetch-latest')
      setImportResult(result)
      loadImportStatus()
    } catch (e: any) {
      setImportError(e.message || 'Fetch from DMR failed')
    } finally {
      setFetchingLatest(false)
    }
  }

  // ── Search ──
  const doSearch = useCallback(async (q: string, operator: string) => {
    if (q.length < 2 && !operator) {
      setResults([])
      setTotal(0)
      setHasSearched(false)
      return
    }
    setLoading(true)
    setHasSearched(true)
    try {
      const params = new URLSearchParams({ limit: '50' })
      if (q) params.set('search', q)
      if (operator) params.set('operator', operator)
      const r = await api.get<{ data: DmrWell[]; total: number }>(`/locations/dmr?${params}`)
      setResults(r.data || [])
      setTotal(r.total || 0)
    } catch {
      setResults([])
      setTotal(0)
    } finally {
      setLoading(false)
    }
  }, [])

  function handleSearchChange(val: string) {
    setQuery(val)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => doSearch(val, operatorFilter), 350)
  }

  function handleOperatorFilter(val: string) {
    setOperatorFilter(val)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => doSearch(query, val), 350)
  }

  // ── Selection ──
  function toggleSelect(id: string) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleSelectAll() {
    const activatable = results.filter(r => !r.matchedWellId)
    if (selected.size === activatable.length) {
      setSelected(new Set())
    } else {
      setSelected(new Set(activatable.map(r => r.id)))
    }
  }

  // ── Bulk Activate ──
  // Rows whose name matches an existing unattached well come back in
  // `ambiguous` instead of being created — nothing auto-links, since a fuzzy
  // hit (e.g. "…-1" vs its horizontal re-entry "…-1H") is often a different
  // wellbore. selected/dmrWellIds stay put until every ambiguous row is
  // resolved; re-posting the same ids picks up only what's still unresolved.
  async function handleBulkActivate(resolutionsPayload?: Array<{ dmrWellId: string } & Resolution>) {
    if (selected.size === 0) return
    if (!effectiveOperator) {
      setActivateError('Pick the operator these wells belong to first.')
      return
    }
    setActivating(true)
    setActivateError(null)
    try {
      const payload: Record<string, any> = {
        dmrWellIds: Array.from(selected),
      }
      if (activatePadId) payload.padId = activatePadId
      if (resolutionsPayload) payload.resolutions = resolutionsPayload
      // Always send the operator explicitly. It's the pad's own operator unless
      // it was overridden — the server would fall back to the pad, but sending
      // it keeps "activate under a different company than DMR says" working
      // with or without a pad.
      payload.operatorId = effectiveOperator.id
      const r = await api.post<{ activated: number; padCleared?: boolean; ambiguous: AmbiguousActivation[] }>(
        '/locations/dmr/activate', payload,
      )
      // Refresh search to update the "Already Active" badges
      doSearch(query, operatorFilter)
      if (r.ambiguous.length > 0) {
        setAmbiguous(r.ambiguous)
        setResolutions(new Map())
      } else {
        setSelected(new Set())
        setAmbiguous([])
        setResolutions(new Map())
        setCompanySearch('')
        setActivateOperator(null)
        setOverridingOperator(false)
      }
      setActivateError(null)
    } catch (e: any) {
      setActivateError(e.message || 'Activation failed')
    } finally {
      setActivating(false)
    }
  }

  function pickResolution(dmrWellId: string, resolution: Resolution) {
    setResolutions(prev => {
      const next = new Map(prev)
      next.set(dmrWellId, resolution)
      return next
    })
  }

  function submitResolutions() {
    const payload = ambiguous.map(a => {
      const res = resolutions.get(a.dmrWellId)
      return res ? { dmrWellId: a.dmrWellId, ...res } : null
    }).filter((r): r is { dmrWellId: string } & Resolution => r !== null)
    handleBulkActivate(payload)
  }

  const activatableSelected = results.filter(r => selected.has(r.id) && !r.matchedWellId)
  // Explicit pick wins over the pad's operator; one of the two must exist. While
  // an override is being typed the pad's operator is held back, so Activate
  // can't fire under the operator the user is in the middle of replacing.
  const effectiveOperator = activateOperator ?? (overridingOperator ? null : padOperator)

  return (
    <div className="pb-32">
      {/* Header */}
      <div className="flex items-center gap-3 mb-4">
        <button onClick={() => navigate('/locations')} className="text-slate-400 hover:text-slate-600">
          <ChevronLeft className="w-5 h-5" />
        </button>
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
            <Database className="w-6 h-6 text-blue-600" />
            DMR Well Database
          </h1>
          <p className="text-xs text-slate-500 mt-0.5">
            North Dakota Division of Mineral Resources reference wells
          </p>
        </div>
        {canImport && (
          <button onClick={() => navigate('/locations/builder')}
            className="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg shrink-0">
            <Layers className="w-4 h-4" /> Location Builder
          </button>
        )}
      </div>

      {/* ── Import Card ── */}
      {canImport && (
        <div className="bg-white border border-slate-200 rounded-lg mb-4">
          <button
            onClick={() => setImportOpen(!importOpen)}
            className="w-full flex items-center justify-between px-4 py-3 text-left"
          >
            <div className="flex items-center gap-2">
              <Upload className="w-4 h-4 text-slate-400" />
              <span className="text-sm font-medium text-slate-700">DMR Import</span>
              {importStatus && (
                <span className="text-xs text-slate-400 ml-2">
                  {importStatus.totalRecords.toLocaleString()} records
                  {/* date-only column (UTC midnight) — render in UTC or it reads a day early */}
                  {importStatus.lastImportDate && (
                    <> &middot; Last: {new Date(importStatus.lastImportDate).toLocaleDateString(undefined, { timeZone: 'UTC' })}</>
                  )}
                </span>
              )}
            </div>
            {importOpen ? (
              <ChevronUp className="w-4 h-4 text-slate-400" />
            ) : (
              <ChevronDown className="w-4 h-4 text-slate-400" />
            )}
          </button>

          {importOpen && (
            <div className="border-t px-4 py-4 space-y-3">
              {importStatus && (
                <div className="grid grid-cols-3 gap-3 text-center text-xs">
                  <div className="bg-slate-50 rounded-lg p-2">
                    <p className="text-lg font-bold text-slate-800">{importStatus.totalRecords.toLocaleString()}</p>
                    <p className="text-slate-500">Total Wells</p>
                  </div>
                  <div className="bg-green-50 rounded-lg p-2">
                    <p className="text-lg font-bold text-green-700">{importStatus.matchedToActive.toLocaleString()}</p>
                    <p className="text-green-600">Activated</p>
                  </div>
                  <div className="bg-blue-50 rounded-lg p-2">
                    <p className="text-lg font-bold text-blue-700">
                      {(importStatus.totalRecords - importStatus.matchedToActive).toLocaleString()}
                    </p>
                    <p className="text-blue-600">Available</p>
                  </div>
                </div>
              )}

              {/* Get newest straight from the state */}
              <div className="flex items-center gap-3">
                <button
                  onClick={handleFetchLatest}
                  disabled={fetchingLatest || uploading}
                  className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {fetchingLatest ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <CloudDownload className="w-4 h-4" />
                  )}
                  {fetchingLatest ? 'Getting newest...' : 'Get newest from DMR'}
                </button>
                <span className="text-xs text-slate-400">
                  Downloads the current OGD_Wells file from the ND DMR. New wells are added; existing ones (and statuses on active wells) are updated.
                </span>
              </div>

              {fetchingLatest && (
                <div className="flex items-center gap-2 text-sm text-emerald-700">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Downloading and importing ~44k wells from the DMR... usually under a minute.
                </div>
              )}

              {/* Upload */}
              <div className="flex items-center gap-3">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv"
                  onChange={e => {
                    const f = e.target.files?.[0]
                    if (f) handleFileUpload(f)
                  }}
                  className="hidden"
                />
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading || fetchingLatest}
                  className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {uploading ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <FileSpreadsheet className="w-4 h-4" />
                  )}
                  {uploading ? 'Importing...' : 'Upload CSV'}
                </button>
                <span className="text-xs text-slate-400">
                  ND DMR well database CSV. Existing records will be updated (matched by API #).
                </span>
              </div>

              {uploading && (
                <div className="flex items-center gap-2 text-sm text-blue-600">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Processing CSV... this may take 15-30 seconds for large files.
                </div>
              )}

              {importError && (
                <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded text-sm flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  {importError}
                </div>
              )}

              {importResult && (
                <div className="bg-green-50 border border-green-200 rounded-lg px-4 py-3">
                  <p className="text-sm font-medium text-green-800 flex items-center gap-1">
                    <CheckCircle2 className="w-4 h-4" />
                    Import Complete
                  </p>
                  <div className="grid grid-cols-4 gap-2 mt-2 text-xs text-center">
                    <div>
                      <p className="font-bold text-slate-800">{importResult.totalRows.toLocaleString()}</p>
                      <p className="text-slate-500">Total Rows</p>
                    </div>
                    <div>
                      <p className="font-bold text-green-700">{importResult.created.toLocaleString()}</p>
                      <p className="text-green-600">New</p>
                    </div>
                    <div>
                      <p className="font-bold text-blue-700">{importResult.updated.toLocaleString()}</p>
                      <p className="text-blue-600">Updated</p>
                    </div>
                    <div>
                      <p className="font-bold text-amber-700">
                        {importResult.skipped + importResult.errors}
                      </p>
                      <p className="text-amber-600">Skipped/Err</p>
                    </div>
                  </div>
                  {(() => {
                    const parts: string[] = []
                    const d = importResult.deduped
                    if (d && d.duplicatesRemoved > 0) parts.push(`${d.duplicatesRemoved.toLocaleString()} pre-existing duplicate rows merged away`)
                    if (d && d.renamed > 0) parts.push(`${d.renamed.toLocaleString()} API numbers normalized`)
                    if ((importResult.mergedInFile ?? 0) > 0) parts.push(`${importResult.mergedInFile!.toLocaleString()} in-file duplicate rows combined`)
                    return parts.length > 0 ? (
                      <p className="mt-2 text-xs text-slate-600">Cleanup: {parts.join(', ')}</p>
                    ) : null
                  })()}
                  {importResult.sourceLastModified && (
                    <p className="mt-2 text-xs text-slate-600">
                      DMR file published {new Date(importResult.sourceLastModified).toLocaleString()}
                    </p>
                  )}
                  {importResult.wellStatus && (
                    <p className="mt-1 text-xs text-slate-600">
                      Active wells: {importResult.wellStatus.statusUpdated.toLocaleString()} status
                      {importResult.wellStatus.statusUpdated === 1 ? '' : 'es'} updated
                      {importResult.wellStatus.statusUpdated > 0 && (
                        <> ({Object.entries(importResult.wellStatus.statusChanges).map(([s, n]) => `${n} → ${s}`).join(', ')})</>
                      )}
                      {' '}of {importResult.wellStatus.activeWellsChecked.toLocaleString()} checked
                      {importResult.wellStatus.unmappedStatusSkipped > 0 && (
                        <>; {importResult.wellStatus.unmappedStatusSkipped} left as-is (DMR code we don&apos;t map)</>
                      )}
                    </p>
                  )}
                  {importResult.errorSamples && importResult.errorSamples.length > 0 && (
                    <div className="mt-2 text-xs text-red-600">
                      <p className="font-medium">Errors:</p>
                      {importResult.errorSamples.map((e, i) => (
                        <p key={i} className="truncate">{e}</p>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Activate everything for an operator ── */}
      {canImport && <DmrOperatorActivatePanel />}

      {/* ── Backfill & Dedupe active wells ── */}
      {canImport && <WellBackfillPanel />}

      {/* ── Search & Browse ── */}
      <div className="flex gap-2 mb-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            type="text"
            value={query}
            onChange={e => handleSearchChange(e.target.value)}
            placeholder="Search well name, API #, or operator..."
            className="w-full pl-9 pr-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
          />
          {loading && (
            <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 animate-spin text-blue-500" />
          )}
        </div>
        <button
          onClick={() => setShowFilters(!showFilters)}
          className={`inline-flex items-center gap-1 px-3 py-2 text-sm border rounded-lg transition-colors ${
            showFilters || operatorFilter
              ? 'border-blue-300 bg-blue-50 text-blue-600'
              : 'border-slate-300 text-slate-500 hover:text-slate-700'
          }`}
        >
          <Filter className="w-4 h-4" />
          Filter
        </button>
      </div>

      {showFilters && (
        <div className="bg-slate-50 border border-slate-200 rounded-lg px-4 py-3 mb-3 flex items-center gap-3">
          <label className="text-xs text-slate-500 shrink-0">Operator:</label>
          <input
            type="text"
            value={operatorFilter}
            onChange={e => handleOperatorFilter(e.target.value)}
            placeholder="Filter by operator name..."
            className="flex-1 text-sm border border-slate-300 rounded px-2 py-1.5 focus:ring-1 focus:ring-blue-500 outline-none"
          />
          {operatorFilter && (
            <button
              onClick={() => handleOperatorFilter('')}
              className="text-slate-400 hover:text-slate-600"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      )}

      {/* ── Results ── */}
      {!hasSearched && !loading && (
        <div className="text-center py-12 text-slate-400">
          <Database className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p className="text-sm">Search the DMR database by well name, API number, or operator</p>
          <p className="text-xs mt-1">Type at least 2 characters, or use the operator filter</p>
        </div>
      )}

      {hasSearched && !loading && results.length === 0 && (
        <div className="text-center py-12 text-slate-400">
          <p className="text-sm">No matching wells found</p>
        </div>
      )}

      {results.length > 0 && (
        <>
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs text-slate-400">
              {total > 50 ? `Showing 50 of ${total.toLocaleString()} results` : `${total} result${total !== 1 ? 's' : ''}`}
            </p>
            {canManage && (
              <button onClick={toggleSelectAll} className="text-xs text-blue-500 hover:text-blue-700">
                {selected.size === results.filter(r => !r.matchedWellId).length ? 'Deselect all' : 'Select all'}
              </button>
            )}
          </div>

          <div className="space-y-2">
            {results.map(dmr => {
              const isActive = !!dmr.matchedWellId
              const isSelected = selected.has(dmr.id)

              return (
                <div
                  key={dmr.id}
                  className={`bg-white border rounded-lg px-3 py-2.5 transition-colors ${
                    isActive
                      ? 'bg-gray-50 border-gray-200 opacity-60'
                      : isSelected
                        ? 'border-blue-400 bg-blue-50'
                        : 'border-slate-200 hover:border-slate-300'
                  }`}
                >
                  <div className="flex items-start gap-3">
                    {/* Checkbox */}
                    {canManage && !isActive && (
                      <label className="mt-1 shrink-0 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleSelect(dmr.id)}
                          className="rounded border-slate-300"
                        />
                      </label>
                    )}

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-sm font-medium text-slate-900 truncate">
                          {dmr.wellName || 'Unnamed'}
                        </p>
                        {isActive ? (
                          <span className="inline-flex items-center gap-1 text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full shrink-0">
                            <CheckCircle2 className="w-3 h-3" /> Active
                          </span>
                        ) : canManage ? (
                          // Single-row activate: select just this well and open the
                          // activate bar. Rides the same transactional endpoint.
                          <button
                            type="button"
                            onClick={() => setSelected(new Set([dmr.id]))}
                            className="shrink-0 text-xs font-medium text-blue-600 hover:text-blue-800 border border-blue-200 rounded px-2 py-0.5"
                          >
                            Activate
                          </button>
                        ) : null}
                      </div>
                      <p className="text-xs text-slate-500 font-mono mt-0.5">{dmr.apiNumber}</p>
                      <p className="text-xs text-slate-400 mt-0.5 truncate">
                        {dmr.operatorName}
                        {dmr.fieldName ? ` \u2022 ${dmr.fieldName}` : ''}
                      </p>
                      <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1 text-xs text-slate-400">
                        {dmr.section != null && (
                          <span>S{dmr.section}-T{dmr.township}N-R{dmr.range}W</span>
                        )}
                        {dmr.county && <span>{dmr.county} Co.</span>}
                        {dmr.wellType && <span>{dmr.wellType}</span>}
                        {dmr.wellStatus && <span>Status: {dmr.wellStatus}</span>}
                        {dmr.totalDepth && <span>TD: {dmr.totalDepth.toLocaleString()}'</span>}
                        {dmr.latitude != null && dmr.longitude != null && (
                          <span className="flex items-center gap-0.5">
                            <MapPin className="w-3 h-3" />
                            {Number(dmr.latitude).toFixed(4)}, {Number(dmr.longitude).toFixed(4)}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}

      {/* ── Sticky Bulk Activate Bar ── */}
      {canManage && selected.size > 0 && (
        <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-slate-200 shadow-lg px-4 py-3 z-40">
          <div className="max-w-2xl mx-auto">
            <div className="flex items-center justify-between mb-2">
              <p className="text-sm font-medium text-slate-700">
                {activatableSelected.length} well{activatableSelected.length !== 1 ? 's' : ''} selected
              </p>
              <button
                onClick={() => { setSelected(new Set()); setAmbiguous([]); setResolutions(new Map()); setCompanySearch(''); setActivateOperator(null); setOverridingOperator(false) }}
                className="text-xs text-slate-400 hover:text-slate-600"
              >
                Clear
              </button>
            </div>

            {ambiguous.length === 0 ? (
              <>
                <div className="mb-2">
                  {activatePadId ? (
                    <div className="flex items-center gap-2 text-sm">
                      <span className="bg-emerald-50 text-emerald-700 px-2 py-1 rounded flex-1 truncate">{activatePadName}</span>
                      <button type="button" onClick={() => { setActivatePadId(''); setActivatePadName(''); setPadSearch(''); setPadOperator(null); setOverridingOperator(false) }} className="text-slate-400 hover:text-red-600">
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  ) : (
                    <div className="relative">
                      <input
                        type="text"
                        value={padSearch}
                        onChange={e => setPadSearch(e.target.value)}
                        placeholder="Attach to a pad (optional) — search by name..."
                        className="w-full text-sm border border-slate-300 rounded-lg px-2 py-1.5 focus:ring-1 focus:ring-blue-500 outline-none"
                      />
                      {padsOptions.length > 0 && (
                        <div className="absolute z-10 bottom-full left-0 right-0 mb-1 bg-white border border-slate-200 rounded-lg shadow-lg max-h-48 overflow-auto">
                          {padsOptions.map(p => (
                            <button
                              key={p.id}
                              type="button"
                              onClick={() => { setActivatePadId(p.id); setActivatePadName(p.name); setPadOperator(p.currentOperator ?? null); setOverridingOperator(false); setPadsOptions([]) }}
                              className="w-full text-left px-3 py-2 text-sm hover:bg-blue-50 border-b border-slate-100 last:border-b-0"
                            >
                              {p.name}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
                {/* Operator — required. Inherited from the pad when it has one,
                    overridable either way (DMR's operator name is frequently a
                    trade or two out of date). */}
                <div className="mb-2">
                  {activateOperator ? (
                    <div className="flex items-center gap-2 text-sm">
                      <span className="bg-emerald-50 text-emerald-700 px-2 py-1 rounded flex-1 truncate">
                        Operator: {activateOperator.name}
                      </span>
                      <button
                        type="button"
                        onClick={() => { setActivateOperator(null); setCompanySearch('') }}
                        className="text-slate-400 hover:text-red-600 shrink-0"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  ) : padOperator && !overridingOperator ? (
                    <div className="flex items-center gap-2 text-sm">
                      <span className="bg-slate-100 text-slate-700 px-2 py-1 rounded flex-1 truncate">
                        Operator: {padOperator.name} <span className="text-slate-400">(from pad)</span>
                      </span>
                      <button
                        type="button"
                        onClick={() => { setCompanySearch(''); setOverridingOperator(true) }}
                        className="text-xs text-blue-600 hover:text-blue-800 shrink-0"
                      >
                        Change
                      </button>
                    </div>
                  ) : (
                    <div className="relative">
                      <input
                        type="text"
                        value={companySearch}
                        onChange={e => setCompanySearch(e.target.value)}
                        placeholder="Operator (required) — search the customer these wells belong to..."
                        className="w-full text-sm border border-slate-300 rounded-lg px-2 py-1.5 focus:ring-1 focus:ring-blue-500 outline-none"
                      />
                      {companySearching && (
                        <Loader2 className="w-3.5 h-3.5 animate-spin text-slate-400 absolute right-2 top-1/2 -translate-y-1/2" />
                      )}
                      {padOperator && overridingOperator && (
                        <button
                          type="button"
                          onClick={() => { setOverridingOperator(false); setCompanySearch('') }}
                          className="absolute right-2 -top-5 text-[11px] text-slate-400 hover:text-slate-600"
                        >
                          keep {padOperator.name}
                        </button>
                      )}
                      {companyOptions.length > 0 && (
                        <div className="absolute z-10 bottom-full left-0 right-0 mb-1 bg-white border border-slate-200 rounded-lg shadow-lg max-h-48 overflow-auto">
                          {companyOptions.map(c => (
                            <button
                              key={c.id}
                              type="button"
                              onClick={() => { setActivateOperator(c); setCompanyOptions([]); setOverridingOperator(false) }}
                              className="w-full text-left px-3 py-2 text-sm hover:bg-blue-50 border-b border-slate-100 last:border-b-0"
                            >
                              {c.name}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
                {activatePadId ? (
                  <p className="text-[11px] text-slate-500 mb-2">
                    Wells land on this pad. If the pad is pending review, this also blesses it.
                  </p>
                ) : (
                  <p className="text-[11px] text-slate-500 mb-2">
                    No pad — wells activate standalone under the operator above, ready to be grouped onto a pad later.
                  </p>
                )}
                {!effectiveOperator && (
                  <p className="text-[11px] text-amber-700 mb-2">
                    An operator is required: without one the well can't be found in any operator-scoped
                    picker afterward. DMR's listed operator is only a suggestion — activate it under
                    whoever actually operates it today.
                  </p>
                )}

                {activateError && (
                  <div className="text-sm text-red-600 mb-2 flex items-center gap-1">
                    <AlertCircle className="w-3.5 h-3.5" />
                    {activateError}
                  </div>
                )}

                <button
                  onClick={() => handleBulkActivate()}
                  disabled={activating || activatableSelected.length === 0 || !effectiveOperator}
                  className="w-full flex items-center justify-center gap-2 py-2.5 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm"
                >
                  {activating ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <CheckCircle2 className="w-4 h-4" />
                  )}
                  Activate {activatableSelected.length} Well{activatableSelected.length !== 1 ? 's' : ''}
                </button>
              </>
            ) : (
              <div className="space-y-3">
                <p className="text-xs font-medium text-amber-800 flex items-center gap-1.5 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-2">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                  {ambiguous.length} well{ambiguous.length === 1 ? '' : 's'} match an existing unattached well by name — confirm each one before continuing
                </p>
                <div className="space-y-2 max-h-[50vh] overflow-y-auto">
                  {ambiguous.map(a => {
                    const chosen = resolutions.get(a.dmrWellId)
                    return (
                      <div key={a.dmrWellId} className="border border-amber-100 rounded-lg p-2.5">
                        <p className="text-xs font-medium text-slate-800">{a.wellName || '(unnamed)'} <span className="text-slate-400 font-mono">{a.apiNumber}</span></p>
                        <DmrAmbiguityChoices candidates={a.candidates} chosen={chosen} onChange={resolution => pickResolution(a.dmrWellId, resolution)} />
                      </div>
                    )
                  })}
                </div>

                {activateError && (
                  <div className="text-sm text-red-600 flex items-center gap-1">
                    <AlertCircle className="w-3.5 h-3.5" />
                    {activateError}
                  </div>
                )}

                <button
                  onClick={submitResolutions}
                  disabled={activating || resolutions.size < ambiguous.length}
                  className="w-full flex items-center justify-center gap-2 py-2.5 bg-amber-600 text-white rounded-lg font-medium hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm"
                >
                  {activating ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                  Confirm {resolutions.size}/{ambiguous.length} and continue
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
