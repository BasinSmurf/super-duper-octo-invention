import { InternalShopValueWidget } from './InternalShopValueWidget'
import { QbSyncQueueWidget, TicketVolumeWidget } from './PipelineWidgets'
/**
 * Widget registry: maps WidgetType → React component + default title.
 *
 * Each widget is a tiny presentational component that fetches its own data.
 * They're deliberately small — focused views, one responsibility each.
 * Each registered widget has a data source or provides an action.
 */

import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Loader2,
  ClipboardList,
  AlertTriangle,
  Wind,
  Users,
  FileCheck,
  FileText,
  Zap,
  TrendingUp,
  DollarSign,
  Plus,
  MapPin,
  Hourglass,
  CalendarClock,
  HeartPulse,
  CheckCircle2,
} from 'lucide-react'
import { api } from '@/lib/api'
import type { WidgetType } from '@/lib/widgetTypes'
import { cn } from '@/lib/cn'

/**
 * Every widget receives its instance config and a way to persist changes to it.
 * Most widgets have no settings and simply declare no parameters -- a zero-arg
 * component is assignable to ComponentType<WidgetProps>, so they need no edit.
 */
export interface WidgetProps {
  config: Record<string, unknown>
  onConfigChange: (next: Record<string, unknown>) => void
}

// ---------------------------------------------------------------------------
// Shared fetch hook — minimal, no caching, refetches on mount
// ---------------------------------------------------------------------------

function useFetch<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(!!path)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!path) return
    let cancelled = false
    setLoading(true)
    // Cache-bust: workbox NetworkFirst can serve stale responses on slow
    // networks. The ?t= param keeps each call a unique cache key.
    const sep = path.includes('?') ? '&' : '?'
    const bustedPath = `${path}${sep}t=${Date.now()}`
    api
      .get<T>(bustedPath)
      .then((d) => {
        if (!cancelled) {
          setData(d)
          setError(null)
        }
      })
      .catch((e) => {
        const status = (e && typeof e === 'object' && 'status' in e) ? (e as any).status : ''
        const msg = e?.message || 'Failed to load'
        if (!cancelled) setError(status ? `${msg} (${status})` : msg)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [path])

  return { data, loading, error }
}

// ---------------------------------------------------------------------------
// Shared UI primitives
// ---------------------------------------------------------------------------

function Skeleton() {
  return <div className="animate-pulse text-slate-400 text-sm">Loading…</div>
}

function ErrorNote({ message }: { message: string }) {
  return (
    <div className="text-sm text-red-600 flex items-start gap-2">
      <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
      <span>{message}</span>
    </div>
  )
}

function EmptyNote({ message }: { message: string }) {
  return <div className="text-sm text-slate-400 italic">{message}</div>
}

