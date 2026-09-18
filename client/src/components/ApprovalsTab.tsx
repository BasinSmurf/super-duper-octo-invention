import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '@/lib/api'
import { cn } from '@/lib/cn'
import { ReviewSignalBadge, type ReviewSignal } from '@/components/ReviewSignalBadge'
import { BulkActionBar } from '@/components/BulkActionBar'
import {
  Loader2,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  HelpCircle,
  DollarSign,
  Clock,
  Filter,
  Check,
  X,
  ChevronRight,
  ChevronDown,
  Search,
  CornerUpLeft,
} from 'lucide-react'

// ──────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────

interface FlaggedLine {
  id: string
  description: string | null
  lineType: string | null
  quantity: string | number | null
  rate: string | number | null
  total: string | number | null
  notes: string | null
}

interface ReviewTicket {
  id: string
  ticketNumber: string
  ticketType: string
  serviceSubtype: string | null
  status: string
  serviceDate: string
  locationDisplay: string | null
  total: string | number | null
  reviewSignal: ReviewSignal | null
  reviewSignalRanAt: string | null
  updatedAt: string
  company: { id: string; name: string }
  field: { id: string; name: string } | null
  pad: { id: string; name: string } | null
  well: { id: string; wellName: string } | null
  assignedTech: { id: string; name: string } | null
  createdBy: { id: string; name: string } | null
  _count: { lineItems: number; attachments: number }
  // MISC/override line items the rule flagged. Empty array if none.
  flaggedLines?: FlaggedLine[]
  // Set when billing/AR bounced the ticket back from the Ready queue.
  customData?: {
    returnedForReview?: { note: string | null; byName: string | null; at: string | null }
    customerLocationMismatch?: {
      status?: 'pending' | 'assigned' | 'left'
      selectedCustomerId?: string | null
      selectedCustomerName?: string | null
      currentOperatorId?: string | null
      currentOperatorName?: string | null
      source?: 'pad' | 'well'
      locationId?: string | null
      reason?: string | null
      resolvedAt?: string | null
    }
  } | null
}

interface ReviewQueueSummary {
  green: number
  yellow: number
  red: number
  unscored: number
  totalAmount: number
}

type VerdictFilter = 'all' | 'green' | 'yellow' | 'red' | 'unscored'

// ──────────────────────────────────────────────────────────────
// Component
// ──────────────────────────────────────────────────────────────

