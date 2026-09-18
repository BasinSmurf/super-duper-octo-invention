import { useState, useEffect, useCallback } from 'react'
import { api } from '@/lib/api'
import { db } from '@/lib/db'
import { cn } from '@/lib/cn'
import {
  Loader2,
  MapPin,
  Check,
  X,
  ChevronDown,
  ChevronUp,
  Sparkles,
  AlertCircle,
  GitMerge,
} from 'lucide-react'

// ──────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────

interface DmrMatch {
  id: string
  apiNumber: string | null
  wellName: string | null
  wellNameBase: string | null
  operatorName: string | null
  wellType: string | null
  wellStatus: string | null
  county: string | null
  section: number | null
  township: number | null
  range: number | null
  latitude: string | null
  longitude: string | null
  matchScore: number | undefined
}

interface ExistingPadMatch {
  id: string
  name: string
  fieldName: string | null
  currentOperatorName: string | null
  wellCount: number
  isActive: boolean
  manuallyVerified: boolean
  matchScore: number | undefined
  sameField?: boolean
  sameOperator?: boolean
  assetCategory?: string
}

type AssetCategory = 'site' | 'other_mobile'
  | 'gas_plant' | 'tank_battery' | 'compressor_station' | 'swd_facility' | 'office' | 'shop'

const ASSET_CATEGORY_OPTIONS: { value: AssetCategory; label: string }[] = [
  { value: 'site', label: 'Normal pad/site' },
  { value: 'other_mobile', label: 'Other mobile asset (any operator)' },
  { value: 'gas_plant', label: 'Gas plant' },
  { value: 'tank_battery', label: 'Tank battery' },
  { value: 'compressor_station', label: 'Compressor station' },
  { value: 'swd_facility', label: 'SWD facility' },
  { value: 'office', label: 'Office' },
  { value: 'shop', label: 'Shop' },
]

const ASSET_CATEGORY_LABELS: Record<string, string> = Object.fromEntries(
  ASSET_CATEGORY_OPTIONS.map(o => [o.value, o.label.replace(' (any operator)', '')]),
)

interface PendingRequest {
  id: string
  name: string
  field: { id: string; name: string; county: string | null } | null
  currentOperator: { id: string; name: string } | null
  // Customer the request was originally made for (captured at intake from
  // the wizard's selected company). Distinct from currentOperator since the
  // pad's operator may legitimately differ once the approver re-routes it.
  requestedFor?: { id: string; name: string } | null
  section: number | null
  township: number | null
  range: number | null
  latitude: string | null
  longitude: string | null
  directions: string | null
  wells: { id: string; wellName: string | null; apiNumber: string | null }[]
  requestedWellNames: string[]
  requester: { id: string; name: string; email: string | null } | null
  notes: string | null
  createdAt: string
  dmrMatches: DmrMatch[]
  existingPadMatches?: ExistingPadMatch[]
}

interface Company {
  id: string
  name: string
  companyType: string
}

// ──────────────────────────────────────────────────────────────
// Component
// ──────────────────────────────────────────────────────────────