function MetricRow({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: React.ElementType
  label: string
  value: string | number
  hint?: string
}) {
  return (
    <div className="flex items-center justify-between py-2">
      <div className="flex items-center gap-2 text-sm text-slate-600">
        <Icon className="w-4 h-4 text-slate-400" />
        <span>{label}</span>
      </div>
      <div className="text-right">
        <div className="text-lg font-semibold text-slate-900">{value}</div>
        {hint && <div className="text-[10px] text-slate-400">{hint}</div>}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Widget implementations
// ---------------------------------------------------------------------------

function MyTicketsWidget() {
  const navigate = useNavigate()
  type Row = { id: string; ticketNumber?: string; status: string; company?: { name?: string }; locationDisplay?: string }
  // /tickets already filters to assignedTechId for field_tech role server-side
  const { data, loading, error } = useFetch<{ data: Row[] } | Row[]>('/tickets?limit=10')
  if (loading) return <Skeleton />
  if (error) return <ErrorNote message={error} />
  const raw = Array.isArray(data) ? data : data?.data ?? []
  const rows = raw.filter(t => !['closed', 'invoiced'].includes(t.status))
  if (rows.length === 0) return <EmptyNote message="No open tickets assigned to you." />
  return (
    <ul className="divide-y divide-slate-100">
      {rows.slice(0, 8).map((t) => (
        <li key={t.id}>
          <button
            onClick={() => navigate(`/tickets/${t.id}`)}
            className="w-full text-left py-2.5 hover:bg-slate-50 px-2 -mx-2 rounded"
          >
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-slate-800">
                {t.ticketNumber || t.id.slice(0, 8)}
              </span>
              <span className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">
                {t.status.replace(/_/g, ' ')}
              </span>
            </div>
            <div className="text-xs text-slate-500 truncate mt-0.5">
              {t.company?.name || '—'} · {t.locationDisplay || ''}
            </div>
          </button>
        </li>
      ))}
    </ul>
  )
}

function QuickActionsWidget() {
  const navigate = useNavigate()
  const actions = [
    { label: 'New Ticket', icon: Plus, onClick: () => navigate('/tickets/start'), color: 'bg-blue-600 hover:bg-blue-700' },
  ]
  return (
    <div className={cn('grid gap-2 h-full', actions.length > 1 ? 'grid-cols-2' : 'grid-cols-1')}>
      {actions.map((a) => (
        <button
          key={a.label}
          onClick={a.onClick}
          className={cn(
            'rounded-lg text-white font-semibold text-sm flex flex-col items-center justify-center gap-2 py-4 transition-colors',
            a.color,
          )}
        >
          <a.icon className="w-6 h-6" />
          {a.label}
        </button>
      ))}
    </div>
  )
}

function UnassignedTicketsWidget() {
  const navigate = useNavigate()
  type Row = { id: string; ticketNumber?: string; company?: { name?: string }; locationDisplay?: string; serviceDate?: string; assignedTechId?: string | null }
  // dispatch-queue?section=queue returns all draft tickets
  const { data, loading, error } = useFetch<{ data: Row[] }>('/tickets/dispatch-queue?section=queue')
  if (loading) return <Skeleton />
  if (error) return <ErrorNote message={error} />
  const all = data?.data ?? []
  const rows = all.filter(t => !t.assignedTechId)
  if (rows.length === 0) return <EmptyNote message="Nothing in the queue — crews are caught up." />
  return (
    <ul className="divide-y divide-slate-100">
      {rows.slice(0, 8).map((t) => (
        <li key={t.id}>
          <button type="button" onClick={() => navigate(`/dispatch?ticket=${encodeURIComponent(t.id)}`)} className="w-full text-left py-2 px-2 -mx-2 hover:bg-slate-50 rounded">
          <div className="text-sm font-medium text-slate-800 truncate">
            {t.ticketNumber || t.id.slice(0, 8)} · {t.company?.name || '—'}
          </div>
          <div className="text-xs text-slate-500 truncate">{t.locationDisplay || ''}</div>
          </button>
        </li>
      ))}
    </ul>
  )
}

function CoverageStatusWidget() {
  const navigate = useNavigate()
  type RouteSummary = {
    id: string
    name: string
    company?: { name?: string }
    totalStops: number
    servicedStops: number
    remainingStops: number
  }
  type Resp = {
    totals: { routes: number; stops: number; serviced: number; remaining: number; percentComplete: number }
    routes: RouteSummary[]
  }
  const { data, loading, error } = useFetch<Resp>('/coverage/routes')
  if (loading) return <Skeleton />
  if (error) return <ErrorNote message={error} />
  if (!data || data.routes.length === 0)
    return <EmptyNote message="No active coverage routes." />
  const topRemaining = [...data.routes]
    .filter(r => r.remainingStops > 0)
    .sort((a, b) => b.remainingStops - a.remainingStops)
    .slice(0, 5)
  return (
    <div onClick={() => navigate('/coverage')} className="cursor-pointer">
      <MetricRow
        icon={Wind}
        label="Overall complete"
        value={`${data.totals.percentComplete}%`}
        hint={`${data.totals.serviced} / ${data.totals.stops} stops`}
      />
      {topRemaining.length > 0 && (
        <>
          <div className="mt-2 pt-2 border-t border-slate-100 text-[11px] uppercase tracking-wide text-slate-400 font-semibold">
            Most remaining
          </div>
          <ul className="divide-y divide-slate-100">
            {topRemaining.map(r => (
              <li key={r.id} className="py-1.5 flex items-center justify-between">
                <div className="min-w-0">
                  <div className="text-sm text-slate-800 truncate">{r.name}</div>
                  <div className="text-[10px] text-slate-500 truncate">{r.company?.name || ''}</div>
                </div>
                <span className="text-xs font-semibold text-amber-700">
                  {r.remainingStops} left
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

function TeamActivityWidget() {
  const { data, loading, error } = useFetch<{ date: string; rows: { id: string; name: string; total: number; working: number; review: number; done: number }[] }>('/dashboard/team-activity')
  if (loading) return <Loader2 className="h-5 w-5 animate-spin" />
  if (error) return <EmptyNote message="Team activity could not load." />
  if (!data?.rows.length) return <EmptyNote message="No team tickets for today's service date." />
  return <div className="space-y-2 text-xs"><p className="text-slate-500">{data.date} · by service date</p>{data.rows.map(row => <div key={row.id} className="flex justify-between gap-3 border-b pb-2"><span className="font-medium">{row.name}</span><span>{row.working} working · {row.review} review · {row.done} done</span></div>)}</div>
}

function PendingLocationRequestsWidget() {
  const navigate = useNavigate()
  type Resp = { data: unknown[]; total: number }
  const { data, loading } = useFetch<Resp>('/locations/requests/pending')
  const count = data?.total ?? 0
  const hasRequests = count > 0

  return (
    <button
      onClick={() => navigate('/dashboard?tab=approvals&atab=locations')}
      className={cn(
        'w-full h-full rounded-xl flex flex-col items-center justify-center gap-1.5 py-5 px-4 transition-all shadow-sm border',
        hasRequests
          ? 'bg-red-600 hover:bg-red-700 text-white border-red-700 animate-pulse'
          : 'bg-slate-100 hover:bg-slate-200 text-slate-500 border-slate-200',
      )}
    >
      <MapPin className={cn('w-7 h-7', hasRequests && 'text-white')} />
      <div className="text-2xl font-bold leading-none">{loading ? '…' : count}</div>
      <div className="text-xs font-semibold uppercase tracking-wider">
        {hasRequests ? 'Location requests pending' : 'Location requests'}
      </div>
    </button>
  )
}

function ApprovalQueueWidget() {
  const navigate = useNavigate()
  type ReviewTicket = {
    id: string
    ticketNumber?: string | null
    company?: { name?: string }
    reviewSignal?: { verdict?: 'green' | 'yellow' | 'red' } | null
  }
  type Resp = {
    tickets: ReviewTicket[]
    total: number
    summary: { green: number; yellow: number; red: number; unscored: number }
  }
  const { data, loading, error } = useFetch<Resp>('/tickets/review-queue')
  if (loading) return <Skeleton />
  if (error) return <ErrorNote message={error} />
  const rows = data?.tickets ?? []
  if (rows.length === 0) return <EmptyNote message="Approval queue is clear." />
  const verdictColor: Record<string, string> = {
    red: 'bg-red-100 text-red-700',
    yellow: 'bg-amber-100 text-amber-700',
    green: 'bg-emerald-100 text-emerald-700',
  }
  return (
    <div>
      {data?.summary && (
        <div className="flex gap-1.5 mb-2 text-[10px] font-semibold">
          {data.summary.red > 0 && (
            <span className="px-1.5 py-0.5 rounded bg-red-100 text-red-700">{data.summary.red} red</span>
          )}
          {data.summary.yellow > 0 && (
            <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">{data.summary.yellow} yellow</span>
          )}
          {data.summary.green > 0 && (
            <span className="px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700">{data.summary.green} green</span>
          )}
          {data.summary.unscored > 0 && (
            <span className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">{data.summary.unscored} unscored</span>
          )}
        </div>
      )}
      <ul className="divide-y divide-slate-100">
        {rows.slice(0, 8).map(r => {
          const verdict = r.reviewSignal?.verdict
          return (
            <li
              key={r.id}
              onClick={() => navigate(`/tickets/${r.id}`)}
              className="py-2 px-2 -mx-2 hover:bg-slate-50 rounded cursor-pointer flex items-center justify-between"
            >
              <div className="min-w-0">
                <div className="text-sm font-medium text-slate-800 truncate">
                  {r.ticketNumber || r.id.slice(0, 8)}
                </div>
                <div className="text-xs text-slate-500 truncate">{r.company?.name || '—'}</div>
              </div>
              {verdict && (
                <span className={cn('text-[10px] font-semibold px-2 py-0.5 rounded uppercase', verdictColor[verdict])}>
                  {verdict}
                </span>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function ReadyToInvoiceWidget() {
  const navigate = useNavigate()
  type Resp = { pipeline?: { ticketsReadyToBill: number; shopWOsReadyToBill: number; ticketQueueTotal: number } }
  const { data, loading, error } = useFetch<Resp>('/dashboard/billing-summary')
  if (loading) return <Skeleton />
  if (error) return <ErrorNote message={error} />
  const p = data?.pipeline
  if (!p) return <EmptyNote message="No pipeline data." />
  return (
    <div
      onClick={() => navigate('/billing')}
      className="cursor-pointer h-full"
    >
      <MetricRow
        icon={FileCheck}
        label="Tickets ready"
        value={p.ticketsReadyToBill}
        hint={`$${p.ticketQueueTotal.toLocaleString()}`}
      />
      <MetricRow icon={FileText} label="Shop WOs ready" value={p.shopWOsReadyToBill} />
    </div>
  )
}

function EnverusStatusWidget() {
  type Resp = { hasIssues: boolean; totalIssues: number; errors: { count: number }; disputed: { count: number } }
  const { data, loading, error } = useFetch<Resp>('/enverus/alerts')
  if (loading) return <Skeleton />
  if (error) return <EmptyNote message="Enverus not configured." />
  if (!data) return <EmptyNote message="No data." />
  if (!data.hasIssues)
    return (
      <div className="text-sm text-emerald-600 flex items-center gap-2">
        <Zap className="w-4 h-4" /> All recent submissions accepted.
      </div>
    )
  return (
    <div>
      <MetricRow icon={AlertTriangle} label="Errors" value={data.errors.count} />
      <MetricRow icon={AlertTriangle} label="Disputed" value={data.disputed.count} />
    </div>
  )
}

function RevenueSummaryWidget() {
  type Resp = { monthToDate?: { total: number } }
  const { data, loading, error } = useFetch<Resp>('/dashboard/billing-summary')
  if (loading) return <Skeleton />
  if (error) return <ErrorNote message={error} />
  const mtd = data?.monthToDate?.total ?? 0
  return (
    <div>
      <MetricRow
        icon={DollarSign}
        label="MTD revenue"
        value={`$${mtd.toLocaleString()}`}
      />
    </div>
  )
}

const ACTIVITY_PERIODS = [
  { key: 'today', label: 'Today' },
  { key: 'week', label: 'This Week' },
  { key: 'month', label: 'This Month' },
] as const

function ActivitySummaryWidget() {
  const navigate = useNavigate()
  const [period, setPeriod] = useState<(typeof ACTIVITY_PERIODS)[number]['key']>('today')
  type Resp = { ticketsClosed: number; dollarsBilled: number }
  const { data, loading, error } = useFetch<Resp>(`/dashboard/period-activity?period=${period}`)

  return (
    <div>
      <div className="flex gap-1 mb-1 text-[11px] font-medium">
        {ACTIVITY_PERIODS.map((p) => (
          <button
            key={p.key}
            onClick={() => setPeriod(p.key)}
            className={cn(
              'px-2 py-1 rounded-full transition-colors',
              period === p.key
                ? 'bg-slate-800 text-white'
                : 'bg-slate-100 text-slate-600 hover:bg-slate-200',
            )}
          >
            {p.label}
          </button>
        ))}
      </div>
      {loading ? (
        <Skeleton />
      ) : error ? (
        <ErrorNote message={error} />
      ) : (
        <div onClick={() => navigate('/tickets')} className="cursor-pointer">
          <MetricRow icon={ClipboardList} label="Tickets closed" value={data?.ticketsClosed ?? 0} />
          <MetricRow icon={DollarSign} label="QB accepted · invoice date" value={`$${(data?.dollarsBilled ?? 0).toLocaleString()}`} />
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Shop Aging (WI-03) - replaced the service board's aging pills
// ---------------------------------------------------------------------------
//
// The pills said "something here is old". These say which units, how old, and
// let you open one. One component, three instances; each instance's bucket and
// threshold live in its own widget config, so the filter is remembered per
// widget per user rather than reset on every login.

const AGING_BUCKETS = [
  { key: 'open',    label: 'Open' },
  { key: 'on_hold', label: 'On Hold' },
  { key: 'waiting', label: 'Waiting on Pickup' },
] as const

// "30" reads as "30 or more days old", so the query is >= not >. 0 = show all.
const AGING_THRESHOLDS = [
  { value: 0,  label: 'Any age' },
  { value: 7,  label: '7+ days' },
  { value: 30, label: '30+ days' },
  { value: 60, label: '60+ days' },
  { value: 90, label: '90+ days' },
] as const

interface AgingRow {
  itemId: string
  workOrderId: string
  workOrderNumber: string
  customer: string
  equipment: string
  serialNumber: string
  status: string
  ageDays: number
  siteName: string
  assigned: string | null
  holdReason: { code: string; label: string; note: string | null } | null
}

interface AgingResp {
  bucket: string
  olderThanDays: number
  count: number
  totalInBucket: number
  rows: AgingRow[]
  truncated: boolean
  siteId: string
  canSeeAllSites: boolean
}

interface SiteOption { id: string; name: string; shortCode: string }

function ShopAgingWidget({ config, onConfigChange }: WidgetProps) {
  const navigate = useNavigate()
  const bucket = typeof config.bucket === 'string' ? config.bucket : 'open'
  const olderThanDays = typeof config.olderThanDays === 'number' ? config.olderThanDays : 30
  const siteId = typeof config.siteId === 'string' ? config.siteId : ''
  const mine = config.mine === true

  const qs = new URLSearchParams({ bucket, olderThanDays: String(olderThanDays) })
  if (siteId) qs.set('siteId', siteId)
  if (mine) qs.set('mine', '1')
  const { data, loading, error } = useFetch<AgingResp>(`/dashboard/shop-aging?${qs}`)

  // Branch selector, supervisors only. Fetched lazily off the same response's
  // canSeeAllSites so a Field Tech never even requests the site list.
  const { data: siteData } = useFetch<{ data: SiteOption[] }>(
    data?.canSeeAllSites ? '/sites' : null,
  )

  const set = (patch: Record<string, unknown>) =>
    onConfigChange({ bucket, olderThanDays, siteId, mine, ...patch })

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex flex-wrap items-center gap-1.5 mb-2">
        {/* The baselines seed one widget per bucket, but a widget added by hand
            from the picker arrives with no config -- without this it would be
            permanently stuck on Open. */}
        <select
          value={bucket}
          onChange={(e) => set({ bucket: e.target.value })}
          className="px-2 py-1 text-[11px] font-semibold border border-slate-200 rounded-md bg-white text-slate-800"
        >
          {AGING_BUCKETS.map((b) => (
            <option key={b.key} value={b.key}>{b.label}</option>
          ))}
        </select>

        <select
          value={olderThanDays}
          onChange={(e) => set({ olderThanDays: Number(e.target.value) })}
          className="px-2 py-1 text-[11px] font-medium border border-slate-200 rounded-md bg-white text-slate-700"
        >
          {AGING_THRESHOLDS.map((t) => (
            <option key={t.value} value={t.value}>{t.label}</option>
          ))}
        </select>

        {data?.canSeeAllSites && (
          <select
            value={siteId}
            onChange={(e) => set({ siteId: e.target.value })}
            className="px-2 py-1 text-[11px] font-medium border border-slate-200 rounded-md bg-white text-slate-700"
          >
            <option value="">My branch</option>
            <option value="all">All branches</option>
            {(siteData?.data ?? []).map((st) => (
              <option key={st.id} value={st.id}>{st.name}</option>
            ))}
          </select>
        )}

        <label className="flex items-center gap-1 text-[11px] text-slate-600 cursor-pointer">
          <input
            type="checkbox"
            checked={mine}
            onChange={(e) => set({ mine: e.target.checked })}
            className="w-3 h-3 accent-slate-700"
          />
          Mine
        </label>
      </div>

      {loading ? (
        <Skeleton />
      ) : error ? (
        <ErrorNote message={error} />
      ) : (
        <>
          <div className="flex items-baseline gap-1.5 mb-2">
            <span className="text-2xl font-bold text-slate-900">{data?.count ?? 0}</span>
            <span className="text-[11px] text-slate-400">
              of {data?.totalInBucket ?? 0}{' '}
              {AGING_BUCKETS.find((b) => b.key === bucket)?.label.toLowerCase()}
            </span>
          </div>

          {(data?.rows.length ?? 0) === 0 ? (
            <EmptyNote message="Nothing this old. " />
          ) : (
            <ul className="flex-1 min-h-0 overflow-auto divide-y divide-slate-100 -mx-1">
              {data!.rows.map((r) => (
                <li key={r.itemId}>
                  <button
                    onClick={() => navigate(`/shop/${r.workOrderId}`)}
                    className="w-full text-left px-1 py-1.5 hover:bg-slate-50 rounded"
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-xs font-semibold text-slate-800 truncate">
                        {r.workOrderNumber}
                      </span>
                      <span className="text-[11px] font-bold text-slate-500 shrink-0">
                        {r.ageDays}d
                      </span>
                    </div>
                    <div className="text-[11px] text-slate-500 truncate">
                      {r.customer} - {r.equipment}
                      {r.holdReason && <> - {r.holdReason.label}</>}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {/* Never let a capped list read as a complete one. */}
          {data?.truncated && (
            <div className="text-[10px] text-slate-400 pt-1">
              Showing the oldest {data.rows.length} of {data.count}.
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Due for Follow-up (WI-10)
// ---------------------------------------------------------------------------

interface FollowUpRow {
  workOrderId: string
  workOrderNumber: string
  companyName: string | null
  siteCode: string | null
  party: 'customer' | 'vendor'
  note: string
  followUpAt: string
  enteredByName: string | null
  overdue: boolean
  overdueLabel: string
}
interface FollowUpResp {
  rows: FollowUpRow[]
  overdueCount: number
  canSeeAllSites: boolean
  withinDays: number
}

// ---------------------------------------------------------------------------
// Background Jobs — the supervisor snapshot from #126, which shipped an
// endpoint and no reader.
// ---------------------------------------------------------------------------

interface ProcessorRow {
  name: string
  running: boolean
  /** False ⇒ never started, because the integration isn't configured. */
  everBeat: boolean
  lastBeatAgoMs: number | null
  stallMs: number
  restarts: number
  givenUp: boolean
}

/** "4m" / "2h" / "18s" — coarse on purpose; exact ms is noise at a glance. */
function agoLabel(ms: number | null): string {
  if (ms === null) return 'never'
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`
  return `${Math.round(ms / 3_600_000)}h`
}

function BackgroundJobsWidget() {
  const navigate = useNavigate()
  const { data, loading, error } = useFetch<{ processors: ProcessorRow[] }>('/admin/ops/processors')

  if (loading) return <Skeleton />
  if (error) return <ErrorNote message={error} />

  const rows = data?.processors ?? []
  // An empty list is not "all healthy" — it means the supervisor registered
  // nothing, which is itself worth saying rather than showing a green tick.
  if (rows.length === 0) return <EmptyNote message="No processors registered." />

  // Three states, not two. A processor that has never beaten is not a fault:
  // either its start() self-skipped because the integration isn't configured
  // (BlueLion, Novara and the S3 uploader all do this), or it simply hasn't
  // reached its first tick yet — rental-bill's interval is measured in hours.
  // The watchdog ignores both, so this widget must not paint them red; a
  // permanent row of red for every switched-off integration is how a health
  // display stops being read at all.
  //
  // Called "idle" rather than "not configured" on purpose: everBeat alone
  // cannot tell those two apart, and claiming a cause the data doesn't carry
  // is how someone ends up hunting a config bug that was really just uptime.
  const idle = rows.filter(r => !r.everBeat && !r.givenUp)
  // givenUp is the loud one: the watchdog burned its restart budget and
  // stopped trying, so that job is down until someone redeploys.
  const givenUp = rows.filter(r => r.givenUp)
  const stalled = rows.filter(r => r.everBeat && !r.running && !r.givenUp)
  const restarts = rows.reduce((n, r) => n + r.restarts, 0)
  const unhealthy = [...givenUp, ...stalled]
  const watched = rows.length - idle.length

  return (
    <div>
      {unhealthy.length === 0 ? (
        <div className="text-sm text-emerald-600 flex items-center gap-2 py-2">
          <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
          <span>
            {watched === 0
              ? 'No processors beating yet.'
              : `All ${watched} active processor${watched === 1 ? '' : 's'} beating.`}
          </span>
        </div>
      ) : (
        <div className="space-y-1.5 py-1">
          {unhealthy.map(r => (
            <div key={r.name} className="flex items-center justify-between gap-2 text-sm">
              <span className="flex items-center gap-1.5 min-w-0">
                <AlertTriangle className={cn(
                  'w-3.5 h-3.5 flex-shrink-0',
                  r.givenUp ? 'text-red-500' : 'text-amber-500',
                )} />
                <span className="font-mono text-xs truncate text-slate-700">{r.name}</span>
              </span>
              <span className={cn(
                'text-[11px] font-medium flex-shrink-0',
                r.givenUp ? 'text-red-600' : 'text-amber-600',
              )}>
                {r.givenUp ? 'gave up' : `stalled ${agoLabel(r.lastBeatAgoMs)}`}
              </span>
            </div>
          ))}
          <div className="text-[11px] text-slate-400 pt-0.5">
            {watched - unhealthy.length} of {watched} beating
          </div>
        </div>
      )}

      {/* Named rather than hidden: "7 of 10" with no explanation reads as three
          broken jobs. Listing them is the difference between a number someone
          trusts and one they learn to ignore. */}
      {idle.length > 0 && (
        <div className="text-[11px] text-slate-400 pt-1">
          {idle.length} idle, no heartbeat yet: {idle.map(r => r.name).join(', ')}
        </div>
      )}

      {/* Restarts are worth surfacing even when everything is currently green:
          a job that keeps dying and coming back reads as healthy right now. */}
      {restarts > 0 && (
        <MetricRow icon={HeartPulse} label="Watchdog restarts" value={restarts} />
      )}

      <button
        onClick={() => navigate('/admin/ops')}
        className="mt-1 text-xs text-blue-600 hover:text-blue-700 hover:underline"
      >
        Ops dashboard →
      </button>
    </div>
  )
}

const FOLLOW_UP_HORIZONS = [
  { value: 0, label: 'Overdue only' },
  { value: 3, label: '+ next 3 days' },
  { value: 7, label: '+ next 7 days' },
]

/**
 * The commitments that have come due.
 *
 * Pairs with Shop Aging, which answers "what has been sitting a long time".
 * This answers the more actionable version: "what did we PROMISE, and has that
 * moment passed". A job waiting 40 days that a vendor swore blind would ship
 * Friday is a different problem from one nobody has touched.
 */
function FollowUpsDueWidget({ config, onConfigChange }: WidgetProps) {
  const navigate = useNavigate()
  const withinDays = typeof config.withinDays === 'number' ? config.withinDays : 0
  const siteId = typeof config.siteId === 'string' ? config.siteId : ''

  const qs = new URLSearchParams({ withinDays: String(withinDays) })
  if (siteId) qs.set('siteId', siteId)
  const { data, loading, error } = useFetch<FollowUpResp>(`/dashboard/follow-ups-due?${qs}`)

  const { data: siteData } = useFetch<{ data: SiteOption[] }>(
    data?.canSeeAllSites ? '/sites' : null,
  )

  const set = (patch: Record<string, unknown>) =>
    onConfigChange({ withinDays, siteId, ...patch })

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex flex-wrap items-center gap-1.5 mb-2">
        <select
          value={withinDays}
          onChange={(e) => set({ withinDays: Number(e.target.value) })}
          className="px-2 py-1 text-[11px] font-semibold border border-slate-200 rounded-md bg-white text-slate-800"
        >
          {FOLLOW_UP_HORIZONS.map((h) => (
            <option key={h.value} value={h.value}>{h.label}</option>
          ))}
        </select>

        {data?.canSeeAllSites && (
          <select
            value={siteId}
            onChange={(e) => set({ siteId: e.target.value })}
            className="px-2 py-1 text-[11px] font-medium border border-slate-200 rounded-md bg-white text-slate-700"
          >
            <option value="">My branch</option>
            <option value="all">All branches</option>
            {(siteData?.data ?? []).map((st) => (
              <option key={st.id} value={st.id}>{st.name}</option>
            ))}
          </select>
        )}
      </div>

      {loading ? (
        <Skeleton />
      ) : error ? (
        <ErrorNote message={error} />
      ) : (
        <>
          <div className="flex items-baseline gap-1.5 mb-2">
            <span className="text-2xl font-bold text-slate-900">{data?.overdueCount ?? 0}</span>
            <span className="text-[11px] text-slate-400">overdue</span>
          </div>

          {(data?.rows.length ?? 0) === 0 ? (
            <EmptyNote message="Nothing due. " />
          ) : (
            <ul className="flex-1 min-h-0 overflow-auto divide-y divide-slate-100 -mx-1">
              {data!.rows.map((r) => (
                <li key={r.workOrderId}>
                  <button
                    onClick={() => navigate(`/shop/${r.workOrderId}`)}
                    className="w-full text-left px-1 py-1.5 hover:bg-slate-50 rounded"
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-xs font-semibold text-slate-800 truncate">
                        {r.workOrderNumber}
                      </span>
                      <span className={cn(
                        'text-[11px] font-bold shrink-0',
                        r.overdue ? 'text-amber-600' : 'text-slate-400',
                      )}>
                        {r.overdueLabel}
                      </span>
                    </div>
                    <div className="text-[11px] text-slate-500 truncate">
                      <span className="uppercase font-semibold text-slate-400">{r.party}</span>
                      {r.companyName && <> - {r.companyName}</>}
                      {r.note && <> - {r.note}</>}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface WidgetRegistryEntry {
  Component: React.ComponentType<WidgetProps>
  icon: React.ElementType
  variant?: 'panel' | 'action'
  /**
   * Per-instance frame title. Only needed where one widget type is added more
   * than once with different settings (Shop Aging) -- otherwise the catalog
   * label is the title, and three frames all reading "Shop Aging" would be
   * useless.
   */
  title?: (config: Record<string, unknown>) => string
}

export const WIDGET_REGISTRY: Record<WidgetType, WidgetRegistryEntry> = {
  internal_shop_value: { Component: InternalShopValueWidget, icon: DollarSign },
  my_tickets: { Component: MyTicketsWidget, icon: ClipboardList },
  quick_actions: { Component: QuickActionsWidget, icon: Plus },
  unassigned_tickets: { Component: UnassignedTicketsWidget, icon: AlertTriangle },
  coverage_status: { Component: CoverageStatusWidget, icon: Wind },
  team_activity: { Component: TeamActivityWidget, icon: Users },
  pending_location_requests: { Component: PendingLocationRequestsWidget, icon: MapPin, variant: 'action' },
  approval_queue: { Component: ApprovalQueueWidget, icon: FileCheck },
  ready_to_invoice: { Component: ReadyToInvoiceWidget, icon: FileText },
  enverus_status: { Component: EnverusStatusWidget, icon: Zap },
  qb_sync_queue: { Component: QbSyncQueueWidget, icon: FileText },
  revenue_summary: { Component: RevenueSummaryWidget, icon: DollarSign },
  ticket_volume: { Component: TicketVolumeWidget, icon: TrendingUp },
  activity_summary: { Component: ActivitySummaryWidget, icon: ClipboardList },
  shop_aging: {
    Component: ShopAgingWidget,
    icon: Hourglass,
    title: (c) => AGING_BUCKETS.find(b => b.key === c.bucket)?.label ?? 'Shop Aging',
  },
  follow_ups_due: { Component: FollowUpsDueWidget, icon: CalendarClock },
  background_jobs: { Component: BackgroundJobsWidget, icon: HeartPulse },
}
