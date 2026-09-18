import { useState, useEffect, useRef, useMemo } from 'react'
import { api } from '@/lib/api'
import { cn } from '@/lib/cn'
import { CustomerSearch } from '@/components/CustomerSearch'
import {
  Route as RouteIcon,
  Plus,
  Loader2,
  ChevronDown,
  ChevronUp,
  MapPin,
  Search,
  Trash2,
  Pencil,
  X,
  Check,
  Building2,
  UserPlus,
  Star,
  ArrowUp,
  ArrowDown,
  Droplets,
} from 'lucide-react'

// ── Types ──────────────────────────────────────────────────

interface Company {
  id: string
  name: string
  companyType: string
  city: string | null
  state: string | null
}

interface Assignment {
  id: string
  userId: string
  isPrimary: boolean
  user: { id: string; name: string; role: string }
}

interface RouteItem {
  id: string
  name: string
  routeNumber: string | null
  companyId: string
  company: { id: string; name: string }
  area: string | null
  description: string | null
  cycleMonths: number
  estimatedMiles: number | null
  sortOrder: number
  isActive: boolean
  assignments: Assignment[]
  _count: { stops: number }
}

interface StopItem {
  id: string
  stopIndex: number
  padId: string | null
  wellId: string | null
  facilityId: string | null
  clientName: string | null
  notes: string | null
  workOrderNumber: string | null
  afeNumber: string | null
  costCenter: string | null
  routeMileage: number | null
  pad: { id: string; name: string; fieldId: string; field: { id: string; name: string } } | null
  well: {
    id: string
    wellName: string | null
    apiNumber: string | null
    padId: string | null
    field: { id: string; name: string } | null
    currentOperator: { id: string; name: string } | null
  } | null
  facility: { id: string; name: string } | null
}

interface RouteDetail extends RouteItem {
  stops: StopItem[]
  assignments: Assignment[]
}

interface TechResult {
  id: string
  name: string
  role: string
}

interface PadResult {
  id: string
  name: string
  fieldId: string
  field: { name: string } | null
}

interface WellResult {
  id: string
  wellName: string | null
  apiNumber: string | null
  pad: { id: string; name: string } | null
  field: { id: string; name: string } | null
  currentOperator: { id: string; name: string } | null
}

// ── Helpers ────────────────────────────────────────────────

const CYCLE_OPTIONS = [
  { value: 1, label: 'Monthly' },
  { value: 3, label: 'Quarterly' },
  { value: 6, label: 'Semi-annual' },
  { value: 12, label: 'Annual' },
]

function cycleLabel(months: number): string {
  const opt = CYCLE_OPTIONS.find(o => o.value === months)
  return opt ? opt.label : `${months}mo`
}

// Well first: a stop that names a well should read as that well, even though it
// also carries the well's pad for mileage/billing/coverage grouping.
function stopLocationName(stop: StopItem): string {
  if (stop.well?.wellName) return stop.well.wellName
  if (stop.pad) return stop.pad.name
  if (stop.facility) return stop.facility.name
  return stop.clientName || `Stop ${stop.stopIndex}`
}

function stopFieldName(stop: StopItem): string | null {
  return stop.pad?.field?.name || stop.well?.field?.name || null
}

/** Secondary line for a well stop — which pad it sits on, or that it has none. */
function stopPadContext(stop: StopItem): string | null {
  if (!stop.well) return null
  return stop.pad ? `on ${stop.pad.name}` : 'no pad'
}

// ── Main Component ─────────────────────────────────────────

