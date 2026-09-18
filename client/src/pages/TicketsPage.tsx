import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '@/contexts/AuthContext'
import { usePermissions } from '@/contexts/PermissionsContext'
import { useSync } from '@/contexts/SyncContext'
import { db } from '@/lib/db'
import { api } from '@/lib/api'
import { cn } from '@/lib/cn'
import { formatCalendarDateNumeric, todayKey, localDateKey } from '@/lib/dates'
import { Plus, ClipboardList, CloudOff, ChevronDown, Search, Ban } from 'lucide-react'

interface Ticket {
  id: string
  ticketNumber: string | null
  ticketType: string
  serviceSubtype: string | null
  status: string
  serviceDate: string
  locationDisplay: string | null
  companyId: string
  companyName?: string
  _offlineStatus?: string
  _count?: { lineItems: number; attachments: number }
}

const STATUS_COLORS: Record<string, string> = {
  draft: 'bg-slate-100 text-slate-700',
  dispatched: 'bg-blue-100 text-blue-700',
  in_progress: 'bg-amber-100 text-amber-700',
  completed: 'bg-green-100 text-green-700',
  supervisor_review: 'bg-purple-100 text-purple-700',
  billing_queue: 'bg-orange-100 text-orange-700',
  invoiced: 'bg-emerald-100 text-emerald-700',
  closed: 'bg-slate-200 text-slate-500',
  void: 'bg-red-200 text-red-800',
}

// Voided tickets read as "dead" in the All view rather than the raw enum name.
const STATUS_LABELS: Record<string, string> = {
  void: 'dead',
}

const PAGE_SIZE = 50

type Tab = 'today' | 'week' | 'all' | 'mine'

