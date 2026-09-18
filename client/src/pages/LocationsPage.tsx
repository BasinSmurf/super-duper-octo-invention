import { useState, useEffect, useCallback } from 'react'
import type { ElementType } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useAuth } from '@/contexts/AuthContext'
import { api } from '@/lib/api'
import { cn } from '@/lib/cn'
import { hasPermission } from '@/lib/permissions'
import { AddPadModal } from '@/components/AddPadModal'
import { AddWellModal } from '@/components/AddWellModal'
import {
  Search,
  ChevronRight,
  Merge,
  Loader2,
  Layers,
  Building,
  Building2,
  Cylinder,
  Droplets,
  Truck,
  Wind,
  AlertTriangle,
  Plus,
  Database,
  Unlink,
  CheckSquare,
  Square,
  X,
} from 'lucide-react'

// Lucide has no oil derrick — hand-rolled in the same 24x24/stroke-2 style.
function DerrickIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M7 21 11 3h2l4 18" />
      <path d="M9.5 8.5h5" />
      <path d="M8.4 14.5h7.2" />
      <path d="M4 21h16" />
    </svg>
  )
}

// Glanceability only — icons follow Well.assetCategory, data untouched.
const ASSET_STYLE: Record<string, { Icon: ElementType; tile: string; icon: string }> = {
  site: { Icon: Droplets, tile: 'bg-amber-50', icon: 'text-amber-500' },
  rig: { Icon: DerrickIcon, tile: 'bg-purple-50', icon: 'text-purple-600' },
  truck: { Icon: Truck, tile: 'bg-purple-50', icon: 'text-purple-600' },
  other_mobile: { Icon: Truck, tile: 'bg-purple-50', icon: 'text-purple-600' },
  gas_plant: { Icon: Cylinder, tile: 'bg-sky-50', icon: 'text-sky-600' },
  tank_battery: { Icon: Cylinder, tile: 'bg-sky-50', icon: 'text-sky-600' },
  compressor_station: { Icon: Cylinder, tile: 'bg-sky-50', icon: 'text-sky-600' },
  swd_facility: { Icon: Cylinder, tile: 'bg-sky-50', icon: 'text-sky-600' },
  office: { Icon: Building, tile: 'bg-slate-100', icon: 'text-slate-500' },
  shop: { Icon: Building, tile: 'bg-slate-100', icon: 'text-slate-500' },
}
const assetStyle = (cat: string | null | undefined) => ASSET_STYLE[cat || 'site'] || ASSET_STYLE.site

// Same codes/labels as WellDetailPage's STATUS_LABELS — kept in sync manually.
const STATUS_LABELS: Record<string, string> = {
  A: 'Active', DRY: 'Dry Hole', PA: 'Plugged & Abandoned', PNC: 'Plugged & Completed',
  IA: 'Inactive', SI: 'Shut In', TA: 'Temp Abandoned',
  LOC: 'Location', WC: 'Waiting Completion', DC: 'Drilling Complete',
}

// Labeled "DMR" so it's never mistaken for the separate ServicePRO active/
// inactive status shown on the well detail page.
function DmrStatusPill({ status }: { status: string | null }) {
  if (!status) return null
  return (
    <span
      title="Status as reported by NDIC/DMR"
      className={cn(
        'text-xs px-1.5 py-0.5 rounded font-medium flex items-center gap-1',
        status === 'A' ? 'bg-green-100 text-green-700' :
        status === 'PA' ? 'bg-red-100 text-red-600' :
        status === 'SI' ? 'bg-amber-100 text-amber-700' :
        'bg-gray-100 text-gray-600'
      )}
    >
      <span className="text-[9px] font-semibold uppercase tracking-wide opacity-60">DMR</span>
      {STATUS_LABELS[status] || status}
    </span>
  )
}

const PAGE_SIZES = [50, 100, 150, 200]

