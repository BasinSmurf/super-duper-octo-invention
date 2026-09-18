import { useState, useEffect, useMemo } from 'react'
import { api } from '@/lib/api'
import { cn } from '@/lib/cn'
import { hasPermission } from '@/lib/permissions'
import { formatCalendarDateNumeric } from '@/lib/dates'
import { useAuth } from '@/contexts/AuthContext'
import { GenerateTicketsModal } from '@/components/GenerateTicketsModal'
import {
  Wind,
  Loader2,
  ChevronDown,
  ChevronUp,
  CheckCircle2,
  Clock,
  TrendingUp,
  Users,
  AlertTriangle,
  Search,
  Building2,
  Zap,
  ArrowUpDown,
} from 'lucide-react'

interface RouteStop {
  stopId: string
  stopIndex: number
  padId: string | null
  padName: string
  /** Well name when the stop IS a well, else the pad name. Prefer this for display. */
  locationName?: string
  wellId?: string | null
  wellName?: string | null
  fieldName: string | null
  clientName: string | null
  isServiced: boolean
  lastServiceDate: string | null
  lastTicketNumber: string | null
  lastTechName: string | null
}

interface RouteSummary {
  routeId: string
  routeName: string
  routeNumber: string | null
  area: string | null
  companyId: string
  companyName: string
  cycleMonths: number
  cycleName?: string
  cycleStart?: string
  cycleEnd?: string
  totalStops: number
  servicedStops: number
  remainingStops: number
  percentComplete: number
  lastServiceDate: string | null
  stops: RouteStop[]
}

interface RouteDetail {
  route: { id: string; name: string; routeNumber: string | null; area: string | null; companyName: string; description: string | null }
  totalStops: number
  servicedStops: number
  remainingStops: number
  percentComplete: number
  techBreakdown: Array<{ name: string; count: number }>
  stops: Array<RouteStop & {
    notes: string | null
    afeNumber: string | null
    serviceCount: number
    lastServiceType: string | null
    tickets: Array<{ id: string; ticketNumber: string; serviceDate: string; serviceSubtype: string | null; techName: string | null }>
  }>
}

/** A stop's display name. `locationName` is well-first; `padName` is the
 *  pre-well-stops field and stays the fallback for a cached older response. */
function stopName(stop: { locationName?: string; padName: string }): string {
  return stop.locationName || stop.padName
}

interface CoverageData {
  periodMonths: number | 'auto'
  cycleName?: string
  cycleStart?: string
  cycleEnd?: string
  totals: { routes: number; stops: number; serviced: number; remaining: number; percentComplete: number }
  pace: { weeksElapsed: number; weeksRemaining: number; avgPerWeek: number; weeksToFinishAtCurrentPace: number | null; needsMoreGuys: boolean }
  routes: RouteSummary[]
}

interface CompanyGroup {
  companyId: string
  companyName: string
  routes: RouteSummary[]
}