export function LocationRequestsTab() {
  const [requests, setRequests] = useState<PendingRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [companies, setCompanies] = useState<Company[]>([])
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())

  // Per-row selection state: picked dmr ids + picked operator + merge target +
  // submitting state. mergeIntoPadId is mutually exclusive with the DMR /
  // keep-as-manual paths — when set, we route through /resolve's merge mode
  // and tickets attached to the pending pad follow automatically.
  const [picks, setPicks] = useState<Record<string, { dmrIds: Set<string>; operatorId: string; keepAsManual: boolean; mergeIntoPadId: string | null; moveOperator: boolean; assetCategory: AssetCategory }>>({})
  const [busyId, setBusyId] = useState<string | null>(null)
  const [rowError, setRowError] = useState<Record<string, string>>({})

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await api.get<{ data: PendingRequest[]; total: number }>('/locations/requests/pending')
      setRequests(res.data)
      // Initialize per-row picks, auto-expand rows with no matches or with a top match suggestion
      const initPicks: typeof picks = {}
      const initExpanded = new Set<string>()
      for (const r of res.data) {
        initPicks[r.id] = {
          dmrIds: new Set(),
          // Pre-select the operator the request was made for (captured at
          // intake from the wizard's customer) — falls back to the pad's
          // currentOperator if requestedFor wasn't stamped, then empty.
          operatorId: r.requestedFor?.id || r.currentOperator?.id || '',
          keepAsManual: false,
          mergeIntoPadId: null,
          moveOperator: true,
          assetCategory: 'site',
        }
        // Auto-expand small queues to reduce clicks
        if (res.data.length <= 5) initExpanded.add(r.id)
      }
      setPicks(initPicks)
      setExpandedIds(initExpanded)
    } catch (e: any) {
      setError(e?.message || 'Failed to load location requests')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // Load companies (operators) once
  useEffect(() => {
    db.companies
      .filter(c => c.isActive !== false)
      .toArray()
      .then(list => {
        const mapped = list.map(c => ({ id: c.id, name: c.name, companyType: c.companyType }))
        mapped.sort((a, b) => a.name.localeCompare(b.name))
        setCompanies(mapped)
      })
      .catch(() => setCompanies([]))
  }, [])

  function toggleExpand(id: string) {
    setExpandedIds(s => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const blankPick = () => ({ dmrIds: new Set<string>(), operatorId: '', keepAsManual: false, mergeIntoPadId: null as string | null, moveOperator: true, assetCategory: 'site' as const })

  function setRowAssetCategory(reqId: string, assetCategory: AssetCategory) {
    setPicks(p => ({ ...p, [reqId]: { ...(p[reqId] || blankPick()), assetCategory } }))
  }

  function toggleDmrPick(reqId: string, dmrId: string) {
    setPicks(p => {
      const row = p[reqId] || blankPick()
      const nextIds = new Set(row.dmrIds)
      if (nextIds.has(dmrId)) nextIds.delete(dmrId)
      else nextIds.add(dmrId)
      // Picking DMR clears the merge target — they're mutually exclusive paths.
      return { ...p, [reqId]: { ...row, dmrIds: nextIds, keepAsManual: false, mergeIntoPadId: null } }
    })
  }

  function setRowOperator(reqId: string, operatorId: string) {
    setPicks(p => ({ ...p, [reqId]: { ...(p[reqId] || blankPick()), operatorId } }))
  }

  function toggleKeepAsManual(reqId: string) {
    setPicks(p => {
      const row = p[reqId] || blankPick()
      return { ...p, [reqId]: { ...row, keepAsManual: !row.keepAsManual, dmrIds: row.keepAsManual ? row.dmrIds : new Set(), mergeIntoPadId: null } }
    })
  }

  function setMergeTarget(reqId: string, padId: string | null) {
    setPicks(p => {
      const row = p[reqId] || blankPick()
      // Picking a merge target clears DMR + manual — they're mutually exclusive.
      return { ...p, [reqId]: { ...row, mergeIntoPadId: padId, dmrIds: new Set(), keepAsManual: false } }
    })
  }

  function toggleMoveOperator(reqId: string) {
    setPicks(p => {
      const row = p[reqId] || blankPick()
      return { ...p, [reqId]: { ...row, moveOperator: !row.moveOperator } }
    })
  }

  async function resolveRow(r: PendingRequest) {
    const pick = picks[r.id]
    if (!pick) return
    if (pick.dmrIds.size === 0 && !pick.keepAsManual && !pick.mergeIntoPadId) {
      setRowError(m => ({ ...m, [r.id]: 'Pick at least one DMR match, "Keep as manual", or a merge target.' }))
      return
    }
    // Force DMR/API matching: keeping a location manual while the server
    // already surfaced DMR/API matches for it needs an explicit "yes, I
    // checked, it's not one of these" — not a silent skip. The matches are
    // right there in the expanded view, so ask before firing the request
    // rather than round-tripping a 409 for the common case.
    if (pick.keepAsManual && !pick.mergeIntoPadId && r.dmrMatches.length > 0) {
      const names = r.dmrMatches.slice(0, 5).map(m => m.wellName || m.apiNumber || '(unnamed)').join(', ')
      if (!window.confirm(
        `${r.dmrMatches.length} DMR/API match${r.dmrMatches.length === 1 ? '' : 'es'} found for "${r.name}":\n\n${names}\n\nKeep this manual anyway?`,
      )) return
    }
    setBusyId(r.id)
    setRowError(m => ({ ...m, [r.id]: '' }))
    try {
      const body: Record<string, unknown> = {}
      if (pick.assetCategory !== 'site') body.assetCategory = pick.assetCategory
      if (pick.mergeIntoPadId) {
        body.mergeIntoPadId = pick.mergeIntoPadId
        // Buyout case: merging into a pad owned by a different operator than the
        // request was for — move the winner's operator too (if the approver left
        // the option on). Server no-ops if it already matches.
        const target = r.existingPadMatches?.find(m => m.id === pick.mergeIntoPadId)
        if (pick.moveOperator && target && !target.sameOperator && r.requestedFor) {
          body.operatorCompanyId = r.requestedFor.id
        }
      } else {
        body.dmrWellIds = Array.from(pick.dmrIds)
        body.operatorCompanyId = pick.operatorId || undefined
        body.keepAsManual = pick.keepAsManual
        // Already confirmed above against our copy of dmrMatches — this
        // covers it. The server recomputes independently and will still 409
        // (caught below) if its fresher copy disagrees, e.g. the queue was
        // left open long enough for a new DMR import to add a match.
        if (pick.keepAsManual) body.overrideDmrMatch = true
      }
      await api.post(`/locations/requests/${r.id}/resolve`, body)
      // Remove row from list
      setRequests(cur => cur.filter(x => x.id !== r.id))
    } catch (e: any) {
      // A 409 here means the server's own recheck disagrees with what this
      // page loaded with (e.g. a new DMR import landed a match while the
      // queue sat open) — its message already explains that; refreshing
      // picks up the fresher dmrMatches.
      setRowError(m => ({ ...m, [r.id]: e?.message || 'Resolve failed' }))
    } finally {
      setBusyId(null)
    }
  }

  // One-click: activate the single best DMR candidate onto this pending pad and
  // drop it from the queue — no expand/pick needed for the common clean match.
  // Operator defaults to the request's intended customer (then the pad's current
  // operator). Falls through to the manual picker below for anything ambiguous.
  async function activateBestMatch(r: PendingRequest) {
    if (r.dmrMatches.length === 0) return
    const best = [...r.dmrMatches].sort((a, b) => (a.matchScore ?? 1) - (b.matchScore ?? 1))[0]
    const pick = picks[r.id]
    const operatorCompanyId = pick?.operatorId || r.requestedFor?.id || r.currentOperator?.id || undefined
    setBusyId(r.id)
    setRowError(m => ({ ...m, [r.id]: '' }))
    try {
      await api.post(`/locations/requests/${r.id}/resolve`, {
        dmrWellIds: [best.id],
        operatorCompanyId,
        keepAsManual: false,
      })
      setRequests(cur => cur.filter(x => x.id !== r.id))
    } catch (e: any) {
      setRowError(m => ({ ...m, [r.id]: e?.message || 'Activate failed' }))
    } finally {
      setBusyId(null)
    }
  }

  async function rejectRow(r: PendingRequest) {
    const reason = window.prompt('Reject reason (optional):') ?? ''
    if (reason === null) return // shouldn't happen; prompt returns null on cancel
    if (!window.confirm(`Reject this location request?\n\n"${r.name}"\n\nAny tickets on it will be kept but flagged "Needs location" on the dispatch board until a real location is assigned.`)) return
    setBusyId(r.id)
    setRowError(m => ({ ...m, [r.id]: '' }))
    try {
      const res = await api.post<{ detachedTickets?: number }>(`/locations/requests/${r.id}/reject`, { reason: reason || undefined })
      if (res.detachedTickets && res.detachedTickets > 0) {
        window.alert(`${res.detachedTickets} ticket${res.detachedTickets === 1 ? '' : 's'} detached and flagged "Needs location" on the dispatch board.`)
      }
      setRequests(cur => cur.filter(x => x.id !== r.id))
    } catch (e: any) {
      setRowError(m => ({ ...m, [r.id]: e?.message || 'Reject failed' }))
    } finally {
      setBusyId(null)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-slate-400">
        <Loader2 className="w-5 h-5 animate-spin mr-2" />
        Loading pending location requests...
      </div>
    )
  }

  if (error) {
    return (
      <div className="bg-rose-50 border border-rose-200 text-rose-700 rounded-lg p-4 text-sm">
        {error}
      </div>
    )
  }

  if (requests.length === 0) {
    return (
      <div className="text-center py-12 text-slate-400">
        <MapPin className="w-10 h-10 mx-auto mb-3 text-slate-300" />
        <p className="text-sm">No pending location requests. 🎉</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-600">
          <span className="font-semibold">{requests.length}</span> location request{requests.length === 1 ? '' : 's'} pending review
        </p>
        <button
          type="button"
          onClick={load}
          className="text-xs text-blue-600 hover:text-blue-800 font-medium"
        >
          Refresh
        </button>
      </div>

      <div className="space-y-2">
        {requests.map(r => {
          const pick = picks[r.id] || blankPick()
          const expanded = expandedIds.has(r.id)
          const pickCount = pick.dmrIds.size
          const busy = busyId === r.id
          return (
            <div key={r.id} className="border border-amber-200 bg-white rounded-lg overflow-hidden">
              {/* ---- Row header ---- */}
              <button
                type="button"
                onClick={() => toggleExpand(r.id)}
                className="w-full flex items-center gap-3 p-3 hover:bg-amber-50 text-left"
              >
                <MapPin className="w-4 h-4 text-amber-600 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-slate-900 truncate">{r.name}</span>
                    <span className="text-xs text-slate-500">
                      {r.field?.name || '—'}
                      {r.field?.county ? ` · ${r.field.county}` : ''}
                    </span>
                    {r.section !== null && (
                      <span className="text-[11px] text-slate-400">
                        S{r.section}/T{r.township}/R{r.range}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-slate-500 mt-0.5">
                    {r.requester ? `Requested by ${r.requester.name}` : 'Requester unknown'}
                    {r.requestedFor && ` for ${r.requestedFor.name}`}
                    {r.requestedWellNames.length > 0 && ` · wells: ${r.requestedWellNames.join(', ')}`}
                    {' · '}
                    {new Date(r.createdAt).toLocaleDateString()}
                  </div>
                </div>
                <div className="shrink-0 flex items-center gap-2">
                  {r.dmrMatches.length > 0 ? (
                    <span className="text-[11px] font-medium text-amber-700 bg-amber-100 rounded px-2 py-0.5 inline-flex items-center gap-1">
                      <Sparkles className="w-3 h-3" />
                      {r.dmrMatches.length} DMR match{r.dmrMatches.length === 1 ? '' : 'es'}
                    </span>
                  ) : (
                    <span className="text-[11px] text-slate-400">No DMR matches</span>
                  )}
                  {pickCount > 0 && (
                    <span className="text-[11px] font-medium text-emerald-700 bg-emerald-100 rounded px-2 py-0.5">
                      {pickCount} picked
                    </span>
                  )}
                  {expanded ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
                </div>
              </button>

              {/* ---- One-click best-match activate (no expand needed) ---- */}
              {r.dmrMatches.length > 0 && pick.mergeIntoPadId === null && (
                <div className="flex items-center gap-2 px-3 py-2 border-t border-amber-100 bg-amber-50/40 flex-wrap">
                  <button
                    type="button"
                    onClick={() => activateBestMatch(r)}
                    disabled={busy}
                    className="text-xs font-medium text-emerald-700 bg-emerald-100 hover:bg-emerald-200 rounded px-2.5 py-1 inline-flex items-center gap-1 disabled:opacity-50"
                  >
                    {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                    Activate best match
                  </button>
                  <span className="text-[11px] text-slate-500 truncate min-w-0">
                    {(() => {
                      const best = [...r.dmrMatches].sort((a, b) => (a.matchScore ?? 1) - (b.matchScore ?? 1))[0]
                      const op = pick.operatorId
                        ? companies.find(c => c.id === pick.operatorId)?.name
                        : r.requestedFor?.name || r.currentOperator?.name
                      return `${best.wellName || best.apiNumber || 'top candidate'} → ${op || 'no operator'}`
                    })()}
                  </span>
                  {rowError[r.id] && <span className="text-[11px] text-red-600">{rowError[r.id]}</span>}
                </div>
              )}

              {/* ---- Expanded detail ---- */}
              {expanded && (
                <div className="border-t border-amber-200 p-3 bg-slate-50 space-y-3">
                  {r.notes && (
                    <div className="text-xs text-slate-600 bg-white border border-slate-200 rounded px-2 py-1.5">
                      <span className="font-medium text-slate-500">Notes: </span>{r.notes}
                    </div>
                  )}

                  {/* Existing-pad matches — surface near-duplicates so the
                      approver can merge instead of activating a duplicate. */}
                  {r.existingPadMatches && r.existingPadMatches.length > 0 && (
                    <div>
                      <p className="text-xs font-medium text-slate-600 mb-1.5 flex items-center gap-1">
                        <GitMerge className="w-3.5 h-3.5 text-blue-600" />
                        Possible duplicates of existing pads
                      </p>
                      <div className="space-y-1">
                        {r.existingPadMatches.map(m => {
                          const picked = pick.mergeIntoPadId === m.id
                          return (
                            <button
                              key={m.id}
                              type="button"
                              onClick={() => setMergeTarget(r.id, picked ? null : m.id)}
                              className={cn(
                                'w-full text-left p-2 rounded border-2 transition-colors text-xs flex items-center gap-2',
                                picked
                                  ? 'border-blue-400 bg-blue-50'
                                  : 'border-slate-200 bg-white hover:border-blue-300',
                              )}
                            >
                              <div className={cn(
                                'w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0',
                                picked ? 'border-blue-500 bg-blue-500' : 'border-slate-300',
                              )}>
                                {picked && <Check className="w-3 h-3 text-white" />}
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="font-medium text-slate-900 flex items-center gap-1.5 flex-wrap">
                                  <span>{m.name}</span>
                                  {m.assetCategory && m.assetCategory !== 'site' && (
                                    <span className="text-[10px] uppercase tracking-wide font-semibold px-1 py-0.5 rounded bg-purple-100 text-purple-700">
                                      known {ASSET_CATEGORY_LABELS[m.assetCategory] || m.assetCategory}
                                    </span>
                                  )}
                                  {m.sameOperator && (
                                    <span className="text-[10px] uppercase tracking-wide font-semibold px-1 py-0.5 rounded bg-blue-100 text-blue-700">same operator</span>
                                  )}
                                  {m.sameField && !m.sameOperator && (
                                    <span className="text-[10px] uppercase tracking-wide font-semibold px-1 py-0.5 rounded bg-slate-100 text-slate-600">same field</span>
                                  )}
                                  {m.manuallyVerified && (
                                    <span className="text-[10px] uppercase tracking-wide font-semibold text-emerald-700">verified</span>
                                  )}
                                </div>
                                <div className="text-slate-500">
                                  {m.fieldName || '—'}
                                  {m.currentOperatorName && ` · ${m.currentOperatorName}`}
                                  {` · ${m.wellCount} well${m.wellCount === 1 ? '' : 's'}`}
                                </div>
                              </div>
                              {typeof m.matchScore === 'number' && (
                                <span className="text-[10px] text-slate-400 shrink-0">
                                  {(1 - m.matchScore).toFixed(2)}
                                </span>
                              )}
                            </button>
                          )
                        })}
                      </div>
                      {pick.mergeIntoPadId && (() => {
                        const target = r.existingPadMatches!.find(m => m.id === pick.mergeIntoPadId)
                        const crossOperator = !!target && !target.sameOperator && !!r.requestedFor
                        return (
                          <>
                            <p className="mt-1.5 text-[11px] text-blue-700">
                              On approve: tickets, wells, and other records on this pending pad will move to the selected pad. The pending pad will be deactivated.
                            </p>
                            {crossOperator && (
                              <label className="mt-1.5 flex items-start gap-2 text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1.5 cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={pick.moveOperator}
                                  onChange={() => toggleMoveOperator(r.id)}
                                  className="mt-0.5 rounded"
                                />
                                <span>
                                  Also move this pad from <b>{target!.currentOperatorName || 'its current operator'}</b> to <b>{r.requestedFor!.name}</b> (buyout).
                                  Updates the pad + its {target!.wellCount} well{target!.wellCount === 1 ? '' : 's'} with operator history.
                                </span>
                              </label>
                            )}
                          </>
                        )
                      })()}
                    </div>
                  )}

                  {/* DMR matches list */}
                  {r.dmrMatches.length > 0 && (
                    <div>
                      <p className="text-xs font-medium text-slate-600 mb-1.5">Suggested DMR wells</p>
                      <div className="space-y-1">
                        {r.dmrMatches.map(m => {
                          const picked = pick.dmrIds.has(m.id)
                          return (
                            <button
                              key={m.id}
                              type="button"
                              onClick={() => toggleDmrPick(r.id, m.id)}
                              className={cn(
                                'w-full text-left p-2 rounded border-2 transition-colors text-xs flex items-center gap-2',
                                picked
                                  ? 'border-emerald-400 bg-emerald-50'
                                  : 'border-slate-200 bg-white hover:border-emerald-300',
                              )}
                            >
                              <div className={cn(
                                'w-4 h-4 rounded border-2 flex items-center justify-center shrink-0',
                                picked ? 'border-emerald-500 bg-emerald-500' : 'border-slate-300',
                              )}>
                                {picked && <Check className="w-3 h-3 text-white" />}
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="font-medium text-slate-900">
                                  {m.wellName || '—'}{m.apiNumber ? ` · API ${m.apiNumber}` : ''}
                                </div>
                                <div className="text-slate-500">
                                  {m.operatorName || '—'}
                                  {m.wellType && ` · ${m.wellType}`}
                                  {m.wellStatus && ` · ${m.wellStatus}`}
                                  {m.county && ` · ${m.county}`}
                                  {m.section !== null && ` · S${m.section}/T${m.township}/R${m.range}`}
                                </div>
                              </div>
                              {typeof m.matchScore === 'number' && (
                                <span className="text-[10px] text-slate-400 shrink-0">
                                  {(1 - m.matchScore).toFixed(2)}
                                </span>
                              )}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  )}

                  {/* Operator + keep-as-manual */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1">Operator</label>
                      <select
                        value={pick.operatorId}
                        onChange={e => setRowOperator(r.id, e.target.value)}
                        className="w-full px-2 py-1.5 text-sm border border-slate-300 rounded bg-white"
                      >
                        <option value="">— No operator —</option>
                        {companies.map(c => (
                          <option key={c.id} value={c.id}>{c.name}</option>
                        ))}
                      </select>
                    </div>
                    <div className="flex items-end">
                      <label className="inline-flex items-center gap-2 text-xs text-slate-600 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={pick.keepAsManual}
                          onChange={() => toggleKeepAsManual(r.id)}
                          className="w-4 h-4 accent-amber-600"
                        />
                        Keep as manual (not in DMR)
                      </label>
                    </div>
                  </div>

                  {(pick.keepAsManual || pick.mergeIntoPadId) && (
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1">
                        {pick.mergeIntoPadId ? 'Asset type (applies to the pad you\'re merging into)' : 'Asset type'}
                      </label>
                      <select
                        value={pick.assetCategory}
                        onChange={e => setRowAssetCategory(r.id, e.target.value as any)}
                        className="w-full px-2 py-1.5 text-sm border border-slate-300 rounded bg-white"
                      >
                        {ASSET_CATEGORY_OPTIONS.map(o => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                      </select>
                      {pick.assetCategory !== 'site' && (
                        <p className="mt-1 text-[11px] text-slate-500">
                          Flagged as a mobile asset — future requests for this same name will
                          match it under ANY operator/field instead of creating a duplicate.
                        </p>
                      )}
                    </div>
                  )}

                  {rowError[r.id] && (
                    <div className="text-xs text-rose-600 bg-rose-50 border border-rose-200 rounded px-2 py-1.5 flex items-center gap-1">
                      <AlertCircle className="w-3.5 h-3.5" />
                      {rowError[r.id]}
                    </div>
                  )}

                  {/* Actions */}
                  <div className="flex gap-2 justify-end pt-1">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => rejectRow(r)}
                      className="px-3 py-1.5 text-xs font-medium rounded border border-slate-300 text-slate-700 hover:bg-slate-100 disabled:opacity-50 inline-flex items-center gap-1"
                    >
                      <X className="w-3.5 h-3.5" /> Reject
                    </button>
                    <button
                      type="button"
                      disabled={busy || (pick.dmrIds.size === 0 && !pick.keepAsManual && !pick.mergeIntoPadId)}
                      onClick={() => resolveRow(r)}
                      className={cn(
                        'px-3 py-1.5 text-xs font-medium rounded text-white disabled:opacity-50 inline-flex items-center gap-1',
                        pick.mergeIntoPadId ? 'bg-blue-600 hover:bg-blue-500' : 'bg-emerald-600 hover:bg-emerald-500',
                      )}
                    >
                      {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : pick.mergeIntoPadId ? <GitMerge className="w-3.5 h-3.5" /> : <Check className="w-3.5 h-3.5" />}
                      {pick.mergeIntoPadId
                        ? 'Merge into selected pad'
                        : pick.keepAsManual
                          ? 'Approve (manual)'
                          : `Approve${pick.dmrIds.size > 0 ? ` — create ${pick.dmrIds.size} well${pick.dmrIds.size === 1 ? '' : 's'}` : ''}`}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
