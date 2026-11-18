import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertTriangle, CheckCircle2, Loader2, RotateCcw, Search, Send } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/cn'
import { formatCalendarDateNumeric } from '@/lib/dates'
import { BulkActionBar } from './BulkActionBar'

/**
 * Dashboard "Rental Billing" tab — the supervisor's send-for-billing queue.
 *
 * An open rental no longer shows up in AR's Ready queue on its own. A field
 * supervisor sends it from here, which freezes the billing period at today.
 * Closed rentals are not sent by hand: closing is the send, and they appear
 * here only while tickets on them still need approval.
 *
 * Server: GET/POST /api/rentals/billing-release (services/rentalBillingRelease.ts).
 */

type ReleaseState = 'unreleased' | 'released' | 'closed_blocked' | 'closed_ready'
type Kind = 'manned' | 'unmanned' | 'non_trailer'

interface Blocker { id: string; ticketNumber: string; status: string; serviceDate: string }

interface ReleaseRow {
  id: string
  agreementNumber: string | null
  status: string
  pickupType: 'dispatch' | 'walk_in'
  startDate: string
  endDate: string | null
  company: { id: string; name: string }
  site: { id: string; name: string } | null
  locationName: string | null
  padName: string | null
  kind: Kind
  state: ReleaseState
  lastBilledThrough: string | null
  unbilledFrom: string
  unbilledDays: number
  overdue: boolean
  blockers: Blocker[]
  approvedTicketCount: number
  approvedTicketTotal: number
  billingReleasedThrough: string | null
  billingReleasedAt: string | null
  billingReleasedBy: { id: string; name: string } | null
  billingReleaseForceReason: string | null
}

interface ReleaseResult {
  id: string
  agreementNumber?: string
  success: boolean
  releasedThrough?: string
  error?: string
  blockers?: Blocker[]
}

type View = 'to_send' | 'sent' | 'all'
type KindFilter = 'all' | Kind
type PickupFilter = 'all' | 'dispatch' | 'walk_in'

const KIND_LABEL: Record<Kind, string> = { manned: 'Manned', unmanned: 'Unmanned', non_trailer: 'Non-trailer' }
const TICKET_STATUS_LABEL: Record<string, string> = { completed: 'completed, not submitted', supervisor_review: 'awaiting approval' }

function Chips<T extends string>({ label, value, options, onChange }: {
  label: string; value: T; options: { value: T; label: string; count?: number }[]; onChange: (next: T) => void
}) {
  return (
    <div className="flex items-center gap-1.5 flex-wrap" role="group" aria-label={label}>
      <span className="text-xs font-medium text-slate-500 mr-1">{label}</span>
      {options.map(o => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'px-2.5 py-1 rounded-full text-xs font-medium border transition-colors',
            value === o.value
              ? 'bg-blue-600 border-blue-600 text-white'
              : 'bg-white border-slate-300 text-slate-600 hover:border-slate-400',
          )}
        >
          {o.label}{o.count != null && <span className="ml-1 opacity-75">{o.count}</span>}
        </button>
      ))}
    </div>
  )
}

