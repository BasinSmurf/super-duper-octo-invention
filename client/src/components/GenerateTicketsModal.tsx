import { useState, useEffect, useMemo } from 'react'
import { api } from '@/lib/api'
import { cn } from '@/lib/cn'
import { todayKey } from '@/lib/dates'
import { X, Loader2, CheckCircle2, Zap, CheckSquare, Square, Search } from 'lucide-react'

interface Tech {
  id: string
  name: string
  role: string
}

interface RouteStop {
  stopId: string
  stopIndex: number
  padId: string | null
  padName: string
  /** Well name when the stop IS a well, else the pad name. Prefer for display. */
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

interface RouteDetailResponse {
  route: { id: string; name: string; companyName: string }
  totalStops: number
  servicedStops: number
  remainingStops: number
  stops: Array<RouteStop & { notes: string | null; afeNumber: string | null }>
}

interface GenerateResult {
  created: number
  cycleName: string
  assignedTech: string
  tickets: Array<{ id: string; ticketNumber: string; location: string }>
}

interface Props {
  routeId: string
  routeName: string
  remainingStops?: number
  onClose: () => void
  onGenerated: () => void
}

export function GenerateTicketsModal({ routeId, routeName, remainingStops: _remainingStops, onClose, onGenerated }: Props) {
  const [techs, setTechs] = useState<Tech[]>([])
  const [stops, setStops] = useState<RouteDetailResponse['stops']>([])
  const [stopsLoading, setStopsLoading] = useState(true)
  const [selectedStopIds, setSelectedStopIds] = useState<Set<string>>(new Set())
  const [selectedTechId, setSelectedTechId] = useState('')
  const [serviceDate, setServiceDate] = useState(() => todayKey())
  const [dispatchNotes, setDispatchNotes] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<GenerateResult | null>(null)
  const [error, setError] = useState('')
  const [stopSearch, setStopSearch] = useState('')

  // Load techs + route stops
  useEffect(() => {
    api.get<{ data: Tech[] }>('/routes/techs')
      .then(res => setTechs(res.data))
      .catch(() => {})

    setStopsLoading(true)
    api.get<RouteDetailResponse>(`/coverage/routes/${routeId}`)
      .then(res => {
        setStops(res.stops)
        // Pre-select all undone stops
        const undone = new Set(res.stops.filter(s => !s.isServiced).map(s => s.stopId))
        setSelectedStopIds(undone)
      })
      .catch(() => {})
      .finally(() => setStopsLoading(false))
  }, [routeId])

  // Derived
  const undoneStops = useMemo(() => stops.filter(s => !s.isServiced), [stops])
  const doneStops = useMemo(() => stops.filter(s => s.isServiced), [stops])

  const filteredUndone = useMemo(() => {
    if (!stopSearch.trim()) return undoneStops
    const q = stopSearch.toLowerCase()
    return undoneStops.filter(s =>
      (s.clientName || s.locationName || s.padName).toLowerCase().includes(q) ||
      s.fieldName?.toLowerCase().includes(q)
    )
  }, [undoneStops, stopSearch])

  // Selection helpers
  function toggleStop(stopId: string) {
    setSelectedStopIds(prev => {
      const next = new Set(prev)
      next.has(stopId) ? next.delete(stopId) : next.add(stopId)
      return next
    })
  }

  function selectAll() {
    setSelectedStopIds(new Set(undoneStops.map(s => s.stopId)))
  }

  function selectNone() {
    setSelectedStopIds(new Set())
  }

  function selectFiltered() {
    setSelectedStopIds(prev => {
      const next = new Set(prev)
      filteredUndone.forEach(s => next.add(s.stopId))
      return next
    })
  }

  const selectedCount = selectedStopIds.size
  const allUndoneSelected = undoneStops.length > 0 && undoneStops.every(s => selectedStopIds.has(s.stopId))

  async function handleGenerate() {
    if (!selectedTechId) {
      setError('Please select a tech')
      return
    }
    if (selectedCount === 0) {
      setError('Please select at least one stop')
      return
    }
    setError('')
    setSubmitting(true)
    try {
      // If all undone are selected, don't send stopIds (generate all)
      const payload: any = {
        assignedTechId: selectedTechId,
        serviceDate,
        dispatchNotes: dispatchNotes || undefined,
      }
      if (!allUndoneSelected) {
        payload.stopIds = Array.from(selectedStopIds)
      }
      const res = await api.post<GenerateResult>(`/coverage/routes/${routeId}/generate-tickets`, payload)
      setResult(res)
    } catch (err: any) {
      setError(err.message || 'Failed to generate tickets')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-xl w-full max-w-lg mx-4 max-h-[90vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 shrink-0">
          <div>
            <h2 className="text-lg font-bold text-slate-900">Generate Tickets</h2>
            <p className="text-sm text-slate-500">{routeName}</p>
          </div>
          <button onClick={onClose} className="p-1 text-slate-400 hover:text-slate-600 rounded-lg hover:bg-slate-100">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content — scrollable */}
        <div className="px-5 py-4 space-y-4 overflow-y-auto flex-1 min-h-0">
          {result ? (
            // Success state
            <div className="text-center py-4">
              <CheckCircle2 className="w-12 h-12 text-green-500 mx-auto mb-3" />
              <p className="text-lg font-bold text-slate-900 mb-1">
                {result.created} ticket{result.created !== 1 ? 's' : ''} created
              </p>
              <p className="text-sm text-slate-500 mb-4">
                Assigned to {result.assignedTech} for {result.cycleName}
              </p>
              <div className="max-h-40 overflow-y-auto bg-slate-50 rounded-lg p-3 text-left">
                {result.tickets.map(t => (
                  <p key={t.id} className="text-xs text-slate-600 py-0.5">
                    <span className="font-mono font-semibold">{t.ticketNumber}</span>
                    <span className="text-slate-400 ml-2">{t.location}</span>
                  </p>
                ))}
              </div>
              <button
                onClick={() => { onGenerated(); onClose() }}
                className="mt-4 px-6 py-2 bg-blue-800 text-white rounded-lg hover:bg-blue-700 font-medium text-sm"
              >
                Done
              </button>
            </div>
          ) : (
            // Form
            <>
              {/* Tech + Date row */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Assign Tech</label>
                  <select
                    value={selectedTechId}
                    onChange={e => setSelectedTechId(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none bg-white"
                  >
                    <option value="">Select tech...</option>
                    {techs.map(t => (
                      <option key={t.id} value={t.id}>
                        {t.name} {t.role === 'field_super' ? '(Sup)' : ''}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Service Date</label>
                  <input
                    type="date"
                    value={serviceDate}
                    onChange={e => setServiceDate(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Dispatch Notes <span className="text-slate-400 font-normal">(optional)</span>
                </label>
                <input
                  type="text"
                  value={dispatchNotes}
                  onChange={e => setDispatchNotes(e.target.value)}
                  placeholder="Instructions for the tech..."
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                />
              </div>

              {/* Stop picker */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-sm font-medium text-slate-700">
                    Select Stops
                    <span className="ml-2 text-xs font-normal text-slate-400">
                      {selectedCount} of {undoneStops.length} undone selected
                    </span>
                  </label>
                  <div className="flex gap-1">
                    <button
                      onClick={allUndoneSelected ? selectNone : selectAll}
                      className="text-[11px] text-blue-600 hover:text-blue-800 font-medium px-1.5 py-0.5 rounded hover:bg-blue-50"
                    >
                      {allUndoneSelected ? 'Deselect all' : 'Select all'}
                    </button>
                  </div>
                </div>

                {/* Stop search (show if > 15 stops) */}
                {undoneStops.length > 15 && (
                  <div className="relative mb-2">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
                    <input
                      type="text"
                      value={stopSearch}
                      onChange={e => setStopSearch(e.target.value)}
                      placeholder="Filter stops..."
                      className="w-full pl-8 pr-24 py-1.5 border border-slate-200 rounded-lg text-xs focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                    />
                    {stopSearch && filteredUndone.length > 0 && filteredUndone.length < undoneStops.length && (
                      <button
                        onClick={selectFiltered}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-blue-600 hover:text-blue-800 font-medium"
                      >
                        Select {filteredUndone.length} matches
                      </button>
                    )}
                  </div>
                )}

                {stopsLoading ? (
                  <div className="flex items-center gap-2 text-sm text-slate-400 py-4 justify-center">
                    <Loader2 className="w-4 h-4 animate-spin" /> Loading stops...
                  </div>
                ) : (
                  <div className="max-h-56 overflow-y-auto border border-slate-200 rounded-lg divide-y divide-slate-100">
                    {filteredUndone.length === 0 && undoneStops.length === 0 && (
                      <p className="text-xs text-slate-400 p-3 text-center">All stops already serviced!</p>
                    )}
                    {filteredUndone.length === 0 && undoneStops.length > 0 && stopSearch && (
                      <p className="text-xs text-slate-400 p-3 text-center">No matches for &ldquo;{stopSearch}&rdquo;</p>
                    )}
                    {filteredUndone.map(stop => {
                      const isSelected = selectedStopIds.has(stop.stopId)
                      return (
                        <button
                          key={stop.stopId}
                          onClick={() => toggleStop(stop.stopId)}
                          className={cn(
                            'w-full flex items-center gap-2.5 px-3 py-2 text-left text-xs transition-colors',
                            isSelected ? 'bg-blue-50' : 'hover:bg-slate-50',
                          )}
                        >
                          {isSelected ? (
                            <CheckSquare className="w-4 h-4 text-blue-600 shrink-0" />
                          ) : (
                            <Square className="w-4 h-4 text-slate-300 shrink-0" />
                          )}
                          <div className="flex-1 min-w-0">
                            <span className={cn('font-medium', isSelected ? 'text-slate-900' : 'text-slate-600')}>
                              {stop.clientName || stop.locationName || stop.padName}
                            </span>
                            {stop.fieldName && (
                              <span className="ml-1.5 text-slate-400">{stop.fieldName}</span>
                            )}
                          </div>
                        </button>
                      )
                    })}
                    {/* Show done stops collapsed */}
                    {doneStops.length > 0 && !stopSearch && (
                      <div className="px-3 py-2 text-[11px] text-slate-400 bg-slate-50">
                        {doneStops.length} stop{doneStops.length !== 1 ? 's' : ''} already serviced this period
                      </div>
                    )}
                  </div>
                )}
              </div>

              {error && (
                <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        {!result && (
          <div className="px-5 py-3 border-t border-slate-200 flex items-center justify-between shrink-0">
            <span className="text-xs text-slate-500">
              {selectedCount > 0 && (
                <><Zap className="w-3 h-3 inline mr-0.5" />{selectedCount} ticket{selectedCount !== 1 ? 's' : ''} will be created</>
              )}
            </span>
            <div className="flex gap-2">
              <button
                onClick={onClose}
                className="px-4 py-2 text-sm text-slate-600 hover:text-slate-800 font-medium"
              >
                Cancel
              </button>
              <button
                onClick={handleGenerate}
                disabled={submitting || !selectedTechId || selectedCount === 0}
                className={cn(
                  'px-5 py-2 rounded-lg text-sm font-medium text-white flex items-center gap-2',
                  submitting || !selectedTechId || selectedCount === 0
                    ? 'bg-slate-300 cursor-not-allowed'
                    : 'bg-blue-800 hover:bg-blue-700',
                )}
              >
                {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
                {submitting ? 'Generating...' : `Generate ${selectedCount} Ticket${selectedCount !== 1 ? 's' : ''}`}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
