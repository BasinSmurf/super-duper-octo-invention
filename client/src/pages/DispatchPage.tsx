import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '@/lib/api'
import { cn } from '@/lib/cn'
import { formatCalendarDateNumeric, calendarDateKey, todayKey } from '@/lib/dates'
import { useAuth } from '@/contexts/AuthContext'
import { GenerateTicketsModal } from '@/components/GenerateTicketsModal'
import { CustomerSearch } from '@/components/CustomerSearch'
import { TechCombobox } from '@/components/TechCombobox'
import { LocationPicker } from '@/components/LocationPicker'
import type { LocationSelection } from '@/components/LocationPicker'
import {
  Send,
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
  CheckCircle2,
  MapPinOff,
} from 'lucide-react'

// ── Types ──

interface Tech {
  id: string
  name: string
  role: string
}

interface Company {
  id: string
  name: string
  companyType: string
  city: string | null
  state: string | null
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
  customData?: { needsLocation?: boolean; needsLocationReason?: string } | null
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

const CALLOUT_TYPES = [
  { value: 'field_service', subtype: null, label: 'Field Service' },
  { value: 'inspection', subtype: 'ih_h2s', label: 'IH Testing' },
  { value: 'field_service', subtype: 'air_fill', label: 'Air Fill' },
]

type Tab = 'queue' | 'dispatched'

// ── Component ──

export function DispatchPage() {
  const { user: _user } = useAuth()
  const navigate = useNavigate()

  const [tab, setTab] = useState<Tab>('queue')
  const [tickets, setTickets] = useState<DispatchTicket[]>([])
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const searchTimeout = useRef<ReturnType<typeof setTimeout>>(undefined)

  // Tech list for assignment
  const [techs, setTechs] = useState<Tech[]>([])

  // Inline dispatch form state
  const [activeTicketId, setActiveTicketId] = useState<string | null>(null)
  const [assignTechId, setAssignTechId] = useState('')
  const [assignDate, setAssignDate] = useState('')
  const [assignNotes, setAssignNotes] = useState('')
  const [dispatching, setDispatching] = useState(false)

  // Coverage gen modal
  const [coverageRoutes, setCoverageRoutes] = useState<CoverageRoute[]>([])
  const [genRouteId, setGenRouteId] = useState<string | null>(null)
  const [genRouteName, setGenRouteName] = useState('')
  const [genRemaining, setGenRemaining] = useState(0)
  const [showRoutePicker, setShowRoutePicker] = useState(false)

  // ── Quick dispatch (callout) state ──
  const [calloutOpen, setCalloutOpen] = useState(false)
  const [calloutType, setCalloutType] = useState(CALLOUT_TYPES[0])
  const [calloutCustomer, setCalloutCustomer] = useState<Company | null>(null)
  const [calloutLocation, setCalloutLocation] = useState<LocationSelection>({ field: null, pad: null, wells: [] })
  const [calloutTechId, setCalloutTechId] = useState('')
  const [calloutDate, setCalloutDate] = useState(() => todayKey())
  const [calloutNotes, setCalloutNotes] = useState('')
  const [calloutSubmitting, setCalloutSubmitting] = useState(false)
  const [calloutSuccess, setCalloutSuccess] = useState<{ ticketNumber: string } | null>(null)
  const [calloutError, setCalloutError] = useState('')

  // Load techs once
  useEffect(() => {
    api.get<{ data: Tech[] }>('/routes/techs')
      .then(res => setTechs(res.data))
      .catch(() => {})
  }, [])

  // Load tickets
  const loadTickets = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ section: tab })
      if (searchQuery) params.set('search', searchQuery)
      const res = await api.get<{ data: DispatchTicket[] }>(`/tickets/dispatch-queue?${params}`)
      setTickets(res.data)
    } catch {
      setTickets([])
    }
    setLoading(false)
  }, [tab, searchQuery])

  useEffect(() => {
    loadTickets()
  }, [loadTickets])

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
    setActiveTicketId(ticket.id)
    setAssignTechId(ticket.assignedTech?.id || '')
    setAssignDate(calendarDateKey(ticket.serviceDate) || todayKey())
    setAssignNotes('')
  }

  function closeDispatchForm() {
    setActiveTicketId(null)
    setAssignTechId('')
    setAssignDate('')
    setAssignNotes('')
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
    } catch (err: any) {
      alert(err.message || 'Failed to dispatch')
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
    } catch (err: any) {
      alert(err.message || 'Failed to reassign')
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

  // ── Quick callout ──

  function resetCallout() {
    setCalloutType(CALLOUT_TYPES[0])
    setCalloutCustomer(null)
    setCalloutLocation({ field: null, pad: null, wells: [] })
    setCalloutTechId('')
    setCalloutDate(todayKey())
    setCalloutNotes('')
    setCalloutError('')
    setCalloutSuccess(null)
  }

  async function handleCalloutSubmit() {
    if (!calloutCustomer) {
      setCalloutError('Please select a customer')
      return
    }
    if (!calloutTechId) {
      setCalloutError('Please select a tech')
      return
    }
    setCalloutError('')
    setCalloutSubmitting(true)

    try {
      // 1. Create ticket as draft
      const ticket = await api.post<any>('/tickets', {
        ticketType: calloutType.value,
        serviceSubtype: calloutType.subtype || undefined,
        companyId: calloutCustomer.id,
        fieldId: calloutLocation.field?.id || undefined,
        padId: calloutLocation.pad?.id || undefined,
        wellId: calloutLocation.wells[0]?.id || undefined,
        assignedTechId: calloutTechId,
        serviceDate: calloutDate,
        dispatchNotes: calloutNotes || undefined,
        customData: calloutLocation.wells.length > 1
          ? { wellIds: calloutLocation.wells.map(w => w.id) }
          : undefined,
      })

      // 2. Transition to dispatched
      await api.post(`/tickets/${ticket.id}/transition`, { targetStatus: 'dispatched' })

      setCalloutSuccess({ ticketNumber: ticket.ticketNumber })
      loadTickets()
    } catch (err: any) {
      setCalloutError(err.message || 'Failed to create ticket')
    } finally {
      setCalloutSubmitting(false)
    }
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Dispatch Board</h1>
          <p className="text-sm text-slate-500 mt-0.5">Assign and manage field tickets</p>
        </div>
        <div className="flex items-center gap-2">
          {/* New Callout button */}
          <button
            onClick={() => { setCalloutOpen(!calloutOpen); if (!calloutOpen) resetCallout() }}
            className={cn(
              'flex items-center gap-2 px-4 py-2 rounded-lg font-medium text-sm transition-colors',
              calloutOpen
                ? 'bg-slate-200 text-slate-700'
                : 'bg-blue-800 text-white hover:bg-blue-700',
            )}
          >
            {calloutOpen ? <X className="w-4 h-4" /> : <Phone className="w-4 h-4" />}
            {calloutOpen ? 'Close' : 'New Callout'}
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
      {calloutOpen && (
        <div className="bg-white rounded-lg border-2 border-blue-200 p-5 mb-4">
          {calloutSuccess ? (
            // Success
            <div className="flex items-center gap-3">
              <CheckCircle2 className="w-8 h-8 text-green-500 shrink-0" />
              <div className="flex-1">
                <p className="font-bold text-slate-900">
                  Ticket {calloutSuccess.ticketNumber} dispatched
                </p>
                <p className="text-sm text-slate-500">
                  Assigned to {techs.find(t => t.id === calloutTechId)?.name || 'tech'} &mdash; {calloutType.label}
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => { resetCallout() }}
                  className="px-4 py-2 text-sm font-medium bg-blue-800 text-white rounded-lg hover:bg-blue-700"
                >
                  Another Callout
                </button>
                <button
                  onClick={() => { setCalloutOpen(false); resetCallout() }}
                  className="px-3 py-2 text-sm text-slate-500 hover:text-slate-700"
                >
                  Done
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 mb-4">
                <Phone className="w-4 h-4 text-blue-600" />
                <h2 className="text-sm font-bold text-slate-900">Quick Dispatch &mdash; Callout</h2>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {/* Left column: type + customer + location */}
                <div className="space-y-3">
                  {/* Service type */}
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1.5">Service Type</label>
                    <div className="flex gap-1">
                      {CALLOUT_TYPES.map(ct => (
                        <button
                          key={`${ct.value}-${ct.subtype}`}
                          onClick={() => setCalloutType(ct)}
                          className={cn(
                            'px-3 py-1.5 text-xs font-medium rounded-lg transition-colors',
                            calloutType.value === ct.value && calloutType.subtype === ct.subtype
                              ? 'bg-blue-800 text-white'
                              : 'bg-slate-100 text-slate-600 hover:bg-slate-200',
                          )}
                        >
                          {ct.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Customer */}
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1.5">Customer</label>
                    <CustomerSearch
                      value={calloutCustomer}
                      onChange={c => {
                        setCalloutCustomer(c)
                        // Reset location when customer changes
                        setCalloutLocation({ field: null, pad: null, wells: [] })
                      }}
                    />
                  </div>

                  {/* Location */}
                  {calloutCustomer && (
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1.5">Location</label>
                      <LocationPicker
                        companyId={calloutCustomer.id}
                        value={calloutLocation}
                        onChange={setCalloutLocation}
                        multiWell={true}
                      />
                    </div>
                  )}
                </div>

                {/* Right column: tech + date + notes */}
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1.5">Assign Tech</label>
                    <TechCombobox
                      techs={techs}
                      value={calloutTechId}
                      onChange={setCalloutTechId}
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1.5">Service Date</label>
                    <input
                      type="date"
                      value={calloutDate}
                      onChange={e => setCalloutDate(e.target.value)}
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1.5">
                      Notes <span className="text-slate-400 font-normal">(optional)</span>
                    </label>
                    <textarea
                      value={calloutNotes}
                      onChange={e => setCalloutNotes(e.target.value)}
                      rows={2}
                      placeholder="What's the callout for? Any instructions..."
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none resize-none"
                    />
                  </div>

                  {calloutError && (
                    <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{calloutError}</p>
                  )}

                  <button
                    onClick={handleCalloutSubmit}
                    disabled={calloutSubmitting || !calloutCustomer || !calloutTechId}
                    className={cn(
                      'w-full py-2.5 rounded-lg text-sm font-bold text-white flex items-center justify-center gap-2',
                      calloutSubmitting || !calloutCustomer || !calloutTechId
                        ? 'bg-slate-300 cursor-not-allowed'
                        : 'bg-blue-800 hover:bg-blue-700',
                    )}
                  >
                    {calloutSubmitting ? (
                      <><Loader2 className="w-4 h-4 animate-spin" /> Creating &amp; Dispatching...</>
                    ) : (
                      <><Send className="w-4 h-4" /> Create &amp; Dispatch</>
                    )}
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      )}

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
      </div>

      {/* Search */}
      <div className="relative mb-4 max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
        <input
          type="text"
          placeholder="Search tickets, companies, locations, tech, created by..."
          onChange={e => handleSearchChange(e.target.value)}
          className="w-full pl-9 pr-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
        />
      </div>

      {/* Ticket list */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 text-slate-400 animate-spin" />
        </div>
      ) : tickets.length === 0 ? (
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
              <div key={ticket.id} className={cn('bg-white rounded-lg border overflow-hidden', needsLocation ? 'border-red-300' : 'border-slate-200')}>
                {/* Ticket card row */}
                <div
                  className="p-4 hover:bg-slate-50 transition-colors cursor-pointer"
                  onClick={() => !isActive && navigate(`/tickets/${ticket.id}`)}
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
                      <p className={cn('text-sm truncate', needsLocation ? 'text-red-600 font-medium' : 'text-slate-500')}>{ticket.locationDisplay || '—'}</p>
                    </div>
                    <div className="flex items-start gap-2">
                      <div className="text-right text-sm text-slate-500 shrink-0">
                        <p>{formatCalendarDateNumeric(ticket.serviceDate)}</p>
                        <p className="text-xs">{ticket.ticketType.replace('_', ' ')}</p>
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
                          onClick={e => { e.stopPropagation(); isActive ? closeDispatchForm() : openDispatchForm(ticket) }}
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
                {isActive && (
                  <div className="px-4 pb-4 pt-1 border-t border-slate-100 bg-slate-50">
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <div>
                        <label className="block text-xs font-medium text-slate-600 mb-1">Tech</label>
                        <TechCombobox
                          techs={techs}
                          value={assignTechId}
                          onChange={setAssignTechId}
                          size="sm"
                        />
                      </div>
                      {isQueue && (
                        <div>
                          <label className="block text-xs font-medium text-slate-600 mb-1">Service Date</label>
                          <input
                            type="date"
                            value={assignDate}
                            onChange={e => setAssignDate(e.target.value)}
                            className="w-full px-2.5 py-1.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                          />
                        </div>
                      )}
                      <div className={isQueue ? '' : 'sm:col-span-2'}>
                        <label className="block text-xs font-medium text-slate-600 mb-1">Notes</label>
                        <input
                          type="text"
                          value={assignNotes}
                          onChange={e => setAssignNotes(e.target.value)}
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
