import { useState, useEffect, useRef, useCallback } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '@/contexts/AuthContext'
import { useApiResource } from '@/hooks/useApiResource'
import { api } from '@/lib/api'
import { cn } from '@/lib/cn'
import { formatCalendarDateNumeric, calendarDateKey, todayKey } from '@/lib/dates'
import { DispatchRentalDialog } from '@/components/DispatchRentalDialog'
import { GenerateTicketsModal } from '@/components/GenerateTicketsModal'
import { TechCombobox } from '@/components/TechCombobox'
import {
  Search,
  Loader2,
  ClipboardList,
  UserPlus,
  RefreshCw,
  ChevronDown,
  // ChevronUp,
  X,
  Zap,
  Phone,
  MapPinOff,
} from 'lucide-react'

// ── Types ──

interface Tech {
  id: string
  name: string
  role: string
}

interface DispatchTicket {
  id: string
  ticketNumber: string | null
  ticketType: string
  serviceSubtype: string | null
  status: string
  serviceDate: string
  locationDisplay: string | null
  companyId: string
  company?: { id: string; name: string }
  field?: { id: string; name: string } | null
  pad?: { id: string; name: string } | null
  well?: { id: string; wellName: string } | null
  assignedTech?: { id: string; name: string } | null
  dispatchedBy?: { id: string; name: string } | null
  dispatchedAt?: string | null
  linkedRentalAgreement?: { id: string; agreementNumber: string } | null
  customData?: { needsLocation?: boolean; needsLocationReason?: string; workType?: string } | null
  _count?: { lineItems: number }
}

interface CoverageRoute {
  routeId: string
  routeName: string
  companyName: string
  remainingStops: number
  totalStops: number
  percentComplete: number
}

const STATUS_COLORS: Record<string, string> = {
  draft: 'bg-slate-100 text-slate-700',
  dispatched: 'bg-blue-100 text-blue-700',
  in_progress: 'bg-amber-100 text-amber-700',
}

interface DispatchRental {
  id: string
  agreementNumber: string
  status: string
  companyId: string
  company: { id: string; name: string }
  fieldId: string | null
  padId: string | null
  wellId: string | null
  wellIds?: string[]
  facilityId?: string | null
  field?: { id: string; name: string } | null
  pad?: { id: string; name: string } | null
  well?: { id: string; wellName: string } | null
  startDate: string
  poNumber?: string | null
  afeNumber?: string | null
}

type Tab = 'queue' | 'dispatched' | 'rentals'

// ── Component ──