export function ApprovalsTab() {
  const navigate = useNavigate()

  const [tickets, setTickets] = useState<ReviewTicket[]>([])
  const [summary, setSummary] = useState<ReviewQueueSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState<string | null>(null)

  const [verdictFilter, setVerdictFilter] = useState<VerdictFilter>('all')
  const [techFilter, setTechFilter] = useState<string>('')
  const [customerFilter, setCustomerFilter] = useState<string>('')
  const [typeFilter, setTypeFilter] = useState<string>('')
  // Free-text search across ticket#, location, customer, tech, and creator.
  // Applied client-side over the already-loaded queue (no refetch per keystroke).
  const [searchQuery, setSearchQuery] = useState<string>('')

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [rejectModalOpen, setRejectModalOpen] = useState(false)
  const [rejectReason, setRejectReason] = useState('')
  const [mismatchReasons, setMismatchReasons] = useState<Record<string, string>>({})

  function toggleExpanded(id: string) {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // Dismissible warmup notice: the price-anomaly rule (out_of_range_total)
  // needs 5+ historical tickets per customer+subtype and 90 days of data to
  // be reliable. Warn supervisors until we're past the warmup window.
  const WARMUP_DISMISS_KEY = 'approvals.warmupNoticeDismissed'
  const [warmupDismissed, setWarmupDismissed] = useState(() =>
    typeof window !== 'undefined' && window.localStorage.getItem(WARMUP_DISMISS_KEY) === '1'
  )
  function dismissWarmup() {
    setWarmupDismissed(true)
    try { window.localStorage.setItem(WARMUP_DISMISS_KEY, '1') } catch {}
  }

  // ─── Data loading ──────────────────────────────────────────

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (verdictFilter !== 'all' && verdictFilter !== 'unscored') {
        params.set('verdict', verdictFilter)
      }
      if (techFilter) params.set('tech', techFilter)
      if (customerFilter) params.set('companyId', customerFilter)

      const data = await api.get<{
        tickets: ReviewTicket[]
        total: number
        summary: ReviewQueueSummary
      }>(`/tickets/review-queue?${params.toString()}`)

      if (data) {
        // Client-side filters (keeps server query simple)
        let filtered = data.tickets
        if (verdictFilter === 'unscored') {
          filtered = filtered.filter(t => !t.reviewSignal)
        }
        if (typeFilter) {
          filtered = filtered.filter(t => t.ticketType === typeFilter)
        }
        setTickets(filtered)
        setSummary(data.summary)
      }
    } catch (err) {
      console.error('Failed to load review queue:', err)
    }
    setLoading(false)
  }, [verdictFilter, techFilter, customerFilter, typeFilter])

  useEffect(() => {
    load()
  }, [load])

  // ─── Search (client-side over loaded queue) ────────────────

  const displayedTickets = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return tickets
    return tickets.filter(t =>
      (t.ticketNumber || '').toLowerCase().includes(q) ||
      (t.locationDisplay || '').toLowerCase().includes(q) ||
      t.company.name.toLowerCase().includes(q) ||
      (t.assignedTech?.name || '').toLowerCase().includes(q) ||
      (t.createdBy?.name || '').toLowerCase().includes(q)
    )
  }, [tickets, searchQuery])

  // ─── Selection ─────────────────────────────────────────────

  const visibleIds = useMemo(() => displayedTickets.map(t => t.id), [displayedTickets])
  const allSelected = visibleIds.length > 0 && visibleIds.every(id => selected.has(id))
  const someSelected = visibleIds.some(id => selected.has(id))

  function toggleOne(id: string) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleAll() {
    if (allSelected) {
      setSelected(new Set())
    } else {
      setSelected(new Set(visibleIds))
    }
  }

  function clearSelection() {
    setSelected(new Set())
  }

  // ─── Bulk actions ──────────────────────────────────────────

  async function handleBulkApprove() {
    if (selected.size === 0) return
    const ticketIds = Array.from(selected)

    setActionLoading('approve')
    try {
      const result = await api.post<{
        results: Array<{ ticketId: string; success: boolean; error?: string }>
        succeeded: number
        failed: number
      }>('/tickets/bulk-transition', {
        ticketIds,
        targetStatus: 'billing_queue',
      })

      if (result) {
        if (result.failed > 0) {
          const firstError = result.results.find(r => !r.success)
          alert(
            `Approved ${result.succeeded}/${ticketIds.length}. ${result.failed} failed.\n\nFirst error: ${firstError?.error || 'unknown'}`,
          )
        }
        setSelected(new Set())
        await load()
      }
    } catch (err: any) {
      alert(`Failed to bulk approve: ${err?.message || 'unknown error'}`)
    }
    setActionLoading(null)
  }

  async function handleBulkReject() {
    if (selected.size === 0) return
    if (!rejectReason.trim()) {
      alert('Please provide a rejection reason')
      return
    }

    const ticketIds = Array.from(selected)
    setActionLoading('reject')
    try {
      const result = await api.post<{
        results: Array<{ ticketId: string; success: boolean; error?: string }>
        succeeded: number
        failed: number
      }>('/tickets/bulk-transition', {
        ticketIds,
        targetStatus: 'in_progress',
        reason: rejectReason.trim(),
      })

      if (result) {
        if (result.failed > 0) {
          alert(`Rejected ${result.succeeded}/${ticketIds.length}. ${result.failed} failed.`)
        }
        setSelected(new Set())
        setRejectReason('')
        setRejectModalOpen(false)
        await load()
      }
    } catch (err: any) {
      alert(`Failed to bulk reject: ${err?.message || 'unknown error'}`)
    }
    setActionLoading(null)
  }

  async function resolveSiteMismatch(ticketId: string, action: 'assign' | 'leave') {
    const reason = (mismatchReasons[ticketId] || '').trim()
    if (action === 'leave' && !reason) {
      alert('Reason is required to leave the mismatch.')
      return
    }
    setActionLoading(`${action}-mismatch-${ticketId}`)
    try {
      await api.post(`/tickets/${ticketId}/site-customer-mismatch`, {
        action,
        ...(action === 'leave' ? { reason } : {}),
      })
      setMismatchReasons(prev => {
        const next = { ...prev }
        delete next[ticketId]
        return next
      })
      await load()
    } catch (err: any) {
      alert(`Failed to resolve site mismatch: ${err?.message || 'unknown error'}`)
    } finally {
      setActionLoading(null)
    }
  }

  // ─── Derived data for filters ──────────────────────────────

  const uniqueTechs = useMemo(() => {
    const map = new Map<string, string>()
    for (const t of tickets) {
      if (t.assignedTech) map.set(t.assignedTech.id, t.assignedTech.name)
    }
    return Array.from(map.entries()).map(([id, name]) => ({ id, name }))
  }, [tickets])

  const uniqueCustomers = useMemo(() => {
    const map = new Map<string, string>()
    for (const t of tickets) {
      map.set(t.company.id, t.company.name)
    }
    return Array.from(map.entries()).map(([id, name]) => ({ id, name }))
  }, [tickets])

  const uniqueTypes = useMemo(() => {
    const set = new Set<string>()
    for (const t of tickets) set.add(t.ticketType)
    return Array.from(set).sort()
  }, [tickets])

  // Footer totals across the currently-visible (filtered + searched) queue
  const totalItems = useMemo(
    () => displayedTickets.reduce((sum, t) => sum + (t._count?.lineItems ?? 0), 0),
    [displayedTickets],
  )
  const totalDollars = useMemo(
    () => displayedTickets.reduce((sum, t) => sum + Number(t.total ?? 0), 0),
    [displayedTickets],
  )

  const TYPE_LABELS: Record<string, string> = {
    field_service: 'Field Service',
    training: 'Training / Occ Health',
    shop_service: 'Shop Service',
    rental: 'Rental',
    direct_sale: 'Direct Sale',
  }

  // ─── Render ────────────────────────────────────────────────

  return (
    <div>
      {/* Warmup notice — dismissible, localStorage-backed */}
      {!warmupDismissed && (
        <div className="mb-4 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
          <div className="flex-1 text-sm">
            <div className="font-medium text-amber-900">Heads up: price-anomaly rule is still warming up</div>
            <div className="text-amber-800 mt-0.5">
              The "out of typical range" yellow warning compares each ticket against
              the rolling 90-day average for that customer + service type. Until we
              accumulate about 90 days of closed ticket history, expect some false
              positives (and false negatives) on this specific check. Other rules
              are unaffected.
            </div>
          </div>
          <button
            onClick={dismissWarmup}
            className="text-amber-700 hover:text-amber-900 text-xs font-medium flex-shrink-0"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Summary cards */}
      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-5">
          <SummaryCard
            icon={<CheckCircle2 className="w-5 h-5 text-emerald-600" />}
            label="Routine"
            value={summary.green}
            tone="green"
            active={verdictFilter === 'green'}
            onClick={() => setVerdictFilter(verdictFilter === 'green' ? 'all' : 'green')}
          />
          <SummaryCard
            icon={<AlertTriangle className="w-5 h-5 text-amber-600" />}
            label="Needs eyes"
            value={summary.yellow}
            tone="yellow"
            active={verdictFilter === 'yellow'}
            onClick={() => setVerdictFilter(verdictFilter === 'yellow' ? 'all' : 'yellow')}
          />
          <SummaryCard
            icon={<XCircle className="w-5 h-5 text-red-600" />}
            label="Problems"
            value={summary.red}
            tone="red"
            active={verdictFilter === 'red'}
            onClick={() => setVerdictFilter(verdictFilter === 'red' ? 'all' : 'red')}
          />
          <SummaryCard
            icon={<HelpCircle className="w-5 h-5 text-slate-500" />}
            label="Unscored"
            value={summary.unscored}
            tone="slate"
            active={verdictFilter === 'unscored'}
            onClick={() =>
              setVerdictFilter(verdictFilter === 'unscored' ? 'all' : 'unscored')
            }
          />
          <SummaryCard
            icon={<DollarSign className="w-5 h-5 text-blue-600" />}
            label="Total value"
            value={`$${summary.totalAmount.toLocaleString(undefined, { maximumFractionDigits: 0 })}`}
            tone="blue"
          />
        </div>
      )}

      {/* Filter bar */}
      <div className="bg-white rounded-lg border border-slate-200 p-3 mb-4 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 text-sm text-slate-600">
          <Filter className="w-4 h-4" />
          <span className="font-medium">Filters:</span>
        </div>

        <select
          value={techFilter}
          onChange={e => setTechFilter(e.target.value)}
          className="text-sm border border-slate-300 rounded-md px-2 py-1.5"
        >
          <option value="">All techs</option>
          {uniqueTechs.map(t => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>

        <select
          value={customerFilter}
          onChange={e => setCustomerFilter(e.target.value)}
          className="text-sm border border-slate-300 rounded-md px-2 py-1.5"
        >
          <option value="">All customers</option>
          {uniqueCustomers.map(c => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>

        <select
          value={typeFilter}
          onChange={e => setTypeFilter(e.target.value)}
          className="text-sm border border-slate-300 rounded-md px-2 py-1.5"
        >
          <option value="">All types</option>
          {uniqueTypes.map(t => (
            <option key={t} value={t}>
              {TYPE_LABELS[t] || t}
            </option>
          ))}
        </select>

        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Search ticket#, customer, location, tech, created by..."
            className="text-sm border border-slate-300 rounded-md pl-8 pr-2 py-1.5 w-72"
          />
        </div>

        {(verdictFilter !== 'all' || techFilter || customerFilter || typeFilter || searchQuery.trim()) && (
          <button
            onClick={() => {
              setVerdictFilter('all')
              setTechFilter('')
              setCustomerFilter('')
              setTypeFilter('')
              setSearchQuery('')
            }}
            className="text-xs text-blue-600 hover:text-blue-700 font-medium"
          >
            Clear filters
          </button>
        )}

        <div className="flex-1" />

        <div className="text-xs text-slate-500">
          {displayedTickets.length} ticket{displayedTickets.length !== 1 ? 's' : ''} awaiting review
        </div>
      </div>

      {/* Table */}
      {loading ? (
        <div className="flex items-center justify-center py-16 text-slate-400">
          <Loader2 className="w-6 h-6 animate-spin" />
        </div>
      ) : displayedTickets.length === 0 ? (
        <div className="bg-white rounded-lg border border-slate-200 text-center py-16 text-slate-400">
          <CheckCircle2 className="w-10 h-10 mx-auto mb-2 opacity-50" />
          {searchQuery.trim() ? (
            <>
              <p className="font-medium text-slate-600">No matches</p>
              <p className="text-sm mt-1">No review tickets match “{searchQuery.trim()}”.</p>
            </>
          ) : (
            <>
              <p className="font-medium text-slate-600">All caught up!</p>
              <p className="text-sm mt-1">No tickets awaiting supervisor review.</p>
            </>
          )}
        </div>
      ) : (
        <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="px-3 py-2.5 w-10">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      ref={el => {
                        if (el) el.indeterminate = !allSelected && someSelected
                      }}
                      onChange={toggleAll}
                      className="rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                    />
                  </th>
                  <th className="px-3 py-2.5 text-left font-medium text-slate-500 text-xs uppercase tracking-wide w-20">
                    Signal
                  </th>
                  <th className="px-3 py-2.5 text-left font-medium text-slate-500 text-xs uppercase tracking-wide">
                    Ticket
                  </th>
                  <th className="px-3 py-2.5 text-left font-medium text-slate-500 text-xs uppercase tracking-wide">
                    Tech
                  </th>
                  <th className="px-3 py-2.5 text-left font-medium text-slate-500 text-xs uppercase tracking-wide">
                    Customer
                  </th>
                  <th className="px-3 py-2.5 text-left font-medium text-slate-500 text-xs uppercase tracking-wide">
                    Location
                  </th>
                  <th className="px-3 py-2.5 text-left font-medium text-slate-500 text-xs uppercase tracking-wide">
                    Type
                  </th>
                  <th className="px-3 py-2.5 text-right font-medium text-slate-500 text-xs uppercase tracking-wide">
                    # Items
                  </th>
                  <th className="px-3 py-2.5 text-right font-medium text-slate-500 text-xs uppercase tracking-wide">
                    Total
                  </th>
                  <th className="px-3 py-2.5 text-right font-medium text-slate-500 text-xs uppercase tracking-wide">
                    Waiting
                  </th>
                </tr>
              </thead>
              <tbody>
                {displayedTickets.map(t => {
                  const isSelected = selected.has(t.id)
                  const reasons = t.reviewSignal?.reasons || []
                  const flagged = t.flaggedLines || []
                  const siteMismatch = t.customData?.customerLocationMismatch
                  const hasPendingSiteMismatch = siteMismatch?.status === 'pending'
                  const isExpanded = expanded.has(t.id)
                  const canExpand = flagged.length > 0 || hasPendingSiteMismatch
                  return (
                    <React.Fragment key={t.id}>
                      <tr
                        className={cn(
                          'border-b border-slate-100 hover:bg-slate-50 transition-colors cursor-pointer',
                          isSelected && 'bg-blue-50 hover:bg-blue-100',
                          isExpanded && !isSelected && 'bg-amber-50/40',
                        )}
                        onClick={() => toggleOne(t.id)}
                      >
                        <td className="px-3 py-2.5" onClick={e => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => toggleOne(t.id)}
                            className="rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                          />
                        </td>
                        <td className="px-3 py-2.5">
                          <ReviewSignalBadge signal={t.reviewSignal} />
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="flex items-start gap-1">
                            {canExpand ? (
                              <button
                                type="button"
                                onClick={e => {
                                  e.stopPropagation()
                                  toggleExpanded(t.id)
                                }}
                                className="mt-0.5 p-0.5 rounded hover:bg-amber-100 text-amber-700 flex-shrink-0"
                                title={`${flagged.length} MISC/override line${flagged.length === 1 ? '' : 's'}`}
                              >
                                {isExpanded ? (
                                  <ChevronDown className="w-3.5 h-3.5" />
                                ) : (
                                  <ChevronRight className="w-3.5 h-3.5" />
                                )}
                              </button>
                            ) : (
                              <span className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                            )}
                            <div>
                              <button
                                onClick={e => {
                                  e.stopPropagation()
                                  navigate(`/tickets/${t.id}`)
                                }}
                                className="font-medium text-blue-600 hover:text-blue-700 hover:underline"
                              >
                                {t.ticketNumber}
                              </button>
                              {t.customData?.returnedForReview && (
                                <div className="mt-1 inline-flex items-start gap-1 text-[11px] text-orange-700 bg-orange-50 border border-orange-200 rounded px-1.5 py-0.5 max-w-md">
                                  <CornerUpLeft className="w-3 h-3 mt-0.5 flex-shrink-0" />
                                  <span>
                                    <span className="font-medium">Returned by billing</span>
                                    {t.customData.returnedForReview.byName ? ` (${t.customData.returnedForReview.byName})` : ''}
                                    {t.customData.returnedForReview.note ? `: ${t.customData.returnedForReview.note}` : ''}
                                  </span>
                                </div>
                              )}
                              {reasons.length > 0 && (
                                <ul className="text-[11px] text-slate-500 mt-0.5 space-y-0.5 list-disc list-inside">
                                  {reasons.map((r, i) => (
                                    <li key={i}>{r}</li>
                                  ))}
                                </ul>
                              )}
                            </div>
                          </div>
                        </td>
                        <td className="px-3 py-2.5 text-slate-700">
                          {t.assignedTech?.name || '—'}
                        </td>
                        <td className="px-3 py-2.5 text-slate-700">{t.company.name}</td>
                        <td className="px-3 py-2.5 text-slate-600 text-xs max-w-[200px] truncate">
                          {t.locationDisplay || '—'}
                        </td>
                        <td className="px-3 py-2.5 text-slate-600 text-xs">
                          {t.ticketType}
                          {t.serviceSubtype && (
                            <span className="text-slate-400"> · {t.serviceSubtype}</span>
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-slate-700">
                          {t._count?.lineItems ?? 0}
                        </td>
                        <td className="px-3 py-2.5 text-right font-medium text-slate-900">
                          {t.total ? `$${Number(t.total).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}
                        </td>
                        <td className="px-3 py-2.5 text-right text-xs text-slate-500">
                          <div className="inline-flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            {formatWaitTime(t.updatedAt)}
                          </div>
                        </td>
                      </tr>
                      {isExpanded && canExpand && (
                        <tr className="bg-amber-50/40 border-b border-slate-100">
                          <td />
                          <td colSpan={9} className="px-3 py-2 pb-3">
                            <div className="space-y-3">
                              {hasPendingSiteMismatch && (
                                <div className="rounded border border-amber-200 bg-white p-3">
                                  <div className="text-[11px] uppercase tracking-wide font-medium text-amber-800 mb-1.5 flex items-center gap-1.5">
                                    <AlertTriangle className="w-3 h-3" />
                                    Customer/site mismatch
                                  </div>
                                  <p className="text-xs text-slate-700 mb-2">
                                    Ticket customer is <span className="font-semibold">{siteMismatch?.selectedCustomerName || t.company.name}</span>;
                                    site currently belongs to <span className="font-semibold">{siteMismatch?.currentOperatorName || 'another customer'}</span>.
                                  </p>
                                  <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto]">
                                    <input
                                      type="text"
                                      value={mismatchReasons[t.id] || ''}
                                      onChange={e => setMismatchReasons(prev => ({ ...prev, [t.id]: e.target.value }))}
                                      placeholder="Reason if leaving mismatch"
                                      className="min-w-0 rounded-md border border-slate-300 px-2 py-1.5 text-xs focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                                    />
                                    <button
                                      type="button"
                                      onClick={() => resolveSiteMismatch(t.id, 'assign')}
                                      disabled={actionLoading === `assign-mismatch-${t.id}` || actionLoading === `leave-mismatch-${t.id}`}
                                      className="rounded-md bg-blue-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-600 disabled:opacity-50"
                                    >
                                      Assign Site
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => resolveSiteMismatch(t.id, 'leave')}
                                      disabled={!mismatchReasons[t.id]?.trim() || actionLoading === `assign-mismatch-${t.id}` || actionLoading === `leave-mismatch-${t.id}`}
                                      className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                                    >
                                      Leave Mismatch
                                    </button>
                                  </div>
                                </div>
                              )}
                              {flagged.length > 0 && (
                                <div>
                                  <div className="text-[11px] uppercase tracking-wide font-medium text-amber-800 mb-1.5 flex items-center gap-1.5">
                                    <AlertTriangle className="w-3 h-3" />
                                    Flagged line items ({flagged.length})
                                  </div>
                                  <table className="w-full text-xs bg-white rounded border border-amber-200">
                                    <thead className="bg-amber-50 text-amber-900">
                                      <tr>
                                        <th className="px-2 py-1 text-left font-medium">Description</th>
                                        <th className="px-2 py-1 text-left font-medium w-16">Type</th>
                                        <th className="px-2 py-1 text-right font-medium w-12">Qty</th>
                                        <th className="px-2 py-1 text-right font-medium w-20">Rate</th>
                                        <th className="px-2 py-1 text-right font-medium w-24">Amount</th>
                                        <th className="px-2 py-1 text-left font-medium">Notes</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {flagged.map(li => (
                                        <tr key={li.id} className="border-t border-amber-100">
                                          <td className="px-2 py-1 text-slate-800">{li.description || '—'}</td>
                                          <td className="px-2 py-1 text-slate-500">{li.lineType || '—'}</td>
                                          <td className="px-2 py-1 text-right tabular-nums">{li.quantity != null ? Number(li.quantity) : '—'}</td>
                                          <td className="px-2 py-1 text-right tabular-nums">{li.rate != null ? `$${Number(li.rate).toFixed(2)}` : '—'}</td>
                                          <td className="px-2 py-1 text-right tabular-nums font-medium text-slate-900">{li.total != null ? `$${Number(li.total).toFixed(2)}` : '—'}</td>
                                          <td className="px-2 py-1 text-slate-600">{li.notes || '—'}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  )
                })}
              </tbody>
              <tfoot className="bg-slate-50 border-t-2 border-slate-200 font-medium text-slate-900">
                <tr>
                  <td className="px-3 py-2.5" colSpan={7}>
                    <span className="text-xs uppercase tracking-wide text-slate-500">
                      Totals — {displayedTickets.length} ticket{displayedTickets.length !== 1 ? 's' : ''}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">
                    {totalItems.toLocaleString()}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">
                    {`$${totalDollars.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                  </td>
                  <td className="px-3 py-2.5" />
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* Bulk action bar */}
      <BulkActionBar
        selectionCount={selected.size}
        onClear={clearSelection}
        itemLabel="ticket"
        actions={[
          {
            label: 'Approve',
            icon: <Check className="w-4 h-4" />,
            variant: 'primary',
            onClick: handleBulkApprove,
            loading: actionLoading === 'approve',
          },
          {
            label: 'Reject',
            icon: <X className="w-4 h-4" />,
            variant: 'danger',
            onClick: () => setRejectModalOpen(true),
            disabled: actionLoading !== null,
          },
        ]}
      />

      {/* Reject modal */}
      {rejectModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-md">
            <div className="p-5 border-b border-slate-200">
              <h3 className="text-lg font-semibold text-slate-900">
                Reject {selected.size} ticket{selected.size !== 1 ? 's' : ''}
              </h3>
              <p className="text-sm text-slate-500 mt-1">
                These tickets will go back to In Progress. The tech will see the reason
                and can resubmit.
              </p>
            </div>
            <div className="p-5">
              <label className="block text-sm font-medium text-slate-700 mb-1">
                Reason <span className="text-red-600">*</span>
              </label>
              <textarea
                value={rejectReason}
                onChange={e => setRejectReason(e.target.value)}
                rows={4}
                placeholder="e.g. Signature missing, line items need review…"
                className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
              />
            </div>
            <div className="px-5 py-4 border-t border-slate-200 flex items-center justify-end gap-2">
              <button
                onClick={() => {
                  setRejectModalOpen(false)
                  setRejectReason('')
                }}
                className="px-4 py-2 rounded-lg text-sm font-medium text-slate-600 hover:bg-slate-100"
              >
                Cancel
              </button>
              <button
                onClick={handleBulkReject}
                disabled={!rejectReason.trim() || actionLoading !== null}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-red-600 text-white hover:bg-red-500 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
              >
                {actionLoading === 'reject' ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <X className="w-4 h-4" />
                )}
                Reject {selected.size} ticket{selected.size !== 1 ? 's' : ''}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────

interface SummaryCardProps {
  icon: React.ReactNode
  label: string
  value: number | string
  tone: 'green' | 'yellow' | 'red' | 'slate' | 'blue'
  active?: boolean
  onClick?: () => void
}

function SummaryCard({ icon, label, value, tone, active, onClick }: SummaryCardProps) {
  const toneBorder: Record<string, string> = {
    green: 'border-emerald-200 hover:border-emerald-400',
    yellow: 'border-amber-200 hover:border-amber-400',
    red: 'border-red-200 hover:border-red-400',
    slate: 'border-slate-200 hover:border-slate-400',
    blue: 'border-blue-200',
  }
  const activeRing: Record<string, string> = {
    green: 'ring-2 ring-emerald-400',
    yellow: 'ring-2 ring-amber-400',
    red: 'ring-2 ring-red-400',
    slate: 'ring-2 ring-slate-400',
    blue: '',
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className={cn(
        'bg-white rounded-lg border p-3 text-left transition-all',
        toneBorder[tone],
        active && activeRing[tone],
        onClick ? 'cursor-pointer' : 'cursor-default',
      )}
    >
      <div className="flex items-center gap-2 mb-1">
        {icon}
        <span className="text-xs font-medium text-slate-500 uppercase tracking-wide">
          {label}
        </span>
      </div>
      <div className="text-2xl font-bold text-slate-900">{value}</div>
    </button>
  )
}

function formatWaitTime(isoDate: string): string {
  const diffMs = Date.now() - new Date(isoDate).getTime()
  const mins = Math.floor(diffMs / 60000)
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  return `${days}d`
}