export function RoutesPage() {
  const [routes, setRoutes] = useState<RouteItem[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const searchTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  // Expand / detail
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<RouteDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

  // Create form
  const [showCreate, setShowCreate] = useState(false)
  const [createName, setCreateName] = useState('')
  const [createCompany, setCreateCompany] = useState<Company | null>(null)
  const [createArea, setCreateArea] = useState('')
  const [createCycleMonths, setCreateCycleMonths] = useState(6)
  const [createRouteNumber, setCreateRouteNumber] = useState('')
  const [saving, setSaving] = useState(false)

  // Edit route metadata
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editArea, setEditArea] = useState('')
  const [editCycleMonths, setEditCycleMonths] = useState(6)
  const [editRouteNumber, setEditRouteNumber] = useState('')

  // Add stop. One search box, wells first — Well is a first-class location, and
  // a route stop is usually a specific wellhead, not the whole pad. Pads come
  // back in the same list as the inline alternative for genuinely pad-level
  // stops (a battery, a whole multi-well site).
  const [addStopRouteId, setAddStopRouteId] = useState<string | null>(null)
  const [stopSearch, setStopSearch] = useState('')
  const [wellResults, setWellResults] = useState<WellResult[]>([])
  const [padResults, setPadResults] = useState<PadResult[]>([])
  const [stopSearching, setStopSearching] = useState(false)
  const [addStopClientName, setAddStopClientName] = useState('')
  const stopSearchTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  // Assign tech
  const [assignRouteId, setAssignRouteId] = useState<string | null>(null)
  const [techSearch, setTechSearch] = useState('')
  const [techResults, setTechResults] = useState<TechResult[]>([])
  const [techSearching, setTechSearching] = useState(false)
  const techSearchTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  // Company card grouping
  const [collapsedCompanies, setCollapsedCompanies] = useState<Set<string>>(new Set())

  // ── Group routes by company ──

  const companyGroups = useMemo(() => {
    const groupMap = new Map<string, { companyId: string; companyName: string; routes: RouteItem[] }>()
    for (const r of routes) {
      if (!groupMap.has(r.companyId)) {
        groupMap.set(r.companyId, { companyId: r.companyId, companyName: r.company.name, routes: [] })
      }
      groupMap.get(r.companyId)!.routes.push(r)
    }
    return Array.from(groupMap.values()).sort((a, b) => a.companyName.localeCompare(b.companyName))
  }, [routes])

  function toggleCompany(companyId: string) {
    setCollapsedCompanies(prev => {
      const next = new Set(prev)
      next.has(companyId) ? next.delete(companyId) : next.add(companyId)
      return next
    })
  }

  // ── Data loading ──

  useEffect(() => {
    loadRoutes()
  }, [])

  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current)
    searchTimer.current = setTimeout(() => loadRoutes(), 300)
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current) }
  }, [search])

  async function loadRoutes() {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (search) params.set('search', search)
      const result = await api.get<{ data: RouteItem[]; total: number }>(`/routes?${params}`)
      if (result) {
        setRoutes(result.data)
        setTotal(result.total)
      }
    } catch {
      // offline
    }
    setLoading(false)
  }

  async function loadDetail(routeId: string) {
    if (expandedId === routeId) {
      setExpandedId(null)
      setDetail(null)
      return
    }
    setExpandedId(routeId)
    setDetailLoading(true)
    setAddStopRouteId(null)
    try {
      const result = await api.get<RouteDetail>(`/routes/${routeId}`)
      if (result) setDetail(result)
    } catch {
      // offline
    }
    setDetailLoading(false)
  }

  // ── Create route ──

  async function handleCreate() {
    if (!createName.trim() || !createCompany) return
    setSaving(true)
    try {
      await api.post('/routes', {
        name: createName.trim(),
        companyId: createCompany.id,
        area: createArea.trim() || null,
        routeNumber: createRouteNumber.trim() || null,
        cycleMonths: createCycleMonths,
      })
      setShowCreate(false)
      setCreateName('')
      setCreateCompany(null)
      setCreateArea('')
      setCreateRouteNumber('')
      setCreateCycleMonths(6)
      await loadRoutes()
    } catch {
      // error
    }
    setSaving(false)
  }

  // ── Edit route ──

  function startEdit(route: RouteItem) {
    setEditingId(route.id)
    setEditName(route.name)
    setEditArea(route.area || '')
    setEditCycleMonths(route.cycleMonths)
    setEditRouteNumber(route.routeNumber || '')
  }

  async function saveEdit() {
    if (!editingId || !editName.trim()) return
    setSaving(true)
    try {
      await api.put(`/routes/${editingId}`, {
        name: editName.trim(),
        area: editArea.trim() || null,
        routeNumber: editRouteNumber.trim() || null,
        cycleMonths: editCycleMonths,
      })
      setEditingId(null)
      await loadRoutes()
      // Refresh detail if expanded
      if (expandedId === editingId) {
        const result = await api.get<RouteDetail>(`/routes/${editingId}`)
        if (result) setDetail(result)
      }
    } catch {
      // error
    }
    setSaving(false)
  }

  // ── Add stop ──

  useEffect(() => {
    const q = stopSearch.trim()
    if (!q) { setWellResults([]); setPadResults([]); return }
    if (stopSearchTimer.current) clearTimeout(stopSearchTimer.current)
    stopSearchTimer.current = setTimeout(async () => {
      setStopSearching(true)
      // Wells and pads in parallel — not scoped to the route's operator on
      // purpose: a well whose operator is wrong or missing is exactly the one
      // you're trying to get onto a route, and scoping would hide it.
      const [wells, pads] = await Promise.all([
        api.get<{ data: WellResult[] }>(`/locations/wells?search=${encodeURIComponent(q)}&active=true&limit=8`)
          .then(r => r.data || []).catch(() => []),
        api.get<{ data: PadResult[] }>(`/locations/pads?search=${encodeURIComponent(q)}&limit=5`)
          .then(r => r.data || []).catch(() => []),
      ])
      setWellResults(wells)
      setPadResults(pads)
      setStopSearching(false)
    }, 300)
    return () => { if (stopSearchTimer.current) clearTimeout(stopSearchTimer.current) }
  }, [stopSearch])

  async function handleAddStop(target: { wellId: string } | { padId: string }) {
    if (!addStopRouteId) return
    setSaving(true)
    try {
      await api.post(`/routes/${addStopRouteId}/stops`, {
        ...target,
        clientName: addStopClientName.trim() || null,
      })
      // Refresh detail
      const result = await api.get<RouteDetail>(`/routes/${addStopRouteId}`)
      if (result) setDetail(result)
      setStopSearch('')
      setWellResults([])
      setPadResults([])
      setAddStopClientName('')
      // Refresh route list to update stop count
      await loadRoutes()
    } catch {
      // error
    }
    setSaving(false)
  }

  // ── Tech search + assign ──

  useEffect(() => {
    if (!techSearch.trim()) { setTechResults([]); return }
    if (techSearchTimer.current) clearTimeout(techSearchTimer.current)
    techSearchTimer.current = setTimeout(async () => {
      setTechSearching(true)
      try {
        const result = await api.get<{ data: TechResult[] }>(`/routes/techs?search=${encodeURIComponent(techSearch)}`)
        if (result) setTechResults(result.data)
      } catch {
        setTechResults([])
      }
      setTechSearching(false)
    }, 300)
    return () => { if (techSearchTimer.current) clearTimeout(techSearchTimer.current) }
  }, [techSearch])

  async function handleAssignTech(routeId: string, userId: string, isPrimary = false) {
    setSaving(true)
    try {
      await api.post(`/routes/${routeId}/assign`, { userId, isPrimary })
      // Refresh detail + list
      const result = await api.get<RouteDetail>(`/routes/${routeId}`)
      if (result) setDetail(result)
      setTechSearch('')
      setTechResults([])
      await loadRoutes()
    } catch {
      // error
    }
    setSaving(false)
  }

  async function handleUnassignTech(routeId: string, userId: string) {
    try {
      await api.delete(`/routes/${routeId}/assign/${userId}`)
      const result = await api.get<RouteDetail>(`/routes/${routeId}`)
      if (result) setDetail(result)
      await loadRoutes()
    } catch {
      // error
    }
  }

  async function handleTogglePrimary(routeId: string, userId: string) {
    setSaving(true)
    try {
      await api.post(`/routes/${routeId}/assign`, { userId, isPrimary: true })
      const result = await api.get<RouteDetail>(`/routes/${routeId}`)
      if (result) setDetail(result)
      await loadRoutes()
    } catch {
      // error
    }
    setSaving(false)
  }

  async function handleDeleteRoute(routeId: string, routeName: string) {
    if (!confirm(`Delete route "${routeName}" and all its stops?`)) return
    try {
      await api.delete(`/routes/${routeId}`)
      setExpandedId(null)
      setDetail(null)
      await loadRoutes()
    } catch {
      // error
    }
  }

  async function handleMoveStop(routeId: string, stopId: string, direction: -1 | 1) {
    if (!detail || detail.id !== routeId) return
    const stops = detail.stops
    const idx = stops.findIndex(s => s.id === stopId)
    if (idx < 0) return
    const target = idx + direction
    if (target < 0 || target >= stops.length) return

    // Build new order + optimistically update UI
    const newOrder = stops.slice()
    const [moved] = newOrder.splice(idx, 1)
    newOrder.splice(target, 0, moved)
    const reindexed = newOrder.map((s, i) => ({ ...s, stopIndex: i + 1 }))
    setDetail({ ...detail, stops: reindexed })

    try {
      await api.post(`/routes/${routeId}/stops/reorder`, {
        stopIds: newOrder.map(s => s.id),
      })
    } catch {
      // Roll back on failure
      setDetail({ ...detail, stops })
    }
  }

  async function handleRemoveStop(routeId: string, stopId: string) {
    try {
      await api.delete(`/routes/${routeId}/stops/${stopId}`)
      // Refresh detail
      const result = await api.get<RouteDetail>(`/routes/${routeId}`)
      if (result) setDetail(result)
      await loadRoutes()
    } catch {
      // error
    }
  }

  // ── Route card renderer (shared across groups) ──

  function renderRouteCard(route: RouteItem) {
    const isExpanded = expandedId === route.id
    const isEditing = editingId === route.id

    return (
      <div key={route.id}>
        {/* Route card */}
        <button
          onClick={() => loadDetail(route.id)}
          className="w-full px-4 py-3 text-left hover:bg-slate-50 transition-colors"
        >
          <div className="flex items-center justify-between mb-1">
            <div className="flex items-center gap-2 min-w-0">
              <RouteIcon className="w-4 h-4 text-slate-400 shrink-0" />
              <span className="font-medium text-slate-900 truncate">{route.name}</span>
              {route.routeNumber && (
                <span className="text-xs text-slate-400 font-mono">#{route.routeNumber}</span>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span className="text-xs px-1.5 py-0.5 bg-slate-100 text-slate-500 rounded font-medium">
                {cycleLabel(route.cycleMonths)}
              </span>
              <span className="text-xs px-1.5 py-0.5 bg-blue-50 text-blue-600 rounded font-medium">
                {route._count.stops} stops
              </span>
              {isExpanded
                ? <ChevronUp className="w-4 h-4 text-slate-400" />
                : <ChevronDown className="w-4 h-4 text-slate-400" />
              }
            </div>
          </div>
          <div className="flex items-center gap-3 text-xs text-slate-500 flex-wrap">
            {route.area && <span>{route.area}</span>}
            {route.assignments?.length > 0 && (
              <span className="flex items-center gap-1">
                {route.assignments.map(a => (
                  <span key={a.id} className={cn(
                    'px-1.5 py-0.5 rounded',
                    a.isPrimary ? 'bg-amber-100 text-amber-700 font-medium' : 'bg-slate-100 text-slate-600'
                  )}>
                    {a.user.name.split(' ')[0]}{a.isPrimary ? ' \u2605' : ''}
                  </span>
                ))}
              </span>
            )}
          </div>
        </button>

        {/* Expanded detail */}
        {isExpanded && (
          <div className="mx-4 mb-3 ml-6 border-l-2 border-blue-200 pl-3 pb-2">
            {detailLoading ? (
              <div className="py-4 flex items-center gap-2 text-sm text-slate-400">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading...
              </div>
            ) : detail ? (
              <>
                {/* Route metadata — edit mode */}
                {isEditing ? (
                  <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 mb-3 space-y-2">
                    <h4 className="text-xs font-semibold text-slate-600">Edit Route</h4>
                    <div className="grid grid-cols-2 gap-2">
                      <input
                        type="text"
                        value={editName}
                        onChange={e => setEditName(e.target.value)}
                        placeholder="Route name"
                        className="px-2 py-1.5 border border-slate-300 rounded text-sm outline-none focus:ring-1 focus:ring-blue-500"
                      />
                      <input
                        type="text"
                        value={editRouteNumber}
                        onChange={e => setEditRouteNumber(e.target.value)}
                        placeholder="Route #"
                        className="px-2 py-1.5 border border-slate-300 rounded text-sm outline-none focus:ring-1 focus:ring-blue-500"
                      />
                      <input
                        type="text"
                        value={editArea}
                        onChange={e => setEditArea(e.target.value)}
                        placeholder="Area"
                        className="px-2 py-1.5 border border-slate-300 rounded text-sm outline-none focus:ring-1 focus:ring-blue-500"
                      />
                      <select
                        value={editCycleMonths}
                        onChange={e => setEditCycleMonths(parseInt(e.target.value, 10))}
                        className="px-2 py-1.5 border border-slate-300 rounded text-sm outline-none focus:ring-1 focus:ring-blue-500 bg-white"
                      >
                        {CYCLE_OPTIONS.map(o => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                      </select>
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={saveEdit}
                        disabled={saving || !editName.trim()}
                        className="flex items-center gap-1 px-3 py-1.5 bg-blue-700 text-white rounded text-xs font-medium hover:bg-blue-800 disabled:opacity-50"
                      >
                        {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                        Save
                      </button>
                      <button
                        onClick={() => setEditingId(null)}
                        className="px-3 py-1.5 text-slate-500 text-xs hover:text-slate-700"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 mb-3">
                    {detail.description && (
                      <p className="text-xs text-slate-500 italic flex-1">{detail.description}</p>
                    )}
                    <button
                      onClick={() => startEdit(route)}
                      className="flex items-center gap-1 px-2 py-1 text-xs text-slate-500 hover:text-blue-700 hover:bg-blue-50 rounded transition-colors"
                    >
                      <Pencil className="w-3 h-3" />
                      Edit
                    </button>
                    <button
                      onClick={() => handleDeleteRoute(route.id, route.name)}
                      className="flex items-center gap-1 px-2 py-1 text-xs text-slate-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
                    >
                      <Trash2 className="w-3 h-3" />
                      Delete
                    </button>
                  </div>
                )}

                {/* Assigned techs */}
                <div className="mb-3">
                  <div className="flex items-center gap-2 mb-1.5">
                    <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Assigned Techs</h4>
                  </div>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {detail.assignments?.map(a => (
                      <span
                        key={a.id}
                        className={cn(
                          'inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs group/chip',
                          a.isPrimary ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-700'
                        )}
                      >
                        {a.isPrimary && <Star className="w-3 h-3 fill-amber-500 text-amber-500" />}
                        {a.user.name}
                        {!a.isPrimary && (
                          <button
                            onClick={() => handleTogglePrimary(route.id, a.userId)}
                            className="opacity-0 group-hover/chip:opacity-100 ml-0.5 text-amber-500 hover:text-amber-700"
                            title="Make primary"
                          >
                            <Star className="w-3 h-3" />
                          </button>
                        )}
                        <button
                          onClick={() => handleUnassignTech(route.id, a.userId)}
                          className="opacity-0 group-hover/chip:opacity-100 ml-0.5 text-red-400 hover:text-red-600"
                          title="Remove"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </span>
                    ))}
                    {(!detail.assignments || detail.assignments.length === 0) && assignRouteId !== route.id && (
                      <span className="text-xs text-slate-400 italic">No techs assigned</span>
                    )}
                    {assignRouteId === route.id ? (
                      <div className="relative">
                        <input
                          type="text"
                          value={techSearch}
                          onChange={e => setTechSearch(e.target.value)}
                          placeholder="Search techs..."
                          autoFocus
                          className="w-40 px-2 py-1 border border-slate-300 rounded text-xs outline-none focus:ring-1 focus:ring-blue-500"
                          onBlur={() => setTimeout(() => { setAssignRouteId(null); setTechSearch(''); setTechResults([]) }, 200)}
                        />
                        {techSearching && <Loader2 className="absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 animate-spin text-slate-400" />}
                        {techResults.length > 0 && (
                          <div className="absolute z-10 mt-1 w-56 bg-white border border-slate-200 rounded-lg shadow-lg max-h-32 overflow-y-auto">
                            {techResults
                              .filter(t => !detail.assignments?.some(a => a.userId === t.id))
                              .map(tech => (
                                <button
                                  key={tech.id}
                                  onMouseDown={(e) => { e.preventDefault(); handleAssignTech(route.id, tech.id) }}
                                  className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-blue-50 transition-colors"
                                >
                                  <UserPlus className="w-3 h-3 text-blue-500 shrink-0" />
                                  <span className="font-medium text-slate-900">{tech.name}</span>
                                  <span className="text-slate-400 ml-auto">{tech.role.replace('_', ' ')}</span>
                                </button>
                              ))}
                          </div>
                        )}
                      </div>
                    ) : (
                      <button
                        onClick={() => { setAssignRouteId(route.id); setTechSearch(''); setTechResults([]) }}
                        className="flex items-center gap-1 px-2 py-1 text-xs text-blue-600 hover:bg-blue-50 rounded transition-colors"
                      >
                        <UserPlus className="w-3 h-3" />
                        Assign
                      </button>
                    )}
                  </div>
                </div>

                {/* Stop list */}
                <div className="space-y-0.5">
                  {detail.stops.length === 0 ? (
                    <p className="text-xs text-slate-400 py-2">No stops yet — add one below.</p>
                  ) : (
                    detail.stops.map((stop, stopIdx) => {
                      const isFirst = stopIdx === 0
                      const isLast = stopIdx === detail.stops.length - 1
                      return (
                        <div
                          key={stop.id}
                          className="flex items-center gap-2 px-3 py-2 rounded hover:bg-slate-50 group text-xs"
                        >
                          <span className="text-slate-400 font-mono w-5 text-right">{stopIdx + 1}</span>
                          <div className="flex flex-col opacity-0 group-hover:opacity-100 transition-opacity">
                            <button
                              onClick={(e) => { e.stopPropagation(); handleMoveStop(route.id, stop.id, -1) }}
                              disabled={isFirst}
                              className="p-0.5 text-slate-400 hover:text-blue-600 disabled:opacity-30 disabled:hover:text-slate-400"
                              title="Move up"
                            >
                              <ArrowUp className="w-3 h-3" />
                            </button>
                            <button
                              onClick={(e) => { e.stopPropagation(); handleMoveStop(route.id, stop.id, 1) }}
                              disabled={isLast}
                              className="p-0.5 text-slate-400 hover:text-blue-600 disabled:opacity-30 disabled:hover:text-slate-400"
                              title="Move down"
                            >
                              <ArrowDown className="w-3 h-3" />
                            </button>
                          </div>
                          <MapPin className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                          <div className="flex-1 min-w-0">
                            <span className="font-medium text-slate-900 truncate block">
                              {stopLocationName(stop)}
                            </span>
                            <div className="flex items-center gap-2 text-slate-400">
                              {stopPadContext(stop) && <span>{stopPadContext(stop)}</span>}
                              {stopFieldName(stop) && <span>{stopFieldName(stop)}</span>}
                              {stop.clientName && (
                                <span className="italic">"{stop.clientName}"</span>
                              )}
                              {stop.afeNumber && (
                                <span className="px-1 bg-slate-100 rounded">AFE: {stop.afeNumber}</span>
                              )}
                              {stop.workOrderNumber && (
                                <span className="px-1 bg-slate-100 rounded">WO: {stop.workOrderNumber}</span>
                              )}
                            </div>
                          </div>
                          <button
                            onClick={(e) => { e.stopPropagation(); handleRemoveStop(route.id, stop.id) }}
                            className="opacity-0 group-hover:opacity-100 p-1 text-red-400 hover:text-red-600 transition-opacity"
                            title="Remove stop"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      )
                    })
                  )}
                </div>

                {/* Add stop */}
                {addStopRouteId === route.id ? (
                  <div className="mt-2 bg-green-50 border border-green-200 rounded-lg p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <h4 className="text-xs font-semibold text-slate-600">Add Stop</h4>
                      <button onClick={() => setAddStopRouteId(null)} className="text-slate-400 hover:text-slate-600">
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>

                    <div className="relative">
                      <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
                      <input
                        type="text"
                        value={stopSearch}
                        onChange={e => setStopSearch(e.target.value)}
                        placeholder="Search a well by name or API..."
                        autoFocus
                        className="w-full pl-8 pr-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-green-500 focus:border-green-500 outline-none"
                      />
                      {stopSearching && (
                        <Loader2 className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 animate-spin" />
                      )}
                    </div>

                    {(wellResults.length > 0 || padResults.length > 0) && (
                      <div className="border border-slate-200 rounded-lg max-h-56 overflow-y-auto bg-white">
                        {wellResults.length > 0 && (
                          <p className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400 bg-slate-50 sticky top-0">
                            Wells
                          </p>
                        )}
                        {wellResults.map(well => (
                          <button
                            key={well.id}
                            onClick={() => handleAddStop({ wellId: well.id })}
                            disabled={saving}
                            className="w-full flex items-center gap-2 px-3 py-2 text-left text-xs hover:bg-green-50 transition-colors border-b border-slate-100 last:border-0"
                          >
                            <Droplets className="w-3.5 h-3.5 text-blue-500 shrink-0" />
                            <div className="flex-1 min-w-0">
                              <span className="font-medium text-slate-900 truncate block">
                                {well.wellName || "(unnamed well)"}
                              </span>
                              <span className="text-slate-400 truncate block">
                                {well.pad ? `on ${well.pad.name}` : "no pad"}
                                {well.currentOperator ? ` · ${well.currentOperator.name}` : " · no operator"}
                                {well.apiNumber ? ` · ${well.apiNumber}` : ""}
                              </span>
                            </div>
                            <Plus className="w-3.5 h-3.5 text-green-600 shrink-0" />
                          </button>
                        ))}

                        {/* Pad-level stop stays available inline — a battery or a
                            whole multi-well site is legitimately one stop. */}
                        {padResults.length > 0 && (
                          <p className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400 bg-slate-50">
                            Pads / sites — whole location
                          </p>
                        )}
                        {padResults.map(pad => (
                          <button
                            key={pad.id}
                            onClick={() => handleAddStop({ padId: pad.id })}
                            disabled={saving}
                            className="w-full flex items-center gap-2 px-3 py-2 text-left text-xs hover:bg-green-50 transition-colors border-b border-slate-100 last:border-0"
                          >
                            <MapPin className="w-3.5 h-3.5 text-green-600 shrink-0" />
                            <div className="flex-1 min-w-0">
                              <span className="font-medium text-slate-900">{pad.name}</span>
                              {pad.field && (
                                <span className="text-slate-400 ml-1.5">{pad.field.name}</span>
                              )}
                            </div>
                            <Plus className="w-3.5 h-3.5 text-green-600 shrink-0" />
                          </button>
                        ))}
                      </div>
                    )}

                    {stopSearch.trim() && !stopSearching && wellResults.length === 0 && padResults.length === 0 && (
                      <p className="text-[11px] text-slate-400 px-1">
                        No active well or pad matches that. A well has to be activated (Locations &rarr; DMR) before it can be a stop.
                      </p>
                    )}

                    <input
                      type="text"
                      value={addStopClientName}
                      onChange={e => setAddStopClientName(e.target.value)}
                      placeholder="Client name / alias (optional)"
                      className="w-full px-3 py-1.5 border border-slate-300 rounded text-xs outline-none focus:ring-1 focus:ring-green-500"
                    />
                  </div>
                ) : (
                  <button
                    onClick={() => { setAddStopRouteId(route.id); setStopSearch(''); setWellResults([]); setPadResults([]); setAddStopClientName('') }}
                    className="mt-2 flex items-center gap-1 px-3 py-1.5 text-xs text-green-700 hover:bg-green-50 rounded font-medium transition-colors"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    Add Stop
                  </button>
                )}
              </>
            ) : null}
          </div>
        )}
      </div>
    )
  }

  // ── Render ──

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Routes</h1>
          <p className="text-sm text-slate-500 mt-0.5">Manage service routes and cycle frequency</p>
        </div>
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="flex items-center gap-1.5 px-4 py-2 bg-blue-800 text-white rounded-lg text-sm font-medium hover:bg-blue-900 transition-colors"
        >
          <Plus className="w-4 h-4" />
          Add Route
        </button>
      </div>

      {/* Create form */}
      {showCreate && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-slate-900 text-sm">New Route</h3>
            <button onClick={() => setShowCreate(false)} className="text-slate-400 hover:text-slate-600">
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Route Name *</label>
              <input
                type="text"
                value={createName}
                onChange={e => setCreateName(e.target.value)}
                placeholder="e.g. Northern Sanish Loop"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Route # (optional)</label>
              <input
                type="text"
                value={createRouteNumber}
                onChange={e => setCreateRouteNumber(e.target.value)}
                placeholder="e.g. R-001"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Customer *</label>
            <CustomerSearch value={createCompany} onChange={setCreateCompany} />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Area</label>
              <input
                type="text"
                value={createArea}
                onChange={e => setCreateArea(e.target.value)}
                placeholder="e.g. Sanish, Oliver"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Cycle Frequency</label>
              <select
                value={createCycleMonths}
                onChange={e => setCreateCycleMonths(parseInt(e.target.value, 10))}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none bg-white"
              >
                {CYCLE_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>{o.label} ({o.value}mo)</option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex gap-2 pt-1">
            <button
              onClick={handleCreate}
              disabled={!createName.trim() || !createCompany || saving}
              className="flex items-center gap-1.5 px-4 py-2 bg-blue-700 text-white rounded-lg text-sm font-medium hover:bg-blue-800 transition-colors disabled:opacity-50"
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
              Create Route
            </button>
            <button
              onClick={() => setShowCreate(false)}
              className="px-4 py-2 text-slate-600 text-sm hover:text-slate-800"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Search */}
      <div className="relative mb-4">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search routes, areas, or customers..."
          className="w-full pl-10 pr-4 py-2.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
        />
      </div>

      {/* Route list — grouped by company */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 text-slate-400 animate-spin" />
        </div>
      ) : routes.length === 0 ? (
        <div className="text-center py-12 text-slate-400">
          <RouteIcon className="w-10 h-10 mx-auto mb-2 opacity-50" />
          <p className="font-medium">No routes found</p>
          <p className="text-sm mt-1">Create a route to start tracking coverage.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {companyGroups.map(group => {
            const isCollapsed = collapsedCompanies.has(group.companyId)
            const totalStops = group.routes.reduce((s, r) => s + r._count.stops, 0)

            return (
              <div key={group.companyId} className="bg-white rounded-lg border border-slate-200 overflow-hidden">
                {/* Company header */}
                <button
                  onClick={() => toggleCompany(group.companyId)}
                  className="w-full flex items-center justify-between px-4 py-3 bg-slate-50 hover:bg-slate-100 transition-colors"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <Building2 className="w-4 h-4 text-slate-500 shrink-0" />
                    <span className="font-semibold text-slate-900 truncate">{group.companyName}</span>
                    <span className="text-xs text-slate-400 shrink-0">
                      {group.routes.length} route{group.routes.length !== 1 ? 's' : ''} &middot; {totalStops} stops
                    </span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {isCollapsed ? <ChevronDown className="w-4 h-4 text-slate-400" /> : <ChevronUp className="w-4 h-4 text-slate-400" />}
                  </div>
                </button>

                {/* Routes inside this company */}
                {!isCollapsed && (
                  <div className="divide-y divide-slate-100">
                    {group.routes.map(route => renderRouteCard(route))}
                  </div>
                )}
              </div>
            )
          })}

          {total > routes.length && (
            <p className="text-center text-xs text-slate-400 py-2">
              Showing {routes.length} of {total} routes
            </p>
          )}
        </div>
      )}
    </div>
  )
}