export function DispatchPage() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const [searchParams] = useSearchParams()
  const linkedTicketId = searchParams.get('ticket')
  const handledLink = useRef<string | null>(null)
  const linkedTicketRow = useRef<HTMLDivElement>(null)

  const [newRentalOpen, setNewRentalOpen] = useState(false)
  const [rentals, setRentals] = useState<DispatchRental[]>([])
  const [rentalsLoading, setRentalsLoading] = useState(false)
  const [rentalsError, setRentalsError] = useState('')
  const [tab, setTab] = useState<Tab>('queue')
  const [searchQuery, setSearchQuery] = useState('')
  const searchTimeout = useRef<ReturnType<typeof setTimeout>>(undefined)
  const ticketParams = new URLSearchParams({ section: tab })
  if (searchQuery) ticketParams.set('search', searchQuery)
  const requestScope = `${user?.id}:${user?.role}`
  const ticketReport = useApiResource<{ data: DispatchTicket[] }>(
    user && tab !== 'rentals' ? `/tickets/dispatch-queue?${ticketParams}` : null, requestScope,
  )
  const tickets = ticketReport.data?.data
  const loading = ticketReport.loading
  const loadTickets = ticketReport.reload

  // Tech list for assignment
  const [techs, setTechs] = useState<Tech[]>([])

  // Inline dispatch form state
  const [selection, setSelection] = useState<{ link: string | null; ticketId: string | null } | null>(null)
  const linkedTicket = tab === 'queue' ? tickets?.find(ticket => ticket.id === linkedTicketId && !ticket.customData?.needsLocation) : undefined
  const activeTicketId = selection?.link === linkedTicketId ? selection.ticketId : linkedTicket?.id ?? null
  const activeTicket = tickets?.find(ticket => ticket.id === activeTicketId)
  const assignmentKey = JSON.stringify([requestScope, linkedTicketId, activeTicketId])
  const [savedAssignment, setSavedAssignment] = useState<{ key: string; techId: string; date: string; notes: string } | null>(null)
  const assignment = savedAssignment?.key === assignmentKey ? savedAssignment : {
    key: assignmentKey, techId: activeTicket?.assignedTech?.id || '', date: calendarDateKey(activeTicket?.serviceDate) || todayKey(), notes: '',
  }
  const { techId: assignTechId, date: assignDate, notes: assignNotes } = assignment
  const [dispatching, setDispatching] = useState(false)

  // Coverage gen modal
  const [coverageRoutes, setCoverageRoutes] = useState<CoverageRoute[]>([])
  const [genRouteId, setGenRouteId] = useState<string | null>(null)
  const [genRouteName, setGenRouteName] = useState('')
  const [genRemaining, setGenRemaining] = useState(0)
  const [showRoutePicker, setShowRoutePicker] = useState(false)

  // Load techs once
  useEffect(() => {
    api.get<{ data: Tech[] }>('/routes/techs')
      .then(res => setTechs(res.data))
      .catch(() => {})
  }, [])

  // Selection and editable defaults derive from the current link and queue.
  // Only scrolling is an effect; refreshing data must not reopen a closed form.
  useEffect(() => {
    if (!linkedTicketId) { handledLink.current = null; return }
    if (handledLink.current === linkedTicketId || !tickets || tab !== 'queue') return
    handledLink.current = linkedTicketId
    const ticket = tickets.find(row => row.id === linkedTicketId)
    if (!ticket) return
    linkedTicketRow.current?.scrollIntoView({ block: 'center' })
  }, [linkedTicketId, tickets, tab])

  useEffect(() => () => { if (searchTimeout.current) clearTimeout(searchTimeout.current) }, [])

  const loadRentals = useCallback(async () => {
    setRentalsLoading(true)
    setRentalsError('')
    try {
      const rows: DispatchRental[] = []
      let total = 0
      do {
        const result = await api.get<{ data: DispatchRental[]; total: number }>(`/rentals?limit=200&offset=${rows.length}`)
        rows.push(...result.data)
        total = result.total
        if (!result.data.length) break
      } while (rows.length < total)
      setRentals(rows.filter(row => ['active', 'scheduled'].includes(row.status)))
    } catch (err) {
      setRentalsError(err instanceof Error ? err.message : 'Could not load rental agreements')
    } finally { setRentalsLoading(false) }
  }, [setRentalsLoading, setRentalsError, setRentals])

  useEffect(() => { if (tab === 'rentals') void loadRentals() }, [tab, loadRentals])

  // Load coverage routes for gen picker
  useEffect(() => {
    api.get<{ routes: CoverageRoute[] }>('/coverage/routes')
      .then(res => {
        setCoverageRoutes(res.routes.filter(r => r.remainingStops > 0))
      })
      .catch(() => {})
  }, [])

  function handleSearchChange(value: string) {
    if (searchTimeout.current) clearTimeout(searchTimeout.current)
    searchTimeout.current = setTimeout(() => {
      setSearchQuery(value)
    }, 400)
  }

  // ── Dispatch action ──

  function openDispatchForm(ticket: DispatchTicket) {
    setSelection({ link: linkedTicketId, ticketId: ticket.id })
    setSavedAssignment({ key: JSON.stringify([requestScope, linkedTicketId, ticket.id]), techId: ticket.assignedTech?.id || '',
      date: calendarDateKey(ticket.serviceDate) || todayKey(), notes: '' })
  }

  function closeDispatchForm() {
    setSelection({ link: linkedTicketId, ticketId: null })
    setSavedAssignment(null)
  }

  async function handleDispatch(ticketId: string) {
    if (!assignTechId) return
    setDispatching(true)
    try {
      await api.put(`/tickets/${ticketId}`, {
        assignedTechId: assignTechId,
        serviceDate: assignDate || undefined,
        dispatchNotes: assignNotes || undefined,
      })
      await api.post(`/tickets/${ticketId}/transition`, { targetStatus: 'dispatched' })
      closeDispatchForm()
      loadTickets()
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Failed to dispatch')
    }
    setDispatching(false)
  }

  async function handleReassign(ticketId: string) {
    if (!assignTechId) return
    setDispatching(true)
    try {
      await api.put(`/tickets/${ticketId}`, { assignedTechId: assignTechId })
      closeDispatchForm()
      loadTickets()
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Failed to reassign')
    }
    setDispatching(false)
  }

  // ── Coverage gen ──

  function openGenModal(route: CoverageRoute) {
    setGenRouteId(route.routeId)
    setGenRouteName(route.routeName)
    setGenRemaining(route.remainingStops)
    setShowRoutePicker(false)
  }

  function openRentalCallout(rental: DispatchRental) {
    navigate(`/tickets/start?dispatch=1&rentalId=${rental.id}`)
  }

  return (
    <div>
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Dispatch Board</h1>
          <p className="text-sm text-slate-500 mt-0.5">Assign field tickets and dispatch rental jobs</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={() => setNewRentalOpen(true)} className="px-4 py-2 rounded-lg bg-blue-800 text-white text-sm font-medium hover:bg-blue-700">New Rental</button>
          {/* New Callout button */}
          <button
            onClick={() => navigate('/tickets/start?dispatch=1')}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-blue-800 text-white text-sm font-medium hover:bg-blue-700"
          >
            <Phone className="w-4 h-4" /> New Callout
          </button>

          {/* Generate from Coverage button */}
          {coverageRoutes.length > 0 && (
            <div className="relative">
              <button
                onClick={() => setShowRoutePicker(!showRoutePicker)}
                className="flex items-center gap-2 px-4 py-2 bg-emerald-700 text-white rounded-lg hover:bg-emerald-600 transition-colors font-medium text-sm"
              >
                <Zap className="w-4 h-4" />
                <span className="hidden sm:inline">Coverage</span>
                <ChevronDown className="w-3.5 h-3.5" />
              </button>
              {showRoutePicker && (
                <>
                  <div className="fixed inset-0 z-30" onClick={() => setShowRoutePicker(false)} />
                  <div className="absolute right-0 top-full mt-1 z-40 bg-white rounded-lg shadow-xl border border-slate-200 w-80 max-h-64 overflow-y-auto">
                    <div className="p-2 border-b border-slate-100">
                      <p className="text-xs text-slate-500 font-medium px-2 py-1">Routes with remaining stops</p>
                    </div>
                    {coverageRoutes.map(r => (
                      <button
                        key={r.routeId}
                        onClick={() => openGenModal(r)}
                        className="w-full text-left px-4 py-2.5 hover:bg-slate-50 flex items-center justify-between"
                      >
                        <div>
                          <p className="text-sm font-medium text-slate-900">{r.routeName}</p>
                          <p className="text-xs text-slate-500">{r.companyName}</p>
                        </div>
                        <span className="text-xs font-bold text-amber-600 bg-amber-50 px-2 py-0.5 rounded-full">
                          {r.remainingStops} left
                        </span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── Quick Callout Form ── */}
      <DispatchRentalDialog open={newRentalOpen} onClose={() => setNewRentalOpen(false)} onCreated={() => {
        setNewRentalOpen(false)
        setTab('rentals')
        void loadRentals()
        void loadTickets()
      }} />

      {/* Tabs */}
      <div className="flex gap-1 mb-4 bg-slate-100 rounded-lg p-1 w-fit">
        <button
          onClick={() => setTab('queue')}
          className={cn(
            'px-4 py-2 rounded-md text-sm font-medium transition-colors',
            tab === 'queue' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700',
          )}
        >
          Queue
        </button>
        <button
          onClick={() => setTab('dispatched')}
          className={cn(
            'px-4 py-2 rounded-md text-sm font-medium transition-colors',
            tab === 'dispatched' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700',
          )}
        >
          Dispatched
        </button>
        <button onClick={() => setTab('rentals')} className={cn('px-4 py-2 rounded-md text-sm font-medium', tab === 'rentals' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700')}>Rentals</button>
      </div>

      {/* Search */}
      <div className="relative mb-4 max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
        <input
          type="text"
          placeholder={tab === 'rentals' ? 'Search rental agreements, customers, locations...' : 'Search tickets, companies, locations, tech, created by...'}
          onChange={e => handleSearchChange(e.target.value)}
          className="w-full pl-9 pr-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
        />
      </div>

      {/* Ticket list */}
      {tab === 'queue' && linkedTicketId && !loading && !ticketReport.error && tickets && !tickets.some(ticket => ticket.id === linkedTicketId) && (
        <p role="status" className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          The linked ticket is no longer in this queue{searchQuery ? ' or is hidden by your search' : ''}.{' '}
          <Link to={`/tickets/${encodeURIComponent(linkedTicketId)}`} className="underline">Open ticket</Link>
        </p>
      )}
      {tab === 'rentals' ? (
        rentalsLoading ? <div className="flex justify-center py-12"><Loader2 className="w-6 h-6 animate-spin text-slate-400" /></div>
        : rentalsError ? <p className="text-red-600 py-6">{rentalsError} <button onClick={() => void loadRentals()} className="underline">Retry</button></p>
        : <div className="space-y-2">
          {rentals.filter(r => [r.agreementNumber, r.company.name, r.field?.name, r.pad?.name, r.well?.wellName].filter(Boolean).join(' ').toLowerCase().includes(searchQuery.toLowerCase())).map(r => <div key={r.id} className="bg-white border rounded-lg p-4 flex flex-wrap items-center justify-between gap-3">
            <button onClick={() => navigate(`/rentals/${r.id}`)} className="text-left">
              <p className="font-semibold text-sm">{r.agreementNumber} · {r.company.name}</p>
              <p className="text-sm text-slate-500">{r.pad?.name || r.well?.wellName || r.field?.name || 'No location'} · {r.status} · {formatCalendarDateNumeric(r.startDate)}</p>
            </button>
            <button onClick={() => openRentalCallout(r)} className="px-3 py-2 rounded-lg bg-blue-800 text-white text-sm font-medium hover:bg-blue-700">New Callout / Ticket</button>
          </div>)}
          {rentals.length === 0 && <p className="text-center text-slate-500 py-12">No scheduled or active rentals. Use New Rental to dispatch a rental job.</p>}
        </div>
      ) : loading ? (
        <div role="status" aria-label="Loading dispatch tickets" className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 text-slate-400 animate-spin" />
        </div>
      ) : ticketReport.error ? (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          <p>Could not load dispatch tickets: {ticketReport.error}</p>
          <button type="button" onClick={loadTickets} className="mt-2 underline">Retry</button>
        </div>
      ) : !tickets?.length ? (
        <div className="text-center py-12">
          <ClipboardList className="w-12 h-12 text-slate-300 mx-auto mb-3" />
          <p className="text-slate-500">
            {tab === 'queue' ? 'No draft tickets in the queue' : 'No dispatched tickets'}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {tickets.map(ticket => {
            const isActive = activeTicketId === ticket.id
            const isQueue = tab === 'queue'
            const needsLocation = !!ticket.customData?.needsLocation

            return (
              <div key={ticket.id} ref={ticket.id === linkedTicketId ? linkedTicketRow : undefined} className={cn('bg-white rounded-lg border overflow-hidden', needsLocation ? 'border-red-300' : ticket.id === linkedTicketId ? 'border-blue-500 ring-1 ring-blue-200' : 'border-slate-200')}>
                {/* Ticket card row */}
                <div
                  className="p-4 hover:bg-slate-50 transition-colors cursor-pointer"
                  onClick={() => { if (!isActive) navigate(`/tickets/${ticket.id}`) }}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-mono text-sm font-semibold text-slate-900">
                          {ticket.ticketNumber || 'Pending...'}
                        </span>
                        <span className={cn('px-2 py-0.5 rounded-full text-xs font-medium', STATUS_COLORS[ticket.status] || 'bg-slate-100')}>
                          {ticket.status.replace('_', ' ')}
                        </span>
                        {needsLocation && (
                          <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700 inline-flex items-center gap-1">
                            <MapPinOff className="w-3 h-3" /> Needs location
                          </span>
                        )}
                      </div>
                      <p className="text-sm text-slate-700 font-medium">{ticket.company?.name || 'Unknown customer'}</p>
                      {ticket.linkedRentalAgreement && <p className="text-xs text-blue-700">RA {ticket.linkedRentalAgreement.agreementNumber}</p>}
                      <p className={cn('text-sm truncate', needsLocation ? 'text-red-600 font-medium' : 'text-slate-500')}>{ticket.locationDisplay || '—'}</p>
                    </div>
                    <div className="flex items-start gap-2">
                      <div className="text-right text-sm text-slate-500 shrink-0">
                        <p>{formatCalendarDateNumeric(ticket.serviceDate)}</p>
                        <p className="text-xs">{ticket.customData?.workType === 'rental_deploy' ? 'Rental deploy' : ticket.ticketType.replace('_', ' ')}</p>
                        {ticket.assignedTech && (
                          <p className="text-xs text-blue-600 font-medium mt-0.5">{ticket.assignedTech.name}</p>
                        )}
                      </div>
                      {/* Action button — needs-location tickets route to the
                          ticket so a real location can be set before dispatch. */}
                      {needsLocation ? (
                        <button
                          onClick={e => { e.stopPropagation(); navigate(`/tickets/${ticket.id}`) }}
                          className="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors shrink-0 bg-red-600 text-white hover:bg-red-700"
                        >
                          <span className="flex items-center gap-1"><MapPinOff className="w-3.5 h-3.5" /> Set location</span>
                        </button>
                      ) : (
                        <button
                          onClick={e => { e.stopPropagation(); if (isActive) closeDispatchForm(); else openDispatchForm(ticket) }}
                          className={cn(
                            'px-3 py-1.5 rounded-lg text-xs font-medium transition-colors shrink-0',
                            isActive
                              ? 'bg-slate-200 text-slate-600'
                              : isQueue
                                ? 'bg-blue-800 text-white hover:bg-blue-700'
                                : 'bg-slate-100 text-slate-600 hover:bg-slate-200',
                          )}
                        >
                          {isActive ? (
                            <X className="w-3.5 h-3.5" />
                          ) : isQueue ? (
                            <span className="flex items-center gap-1"><UserPlus className="w-3.5 h-3.5" /> Assign</span>
                          ) : (
                            <span className="flex items-center gap-1"><RefreshCw className="w-3.5 h-3.5" /> Reassign</span>
                          )}
                        </button>
                      )}
                    </div>
                  </div>
                </div>

                {/* Inline dispatch/reassign form */}
                {isActive && !needsLocation && (
                  <div className="px-4 pb-4 pt-1 border-t border-slate-100 bg-slate-50">
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <div>
                        <label className="block text-xs font-medium text-slate-600 mb-1">Tech</label>
                        <TechCombobox
                          techs={techs}
                          value={assignTechId}
                          onChange={techId => setSavedAssignment({ ...assignment, techId })}
                          size="sm"
                        />
                      </div>
                      {isQueue && (
                        <div>
                          <label className="block text-xs font-medium text-slate-600 mb-1">Service Date</label>
                          <input
                            type="date"
                            value={assignDate}
                            onChange={e => setSavedAssignment({ ...assignment, date: e.target.value })}
                            className="w-full px-2.5 py-1.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                          />
                        </div>
                      )}
                      <div className={isQueue ? '' : 'sm:col-span-2'}>
                        <label className="block text-xs font-medium text-slate-600 mb-1">Notes</label>
                        <input
                          type="text"
                          value={assignNotes}
                          onChange={e => setSavedAssignment({ ...assignment, notes: e.target.value })}
                          placeholder="Dispatch notes..."
                          className="w-full px-2.5 py-1.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                        />
                      </div>
                    </div>
                    <div className="flex justify-end mt-3 gap-2">
                      <button
                        onClick={closeDispatchForm}
                        className="px-3 py-1.5 text-xs text-slate-500 hover:text-slate-700 font-medium"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={() => isQueue ? handleDispatch(ticket.id) : handleReassign(ticket.id)}
                        disabled={dispatching || !assignTechId}
                        className={cn(
                          'px-4 py-1.5 rounded-lg text-xs font-medium text-white flex items-center gap-1.5',
                          dispatching || !assignTechId
                            ? 'bg-slate-300 cursor-not-allowed'
                            : 'bg-blue-800 hover:bg-blue-700',
                        )}
                      >
                        {dispatching && <Loader2 className="w-3 h-3 animate-spin" />}
                        {isQueue ? 'Dispatch' : 'Reassign'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Generate Tickets Modal */}
      {genRouteId && (
        <GenerateTicketsModal
          routeId={genRouteId}
          routeName={genRouteName}
          remainingStops={genRemaining}
          onClose={() => setGenRouteId(null)}
          onGenerated={() => {
            loadTickets()
            api.get<{ routes: CoverageRoute[] }>('/coverage/routes')
              .then(res => setCoverageRoutes(res.routes.filter(r => r.remainingStops > 0)))
              .catch(() => {})
          }}
        />
      )}
    </div>
  )
}