export function TicketsPage() {
  const { user } = useAuth()
  const { can } = usePermissions()
  const navigate = useNavigate()
  const { syncState } = useSync()
  const isTech = user?.role === 'field_tech'
  const [tab, setTab] = useState<Tab>(isTech ? 'today' : 'all')
  const [tickets, setTickets] = useState<Ticket[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [totalCount, setTotalCount] = useState(0)
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const searchTimeout = useRef<ReturnType<typeof setTimeout>>(undefined)

  // Void (soft-kill — stays in All as "dead") is a quick list action. Hard
  // delete lives on the ticket detail page (per the destructive-action convention).
  const canVoid = can('tickets:cancel')

  const loadTickets = useCallback(async function loadTickets(append = false, offset = 0) {
    if (!append) setLoading(true)
    else setLoadingMore(true)
    try {
      // 1. Get offline-pending tickets from Dexie (only pending, not all 44K)
      let offlinePending: Ticket[] = []
      if (!append) {
        const pendingLocal = await db.tickets
          .filter(t => t._offlineStatus === 'pending')
          .toArray()
        if (pendingLocal.length > 0) {
          const companyIds = [...new Set(pendingLocal.map(t => t.companyId).filter(Boolean))]
          const companies = await db.companies.bulkGet(companyIds)
          const companyMap = new Map(companies.filter(Boolean).map(c => [c!.id, c!.name]))
          offlinePending = pendingLocal.map(t => ({
            id: t.id,
            ticketNumber: t.ticketNumber ?? null,
            ticketType: t.ticketType,
            serviceSubtype: t.serviceSubtype ?? null,
            status: t.status,
            serviceDate: t.serviceDate,
            locationDisplay: t.locationDisplay ?? null,
            companyId: t.companyId,
            companyName: companyMap.get(t.companyId) || 'Unknown',
            _offlineStatus: t._offlineStatus,
          }))
        }
      }

      // 2. Fetch from API with pagination
      let apiTickets: Ticket[] = []
      let total = 0
      try {
        if (tab === 'mine') {
          // "My Tickets" wants active jobs assigned to me regardless of age,
          // not a date-scoped list — keep this on the dedicated endpoint.
          const apiData = await api.get<any[]>('/tickets/my-recent')
          apiTickets = apiData.map(t => ({
            id: t.id,
            ticketNumber: t.ticketNumber,
            ticketType: t.ticketType,
            serviceSubtype: t.serviceSubtype,
            status: t.status,
            serviceDate: t.serviceDate,
            locationDisplay: t.locationDisplay || t.pad?.name || null,
            companyId: t.companyId,
            companyName: t.company?.name || 'Unknown',
            _count: t._count,
          }))
          total = apiTickets.length
        } else {
          // Build query params
          const params = new URLSearchParams({
            limit: String(PAGE_SIZE),
            offset: String(offset),
          })
          if (tab === 'today') {
            const todayStr = todayKey()
            params.set('dateFrom', todayStr)
            params.set('dateTo', todayStr)
            params.set('excludeVoid', 'true')
          } else if (tab === 'week') {
            // Calendar week (Sun–Sat) containing today, not a rolling window
            // pinned to "active" tickets from months ago.
            const now = new Date()
            const weekStart = new Date(now)
            weekStart.setDate(now.getDate() - now.getDay())
            const weekEnd = new Date(weekStart)
            weekEnd.setDate(weekStart.getDate() + 6)
            params.set('dateFrom', localDateKey(weekStart))
            params.set('dateTo', localDateKey(weekEnd))
            params.set('excludeVoid', 'true')
          }
          if (searchQuery) params.set('search', searchQuery)
          if (statusFilter) params.set('status', statusFilter)
          const apiData = await api.get<{ data: any[]; total: number }>(`/tickets?${params}`)
          apiTickets = apiData.data.map(t => ({
            id: t.id,
            ticketNumber: t.ticketNumber,
            ticketType: t.ticketType,
            serviceSubtype: t.serviceSubtype,
            status: t.status,
            serviceDate: t.serviceDate,
            locationDisplay: t.locationDisplay || t.pad?.name || null,
            companyId: t.companyId,
            companyName: t.company?.name || 'Unknown',
            _count: t._count,
          }))
          total = apiData.total
        }
      } catch {
        // Offline fallback — show only pending offline tickets
      }

      // 3. Merge: offline-pending first, then API results (dedup)
      const apiIds = new Set(apiTickets.map(t => t.id))
      const uniqueOffline = offlinePending.filter(t => !apiIds.has(t.id))

      let merged = append
        ? [...tickets, ...apiTickets]
        : [...uniqueOffline, ...apiTickets]

      // Today/Week are now date-scoped and void-excluded server-side (see
      // dateFrom/dateTo/excludeVoid above). All Tickets intentionally keeps
      // void tickets visible as "dead".
      if (tab === 'mine') {
        // Show only dispatched + in_progress tickets assigned to me
        merged = merged.filter(t =>
          ['dispatched', 'in_progress'].includes(t.status)
        )
      }

      // Sort: pending offline first, then by date desc (only for non-append)
      if (!append) {
        merged.sort((a, b) => {
          const aPending = a._offlineStatus === 'pending' ? 0 : 1
          const bPending = b._offlineStatus === 'pending' ? 0 : 1
          if (aPending !== bPending) return aPending - bPending
          return (b.serviceDate || '').localeCompare(a.serviceDate || '')
        })
      }

      setTickets(merged)
      setTotalCount(total)
    } catch {
      if (!append) setTickets([])
    } finally {
      setLoading(false)
      setLoadingMore(false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, searchQuery, statusFilter])

  function handleLoadMore() {
    const currentOffset = tickets.filter(t => !t._offlineStatus).length
    loadTickets(true, currentOffset)
  }

  // Reload when tab changes, sync completes, or pending count changes
  useEffect(() => {
    loadTickets()
  }, [loadTickets, syncState.lastSyncedAt, syncState.pendingMutations])

  function handleSearchChange(value: string) {
    if (searchTimeout.current) clearTimeout(searchTimeout.current)
    searchTimeout.current = setTimeout(() => {
      setSearchQuery(value)
    }, 400)
  }

  async function handleVoidTicket(ticket: Ticket, e: React.MouseEvent) {
    e.stopPropagation()
    const label = ticket.ticketNumber || ticket.id.slice(0, 8)
    const reason = prompt(`Void (nullify) ticket ${label}?\n\nIt stays visible in All as "dead" but drops out of all active/billing queues.\n\nOptional reason:`)
    if (reason === null) return // cancelled

    setDeletingId(ticket.id)
    try {
      const res = await api.post<{
        retracted: Array<{ invoiceNumber: string }>
        locked: Array<{ invoiceNumber: string; status: string; qbNumber: string | null }>
      }>(`/tickets/${ticket.id}/void`, { reason: reason.trim() || undefined })
      // Keep it in the list — just mark it dead.
      setTickets(prev => prev.map(t => (t.id === ticket.id ? { ...t, status: 'void' } : t)))
      try { await db.tickets.update(ticket.id, { status: 'void' }) } catch { /* not cached */ }

      // Tell the user what happened on the billing side.
      const retracted = res?.retracted ?? []
      const locked = res?.locked ?? []
      if (locked.length) {
        alert(
          `Ticket ${label} voided.\n\n` +
          `${locked.length} invoice(s) already in QuickBooks were NOT retracted (can't un-bork across QBWC) — handle these in QB:\n` +
          locked.map(l => `  • ${l.invoiceNumber}${l.qbNumber ? ` (QB ${l.qbNumber})` : ''} — ${l.status}`).join('\n') +
          (retracted.length ? `\n\nRetracted ${retracted.length} pre-QB invoice(s).` : ''),
        )
      } else if (retracted.length) {
        alert(`Ticket ${label} voided. Retracted ${retracted.length} pre-QB invoice(s): ${retracted.map(r => r.invoiceNumber).join(', ')}.`)
      }
    } catch (err: any) {
      alert(`Failed to void: ${err.message || 'Unknown error'}`)
    } finally {
      setDeletingId(null)
    }
  }


  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-slate-900">Tickets</h1>
        {(user?.role === 'field_tech' || user?.role === 'dispatch' || user?.role === 'field_super' || user?.role === 'platform_admin') && (
          <button
            onClick={() => navigate('/tickets/start')}
            className="flex items-center gap-2 px-4 py-2 bg-blue-800 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium"
          >
            <Plus className="w-5 h-5" />
            New Ticket
          </button>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-4 bg-slate-100 rounded-lg p-1 w-fit">
        <button
          onClick={() => setTab('today')}
          className={cn(
            'px-4 py-2 rounded-md text-sm font-medium transition-colors',
            tab === 'today' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700',
          )}
        >
          Today
        </button>
        <button
          onClick={() => setTab('week')}
          className={cn(
            'px-4 py-2 rounded-md text-sm font-medium transition-colors',
            tab === 'week' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700',
          )}
        >
          This Week
        </button>
        <button
          onClick={() => setTab('all')}
          className={cn(
            'px-4 py-2 rounded-md text-sm font-medium transition-colors',
            tab === 'all' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700',
          )}
        >
          All Tickets
        </button>
        {isTech && (
          <button
            onClick={() => setTab('mine')}
            className={cn(
              'px-4 py-2 rounded-md text-sm font-medium transition-colors',
              tab === 'mine' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700',
            )}
          >
            My Tickets
          </button>
        )}
      </div>

      {/* Search + filters (All tab only) */}
      {tab === 'all' && (
        <div className="flex gap-3 mb-4">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              type="text"
              placeholder="Search tickets, companies, locations, tech, created by..."
              onChange={e => handleSearchChange(e.target.value)}
              className="w-full pl-9 pr-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
          <select
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value)}
            className="px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">All Statuses</option>
            <option value="draft">Draft</option>
            <option value="dispatched">Dispatched</option>
            <option value="in_progress">In Progress</option>
            <option value="completed">Completed</option>
            <option value="supervisor_review">Supervisor Review</option>
            <option value="billing_queue">Billing Queue</option>
            <option value="invoiced">Invoiced</option>
            <option value="closed">Closed</option>
            <option value="void">Void / Dead</option>
          </select>
          {totalCount > 0 && (
            <span className="self-center text-sm text-slate-500">
              {tickets.length} of {totalCount.toLocaleString()}
            </span>
          )}
        </div>
      )}

      {/* Ticket list */}
      {loading ? (
        <div className="text-center py-12 text-slate-400">Loading tickets...</div>
      ) : tickets.length === 0 ? (
        <div className="text-center py-12">
          <ClipboardList className="w-12 h-12 text-slate-300 mx-auto mb-3" />
          <p className="text-slate-500">
            {tab === 'today' ? 'No tickets for today' : tab === 'week' ? 'No tickets this week' : tab === 'mine' ? 'No dispatched tickets assigned to you' : 'No tickets found'}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {tickets.map(ticket => (
            <div
              key={ticket.id}
              onClick={() => navigate(`/tickets/${ticket.id}`)}
              className="bg-white rounded-lg border border-slate-200 p-4 hover:border-slate-300 transition-colors cursor-pointer"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-mono text-sm font-semibold text-slate-900">
                      {ticket.ticketNumber || 'Pending...'}
                    </span>
                    <span className={cn('px-2 py-0.5 rounded-full text-xs font-medium', STATUS_COLORS[ticket.status] || 'bg-slate-100')}>
                      {STATUS_LABELS[ticket.status] || ticket.status.replace('_', ' ')}
                    </span>
                    {ticket._offlineStatus === 'pending' && (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-amber-50 text-amber-600 border border-amber-200">
                        <CloudOff className="w-2.5 h-2.5" />
                        queued
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-slate-700 font-medium">{ticket.companyName || 'Unknown customer'}</p>
                  <p className="text-sm text-slate-500 truncate">{ticket.locationDisplay || '—'}</p>
                </div>
                <div className="flex items-start gap-3">
                  <div className="text-right text-sm text-slate-500 shrink-0">
                    <p>{formatCalendarDateNumeric(ticket.serviceDate)}</p>
                    <p className="text-xs">{ticket.ticketType.replace('_', ' ')}</p>
                    {ticket._count && ticket._count.lineItems > 0 && (
                      <p className="text-xs text-slate-400">{ticket._count.lineItems} items</p>
                    )}
                  </div>
                  {/* Void (billing/AR + admin) — soft-kill, stays as "dead". Hidden once dead. */}
                  {canVoid && ticket.status !== 'void' && ticket._offlineStatus !== 'pending' && (
                    <button
                      onClick={(e) => handleVoidTicket(ticket, e)}
                      disabled={deletingId === ticket.id}
                      className={cn(
                        'p-1.5 rounded-lg transition-colors shrink-0',
                        deletingId === ticket.id
                          ? 'text-amber-300 cursor-not-allowed'
                          : 'text-slate-300 hover:text-amber-600 hover:bg-amber-50',
                      )}
                      title="Void / mark dead (kept in All)"
                    >
                      <Ban className={cn('w-4 h-4', deletingId === ticket.id && 'animate-pulse')} />
                    </button>
                  )}
                  {/* Hard delete now lives on the ticket detail page. */}
                </div>
              </div>
            </div>
          ))}

          {/* Load More */}
          {tab !== 'mine' && tickets.length < totalCount && (
            <button
              onClick={handleLoadMore}
              disabled={loadingMore}
              className="w-full py-3 text-sm font-medium text-blue-700 bg-blue-50 rounded-lg hover:bg-blue-100 transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
            >
              {loadingMore ? (
                'Loading...'
              ) : (
                <>
                  <ChevronDown className="w-4 h-4" />
                  Load More ({(totalCount - tickets.length).toLocaleString()} remaining)
                </>
              )}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
