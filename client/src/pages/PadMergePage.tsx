import { useState, useEffect, useCallback } from 'react'
import { api } from '@/lib/api'
import { cn } from '@/lib/cn'
import {
  Merge,
  ChevronDown,
  ChevronUp,
  CheckCircle,
  AlertTriangle,
  Crown,
  Trash2,
  Loader2,
  Search,
  MapPin,
  X,
  Undo2,
  Droplets,
  Wind,
  FileText,
  Wrench,
} from 'lucide-react'

// ---- Types ----
interface PadInfo {
  id: string
  name: string
  fieldName: string | null
  azureLocationId: number | null
  wells: number
  workPoints: number
  tickets: number
  equipment: number
}

interface DupeGroup {
  groupKey: string
  operator: string
  operatorId: string | null
  pads: PadInfo[]
  totalWells: number
  totalWorkPoints: number
}

interface MergeResult {
  message: string
  winner: { id: string; name: string }
  moved: Record<string, number>
}

export function PadMergePage() {
  const [groups, setGroups] = useState<DupeGroup[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [expandedKey, setExpandedKey] = useState<string | null>(null)
  const [selectedWinners, setSelectedWinners] = useState<Map<string, string>>(new Map())
  const [merging, setMerging] = useState<string | null>(null)
  const [mergeResults, setMergeResults] = useState<Map<string, MergeResult>>(new Map())
  const [dismissedGroups, setDismissedGroups] = useState<Set<string>>(new Set())
  const [excludedPads, setExcludedPads] = useState<Map<string, Set<string>>>(new Map())

  function toggleExclude(groupKey: string, padId: string) {
    setExcludedPads(prev => {
      const next = new Map(prev)
      const set = new Set(next.get(groupKey) || [])
      if (set.has(padId)) set.delete(padId)
      else set.add(padId)
      next.set(groupKey, set)
      return next
    })
    // If excluded pad was the selected winner, clear selection so auto-select picks again
    setSelectedWinners(prev => {
      if (prev.get(groupKey) !== padId) return prev
      const next = new Map(prev)
      next.delete(groupKey)
      return next
    })
  }

  const loadGroups = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await api.get<{ data: DupeGroup[]; total: number }>('/locations/pad-duplicates')
      setGroups(res.data || [])
    } catch (e: any) {
      setError(e.message || 'Failed to load duplicates')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadGroups() }, [loadGroups])

  function toggleExpand(key: string) {
    setExpandedKey(prev => prev === key ? null : key)
  }

  function selectWinner(groupKey: string, padId: string) {
    setSelectedWinners(prev => {
      const next = new Map(prev)
      next.set(groupKey, padId)
      return next
    })
  }

  /** Auto-select the "best" pad as winner: most wells, then most WPs */
  function autoSelectWinner(group: DupeGroup): string {
    const excluded = excludedPads.get(group.groupKey) || new Set()
    const candidates = group.pads.filter(p => !excluded.has(p.id))
    if (candidates.length === 0) return group.pads[0].id
    const sorted = [...candidates].sort((a, b) => {
      const aScore = a.wells * 100 + a.workPoints * 10 + a.tickets + a.equipment
      const bScore = b.wells * 100 + b.workPoints * 10 + b.tickets + b.equipment
      return bScore - aScore
    })
    return sorted[0].id
  }

  async function doMerge(group: DupeGroup) {
    const winnerId = selectedWinners.get(group.groupKey) || autoSelectWinner(group)
    const excluded = excludedPads.get(group.groupKey) || new Set()
    const loserIds = group.pads.filter(p => p.id !== winnerId && !excluded.has(p.id)).map(p => p.id)

    if (loserIds.length === 0) return

    setMerging(group.groupKey)
    try {
      const result = await api.post<MergeResult>('/locations/pads/merge', { winnerId, loserIds })
      setMergeResults(prev => {
        const next = new Map(prev)
        next.set(group.groupKey, result)
        return next
      })
      // Remove the group from the list after successful merge
      setGroups(prev => prev.filter(g => g.groupKey !== group.groupKey))
    } catch (e: any) {
      setError('Merge failed: ' + (e.message || 'Unknown error'))
    } finally {
      setMerging(null)
    }
  }

  function dismissGroup(key: string) {
    setDismissedGroups(prev => new Set([...prev, key]))
  }

  // Filter
  const q = search.toLowerCase().trim()
  const filtered = groups.filter(g => {
    if (dismissedGroups.has(g.groupKey)) return false
    if (!q) return true
    return g.operator.toLowerCase().includes(q) ||
           g.pads.some(p => p.name.toLowerCase().includes(q))
  })

  const mergedCount = mergeResults.size
  const remainingCount = filtered.length

  return (
    <div className="max-w-4xl mx-auto px-4 py-6 space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Merge className="w-6 h-6 text-blue-600" />
          Merge Duplicate Pads
        </h1>
        <p className="text-sm text-gray-500 mt-1">
          Pads with similar names under the same operator. Pick the winner, merge the rest.
        </p>
      </div>

      {/* Stats bar */}
      <div className="flex items-center gap-4 text-sm">
        {mergedCount > 0 && (
          <span className="inline-flex items-center gap-1 text-green-700 bg-green-50 px-3 py-1 rounded-full">
            <CheckCircle className="w-4 h-4" /> {mergedCount} merged
          </span>
        )}
        <span className="text-gray-500">
          {remainingCount} group{remainingCount !== 1 ? 's' : ''} remaining
        </span>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Filter by pad name or operator..."
          className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
        />
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
          {error}
          <button onClick={() => setError(null)} className="ml-2 underline">dismiss</button>
        </div>
      )}

      {loading && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-blue-500" />
          <span className="ml-2 text-gray-500">Loading duplicates...</span>
        </div>
      )}

      {/* Group list */}
      {!loading && filtered.length === 0 && (
        <div className="text-center py-12 text-gray-400">
          <CheckCircle className="w-12 h-12 mx-auto mb-3 text-green-400" />
          <p className="text-lg font-medium text-green-600">All clean!</p>
          <p className="text-sm">No duplicate pad groups found{search ? ' matching your search' : ''}.</p>
        </div>
      )}

      <div className="space-y-3">
        {filtered.map(group => {
          const isExpanded = expandedKey === group.groupKey
          const winnerId = selectedWinners.get(group.groupKey) || autoSelectWinner(group)
          const isMerging = merging === group.groupKey
          const result = mergeResults.get(group.groupKey)

          return (
            <div key={group.groupKey} className="border border-gray-200 rounded-lg bg-white shadow-sm overflow-hidden">
              {/* Group header */}
              <button
                onClick={() => toggleExpand(group.groupKey)}
                className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-gray-50 transition-colors"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0" />
                    <span className="font-medium text-sm truncate">
                      {group.pads[0].name}
                    </span>
                    <span className="text-xs text-gray-400 flex-shrink-0">
                      +{group.pads.length - 1} dupe{group.pads.length > 2 ? 's' : ''}
                    </span>
                  </div>
                  <div className="text-xs text-gray-500 mt-0.5 flex items-center gap-3">
                    <span>{group.operator}</span>
                    <span className="flex items-center gap-1"><Droplets className="w-3 h-3" />{group.totalWells} wells</span>
                    <span className="flex items-center gap-1"><Wind className="w-3 h-3" />{group.totalWorkPoints} WPs</span>
                  </div>
                </div>
                {isExpanded ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
              </button>

              {/* Expanded detail */}
              {isExpanded && (
                <div className="border-t border-gray-100 px-4 py-3 space-y-3">
                  <p className="text-xs text-gray-500">Click a pad to make it the merge winner (gets all data). Use the × to exclude a pad from the merge (e.g. different physical location).</p>

                  {group.pads.map(pad => {
                    const excludedSet = excludedPads.get(group.groupKey) || new Set()
                    const isExcluded = excludedSet.has(pad.id)
                    const isWinner = !isExcluded && pad.id === winnerId
                    const hasData = pad.wells > 0 || pad.workPoints > 0 || pad.tickets > 0 || pad.equipment > 0

                    return (
                      <div
                        key={pad.id}
                        className={cn(
                          'w-full flex items-stretch rounded-lg border-2 transition-all overflow-hidden',
                          isExcluded
                            ? 'border-gray-200 bg-gray-50 opacity-60'
                            : isWinner
                              ? 'border-blue-500 bg-blue-50'
                              : hasData
                                ? 'border-gray-200 bg-white hover:border-gray-300'
                                : 'border-gray-100 bg-gray-50 hover:border-gray-200'
                        )}
                      >
                        <button
                          type="button"
                          onClick={() => !isExcluded && selectWinner(group.groupKey, pad.id)}
                          disabled={isExcluded}
                          className="flex-1 text-left px-3 py-2.5 min-w-0"
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            {isWinner && <Crown className="w-4 h-4 text-blue-600 flex-shrink-0" />}
                            {!isWinner && !isExcluded && !hasData && <Trash2 className="w-3.5 h-3.5 text-gray-300 flex-shrink-0" />}
                            <span className={cn(
                              'text-sm font-medium truncate',
                              isExcluded ? 'text-gray-500 line-through' : isWinner ? 'text-blue-700' : 'text-gray-700'
                            )}>
                              {pad.name}
                            </span>
                            {isWinner && <span className="text-xs bg-blue-200 text-blue-800 px-1.5 py-0.5 rounded font-medium flex-shrink-0">WINNER</span>}
                            {isExcluded && <span className="text-xs bg-gray-200 text-gray-600 px-1.5 py-0.5 rounded font-medium flex-shrink-0">EXCLUDED</span>}
                          </div>
                          <div className="flex items-center gap-3 mt-1 text-xs text-gray-500 ml-6">
                            {pad.fieldName && <span className="flex items-center gap-1"><MapPin className="w-3 h-3" />{pad.fieldName}</span>}
                            <span className="flex items-center gap-1"><Droplets className="w-3 h-3" />{pad.wells} wells</span>
                            <span className="flex items-center gap-1"><Wind className="w-3 h-3" />{pad.workPoints} WPs</span>
                            {pad.tickets > 0 && <span className="flex items-center gap-1"><FileText className="w-3 h-3" />{pad.tickets} tickets</span>}
                            {pad.equipment > 0 && <span className="flex items-center gap-1"><Wrench className="w-3 h-3" />{pad.equipment} equip</span>}
                            {pad.azureLocationId && <span className="text-gray-400">azLoc #{pad.azureLocationId}</span>}
                          </div>
                        </button>
                        <button
                          type="button"
                          onClick={() => toggleExclude(group.groupKey, pad.id)}
                          title={isExcluded ? 'Include in merge' : 'Exclude from merge (leave as separate pad)'}
                          className={cn(
                            'px-3 flex items-center justify-center border-l',
                            isExcluded
                              ? 'text-blue-600 hover:bg-blue-50 border-gray-200'
                              : 'text-gray-400 hover:text-red-600 hover:bg-red-50 border-gray-100'
                          )}
                        >
                          {isExcluded ? <Undo2 className="w-4 h-4" /> : <X className="w-4 h-4" />}
                        </button>
                      </div>
                    )
                  })}

                  {/* Action buttons */}
                  <div className="flex items-center gap-2 pt-2">
                    {(() => {
                      const excluded = excludedPads.get(group.groupKey) || new Set()
                      const mergeable = group.pads.filter(p => !excluded.has(p.id))
                      const canMerge = mergeable.length >= 2
                      return (
                        <button
                          onClick={() => doMerge(group)}
                          disabled={isMerging || !canMerge}
                          title={!canMerge ? 'Need at least 2 pads to merge — un-exclude one' : undefined}
                          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                        >
                          {isMerging
                            ? <><Loader2 className="w-4 h-4 animate-spin" /> Merging...</>
                            : <><Merge className="w-4 h-4" /> Merge {mergeable.length} into {group.pads.find(p => p.id === winnerId)?.name}</>
                          }
                        </button>
                      )
                    })()}
                    <button
                      onClick={() => dismissGroup(group.groupKey)}
                      className="px-3 py-2 text-sm text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
                    >
                      Skip
                    </button>
                  </div>

                  {result && (
                    <div className="bg-green-50 border border-green-200 text-green-700 px-3 py-2 rounded-lg text-xs">
                      <CheckCircle className="w-4 h-4 inline mr-1" />
                      {result.message} — Moved: {Object.entries(result.moved).filter(([,v]) => v > 0).map(([k,v]) => `${v} ${k}`).join(', ')}
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