export function RentalReleaseTab() {
  const navigate = useNavigate()
  const [rows, setRows] = useState<ReleaseRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [view, setView] = useState<View>('to_send')
  const [kind, setKind] = useState<KindFilter>('all')
  const [pickup, setPickup] = useState<PickupFilter>('all')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [sending, setSending] = useState(false)
  const [recalling, setRecalling] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<{ sent: number; failed: ReleaseResult[] } | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ data: ReleaseRow[] }>('/rentals/billing-release')
      setRows(res.data)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load rentals')
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => { void load() }, [load])

  // Everything except the view filter, so the view chips can show live counts.
  const matching = useMemo(() => {
    const q = search.trim().toLowerCase()
    return rows.filter(r => {
      if (kind !== 'all' && r.kind !== kind) return false
      if (pickup !== 'all' && r.pickupType !== pickup) return false
      if (!q) return true
      return [r.company.name, r.padName, r.locationName, r.agreementNumber]
        .some(v => v?.toLowerCase().includes(q))
    })
  }, [rows, search, kind, pickup])

  const needsField = (r: ReleaseRow) => r.state === 'unreleased' || r.state === 'closed_blocked'
  const visible = useMemo(() => {
    const list = matching.filter(r => view === 'all' || (view === 'to_send' ? needsField(r) : !needsField(r)))
    // Closed-and-stuck first, then overdue, then the longest unbilled.
    const rank = (r: ReleaseRow) => r.state === 'closed_blocked' ? 0 : r.overdue ? 1 : 2
    return [...list].sort((a, b) => rank(a) - rank(b) || b.unbilledDays - a.unbilledDays)
  }, [matching, view])

  // Only an open, unsent rental can be sent by hand.
  const sendable = visible.filter(r => r.state === 'unreleased')
  const selectedIds = sendable.filter(r => selected.has(r.id)).map(r => r.id)
  const allSelected = sendable.length > 0 && selectedIds.length === sendable.length

  function toggle(id: string) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  async function sendSelected() {
    if (!selectedIds.length) return
    setSending(true)
    try {
      const res = await api.post<{ results: ReleaseResult[] }>('/rentals/billing-release', { ids: selectedIds })
      setOutcome({ sent: res.results.filter(r => r.success).length, failed: res.results.filter(r => !r.success) })
      // Keep the refused ones selected so a retry after approving is one click.
      setSelected(new Set(res.results.filter(r => !r.success).map(r => r.id)))
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send for billing')
    } finally {
      setSending(false)
    }
  }

  async function recall(row: ReleaseRow) {
    setRecalling(row.id)
    try {
      const res = await api.post<{ results: ReleaseResult[] }>('/rentals/billing-release/recall', { ids: [row.id] })
      const failed = res.results.find(r => !r.success)
      if (failed) setError(`${row.agreementNumber || 'Rental'}: ${failed.error}`)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to take back')
    } finally {
      setRecalling(null)
    }
  }

  if (loading) {
    return <div className="flex items-center justify-center py-16 text-slate-400"><Loader2 className="w-6 h-6 animate-spin" /></div>
  }

  const count = (pred: (r: ReleaseRow) => boolean) => matching.filter(pred).length

  return (
    <div className="pb-24">
      <div className="mb-4">
        <p className="text-sm text-slate-600">
          Open rentals stay out of the billing queue until you send them. Sending bills from the last billed day through today.
          A closed rental goes to billing on its own once its tickets are approved.
        </p>
      </div>

      <div className="bg-white border border-slate-200 rounded-lg p-3 mb-4 space-y-3">
        <div className="relative">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="search"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search customer, pad or agreement #"
            aria-label="Search rentals"
            className="w-full pl-9 pr-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
          />
        </div>
        <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:gap-6 lg:flex-wrap">
          <Chips label="Show" value={view} onChange={setView} options={[
            { value: 'to_send', label: 'Needs sending', count: count(needsField) },
            { value: 'sent', label: 'In billing', count: count(r => !needsField(r)) },
            { value: 'all', label: 'All', count: matching.length },
          ]} />
          <Chips label="Type" value={kind} onChange={setKind} options={[
            { value: 'all', label: 'All' },
            { value: 'manned', label: 'Manned' },
            { value: 'unmanned', label: 'Unmanned' },
            { value: 'non_trailer', label: 'Non-trailer' },
          ]} />
          <Chips label="Pickup" value={pickup} onChange={setPickup} options={[
            { value: 'all', label: 'All' },
            { value: 'dispatch', label: 'Dispatched' },
            { value: 'walk_in', label: 'Walk-in' },
          ]} />
        </div>
      </div>

      {error && (
        <div role="alert" className="mb-4 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800 flex items-start justify-between gap-3">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} className="text-red-700 underline shrink-0">Dismiss</button>
        </div>
      )}

      {outcome && (
        <div role="status" className={cn('mb-4 rounded-lg border p-3 text-sm',
          outcome.failed.length ? 'border-amber-300 bg-amber-50 text-amber-900' : 'border-green-300 bg-green-50 text-green-900')}>
          <div className="flex items-start justify-between gap-3">
            <p className="font-medium">
              {outcome.sent > 0 && `Sent ${outcome.sent} rental${outcome.sent === 1 ? '' : 's'} for billing. `}
              {outcome.failed.length > 0 && `${outcome.failed.length} could not be sent:`}
            </p>
            <button type="button" onClick={() => setOutcome(null)} className="underline shrink-0">Dismiss</button>
          </div>
          {outcome.failed.length > 0 && (
            <ul className="mt-2 space-y-1">
              {outcome.failed.map(f => {
                const row = rows.find(r => r.id === f.id)
                return (
                  <li key={f.id}>
                    <span className="font-medium">{row?.agreementNumber || f.agreementNumber || 'Rental'}</span>
                    {row && <span> · {row.company.name}</span>}: {f.error}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}

      {visible.length === 0 ? (
        <div className="text-center py-16 text-slate-500">
          <CheckCircle2 className="w-10 h-10 mx-auto mb-3 text-green-500" />
          <p className="font-medium">
            {rows.length === 0 ? 'No rentals owe billing.' : view === 'to_send' ? 'Nothing waiting on you here.' : 'No rentals match.'}
          </p>
        </div>
      ) : (
        <>
          {sendable.length > 0 && (
            <label className="flex items-center gap-2 mb-2 text-sm text-slate-600 cursor-pointer w-fit">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={() => setSelected(allSelected ? new Set() : new Set(sendable.map(r => r.id)))}
                className="w-4 h-4 rounded border-slate-300"
              />
              Select all {sendable.length} that can be sent
            </label>
          )}
          <ul className="space-y-2">
            {visible.map(r => {
              const canSend = r.state === 'unreleased'
              const isSelected = canSend && selected.has(r.id)
              return (
                <li
                  key={r.id}
                  className={cn(
                    'bg-white rounded-lg border p-3 flex gap-3',
                    isSelected ? 'border-blue-400 ring-1 ring-blue-200'
                      : r.state === 'closed_blocked' ? 'border-amber-300'
                      : 'border-slate-200',
                  )}
                >
                  <div className="pt-0.5 w-4 shrink-0">
                    {canSend && (
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggle(r.id)}
                        aria-label={`Select ${r.agreementNumber || 'rental'} for ${r.company.name}`}
                        className="w-4 h-4 rounded border-slate-300"
                      />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <button
                        type="button"
                        onClick={() => navigate(`/rentals/${r.id}`)}
                        className="font-medium text-blue-700 hover:text-blue-900 hover:underline"
                      >
                        {r.agreementNumber || r.id.slice(0, 8)}
                      </button>
                      <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 font-medium">{KIND_LABEL[r.kind]}</span>
                      {r.pickupType === 'walk_in' && <span className="text-xs px-2 py-0.5 rounded-full bg-teal-50 text-teal-700 font-medium">Walk-in</span>}
                      {r.overdue && <span className="text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-700 font-semibold">Past due to send</span>}
                      {r.state === 'released' && <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-800 font-semibold">In billing</span>}
                      {r.state === 'closed_ready' && <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-800 font-semibold">Closed · in billing</span>}
                      {r.state === 'closed_blocked' && <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 font-semibold">Closed · needs approvals</span>}
                    </div>
                    <p className="text-sm text-slate-800 mt-0.5">
                      {r.company.name}{r.locationName && <span className="text-slate-500"> · {r.locationName}</span>}
                    </p>
                    <p className="text-xs text-slate-500 mt-1">
                      <span className="font-semibold text-slate-700">{r.unbilledDays} day{r.unbilledDays === 1 ? '' : 's'} unbilled</span>
                      {' '}since {formatCalendarDateNumeric(r.unbilledFrom)}
                      {' · '}{r.lastBilledThrough ? `last billed through ${formatCalendarDateNumeric(r.lastBilledThrough)}` : 'never billed'}
                      {r.status === 'completed' && r.endDate && ` · closed ${formatCalendarDateNumeric(r.endDate)}`}
                      {r.site && ` · ${r.site.name}`}
                    </p>

                    {r.approvedTicketCount > 0 && (
                      <p className="text-xs text-slate-500 mt-1">
                        {r.approvedTicketCount} approved ticket{r.approvedTicketCount === 1 ? '' : 's'} will bill with it
                        {r.approvedTicketTotal > 0 && ` · $${r.approvedTicketTotal.toFixed(2)}`}
                      </p>
                    )}

                    {r.blockers.length > 0 && (
                      <div className="mt-2 rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
                        <p className="font-medium flex items-center gap-1.5">
                          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                          {r.blockers.length} ticket{r.blockers.length === 1 ? '' : 's'} must be approved before this can go to billing
                        </p>
                        <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                          {r.blockers.map(b => (
                            <li key={b.id}>
                              <button type="button" onClick={() => navigate(`/tickets/${b.id}`)} className="text-blue-700 underline">
                                {b.ticketNumber}
                              </button>
                              <span className="text-amber-800"> {formatCalendarDateNumeric(b.serviceDate)} · {TICKET_STATUS_LABEL[b.status] || b.status}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {r.state === 'released' && (
                      <div className="mt-2 flex items-center gap-3 flex-wrap text-xs text-slate-600">
                        <span>
                          Sent through {formatCalendarDateNumeric(r.billingReleasedThrough)}
                          {r.billingReleasedBy ? ` by ${r.billingReleasedBy.name}` : ' at cutover'}
                          {r.billingReleasedAt && ` on ${formatCalendarDateNumeric(r.billingReleasedAt.slice(0, 10))}`}
                          {r.billingReleaseForceReason && ` · forced: ${r.billingReleaseForceReason}`}
                        </span>
                        <button
                          type="button"
                          onClick={() => void recall(r)}
                          disabled={recalling === r.id}
                          className="inline-flex items-center gap-1 text-blue-700 underline disabled:opacity-50"
                        >
                          {recalling === r.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />}
                          Take back
                        </button>
                      </div>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        </>
      )}

      <BulkActionBar
        selectionCount={selectedIds.length}
        itemLabel="rental"
        onClear={() => setSelected(new Set())}
        actions={[{
          label: 'Send for billing',
          icon: <Send className="w-4 h-4" />,
          variant: 'primary',
          onClick: () => void sendSelected(),
          loading: sending,
        }]}
      />
    </div>
  )
}