export function CoveragePage() {
  const { user } = useAuth()
  const canDispatch = hasPermission(user?.role, 'dispatch:manage')
  const [data, setData] = useState<CoverageData | null>(null)
  const [detail, setDetail] = useState<RouteDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [months, setMonths] = useState<number | 'auto'>('auto')
  const [expandedRoute, setExpandedRoute] = useState<string | null>(null)
  const [expandedStop, setExpandedStop] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [collapsedCompanies, setCollapsedCompanies] = useState<Set<string>>(new Set())
  const [genRoute, setGenRoute] = useState<{ id: string; name: string; remaining: number } | null>(null)
  const [stopSort, setStopSort] = useState<'undone' | 'alpha' | 'index'>('undone')

  useEffect(() => {
    loadData()
  }, [months])

  async function loadData() {
    setLoading(true)
    setDetail(null)
    setExpandedRoute(null)
    try {
      const result = await api.get<CoverageData>(`/coverage/routes?months=${months === 'auto' ? 'auto' : months}`)
      if (result) setData(result)
    } catch {
      // offline
    }
    setLoading(false)
  }

  async function loadRouteDetail(routeId: string) {
    if (expandedRoute === routeId) {
      setExpandedRoute(null)
      setDetail(null)
      return
    }
    setExpandedRoute(routeId)
    setDetailLoading(true)
    setExpandedStop(null)
    try {
      const result = await api.get<RouteDetail>(`/coverage/routes/${routeId}${months !== 'auto' ? `?months=${months}` : ''}`)
      if (result) setDetail(result)
    } catch {
      // offline
    }
    setDetailLoading(false)
  }

  // ── Filter + group by company ──

  const { filteredGroups, filteredTotals } = useMemo(() => {
    if (!data) return { filteredGroups: [] as CompanyGroup[], filteredTotals: null }

    const q = search.toLowerCase().trim()

    // Filter routes: match route name, company name, area, OR any stop's name/field/alias
    const filtered = q ? data.routes.filter(r => {
      if (r.routeName.toLowerCase().includes(q)) return true
      if (r.companyName.toLowerCase().includes(q)) return true
      if (r.area?.toLowerCase().includes(q)) return true
      if (r.routeNumber?.toLowerCase().includes(q)) return true
      return r.stops.some(s =>
        stopName(s).toLowerCase().includes(q) ||
        s.fieldName?.toLowerCase().includes(q) ||
        s.clientName?.toLowerCase().includes(q)
      )
    }) : data.routes

    // Group by company
    const groupMap = new Map<string, CompanyGroup>()
    for (const r of filtered) {
      if (!groupMap.has(r.companyId)) {
        groupMap.set(r.companyId, { companyId: r.companyId, companyName: r.companyName, routes: [] })
      }
      groupMap.get(r.companyId)!.routes.push(r)
    }

    // Sort groups by total remaining (most work first)
    const groups = Array.from(groupMap.values()).sort((a, b) => {
      const aRemaining = a.routes.reduce((s, r) => s + r.remainingStops, 0)
      const bRemaining = b.routes.reduce((s, r) => s + r.remainingStops, 0)
      return bRemaining - aRemaining
    })

    // Filtered totals
    const stops = filtered.reduce((s, r) => s + r.totalStops, 0)
    const serviced = filtered.reduce((s, r) => s + r.servicedStops, 0)

    return {
      filteredGroups: groups,
      filteredTotals: {
        routes: filtered.length,
        stops,
        serviced,
        remaining: stops - serviced,
        percentComplete: stops > 0 ? Math.round((serviced / stops) * 100) : 0,
      },
    }
  }, [data, search])

  // ── Helpers ──

  function toggleCompany(companyId: string) {
    setCollapsedCompanies(prev => {
      const next = new Set(prev)
      next.has(companyId) ? next.delete(companyId) : next.add(companyId)
      return next
    })
  }

  function progressColor(pct: number): string {
    if (pct >= 80) return 'bg-green-500'
    if (pct >= 50) return 'bg-amber-500'
    return 'bg-red-500'
  }

  function progressTextColor(pct: number): string {
    if (pct >= 80) return 'text-green-700'
    if (pct >= 50) return 'text-amber-600'
    return 'text-red-600'
  }

  function daysAgo(dateStr: string | null): string {
    if (!dateStr) return 'Never'
    const d = new Date(dateStr)
    const diff = Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24))
    if (diff === 0) return 'Today'
    if (diff === 1) return 'Yesterday'
    if (diff < 7) return `${diff}d ago`
    if (diff < 30) return `${Math.floor(diff / 7)}w ago`
    return `${Math.floor(diff / 30)}mo ago`
  }

  // Use filtered totals when searching, raw totals otherwise
  const displayTotals = filteredTotals || data?.totals

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Coverage</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            {data?.cycleName
              ? <>Current period: <span className="font-semibold text-slate-700">{data.cycleName}</span>
                {data.cycleStart && data.cycleEnd && (
                  <span className="text-slate-400"> ({new Date(data.cycleStart).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} &ndash; {new Date(data.cycleEnd).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })})</span>
                )}
              </>
              : 'Route progress by customer'}
          </p>
        </div>
      </div>

      {/* Period filter */}
      <div className="flex gap-0.5 bg-slate-100 p-1 rounded-lg mb-4 w-fit">
        {([{ value: 'auto' as const, label: 'Per Route' }, { value: 3 as const, label: '3 months' }, { value: 6 as const, label: '6 months' }, { value: 12 as const, label: '12 months' }]).map(m => (
          <button
            key={m.value}
            onClick={() => setMonths(m.value)}
            className={cn(
              'px-4 py-1.5 text-xs font-medium rounded-md transition-colors',
              months === m.value ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700',
            )}
          >
            {m.label}
          </button>
        ))}
      </div>

      {/* Search */}
      <div className="relative mb-4">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search routes, pads, fields, customers..."
          className="w-full pl-10 pr-4 py-2.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
        />
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 text-slate-400 animate-spin" />
        </div>
      ) : !data || data.totals.routes === 0 ? (
        <div className="text-center py-12 text-slate-400">
          <Wind className="w-10 h-10 mx-auto mb-2 opacity-50" />
          <p className="font-medium">No routes configured</p>
          <p className="text-sm mt-1">Set up service routes to track coverage progress.</p>
        </div>
      ) : (
        <>
          {/* Global stats */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <div className="bg-white rounded-lg border border-slate-200 p-3">
              <p className="text-xs text-slate-500">Routes</p>
              <p className="text-xl font-bold text-slate-900">{displayTotals?.routes ?? 0}</p>
            </div>
            <div className="bg-white rounded-lg border border-slate-200 p-3">
              <p className="text-xs text-slate-500">Stops Done</p>
              <p className="text-xl font-bold text-green-700">{displayTotals?.serviced ?? 0} <span className="text-sm font-normal text-slate-400">/ {displayTotals?.stops ?? 0}</span></p>
            </div>
            <div className="bg-white rounded-lg border border-slate-200 p-3">
              <p className="text-xs text-slate-500">Remaining</p>
              <p className={cn('text-xl font-bold', (displayTotals?.remaining ?? 0) > 0 ? 'text-amber-600' : 'text-green-700')}>
                {displayTotals?.remaining ?? 0}
              </p>
            </div>
            <div className="bg-white rounded-lg border border-slate-200 p-3">
              <p className="text-xs text-slate-500">Complete</p>
              <p className={cn('text-xl font-bold', progressTextColor(displayTotals?.percentComplete ?? 0))}>
                {displayTotals?.percentComplete ?? 0}%
              </p>
            </div>
          </div>

          {/* Pace indicator */}
          <div className={cn(
            'rounded-lg border p-4 mb-4',
            data.pace.needsMoreGuys ? 'bg-red-50 border-red-200' : 'bg-green-50 border-green-200',
          )}>
            <div className="flex items-center gap-2 mb-1">
              {data.pace.needsMoreGuys
                ? <AlertTriangle className="w-4 h-4 text-red-600" />
                : <TrendingUp className="w-4 h-4 text-green-600" />
              }
              <span className={cn('text-sm font-semibold', data.pace.needsMoreGuys ? 'text-red-800' : 'text-green-800')}>
                {data.pace.avgPerWeek} stops/week
              </span>
              <span className="text-xs text-slate-500">
                ({data.pace.weeksElapsed}w elapsed, ~{data.pace.weeksRemaining}w left{data.cycleName ? ` in ${data.cycleName}` : ' in period'})
              </span>
            </div>
            <p className={cn('text-xs', data.pace.needsMoreGuys ? 'text-red-700' : 'text-green-700')}>
              {data.pace.weeksToFinishAtCurrentPace !== null && data.totals.remaining > 0 ? (
                <>
                  {data.totals.remaining} stops left at {data.pace.avgPerWeek}/week = ~{data.pace.weeksToFinishAtCurrentPace} weeks.
                  {data.pace.needsMoreGuys
                    ? <span className="font-bold"> Behind pace — need more guys.</span>
                    : <span> On track.</span>
                  }
                </>
              ) : data.totals.remaining === 0 ? (
                'All stops serviced this period.'
              ) : (
                'No stops completed yet — pace not available.'
              )}
            </p>
          </div>

          {/* Global progress bar */}
          <div className="bg-white rounded-lg border border-slate-200 p-3 mb-4">
            <div className="flex items-center justify-between text-xs text-slate-500 mb-1.5">
              <span>{displayTotals?.serviced ?? 0} of {displayTotals?.stops ?? 0} stops</span>
              <span>{displayTotals?.percentComplete ?? 0}%</span>
            </div>
            <div className="w-full h-3 bg-slate-100 rounded-full overflow-hidden">
              <div
                className={cn('h-full rounded-full transition-all', progressColor(displayTotals?.percentComplete ?? 0))}
                style={{ width: `${displayTotals?.percentComplete ?? 0}%` }}
              />
            </div>
          </div>

          {/* Search result info */}
          {search && (
            <p className="text-xs text-slate-400 mb-2">
              {filteredGroups.length === 0
                ? 'No matches found.'
                : `${displayTotals?.routes ?? 0} routes across ${filteredGroups.length} customer${filteredGroups.length !== 1 ? 's' : ''}`
              }
            </p>
          )}

          {/* Company-grouped route list */}
          <div className="space-y-3">
            {filteredGroups.map(group => {
              const isCollapsed = collapsedCompanies.has(group.companyId)
              const groupStops = group.routes.reduce((s, r) => s + r.totalStops, 0)
              const groupServiced = group.routes.reduce((s, r) => s + r.servicedStops, 0)
              const groupPct = groupStops > 0 ? Math.round((groupServiced / groupStops) * 100) : 0

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
                      <span className="text-xs text-slate-400 shrink-0">{group.routes.length} route{group.routes.length !== 1 ? 's' : ''}</span>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      {/* Mini progress */}
                      <div className="hidden sm:flex items-center gap-2">
                        <div className="w-24 h-1.5 bg-slate-200 rounded-full overflow-hidden">
                          <div className={cn('h-full rounded-full', progressColor(groupPct))} style={{ width: `${groupPct}%` }} />
                        </div>
                        <span className={cn('text-xs font-bold', progressTextColor(groupPct))}>{groupPct}%</span>
                      </div>
                      <span className="text-xs text-slate-500">{groupServiced}/{groupStops}</span>
                      {isCollapsed ? <ChevronDown className="w-4 h-4 text-slate-400" /> : <ChevronUp className="w-4 h-4 text-slate-400" />}
                    </div>
                  </button>

                  {/* Routes inside this company */}
                  {!isCollapsed && (
                    <div className="divide-y divide-slate-100">
                      {group.routes.map(route => {
                        const isExpanded = expandedRoute === route.routeId

                        return (
                          <div key={route.routeId}>
                            <button
                              onClick={() => loadRouteDetail(route.routeId)}
                              className="w-full px-4 py-3 text-left hover:bg-slate-50 transition-colors"
                            >
                              <div className="flex items-center justify-between mb-1">
                                <div className="min-w-0">
                                  <span className="font-medium text-slate-900">{route.routeName}</span>
                                  {route.routeNumber && (
                                    <span className="ml-2 text-xs text-slate-400">#{route.routeNumber}</span>
                                  )}
                                </div>
                                <div className="flex items-center gap-2 shrink-0">
                                  {canDispatch && route.remainingStops > 0 && (
                                    <button
                                      onClick={e => { e.stopPropagation(); setGenRoute({ id: route.routeId, name: route.routeName, remaining: route.remainingStops }) }}
                                      className="px-2 py-1 text-[11px] font-medium bg-emerald-100 text-emerald-700 rounded hover:bg-emerald-200 transition-colors flex items-center gap-1"
                                      title="Generate tickets for remaining stops"
                                    >
                                      <Zap className="w-3 h-3" />
                                      Gen
                                    </button>
                                  )}
                                  <span className={cn(
                                    'text-xs font-bold px-2 py-0.5 rounded-full',
                                    route.percentComplete >= 80 ? 'bg-green-100 text-green-700' :
                                    route.percentComplete >= 50 ? 'bg-amber-100 text-amber-700' :
                                    'bg-red-100 text-red-700',
                                  )}>
                                    {route.servicedStops}/{route.totalStops}
                                  </span>
                                  {isExpanded ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
                                </div>
                              </div>

                              <div className="flex items-center gap-3 text-xs text-slate-500">
                                {route.area && <span>{route.area}</span>}
                                <span className="px-1.5 py-0.5 bg-blue-50 text-blue-600 rounded font-medium">
                                  {route.cycleName || (route.cycleMonths === 1 ? 'Monthly' : route.cycleMonths === 3 ? 'Quarterly' : route.cycleMonths === 6 ? 'Semi-annual' : route.cycleMonths === 12 ? 'Annual' : `${route.cycleMonths}mo`)}
                                </span>
                                {route.remainingStops > 0 && (
                                  <span className="text-amber-600 font-medium">{route.remainingStops} left</span>
                                )}
                                {route.lastServiceDate && (
                                  <span className="ml-auto">Last: {daysAgo(route.lastServiceDate)}</span>
                                )}
                              </div>

                              {/* Progress bar */}
                              <div className="w-full h-1.5 bg-slate-100 rounded-full overflow-hidden mt-2">
                                <div
                                  className={cn('h-full rounded-full', progressColor(route.percentComplete))}
                                  style={{ width: `${route.percentComplete}%` }}
                                />
                              </div>
                            </button>

                            {/* Expanded: route detail */}
                            {isExpanded && (
                              <div className="mx-4 mb-3 ml-6 border-l-2 border-blue-200 pl-3 pb-2">
                                {detailLoading ? (
                                  <div className="py-4 flex items-center gap-2 text-sm text-slate-400">
                                    <Loader2 className="w-4 h-4 animate-spin" /> Loading...
                                  </div>
                                ) : detail ? (
                                  <>
                                    {/* Route description */}
                                    {detail.route.description && (
                                      <p className="text-xs text-slate-500 mb-2 italic">{detail.route.description}</p>
                                    )}

                                    {/* Tech breakdown */}
                                    {detail.techBreakdown.length > 0 && (
                                      <div className="bg-slate-50 rounded-lg p-3 mb-2">
                                        <div className="flex items-center gap-1.5 mb-1.5">
                                          <Users className="w-3.5 h-3.5 text-slate-500" />
                                          <span className="text-xs font-semibold text-slate-600">Who's working this</span>
                                        </div>
                                        <div className="flex flex-wrap gap-2">
                                          {detail.techBreakdown.map(t => (
                                            <span key={t.name} className="text-xs px-2 py-0.5 bg-white rounded border border-slate-200">
                                              {t.name}: <span className="font-bold">{t.count}</span>
                                            </span>
                                          ))}
                                        </div>
                                      </div>
                                    )}

                                    {/* Stop sort + list */}
                                    <div className="flex items-center gap-1 mb-1.5">
                                      <ArrowUpDown className="w-3 h-3 text-slate-400" />
                                      <span className="text-[11px] text-slate-400 mr-1">Sort:</span>
                                      {([
                                        { key: 'undone' as const, label: 'Undone first' },
                                        { key: 'alpha' as const, label: 'A-Z' },
                                        { key: 'index' as const, label: 'Route order' },
                                      ]).map(s => (
                                        <button
                                          key={s.key}
                                          onClick={() => setStopSort(s.key)}
                                          className={cn(
                                            'px-2 py-0.5 text-[11px] rounded transition-colors',
                                            stopSort === s.key
                                              ? 'bg-blue-100 text-blue-700 font-semibold'
                                              : 'text-slate-400 hover:text-slate-600',
                                          )}
                                        >
                                          {s.label}
                                        </button>
                                      ))}
                                    </div>
                                    <div className="space-y-0.5">
                                      {[...detail.stops].sort((a, b) => {
                                        if (stopSort === 'undone') {
                                          if (a.isServiced !== b.isServiced) return a.isServiced ? 1 : -1
                                          return a.stopIndex - b.stopIndex
                                        }
                                        if (stopSort === 'alpha') {
                                          const nameA = (a.clientName || stopName(a)).toLowerCase()
                                          const nameB = (b.clientName || stopName(b)).toLowerCase()
                                          return nameA.localeCompare(nameB)
                                        }
                                        return a.stopIndex - b.stopIndex
                                      }).map(stop => (
                                        <div key={stop.stopId}>
                                          <button
                                            onClick={() => setExpandedStop(expandedStop === stop.stopId ? null : stop.stopId)}
                                            className={cn(
                                              'w-full flex items-center gap-2 px-3 py-2 rounded text-left text-xs transition-colors',
                                              stop.isServiced ? 'hover:bg-green-50' : 'hover:bg-red-50 bg-red-50/30',
                                            )}
                                          >
                                            {stop.isServiced ? (
                                              <CheckCircle2 className="w-3.5 h-3.5 text-green-500 shrink-0" />
                                            ) : (
                                              <Clock className="w-3.5 h-3.5 text-red-400 shrink-0" />
                                            )}
                                            <span className={cn(
                                              'font-medium truncate',
                                              stop.isServiced ? 'text-slate-500' : 'text-slate-900',
                                            )}>
                                              {stop.clientName || stopName(stop)}
                                            </span>
                                            {stop.fieldName && (
                                              <span className="text-slate-400 truncate hidden sm:inline">{stop.fieldName}</span>
                                            )}
                                            <span className="ml-auto text-slate-400 shrink-0">
                                              {stop.isServiced ? (
                                                <span className="text-green-600">{daysAgo(stop.lastServiceDate)}</span>
                                              ) : (
                                                <span className="text-red-500 font-medium">Not done</span>
                                              )}
                                            </span>
                                          </button>

                                          {/* Expanded stop: ticket history */}
                                          {expandedStop === stop.stopId && 'tickets' in stop && (stop as any).tickets.length > 0 && (
                                            <div className="ml-8 mb-1 text-[11px] text-slate-400 space-y-0.5">
                                              {(stop as any).tickets.map((t: any) => (
                                                <p key={t.id}>
                                                  {t.ticketNumber} — {formatCalendarDateNumeric(t.serviceDate)}
                                                  {t.techName && <span className="ml-1">({t.techName})</span>}
                                                  {t.serviceSubtype && <span className="ml-1 text-slate-300">{t.serviceSubtype.replace(/_/g, ' ')}</span>}
                                                </p>
                                              ))}
                                            </div>
                                          )}
                                        </div>
                                      ))}
                                    </div>
                                  </>
                                ) : null}
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </>
      )}

      {/* Generate Tickets Modal */}
      {genRoute && (
        <GenerateTicketsModal
          routeId={genRoute.id}
          routeName={genRoute.name}
          remainingStops={genRoute.remaining}
          onClose={() => setGenRoute(null)}
          onGenerated={() => { setGenRoute(null); loadData() }}
        />
      )}
    </div>
  )
}