// Prev/next + page-jump bar — mirrors the DMR review-queue pagination pattern.
function PaginationBar({
  offset, pageSize, total, loading, onPrev, onNext, onJump,
}: {
  offset: number; pageSize: number; total: number; loading: boolean
  onPrev: () => void; onNext: () => void; onJump: (offset: number) => void
}) {
  const [pageInput, setPageInput] = useState('')
  if (total <= pageSize) return null
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const currentPage = Math.floor(offset / pageSize) + 1
  const goToPage = (raw: string) => {
    const p = Math.min(totalPages, Math.max(1, parseInt(raw, 10) || currentPage))
    setPageInput('')
    if (p !== currentPage) onJump((p - 1) * pageSize)
  }
  return (
    <div className="flex items-center justify-between mt-3 text-sm gap-2 flex-wrap">
      <button disabled={offset === 0 || loading} onClick={onPrev} className="px-3 py-1 border border-slate-200 rounded disabled:opacity-40">Prev</button>
      <div className="flex items-center gap-1.5 text-slate-500">
        <span>{offset + 1}–{Math.min(offset + pageSize, total)} of {total.toLocaleString()} · page</span>
        <input
          type="number"
          min={1}
          max={totalPages}
          value={pageInput || currentPage}
          onChange={e => setPageInput(e.target.value)}
          onBlur={e => goToPage(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') goToPage((e.target as HTMLInputElement).value) }}
          className="w-14 text-center border border-slate-200 rounded px-1 py-0.5"
        />
        <span>of {totalPages}</span>
      </div>
      <button disabled={offset + pageSize >= total || loading} onClick={onNext} className="px-3 py-1 border border-slate-200 rounded disabled:opacity-40">Next</button>
    </div>
  )
}

// ---- Types ----
interface PadResult {
  id: string
  name: string
  isActive: boolean
  pendingReview: boolean
  field: { id: string; name: string } | null
  currentOperator: { id: string; name: string } | null
  _count: { wells: number; workPoints: number }
}

interface UnassignedWell {
  id: string
  wellName: string | null
  apiNumber: string | null
  wellType: string | null
  wellStatus: string | null
  wellNameBase: string | null
  section: number | null
  township: number | null
  range: number | null
  assetCategory: string | null
  field: { id: string; name: string } | null
  currentOperator: { id: string; name: string } | null
}

interface OperatorSummary {
  currentOperatorId: string | null
  _count: number
}

interface WellResult {
  id: string
  wellName: string | null
  apiNumber: string | null
  wellStatus: string | null
  section: number | null
  township: number | null
  range: number | null
  assetCategory: string | null
  pad: { id: string; name: string } | null
  field: { id: string; name: string } | null
  currentOperator: { id: string; name: string } | null
}

type Tab = 'assets' | 'pads' | 'unassigned'

export function LocationsPage() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const canManage = hasPermission(user?.role, 'locations:manage')
  const [tab, setTab] = useState<Tab>('assets')
  const [search, setSearch] = useState('')
  const [showAddPad, setShowAddPad] = useState(false)
  const [showAddAsset, setShowAddAsset] = useState(false)

  // Pagination — shared across tabs; offset resets to 0 whenever the tab,
  // search, operator filter, or page size changes (only Prev/Next/jump move it).
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0])
  const [offset, setOffset] = useState(0)

  // Pads state
  const [pads, setPads] = useState<PadResult[]>([])
  const [padsTotal, setPadsTotal] = useState(0)
  const [padsLoading, setPadsLoading] = useState(false)

  // Wells state
  const [wells, setWells] = useState<WellResult[]>([])
  const [wellsTotal, setWellsTotal] = useState(0)
  const [wellsLoading, setWellsLoading] = useState(false)

  // Unassigned wells state
  const [unassigned, setUnassigned] = useState<UnassignedWell[]>([])
  const [unassignedTotal, setUnassignedTotal] = useState(0)
  const [unassignedLoading, setUnassignedLoading] = useState(false)
  const [operatorSummary, setOperatorSummary] = useState<OperatorSummary[]>([])
  const [operatorFilter, setOperatorFilter] = useState<string>('')
  const [selectedWells, setSelectedWells] = useState<Set<string>>(new Set())

  // Assign to existing pad state
  const [showPadPicker, setShowPadPicker] = useState(false)
  const [padPickerSearch, setPadPickerSearch] = useState('')
  const [padPickerResults, setPadPickerResults] = useState<PadResult[]>([])
  const [padPickerLoading, setPadPickerLoading] = useState(false)

  // Set-operator state — the fix-up path for wells that came out of DMR
  // activation with no operator (they're invisible to every operator-scoped
  // picker until one is stamped on).
  const [showOperatorPicker, setShowOperatorPicker] = useState(false)
  const [operatorPickerSearch, setOperatorPickerSearch] = useState('')
  const [operatorPickerResults, setOperatorPickerResults] = useState<{ id: string; name: string }[]>([])
  const [operatorPickerLoading, setOperatorPickerLoading] = useState(false)
  const [settingOperator, setSettingOperator] = useState(false)
  const [operatorError, setOperatorError] = useState<string | null>(null)

  // Operator name lookup map (populated from unassigned data)
  const [operatorNames, setOperatorNames] = useState<Map<string, string>>(new Map())

  const loadPads = useCallback(async (q: string, off: number, size: number) => {
    setPadsLoading(true)
    try {
      const params = new URLSearchParams({ limit: String(size), offset: String(off), active: 'true' })
      if (q) params.set('search', q)
      const res = await api.get<{ data: PadResult[]; total: number }>(`/locations/pads?${params}`)
      setPads(res.data || [])
      setPadsTotal(res.total || 0)
    } catch {
      setPads([])
    } finally {
      setPadsLoading(false)
    }
  }, [])

  const loadWells = useCallback(async (q: string, off: number, size: number) => {
    setWellsLoading(true)
    try {
      const params = new URLSearchParams({ limit: String(size), offset: String(off), active: 'true' })
      if (q) params.set('search', q)
      const res = await api.get<{ data: WellResult[]; total: number }>(`/locations/wells?${params}`)
      setWells(res.data || [])
      setWellsTotal(res.total || 0)
    } catch {
      setWells([])
    } finally {
      setWellsLoading(false)
    }
  }, [])

  const loadUnassigned = useCallback(async (q: string, opId: string | undefined, off: number, size: number) => {
    setUnassignedLoading(true)
    try {
      const params = new URLSearchParams({ limit: String(size), offset: String(off) })
      if (q) params.set('search', q)
      if (opId) params.set('operatorId', opId)
      const res = await api.get<{
        data: UnassignedWell[]
        total: number
        operatorSummary: OperatorSummary[]
      }>(`/locations/wells/unassigned?${params}`)
      setUnassigned(res.data || [])
      setUnassignedTotal(res.total || 0)
      setOperatorSummary(res.operatorSummary || [])
      // Build operator name map from results
      const nameMap = new Map<string, string>()
      for (const w of res.data || []) {
        if (w.currentOperator) nameMap.set(w.currentOperator.id, w.currentOperator.name)
      }
      setOperatorNames(prev => {
        const merged = new Map(prev)
        nameMap.forEach((v, k) => merged.set(k, v))
        return merged
      })
    } catch {
      setUnassigned([])
    } finally {
      setUnassignedLoading(false)
    }
  }, [])

  // Reload data when search, tab, page size, or offset changes
  useEffect(() => {
    if (tab === 'pads') loadPads(search, offset, pageSize)
    else if (tab === 'assets') loadWells(search, offset, pageSize)
    else if (tab === 'unassigned') loadUnassigned(search, operatorFilter, offset, pageSize)
  }, [tab, search, operatorFilter, offset, pageSize, loadPads, loadWells, loadUnassigned])

  // Fetch unassigned count on mount (for the badge) even when not on that tab
  useEffect(() => {
    if (canManage) {
      api.get<{ total: number }>('/locations/wells/unassigned?limit=0')
        .then(res => setUnassignedTotal(res.total || 0))
        .catch(() => {})
    }
  }, [canManage])

  // Clear selection when switching tabs/filters
  useEffect(() => { setSelectedWells(new Set()) }, [tab, operatorFilter])

  // Search for pads in the pad picker
  useEffect(() => {
    if (!showPadPicker || padPickerSearch.length < 2) { setPadPickerResults([]); return }
    const t = setTimeout(async () => {
      setPadPickerLoading(true)
      try {
        const params = new URLSearchParams({ search: padPickerSearch, limit: '10' })
        const res = await api.get<{ data: PadResult[] }>(`/locations/pads?${params}`)
        setPadPickerResults(res.data || [])
      } catch { setPadPickerResults([]) }
      finally { setPadPickerLoading(false) }
    }, 300)
    return () => clearTimeout(t)
  }, [padPickerSearch, showPadPicker])

  // Search companies for the set-operator picker
  useEffect(() => {
    if (!showOperatorPicker || operatorPickerSearch.length < 2) { setOperatorPickerResults([]); return }
    const t = setTimeout(async () => {
      setOperatorPickerLoading(true)
      try {
        const res = await api.get<{ data: { id: string; name: string }[] }>(
          `/companies?search=${encodeURIComponent(operatorPickerSearch)}&limit=10&active=true`,
        )
        setOperatorPickerResults(res.data || [])
      } catch { setOperatorPickerResults([]) }
      finally { setOperatorPickerLoading(false) }
    }, 300)
    return () => clearTimeout(t)
  }, [operatorPickerSearch, showOperatorPicker])

  async function handleSetOperator(companyId: string) {
    if (selectedWells.size === 0) return
    setSettingOperator(true)
    setOperatorError(null)
    try {
      await api.post('/locations/wells/bulk-set-operator', {
        wellIds: [...selectedWells],
        operatorId: companyId,
      })
      setShowOperatorPicker(false)
      setSelectedWells(new Set())
      loadUnassigned(search, operatorFilter, offset, pageSize)
    } catch (e: any) {
      setOperatorError(e.message || 'Failed to set operator')
    } finally {
      setSettingOperator(false)
    }
  }

  const toggleWell = (id: string) => {
    setSelectedWells(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleAll = () => {
    if (selectedWells.size === unassigned.length) {
      setSelectedWells(new Set())
    } else {
      setSelectedWells(new Set(unassigned.map(w => w.id)))
    }
  }

  const handleAssignToExistingPad = async (padId: string) => {
    try {
      await api.post('/locations/wells/bulk-reassign', {
        wellIds: [...selectedWells],
        padId,
      })
      setShowPadPicker(false)
      setPadPickerSearch('')
      setSelectedWells(new Set())
      loadUnassigned(search, operatorFilter, offset, pageSize)
    } catch (e: any) {
      alert(e.message || 'Failed to assign wells')
    }
  }

  const searchPlaceholders: Record<Tab, string> = {
    assets: 'Search assets by name or API#...',
    pads: 'Search pads by name...',
    unassigned: 'Search wells by name or API#...',
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold text-slate-900">Locations</h1>
        <div className="flex items-center gap-2">
          {canManage && (
            <button
              onClick={() => setShowAddPad(true)}
              className="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors"
            >
              <Plus className="w-4 h-4" />
              Add Pad
            </button>
          )}
          {canManage && (
            <button
              onClick={() => setShowAddAsset(true)}
              className="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium text-blue-600 bg-blue-50 hover:bg-blue-100 rounded-lg transition-colors"
            >
              <Plus className="w-4 h-4" />
              Add Asset
            </button>
          )}
          <Link
            to="/locations/dmr"
            className="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium text-blue-600 bg-blue-50 hover:bg-blue-100 rounded-lg transition-colors"
          >
            <Database className="w-4 h-4" />
            DMR
          </Link>
          <Link
            to="/locations/merge"
            className="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium text-blue-600 bg-blue-50 hover:bg-blue-100 rounded-lg transition-colors"
          >
            <Merge className="w-4 h-4" />
            Merge Dupes
          </Link>
        </div>
      </div>

      {/* Tabs — Assets is the main event; Pads is second-class grouping data */}
      <div className="flex gap-1 p-1 bg-slate-100 rounded-lg mb-4">
        <button
          onClick={() => { setTab('assets'); setOffset(0) }}
          className={cn(
            'flex-1 flex items-center justify-center gap-2 py-2 text-sm font-medium rounded-md transition-colors',
            tab === 'assets'
              ? 'bg-white text-slate-900 shadow-sm'
              : 'text-slate-500 hover:text-slate-700'
          )}
        >
          <Droplets className="w-4 h-4" />
          Assets
        </button>
        {canManage && (
          <button
            onClick={() => { setTab('unassigned'); setOffset(0) }}
            className={cn(
              'flex-1 flex items-center justify-center gap-2 py-2 text-sm font-medium rounded-md transition-colors',
              tab === 'unassigned'
                ? 'bg-white text-slate-900 shadow-sm'
                : 'text-slate-500 hover:text-slate-700'
            )}
          >
            <Unlink className="w-4 h-4" />
            Unassigned
            {unassignedTotal > 0 && tab !== 'unassigned' && (
              <span className="bg-amber-100 text-amber-700 text-xs font-medium px-1.5 py-0.5 rounded-full">
                {unassignedTotal}
              </span>
            )}
          </button>
        )}
        <button
          onClick={() => { setTab('pads'); setOffset(0) }}
          className={cn(
            'flex items-center justify-center gap-2 py-2 px-4 text-sm font-medium rounded-md transition-colors',
            tab === 'pads'
              ? 'bg-white text-slate-900 shadow-sm'
              : 'text-slate-500 hover:text-slate-700'
          )}
        >
          <Layers className="w-4 h-4" />
          Pads
        </button>
      </div>

      {/* Search + page size */}
      <div className="flex items-center gap-2 mb-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            type="text"
            value={search}
            onChange={e => { setSearch(e.target.value); setOffset(0) }}
            placeholder={searchPlaceholders[tab]}
            className="w-full pl-10 pr-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none text-sm"
          />
        </div>
        <label className="text-xs text-slate-500 flex items-center gap-1.5 flex-shrink-0">
          Per page
          <select
            value={pageSize}
            onChange={e => { setPageSize(Number(e.target.value)); setOffset(0) }}
            className="text-sm border border-slate-300 rounded-lg px-2 py-2"
          >
            {PAGE_SIZES.map(size => <option key={size} value={size}>{size}</option>)}
          </select>
        </label>
      </div>

      {/* Pads tab */}
      {tab === 'pads' && (
        <>
          {padsLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-5 h-5 animate-spin text-blue-500" />
              <span className="ml-2 text-sm text-slate-400">Loading pads...</span>
            </div>
          ) : pads.length === 0 ? (
            <div className="text-center py-12 text-slate-400">
              <Layers className="w-10 h-10 mx-auto mb-2 opacity-40" />
              <p className="text-sm">No pads found{search ? ` matching "${search}"` : ''}.</p>
            </div>
          ) : (
            <>
              <p className="text-xs text-slate-400 mb-2">
                Showing {offset + 1}–{offset + pads.length} of {padsTotal} pads
              </p>
              <div className="space-y-2">
                {pads.map(pad => (
                  <button
                    key={pad.id}
                    onClick={() => navigate(`/locations/pads/${pad.id}`)}
                    className="w-full text-left bg-white rounded-lg border border-slate-200 p-3 hover:border-blue-300 hover:shadow-sm transition-all"
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-lg bg-emerald-50 flex items-center justify-center flex-shrink-0">
                        <Layers className="w-4 h-4 text-emerald-600" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-slate-900 truncate">{pad.name}</span>
                          {pad.pendingReview && (
                            <AlertTriangle className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" />
                          )}
                        </div>
                        <div className="flex items-center gap-2 text-xs text-slate-500 mt-0.5">
                          {pad.currentOperator && (
                            <span className="flex items-center gap-1">
                              <Building2 className="w-3 h-3" />{pad.currentOperator.name}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="text-right text-xs text-slate-400 flex-shrink-0">
                        <p className="flex items-center gap-1 justify-end"><Droplets className="w-3 h-3" />{pad._count.wells}</p>
                        <p className="flex items-center gap-1 justify-end"><Wind className="w-3 h-3" />{pad._count.workPoints}</p>
                      </div>
                      <ChevronRight className="w-4 h-4 text-slate-300 flex-shrink-0" />
                    </div>
                  </button>
                ))}
              </div>
              <PaginationBar
                offset={offset} pageSize={pageSize} total={padsTotal} loading={padsLoading}
                onPrev={() => setOffset(Math.max(0, offset - pageSize))}
                onNext={() => setOffset(offset + pageSize)}
                onJump={setOffset}
              />
            </>
          )}
        </>
      )}

      {/* Assets tab */}
      {tab === 'assets' && (
        <>
          {wellsLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-5 h-5 animate-spin text-blue-500" />
              <span className="ml-2 text-sm text-slate-400">Loading assets...</span>
            </div>
          ) : wells.length === 0 ? (
            <div className="text-center py-12 text-slate-400">
              <Droplets className="w-10 h-10 mx-auto mb-2 opacity-40" />
              <p className="text-sm">No assets found{search ? ` matching "${search}"` : ''}.</p>
            </div>
          ) : (
            <>
              <p className="text-xs text-slate-400 mb-2">
                Showing {offset + 1}–{offset + wells.length} of {wellsTotal} assets
              </p>
              <div className="space-y-2">
                {wells.map(well => {
                  const style = assetStyle(well.assetCategory)
                  return (
                  <button
                    key={well.id}
                    onClick={() => navigate(`/locations/wells/${well.id}`)}
                    className="w-full text-left bg-white rounded-lg border border-slate-200 p-3 hover:border-blue-300 hover:shadow-sm transition-all"
                  >
                    <div className="flex items-center gap-3">
                      <div className={cn('w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0', style.tile)}>
                        <style.Icon className={cn('w-4 h-4', style.icon)} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-slate-900 truncate">
                            {well.wellName || 'Unnamed Well'}
                          </span>
                          <DmrStatusPill status={well.wellStatus} />
                        </div>
                        <div className="flex items-center gap-3 text-xs text-slate-500 mt-0.5">
                          {well.apiNumber && <span>API: {well.apiNumber}</span>}
                          {well.currentOperator && (
                            <span className="flex items-center gap-1">
                              <Building2 className="w-3 h-3" />{well.currentOperator.name}
                            </span>
                          )}
                          {well.pad && (
                            <span className="flex items-center gap-1">
                              <Layers className="w-3 h-3" />{well.pad.name}
                            </span>
                          )}
                        </div>
                      </div>
                      <ChevronRight className="w-4 h-4 text-slate-300 flex-shrink-0" />
                    </div>
                  </button>
                )})}
              </div>
              <PaginationBar
                offset={offset} pageSize={pageSize} total={wellsTotal} loading={wellsLoading}
                onPrev={() => setOffset(Math.max(0, offset - pageSize))}
                onNext={() => setOffset(offset + pageSize)}
                onJump={setOffset}
              />
            </>
          )}
        </>
      )}

      {/* Unassigned Wells tab */}
      {tab === 'unassigned' && (
        <>
          {/* Operator filter chips */}
          {operatorSummary.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-3">
              <button
                onClick={() => { setOperatorFilter(''); setOffset(0) }}
                className={cn(
                  'text-xs px-2.5 py-1 rounded-full transition-colors',
                  !operatorFilter
                    ? 'bg-blue-600 text-white'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                )}
              >
                All ({operatorSummary.reduce((sum, o) => sum + o._count, 0)})
              </button>
              {/* The no-operator bucket. Wells land here when DMR activation ran
                  without an operator; they're filtered out of every
                  operator-scoped picker, so this chip plus "Set operator" below
                  is the only way to get them back into circulation. */}
              {operatorSummary
                .filter(o => !o.currentOperatorId && o._count > 0)
                .map(o => (
                  <button
                    key="no-operator"
                    onClick={() => { setOperatorFilter('none'); setOffset(0) }}
                    className={cn(
                      'text-xs px-2.5 py-1 rounded-full transition-colors',
                      operatorFilter === 'none'
                        ? 'bg-amber-600 text-white'
                        : 'bg-amber-100 text-amber-800 hover:bg-amber-200'
                    )}
                  >
                    No operator ({o._count})
                  </button>
                ))}
              {operatorSummary
                .filter(o => o.currentOperatorId)
                .sort((a, b) => b._count - a._count)
                .map(o => (
                  <button
                    key={o.currentOperatorId}
                    onClick={() => { setOperatorFilter(o.currentOperatorId!); setOffset(0) }}
                    className={cn(
                      'text-xs px-2.5 py-1 rounded-full transition-colors',
                      operatorFilter === o.currentOperatorId
                        ? 'bg-blue-600 text-white'
                        : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                    )}
                  >
                    {operatorNames.get(o.currentOperatorId!) || o.currentOperatorId?.slice(0, 8)} ({o._count})
                  </button>
                ))}
            </div>
          )}

          {/* Action bar */}
          {selectedWells.size > 0 && (
            <div className="flex items-center gap-2 mb-3 p-2.5 bg-blue-50 border border-blue-200 rounded-lg">
              <span className="text-sm font-medium text-blue-800">{selectedWells.size} selected</span>
              <div className="flex-1" />
              <button
                onClick={() => { setShowPadPicker(true); setPadPickerSearch('') }}
                className="text-xs font-medium px-3 py-1.5 bg-white text-blue-700 border border-blue-300 rounded-md hover:bg-blue-50 transition-colors"
              >
                <Layers className="w-3.5 h-3.5 inline mr-1" />
                Assign to Existing Pad
              </button>
              <button
                onClick={() => { setShowOperatorPicker(true); setOperatorPickerSearch(''); setOperatorError(null) }}
                className="text-xs font-medium px-3 py-1.5 bg-white text-blue-700 border border-blue-300 rounded-md hover:bg-blue-50 transition-colors"
              >
                <Building2 className="w-3.5 h-3.5 inline mr-1" />
                Set Operator
              </button>
              <button
                onClick={() => setSelectedWells(new Set())}
                className="text-xs text-slate-500 hover:text-slate-700 px-2 py-1.5"
              >
                Clear
              </button>
            </div>
          )}

          {unassignedLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-5 h-5 animate-spin text-blue-500" />
              <span className="ml-2 text-sm text-slate-400">Loading unassigned wells...</span>
            </div>
          ) : unassigned.length === 0 ? (
            <div className="text-center py-12 text-slate-400">
              <Droplets className="w-10 h-10 mx-auto mb-2 opacity-40" />
              <p className="text-sm">
                {unassignedTotal === 0
                  ? 'All wells are assigned to pads.'
                  : `No wells found${search ? ` matching "${search}"` : ''}.`}
              </p>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs text-slate-400">
                  Showing {offset + 1}–{offset + unassigned.length} of {unassignedTotal} unassigned wells
                </p>
                <button
                  onClick={toggleAll}
                  className="text-xs text-blue-600 hover:text-blue-800"
                >
                  {selectedWells.size === unassigned.length ? 'Deselect all' : 'Select all'}
                </button>
              </div>
              <div className="space-y-1.5">
                {unassigned.map(well => {
                  const style = assetStyle(well.assetCategory)
                  return (
                  <div
                    key={well.id}
                    onClick={() => toggleWell(well.id)}
                    className={cn(
                      'flex items-center gap-3 bg-white rounded-lg border p-3 cursor-pointer transition-all',
                      selectedWells.has(well.id)
                        ? 'border-blue-400 bg-blue-50/50 shadow-sm'
                        : 'border-slate-200 hover:border-slate-300'
                    )}
                  >
                    {selectedWells.has(well.id)
                      ? <CheckSquare className="w-5 h-5 text-blue-600 flex-shrink-0" />
                      : <Square className="w-5 h-5 text-slate-300 flex-shrink-0" />
                    }
                    <div className={cn('w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0', style.tile)}>
                      <style.Icon className={cn('w-4 h-4', style.icon)} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-slate-900 truncate">
                          {well.wellName || 'Unnamed Well'}
                        </span>
                        <DmrStatusPill status={well.wellStatus} />
                      </div>
                      <div className="flex items-center gap-3 text-xs text-slate-500 mt-0.5">
                        {well.apiNumber && <span>API: {well.apiNumber}</span>}
                        {well.currentOperator && (
                          <span className="flex items-center gap-1">
                            <Building2 className="w-3 h-3" />{well.currentOperator.name}
                          </span>
                        )}
                        {well.section != null && well.township != null && well.range != null && (
                          <span>S{well.section} T{well.township}N R{well.range}W</span>
                        )}
                      </div>
                    </div>
                  </div>
                )})}
              </div>
              <PaginationBar
                offset={offset} pageSize={pageSize} total={unassignedTotal} loading={unassignedLoading}
                onPrev={() => setOffset(Math.max(0, offset - pageSize))}
                onNext={() => setOffset(offset + pageSize)}
                onJump={setOffset}
              />
            </>
          )}
        </>
      )}

      {/* Add Pad Modal */}
      {showAddPad && (
        <AddPadModal
          onCreated={(pad) => {
            setShowAddPad(false)
            navigate(`/locations/pads/${pad.id}`)
          }}
          onClose={() => setShowAddPad(false)}
        />
      )}

      {/* Add Asset Modal — same well-creation modal as "Add Well" on a pad's
          detail page, opened here with no padId so it creates a standalone,
          unattached asset (match an API wellbore, or manually create a
          mobile/fixed asset). */}
      {showAddAsset && (
        <AddWellModal
          onCreated={() => {
            setShowAddAsset(false)
            setTab('assets')
            loadWells(search, offset, pageSize)
          }}
          onClose={() => setShowAddAsset(false)}
        />
      )}

      {/* Operator Picker Modal (Set Operator on selected wells) */}
      {showOperatorPicker && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <h3 className="text-base font-semibold text-gray-900">Set Operator</h3>
              <button onClick={() => setShowOperatorPicker(false)} className="text-gray-400 hover:text-gray-600">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="px-5 py-4 space-y-3">
              <p className="text-sm text-gray-500">
                {selectedWells.size} well{selectedWells.size !== 1 ? 's' : ''} will be stamped with the operator you pick.
                Whoever actually operates it today — not whatever DMR lists.
              </p>
              {operatorError && (
                <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded text-sm">{operatorError}</div>
              )}
              <div className="relative">
                <Search className="absolute left-3 top-2.5 w-4 h-4 text-gray-400" />
                <input
                  type="text"
                  value={operatorPickerSearch}
                  onChange={e => setOperatorPickerSearch(e.target.value)}
                  placeholder="Search customers..."
                  className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  autoFocus
                />
              </div>
              {(operatorPickerLoading || settingOperator) && (
                <div className="flex items-center gap-2 text-sm text-gray-400 py-2">
                  <Loader2 className="w-4 h-4 animate-spin" /> {settingOperator ? 'Saving...' : 'Searching...'}
                </div>
              )}
              {operatorPickerResults.length > 0 && !settingOperator && (
                <div className="max-h-64 overflow-y-auto space-y-1 border border-gray-200 rounded-lg p-1">
                  {operatorPickerResults.map(c => (
                    <button
                      key={c.id}
                      onClick={() => handleSetOperator(c.id)}
                      className="w-full text-left px-3 py-2 rounded-md hover:bg-blue-50 text-sm flex items-center gap-2"
                    >
                      <Building2 className="w-4 h-4 text-blue-500 flex-shrink-0" />
                      <span className="font-medium text-gray-800 truncate">{c.name}</span>
                    </button>
                  ))}
                </div>
              )}
              {operatorPickerSearch.length >= 2 && !operatorPickerLoading && operatorPickerResults.length === 0 && (
                <p className="text-sm text-gray-400 text-center py-4">No customers found.</p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Pad Picker Modal (Assign to Existing Pad) */}
      {showPadPicker && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <h3 className="text-base font-semibold text-gray-900">Assign to Existing Pad</h3>
              <button onClick={() => setShowPadPicker(false)} className="text-gray-400 hover:text-gray-600">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="px-5 py-4 space-y-3">
              <p className="text-sm text-gray-500">
                {selectedWells.size} well{selectedWells.size !== 1 ? 's' : ''} will be assigned to the selected pad.
              </p>
              <div className="relative">
                <Search className="absolute left-3 top-2.5 w-4 h-4 text-gray-400" />
                <input
                  type="text"
                  value={padPickerSearch}
                  onChange={e => setPadPickerSearch(e.target.value)}
                  placeholder="Search pads..."
                  className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  autoFocus
                />
              </div>
              {padPickerLoading && (
                <div className="flex items-center gap-2 text-sm text-gray-400 py-2">
                  <Loader2 className="w-4 h-4 animate-spin" /> Searching...
                </div>
              )}
              {padPickerResults.length > 0 && (
                <div className="max-h-64 overflow-y-auto space-y-1 border border-gray-200 rounded-lg p-1">
                  {padPickerResults.map(p => (
                    <button
                      key={p.id}
                      onClick={() => handleAssignToExistingPad(p.id)}
                      className="w-full text-left px-3 py-2 rounded-md hover:bg-blue-50 text-sm flex items-center gap-2"
                    >
                      <Layers className="w-4 h-4 text-emerald-500 flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <span className="font-medium text-gray-800 truncate block">{p.name}</span>
                        <span className="text-xs text-gray-400">
                          {p.currentOperator?.name}{' \u00B7 '}{p._count.wells} wells
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
              )}
              {padPickerSearch.length >= 2 && !padPickerLoading && padPickerResults.length === 0 && (
                <p className="text-sm text-gray-400 text-center py-4">No pads found.</p>
              )}
            </div>
          </div>
        </div>
      )}

    </div>
  )
}
