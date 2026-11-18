import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '@/lib/api'
import { cn } from '@/lib/cn'
import { useAuth } from '@/contexts/AuthContext'
import { CustomerSearch } from '@/components/CustomerSearch'
import { NovaraOpsCard } from '@/components/NovaraOpsCard'
import type { QbDivision } from '@/lib/qbDivision'
import {
  Activity,
  AlertTriangle,
  Bug,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  DollarSign,
  FileSignature,
  GraduationCap,
  Loader2,
  RefreshCw,
  Timer,
  Truck,
  Eye,
  Zap,
} from 'lucide-react'

interface OpsSummary {
  generatedAt: string
  tickets: {
    byStatus: Record<string, number>
    stuck: {
      supervisorReviewOver4h: number
      awaitingSignatureOver8h: number
    }
  }
  qb: {
    byStatus: Record<string, number>
    pendingConversion: {
      total: number
      over1d: number
      over3d: number
    }
    diff?: {
      diverged: number
      neverChecked: number
    }
  }
  enverus: {
    byStatus: Record<string, number>
  }
  bluelion: {
    byStatus: Record<string, number>
  }
  signatures: {
    pending: number
    over48h: number
  }
  shop?: {
    /**
     * Field-inspection intakes whose "return to shop" pick never became a
     * transfer event, so the gear is parked at the intake site while the tech
     * believes it's on its way. Keyed by cause: unknown_short_code (a device
     * sent a code no site carries) vs site_inactive (a shop techs still select
     * was deactivated). Self-clearing — a WO that has since transited, by any
     * route, drops out of the count.
     *
     * Optional because a server that predates this field returns no `shop` key.
     */
    transitFailed: {
      total: number
      byReason: Record<string, number>
    }
  }
}

interface BlueLionCandidate {
  id: string
  full_name: string
  employer?: string | null
  last_trained_on?: string | null
}

interface BlueLionQueueRow {
  id: string
  entityType: string
  externalId: string
  status: string
  resultStatus: string | null
  errorMessage: string | null
  retryCount: number
  createdAt: string
  candidates: BlueLionCandidate[] | null
}

interface JobInfo {
  jobName: string
  startedAt: string
  finishedAt: string | null
  status: 'running' | 'success' | 'error' | 'skipped'
  durationMs: number | null
  errorMessage: string | null
  recentLastHour: { error: number; skipped: number; success: number }
}

interface JobsResponse {
  jobs: JobInfo[]
}

interface PortalPreviewCustomer {
  id: string
  name: string
  companyType: string
  city: string | null
  state: string | null
  cashCcOnly?: boolean
  creditHold?: boolean
  assignedFieldNames?: string[]
}

const REFRESH_MS = 30_000

const TICKET_STATUS_ORDER = [
  'draft', 'dispatched', 'in_progress', 'completed',
  'supervisor_review', 'awaiting_signature', 'billing_queue',
  'invoiced', 'closed',
]

const QB_STATUS_ORDER = ['pending', 'sent', 'success', 'error', 'skipped']
const ENVERUS_STATUS_ORDER = ['pending', 'submitted', 'accepted', 'rejected', 'error', 'retrying']
const BLUELION_STATUS_ORDER = ['pending', 'retrying', 'synced', 'needs_attention', 'error']

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' })
  } catch { return iso }
}

/**
 * Time-of-day alone is a lie on a queue holding backfilled history — a row from
 * March reads as "9:59 AM" like it landed this morning. Date shown unless the
 * row is from today.
 */
function fmtWhen(iso: string): string {
  try {
    const d = new Date(iso)
    const today = new Date()
    const sameDay = d.toDateString() === today.toDateString()
    return sameDay
      ? d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
      : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) +
        (d.getFullYear() === today.getFullYear() ? '' : ` ${d.getFullYear()}`) +
        ', ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  } catch { return iso }
}

export function AdminOpsPage() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const [data, setData] = useState<OpsSummary | null>(null)
  const [jobs, setJobs] = useState<JobInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastLoadedAt, setLastLoadedAt] = useState<Date | null>(null)
  const [divisionFilter, setDivisionFilter] = useState<'' | QbDivision>('')
  const [dickinsonFilter, setDickinsonFilter] = useState<'' | 'true' | 'false'>('')
  const [portalPreviewCustomer, setPortalPreviewCustomer] = useState<PortalPreviewCustomer | null>(null)
  const loadingRef = useRef(false)
  const jobsLoadingRef = useRef(false)
  const canPreviewPortal = user?.role === 'platform_admin'

  async function load() {
    if (loadingRef.current) return // drop overlapping polls
    loadingRef.current = true
    // A slow history request must not hold the health summary behind a spinner
    // or prevent its next poll. Keep at most one jobs request in flight.
    if (!jobsLoadingRef.current) {
      jobsLoadingRef.current = true
      void api.get<JobsResponse>('/admin/jobs')
        .then(jobsRes => setJobs(jobsRes.jobs ?? []))
        .catch(() => { /* Preserve the last known jobs during a transient failure. */ })
        .finally(() => { jobsLoadingRef.current = false })
    }
    try {
      const params = new URLSearchParams()
      if (divisionFilter) params.set('division', divisionFilter)
      if (dickinsonFilter) params.set('dickinson', dickinsonFilter)
      const qs = params.toString()
      const summary = await api.get<OpsSummary>(`/admin/ops/summary${qs ? `?${qs}` : ''}`)
      setData(summary)
      setError(null)
      setLastLoadedAt(new Date())
    } catch (e: any) {
      setError(e?.message || 'Failed to load ops summary')
    } finally {
      loadingRef.current = false
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    const t = setInterval(load, REFRESH_MS)
    return () => clearInterval(t)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [divisionFilter, dickinsonFilter])

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 text-slate-400 animate-spin" />
      </div>
    )
  }

  if (error && !data) {
    return (
      <div className="max-w-2xl mx-auto p-4 bg-red-50 border border-red-200 rounded-lg">
        <p className="text-sm text-red-800 font-medium">Unable to load ops summary</p>
        <p className="text-xs text-red-600 mt-1">{error}</p>
      </div>
    )
  }

  if (!data) return null

  const totalStuck =
    data.tickets.stuck.supervisorReviewOver4h +
    data.tickets.stuck.awaitingSignatureOver8h +
    data.qb.pendingConversion.over3d +
    (data.qb.byStatus.error || 0) +
    (data.enverus.byStatus.error || 0) +
    (data.enverus.byStatus.rejected || 0) +
    (data.bluelion.byStatus.error || 0) +
    (data.bluelion.byStatus.needs_attention || 0) +
    data.signatures.over48h +
    (data.shop?.transitFailed.total || 0)

  function openCustomerPortalPreview() {
    if (!portalPreviewCustomer) return
    sessionStorage.setItem('sundog_portal_preview_company_id', portalPreviewCustomer.id)
    sessionStorage.setItem('sundog_portal_preview_company_name', portalPreviewCustomer.name)
    navigate(`/portal?previewCompanyId=${encodeURIComponent(portalPreviewCustomer.id)}`)
  }

  return (
    <div className="max-w-6xl mx-auto pb-12">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between mb-5">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
            <Activity className="w-6 h-6 text-blue-600" />
            Ops Dashboard
          </h1>
          <p className="text-xs text-slate-500 mt-0.5">
            Platform health · refreshes every 30s
            {lastLoadedAt && <> · last: {fmtTime(lastLoadedAt.toISOString())}</>}
          </p>
        </div>
        <div className="flex flex-col gap-3 lg:items-end">
          <button
            onClick={() => load()}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100 rounded-lg self-start lg:self-end"
          >
            <RefreshCw className={cn('w-4 h-4', loading && 'animate-spin')} />
            Refresh
          </button>
          {canPreviewPortal && (
            <div className="bg-white border border-slate-200 rounded-lg p-3 w-full lg:w-[420px] shadow-sm">
              <div className="flex items-center justify-between gap-3 mb-2">
                <div>
                  <p className="text-sm font-semibold text-slate-900">Customer View</p>
                  <p className="text-xs text-slate-500">Preview the external portal.</p>
                </div>
                <button
                  type="button"
                  onClick={openCustomerPortalPreview}
                  disabled={!portalPreviewCustomer}
                  className="inline-flex items-center gap-2 px-3 py-2 rounded-md bg-blue-700 text-white text-sm font-semibold hover:bg-blue-800 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Eye className="w-4 h-4" />
                  Open
                </button>
              </div>
              <CustomerSearch value={portalPreviewCustomer} onChange={setPortalPreviewCustomer} />
            </div>
          )}
        </div>
      </div>

      {/* Division (QB Class) filter */}
      <div className="flex flex-wrap items-center gap-2 mb-4 p-3 bg-white rounded-lg border border-slate-200">
        <span className="text-xs font-medium text-slate-500 uppercase tracking-wide mr-1">Filter</span>
        <select
          value={divisionFilter}
          onChange={e => setDivisionFilter(e.target.value as '' | QbDivision)}
          className="px-2 py-1 text-sm border border-slate-300 rounded bg-white"
        >
          <option value="">All divisions</option>
          <option value="D1">D1 (Training)</option>
          <option value="D2">D2 (Consulting)</option>
          <option value="D3">D3 (Safety Service)</option>
          <option value="D4">D4 (On Site)</option>
          <option value="D5">D5 (Store)</option>
          <option value="D6">D6 (FEX)</option>
          <option value="D7">D7 (Sky Shield)</option>
          <option value="D8">D8 (Occ Health)</option>
        </select>
        <select
          value={dickinsonFilter}
          onChange={e => setDickinsonFilter(e.target.value as '' | 'true' | 'false')}
          className="px-2 py-1 text-sm border border-slate-300 rounded bg-white"
        >
          <option value="">Dickinson: any</option>
          <option value="true">Dickinson only</option>
          <option value="false">Non-Dickinson</option>
        </select>
        {(divisionFilter || dickinsonFilter) && (
          <button
            onClick={() => { setDivisionFilter(''); setDickinsonFilter('') }}
            className="text-xs text-slate-500 hover:text-slate-700 ml-1"
          >
            clear
          </button>
        )}
      </div>

      {/* Top-line banner */}
      <div className={cn(
        'mb-5 rounded-lg border p-4 flex items-center gap-3',
        totalStuck === 0
          ? 'bg-emerald-50 border-emerald-200'
          : 'bg-amber-50 border-amber-200',
      )}>
        {totalStuck === 0 ? (
          <>
            <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
            <div>
              <p className="text-sm font-semibold text-emerald-900">All systems nominal</p>
              <p className="text-xs text-emerald-700">Nothing stuck past threshold.</p>
            </div>
          </>
        ) : (
          <>
            <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0" />
            <div>
              <p className="text-sm font-semibold text-amber-900">{totalStuck} item{totalStuck !== 1 ? 's' : ''} need attention</p>
              <p className="text-xs text-amber-700">Review the flagged counts below.</p>
            </div>
          </>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Tickets */}
        <Card
          icon={<Zap className="w-5 h-5 text-blue-600" />}
          title="Tickets"
          onClick={() => navigate('/tickets')}
        >
          <StatusGrid
            order={TICKET_STATUS_ORDER}
            counts={data.tickets.byStatus}
          />
          <StuckRow
            label="supervisor_review > 4h"
            count={data.tickets.stuck.supervisorReviewOver4h}
          />
          <StuckRow
            label="awaiting_signature > 8h"
            count={data.tickets.stuck.awaitingSignatureOver8h}
          />
        </Card>

        {/* QuickBooks */}
        <Card
          icon={<DollarSign className="w-5 h-5 text-indigo-600" />}
          title="QuickBooks Sync"
          onClick={() => navigate('/billing')}
        >
          <StatusGrid
            order={QB_STATUS_ORDER}
            counts={data.qb.byStatus}
            highlight={{ error: 'red' }}
          />
          <div className="mt-3 pt-3 border-t border-slate-100">
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1.5">
              Pending SO → Invoice Conversion
            </p>
            <div className="grid grid-cols-3 gap-2 text-center">
              <MiniStat label="total" value={data.qb.pendingConversion.total} />
              <MiniStat label=">1 day" value={data.qb.pendingConversion.over1d} tone={data.qb.pendingConversion.over1d > 0 ? 'warn' : undefined} />
              <MiniStat label=">3 days" value={data.qb.pendingConversion.over3d} tone={data.qb.pendingConversion.over3d > 0 ? 'bad' : undefined} />
            </div>
          </div>
          {data.qb.diff && (
            <div className="mt-3 pt-3 border-t border-slate-100">
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1.5">
                Invoice Diff (SP ↔ QB)
              </p>
              <div className="grid grid-cols-2 gap-2 text-center">
                <MiniStat
                  label="diverged"
                  value={data.qb.diff.diverged}
                  tone={data.qb.diff.diverged > 0 ? 'bad' : undefined}
                />
                <MiniStat
                  label="never checked"
                  value={data.qb.diff.neverChecked}
                />
              </div>
            </div>
          )}
          <div className="mt-3 pt-3 border-t border-slate-100">
            <GankNowButtons />
          </div>
          <div className="mt-3 pt-3 border-t border-slate-100">
            <FailedQbSyncs failedCount={data.qb.byStatus.error || 0} onChanged={load} />
          </div>
          <div className="mt-3 pt-3 border-t border-slate-100">
            <QbSalesTaxReconcile />
          </div>
          <div className="mt-3 pt-3 border-t border-slate-100">
            <QbCustomerReview />
          </div>
        </Card>

        {/* Enverus */}
        <Card
          icon={<FileSignature className="w-5 h-5 text-cyan-600" />}
          title="Enverus Submissions"
        >
          <StatusGrid
            order={ENVERUS_STATUS_ORDER}
            counts={data.enverus.byStatus}
            highlight={{ error: 'red', rejected: 'red', retrying: 'amber' }}
          />
        </Card>

        {/* BlueLion cert push */}
        <Card
          icon={<GraduationCap className="w-5 h-5 text-orange-600" />}
          title="BlueLion Cert Push"
        >
          <StatusGrid
            order={BLUELION_STATUS_ORDER}
            counts={data.bluelion.byStatus}
            highlight={{ error: 'red', needs_attention: 'amber', retrying: 'amber' }}
          />
          <div className="mt-3 pt-3 border-t border-slate-100">
            <BlueLionQueue
              attentionCount={(data.bluelion.byStatus.needs_attention || 0) + (data.bluelion.byStatus.error || 0)}
              errorCount={data.bluelion.byStatus.error || 0}
              onChanged={load}
            />
          </div>
        </Card>

        {/* Signatures */}
        <Card
          icon={<Clock className="w-5 h-5 text-violet-600" />}
          title="Signature Requests"
        >
          <div className="grid grid-cols-2 gap-2">
            <MiniStat label="pending" value={data.signatures.pending} />
            <MiniStat label="> 48h" value={data.signatures.over48h} tone={data.signatures.over48h > 0 ? 'warn' : undefined} />
          </div>
        </Card>

        {/* Shop transit misses.
            Unlike every other card here this one counts PHYSICAL EQUIPMENT, not
            queue depth — each unit is gear a tech handed off toward a shop that
            never got an inbound card for it. So any non-zero value is a
            warn tone; there is no healthy backlog. */}
        {data.shop && (
          <Card
            icon={<Truck className="w-5 h-5 text-orange-600" />}
            title="Shop Transit Not Created"
          >
            <div className="grid grid-cols-2 gap-2">
              <MiniStat
                label="work orders"
                value={data.shop.transitFailed.total}
                tone={data.shop.transitFailed.total > 0 ? 'warn' : undefined}
              />
              <MiniStat
                label="bad short code"
                value={data.shop.transitFailed.byReason.unknown_short_code || 0}
                tone={data.shop.transitFailed.byReason.unknown_short_code ? 'warn' : undefined}
              />
              <MiniStat
                label="site deactivated"
                value={data.shop.transitFailed.byReason.site_inactive || 0}
                tone={data.shop.transitFailed.byReason.site_inactive ? 'warn' : undefined}
              />
            </div>
            {data.shop.transitFailed.total > 0 && (
              <p className="mt-2 text-xs text-slate-500">
                Gear intake'd in the field with a return shop that couldn't be resolved. It's sitting
                at the intake site and no shop is expecting it.
              </p>
            )}
          </Card>
        )}

        <NovaraOpsCard refreshedAt={lastLoadedAt} onChanged={load} />

        {/* Background Jobs */}
        <Card
          icon={<Timer className="w-5 h-5 text-emerald-600" />}
          title="Background Jobs"
        >
          {jobs.length === 0 ? (
            <p className="text-xs text-slate-400 italic px-1 py-2">
              No jobs have run yet — wait a minute and refresh.
            </p>
          ) : (
            <div className="space-y-1.5">
              {jobs.map(j => <JobRow key={j.jobName} job={j} />)}
            </div>
          )}
        </Card>
      </div>

      <div className="mt-4">
        <BugReportsPanel />
      </div>

      <p className="text-[11px] text-slate-400 text-center mt-8">
        serviced by <span className="font-medium">WelshIT</span>
      </p>
    </div>
  )
}

// ─── Bug reports / feature requests ─────────────────────────

interface BugReportItem {
  id: string
  type: 'bug' | 'feature'
  title: string
  description: string | null
  reporterName: string | null
  reporterEmail: string | null
  reporterRole: string | null
  route: string | null
  context: Record<string, unknown> | null
  logs: { ts: number; level: string; text: string }[] | null
  screenshotKey: string | null
  emailed: boolean
  status: 'open' | 'resolved'
  createdAt: string
}

function relTime(iso: string): string {
  try {
    const diff = Date.now() - new Date(iso).getTime()
    const m = Math.floor(diff / 60000)
    if (m < 1) return 'just now'
    if (m < 60) return `${m}m ago`
    const h = Math.floor(m / 60)
    if (h < 24) return `${h}h ago`
    return `${Math.floor(h / 24)}d ago`
  } catch { return iso }
}

function BugReportsPanel() {
  const [reports, setReports] = useState<BugReportItem[]>([])
  const [openCount, setOpenCount] = useState(0)
  const [loaded, setLoaded] = useState(false)
  const [showResolved, setShowResolved] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)

  async function load() {
    try {
      const res = await api.get<{ reports: BugReportItem[]; openCount: number }>(
        `/admin/bug-reports${showResolved ? '' : '?status=open'}`,
      )
      setReports(res.reports)
      setOpenCount(res.openCount)
    } catch {
      // leave previous state
    } finally {
      setLoaded(true)
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showResolved])

  async function setStatus(id: string, status: 'open' | 'resolved') {
    try {
      await api.patch(`/admin/bug-reports/${id}`, { status })
      load()
    } catch { /* ignore */ }
  }

  return (
    <div className="bg-white rounded-lg border border-slate-200 p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-semibold text-slate-800 flex items-center gap-2">
          <Bug className="w-5 h-5 text-rose-600" />
          Bug Reports &amp; Feature Requests
          {openCount > 0 && (
            <span className="text-xs font-medium bg-rose-100 text-rose-700 rounded-full px-2 py-0.5">
              {openCount} open
            </span>
          )}
        </h2>
        <label className="flex items-center gap-1.5 text-xs text-slate-500 cursor-pointer">
          <input type="checkbox" checked={showResolved} onChange={e => setShowResolved(e.target.checked)} />
          Show resolved
        </label>
      </div>

      {!loaded ? (
        <p className="text-xs text-slate-400 py-2">Loading…</p>
      ) : reports.length === 0 ? (
        <p className="text-xs text-slate-400 italic py-2">
          {showResolved ? 'No reports yet.' : 'No open reports — nice.'}
        </p>
      ) : (
        <div className="divide-y divide-slate-100">
          {reports.map(r => (
            <div key={r.id} className="py-2.5">
              <div className="flex items-start gap-2">
                <span className={cn(
                  'text-[10px] font-bold uppercase rounded px-1.5 py-0.5 shrink-0 mt-0.5',
                  r.type === 'bug' ? 'bg-rose-100 text-rose-700' : 'bg-indigo-100 text-indigo-700',
                )}>
                  {r.type}
                </span>
                <div className="flex-1 min-w-0">
                  <button
                    onClick={() => setExpanded(expanded === r.id ? null : r.id)}
                    className="text-left w-full"
                  >
                    <p className="text-sm font-medium text-slate-800 truncate">{r.title}</p>
                    <p className="text-xs text-slate-500">
                      {r.reporterName || 'unknown'}
                      {r.reporterRole && ` · ${r.reporterRole.replace('_', ' ')}`}
                      {' · '}{relTime(r.createdAt)}
                      {r.route && <> · <span className="font-mono">{r.route}</span></>}
                      {!r.emailed && <span className="text-amber-600"> · not emailed</span>}
                    </p>
                  </button>

                  {expanded === r.id && (
                    <div className="mt-2 space-y-2">
                      {r.description && (
                        <p className="text-sm text-slate-700 whitespace-pre-wrap bg-slate-50 rounded p-2">{r.description}</p>
                      )}
                      {r.reporterEmail && (
                        <p className="text-xs text-slate-500">Reply to: {r.reporterEmail}</p>
                      )}
                      {r.screenshotKey && <ScreenshotImg keyPath={r.screenshotKey} />}
                      {r.logs && r.logs.length > 0 && (
                        <details className="text-xs">
                          <summary className="cursor-pointer text-slate-500">Console logs ({r.logs.length})</summary>
                          <pre className="mt-1 bg-slate-900 text-slate-200 rounded p-2 overflow-auto max-h-48 whitespace-pre-wrap">
                            {r.logs.map(l => `${new Date(l.ts).toLocaleTimeString()} [${l.level}] ${l.text}`).join('\n')}
                          </pre>
                        </details>
                      )}
                    </div>
                  )}
                </div>

                <button
                  onClick={() => setStatus(r.id, r.status === 'open' ? 'resolved' : 'open')}
                  className={cn(
                    'text-xs rounded px-2 py-1 shrink-0',
                    r.status === 'open'
                      ? 'text-emerald-700 hover:bg-emerald-50'
                      : 'text-slate-400 hover:bg-slate-100',
                  )}
                >
                  {r.status === 'open' ? 'Resolve' : 'Reopen'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** Fetches an auth-gated stored image and renders it via a blob URL. */
function ScreenshotImg({ keyPath }: { keyPath: string }) {
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let objUrl: string | null = null
    let cancelled = false
    const token = localStorage.getItem('sundog_token')
    fetch(`/api/files/${keyPath}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then(r => (r.ok ? r.blob() : Promise.reject(new Error('load failed'))))
      .then(b => {
        if (cancelled) return
        objUrl = URL.createObjectURL(b)
        setUrl(objUrl)
      })
      .catch(() => setFailed(true))
    return () => {
      cancelled = true
      if (objUrl) URL.revokeObjectURL(objUrl)
    }
  }, [keyPath])

  if (failed) return <p className="text-xs text-slate-400">Screenshot unavailable.</p>
  if (!url) return <p className="text-xs text-slate-400">Loading screenshot…</p>
  return <img src={url} alt="report screenshot" className="rounded border border-slate-200 max-w-full" />
}

// ─── Sub-components ──────────────────────────────────────────

function Card({ icon, title, onClick, children }: {
  icon: React.ReactNode
  title: string
  onClick?: () => void
  children: React.ReactNode
}) {
  return (
    <div className="bg-white rounded-lg border border-slate-200 p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          {icon}
          <h2 className="font-semibold text-slate-900">{title}</h2>
        </div>
        {onClick && (
          <button
            onClick={onClick}
            className="text-xs text-blue-600 hover:text-blue-800 font-medium"
          >
            Open →
          </button>
        )}
      </div>
      <div className="space-y-2">{children}</div>
    </div>
  )
}

function StatusGrid({ order, counts, highlight }: {
  order: string[]
  counts: Record<string, number>
  highlight?: Record<string, 'red' | 'amber'>
}) {
  return (
    <div className="grid grid-cols-3 gap-1.5">
      {order.map(status => {
        const count = counts[status] || 0
        const tone = count > 0 ? highlight?.[status] : undefined
        return (
          <div
            key={status}
            className={cn(
              'flex flex-col px-2 py-1.5 rounded border text-center',
              tone === 'red' ? 'bg-red-50 border-red-200' :
              tone === 'amber' ? 'bg-amber-50 border-amber-200' :
              count === 0 ? 'bg-slate-50 border-slate-100' : 'bg-white border-slate-200',
            )}
          >
            <span className={cn(
              'text-lg font-bold leading-tight',
              tone === 'red' ? 'text-red-700' :
              tone === 'amber' ? 'text-amber-700' :
              count === 0 ? 'text-slate-400' : 'text-slate-900',
            )}>{count}</span>
            <span className="text-[10px] text-slate-500 truncate" title={status}>
              {status.replace(/_/g, ' ')}
            </span>
          </div>
        )
      })}
    </div>
  )
}

function StuckRow({ label, count }: { label: string; count: number }) {
  return (
    <div className={cn(
      'flex items-center justify-between px-3 py-2 rounded border text-sm',
      count > 0
        ? 'bg-amber-50 border-amber-200 text-amber-800'
        : 'bg-slate-50 border-slate-100 text-slate-500',
    )}>
      <span>{label}</span>
      <span className="font-bold">{count}</span>
    </div>
  )
}

function MiniStat({ label, value, tone }: {
  label: string
  value: number
  tone?: 'warn' | 'bad'
}) {
  return (
    <div className={cn(
      'rounded border px-2 py-1.5',
      tone === 'bad' ? 'bg-red-50 border-red-200' :
      tone === 'warn' ? 'bg-amber-50 border-amber-200' :
      'bg-slate-50 border-slate-100',
    )}>
      <p className={cn(
        'text-base font-bold leading-tight',
        tone === 'bad' ? 'text-red-700' :
        tone === 'warn' ? 'text-amber-700' :
        value === 0 ? 'text-slate-400' : 'text-slate-900',
      )}>{value}</p>
      <p className="text-[10px] text-slate-500">{label}</p>
    </div>
  )
}

function GankNowButtons() {
  const [busy, setBusy] = useState<string | null>(null)
  const [result, setResult] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null)

  async function trigger(label: string, path: string) {
    setBusy(label)
    setResult(null)
    try {
      const res = await api.post<{ queued: boolean; message: string }>(path, {})
      setResult({ kind: 'ok', msg: res.message })
    } catch (e: any) {
      setResult({ kind: 'err', msg: e?.message || 'Failed' })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div>
      <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1.5">
        Sync now (gank from QB)
      </p>
      <div className="flex gap-2 flex-wrap">
        <button
          onClick={() => trigger('items', '/admin/qb/sync-items')}
          disabled={busy !== null}
          className="px-3 py-1.5 text-xs font-medium rounded border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 disabled:opacity-50 inline-flex items-center gap-1"
        >
          {busy === 'items' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          Items + prices
        </button>
        <button
          onClick={() => trigger('price-levels', '/admin/qb/sync-price-levels')}
          disabled={busy !== null}
          className="px-3 py-1.5 text-xs font-medium rounded border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 disabled:opacity-50 inline-flex items-center gap-1"
        >
          {busy === 'price-levels' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          Price levels
        </button>
        <button
          onClick={() => trigger('customers', '/admin/qb/sync-customers')}
          disabled={busy !== null}
          className="px-3 py-1.5 text-xs font-medium rounded border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 disabled:opacity-50 inline-flex items-center gap-1"
        >
          {busy === 'customers' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          Customers
        </button>
      </div>
      {result && (
        <p className={cn(
          'text-[11px] mt-1.5',
          result.kind === 'ok' ? 'text-emerald-700' : 'text-red-700',
        )}>
          {result.msg}
        </p>
      )}
    </div>
  )
}

interface FailedQbEntry {
  id: string
  entityType: string
  entityId: string
  action: string
  status: string
  retryCount: number
  errorCode: string | null
  errorMessage: string | null
  createdAt: string
  sentAt: string | null
}

interface FailedQbDetail extends FailedQbEntry {
  qbxmlRequest: string | null
  qbxmlResponse: string | null
  completedAt: string | null
}

/**
 * One dead entry's full story: the untruncated error, the exact qbXML we sent
 * and the raw response QB sent back.
 *
 * The collapsed row shows error_message, which for a qbXML rejection is a
 * one-liner that names a problem without naming the element that caused it —
 * you can't tell an unmapped tax item from a bad customer ref by squinting at
 * it. The request/response pair can, so it's here, one row at a time (these
 * bodies run to tens of KB, which is why the list endpoint omits them).
 */
function FailedQbDetailPanel({ id }: { id: string }) {
  const [detail, setDetail] = useState<FailedQbDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    api.get<FailedQbDetail>(`/admin/qb/failed/${id}`)
      .then(d => { if (alive) setDetail(d) })
      .catch((e: any) => { if (alive) setError(e?.message || 'Failed to load detail') })
    return () => { alive = false }
  }, [id])

  async function copy(label: string, text: string) {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(label)
      setTimeout(() => setCopied(null), 1500)
    } catch {
      setCopied(null)
    }
  }

  if (error) return <p className="text-[11px] text-red-700 mt-1.5">{error}</p>
  if (!detail) return <p className="text-[11px] text-slate-400 mt-1.5">Loading detail…</p>

  const blocks: { label: string; body: string | null }[] = [
    { label: 'Response from QB', body: detail.qbxmlResponse },
    { label: 'Request we sent', body: detail.qbxmlRequest },
  ]

  return (
    <div className="mt-2 space-y-2 border-t border-red-200 pt-2">
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] text-slate-600">
        <span>Entity: <span className="font-mono">{detail.entityType} {detail.entityId}</span></span>
        <span>Status: <span className="font-mono">{detail.status}</span> · retries {detail.retryCount}</span>
        <span>Queued: {fmtTime(detail.createdAt)}</span>
        <span>{detail.sentAt ? `Sent: ${fmtTime(detail.sentAt)}` : 'Never sent'}</span>
      </div>

      <div>
        <div className="flex items-center justify-between">
          <p className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">Error</p>
          {detail.errorMessage && (
            <button
              onClick={() => copy('error', detail.errorMessage!)}
              className="text-[11px] text-blue-600 hover:bg-blue-50 rounded px-1.5 py-0.5 inline-flex items-center gap-1"
            >
              <Copy className="w-3 h-3" />
              {copied === 'error' ? 'copied' : 'copy'}
            </button>
          )}
        </div>
        <pre className="text-[11px] text-red-800 whitespace-pre-wrap break-words font-mono bg-white/70 border border-red-100 rounded p-2 mt-0.5">
          {detail.errorCode ? `[${detail.errorCode}] ` : ''}{detail.errorMessage || '(no message recorded)'}
        </pre>
      </div>

      {blocks.map(b => (
        <div key={b.label}>
          <div className="flex items-center justify-between">
            <p className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">{b.label}</p>
            {b.body && (
              <button
                onClick={() => copy(b.label, b.body!)}
                className="text-[11px] text-blue-600 hover:bg-blue-50 rounded px-1.5 py-0.5 inline-flex items-center gap-1"
              >
                <Copy className="w-3 h-3" />
                {copied === b.label ? 'copied' : 'copy'}
              </button>
            )}
          </div>
          {b.body ? (
            <pre className="text-[10px] leading-relaxed text-slate-700 font-mono bg-white/70 border border-slate-200 rounded p-2 mt-0.5 max-h-64 overflow-auto whitespace-pre">
              {b.body}
            </pre>
          ) : (
            <p className="text-[11px] text-slate-400 italic mt-0.5">
              {b.label === 'Response from QB' ? 'Nothing came back — died before QB answered.' : 'Not recorded.'}
            </p>
          )}
        </div>
      ))}
    </div>
  )
}

/**
 * Failed QB sync triage. Lists every dead queue entry with its QB error so
 * an admin can tell a transient connection failure (safe to retry) from a
 * hard rejection (3140 bad ref / 0x80040400 parse error) that needs a data
 * fix first. "Retry all" / per-row retry reset the rows to pending; QBWC
 * re-sends on its next poll.
 */
function FailedQbSyncs({ failedCount, onChanged }: { failedCount: number; onChanged: () => void }) {
  const [open, setOpen] = useState(false)
  const [entries, setEntries] = useState<FailedQbEntry[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [result, setResult] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null)
  // Which rows are expanded. A set, not a single id — comparing two failures
  // side by side is the whole point when 20 rows share one error string.
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  function toggleRow(id: string) {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function load() {
    try {
      const res = await api.get<{ count: number; entries: FailedQbEntry[] }>('/admin/qb/failed')
      setEntries(res.entries)
    } catch (e: any) {
      setResult({ kind: 'err', msg: e?.message || 'Failed to load' })
    }
  }

  function toggle() {
    const next = !open
    setOpen(next)
    if (next && entries === null) load()
  }

  async function retry(ids?: string[]) {
    setBusy(ids ? ids[0] : 'all')
    setResult(null)
    try {
      const res = await api.post<{ retried: number; message: string }>('/admin/qb/retry-failed', ids ? { ids } : {})
      setResult({ kind: 'ok', msg: res.message })
      await load()
      onChanged() // refresh the top-level summary counts
    } catch (e: any) {
      setResult({ kind: 'err', msg: e?.message || 'Retry failed' })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div>
      <button
        onClick={toggle}
        className="flex items-center justify-between w-full text-left"
      >
        <span className="text-xs font-medium text-slate-500 uppercase tracking-wide">
          Failed syncs{failedCount > 0 && <span className="text-red-600"> · {failedCount}</span>}
        </span>
        <span className="text-xs text-blue-600">{open ? 'hide' : 'show'}</span>
      </button>

      {open && (
        <div className="mt-2 space-y-2">
          {entries === null ? (
            <p className="text-xs text-slate-400 py-1">Loading…</p>
          ) : entries.length === 0 ? (
            <p className="text-xs text-slate-400 italic py-1">No dead entries — queue is clean.</p>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <p className="text-[11px] text-slate-500">
                  {entries.length} dead entr{entries.length === 1 ? 'y' : 'ies'}. Hard rejections (3140, 0x80040400) re-fail until the underlying data is fixed.
                </p>
                <button
                  onClick={() => retry()}
                  disabled={busy !== null}
                  className="px-2.5 py-1 text-xs font-medium rounded border border-amber-300 bg-amber-50 hover:bg-amber-100 text-amber-800 disabled:opacity-50 inline-flex items-center gap-1 shrink-0"
                >
                  {busy === 'all' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                  Retry all
                </button>
              </div>
              <div className="space-y-1.5">
                {entries.map(e => {
                  const isOpen = expanded.has(e.id)
                  return (
                    <div key={e.id} className="px-2 py-1.5 rounded border border-red-100 bg-red-50/50">
                      <div className="flex items-start gap-2">
                        <button
                          onClick={() => toggleRow(e.id)}
                          className="shrink-0 mt-0.5 text-slate-400 hover:text-slate-600"
                          title={isOpen ? 'Collapse' : 'Show full error + qbXML'}
                          aria-expanded={isOpen}
                        >
                          {isOpen
                            ? <ChevronDown className="w-3.5 h-3.5" />
                            : <ChevronRight className="w-3.5 h-3.5" />}
                        </button>
                        <button onClick={() => toggleRow(e.id)} className="min-w-0 flex-1 text-left">
                          <p className="text-xs font-medium text-slate-700">
                            <span className="font-mono">{e.entityType}/{e.action}</span>
                            {e.errorCode && <span className="ml-1.5 text-red-700">[{e.errorCode}]</span>}
                            <span className="text-slate-400"> · {fmtTime(e.createdAt)}</span>
                          </p>
                          {e.errorMessage && (
                            <p
                              className={cn('text-[11px] text-red-700 mt-0.5 break-words', !isOpen && 'line-clamp-2')}
                              title={e.errorMessage}
                            >
                              {e.errorMessage}
                            </p>
                          )}
                        </button>
                        <button
                          onClick={() => retry([e.id])}
                          disabled={busy !== null}
                          className="text-[11px] text-blue-600 hover:bg-blue-50 rounded px-2 py-1 shrink-0 disabled:opacity-50"
                        >
                          {busy === e.id ? '…' : 'Retry'}
                        </button>
                      </div>
                      {isOpen && <FailedQbDetailPanel id={e.id} />}
                    </div>
                  )
                })}
              </div>
            </>
          )}
          {result && (
            <p className={cn('text-[11px]', result.kind === 'ok' ? 'text-emerald-700' : 'text-red-700')}>
              {result.msg}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * BlueLion push queue triage. The queue drains on a 60s tick, so `pending` is
 * normal and self-clearing — what needs a human is `needs_attention`:
 *   - `ambiguous` — BlueLion matched several people to one name. Pick the right
 *     one and resolve; the choice is stamped on the roster/fit-test row so
 *     every later push for that person skips the ambiguity.
 *   - `invalid` — bad classCode or unmapped course. Fix the source data first;
 *     a retry without that re-fails identically.
 * `error` rows are permanent failures after MAX_RETRIES (usually transport —
 * check BLUELION_URL scheme/reachability before retrying en masse).
 */
function BlueLionQueue({ attentionCount, errorCount, onChanged }: {
  attentionCount: number
  errorCount: number
  onChanged: () => void
}) {
  const [open, setOpen] = useState(false)
  const [recent, setRecent] = useState<BlueLionQueueRow[] | null>(null)
  const [attention, setAttention] = useState<BlueLionQueueRow[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [result, setResult] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null)

  async function load() {
    try {
      const [all, needs, errored] = await Promise.all([
        api.get<BlueLionQueueRow[]>('/bluelion/queue'),
        api.get<BlueLionQueueRow[]>('/bluelion/queue?status=needs_attention'),
        api.get<BlueLionQueueRow[]>('/bluelion/queue?status=error'),
      ])
      setRecent(all)
      setAttention([...needs, ...errored])
    } catch (e: any) {
      setRecent([])
      setResult({ kind: 'err', msg: e?.message || 'Failed to load (needs the billing:bluelion permission)' })
    }
  }

  function toggle() {
    const next = !open
    setOpen(next)
    if (next && recent === null) load()
  }

  /**
   * Connection probe. Separate from `act` because it's a GET and reports the
   * response rather than a fixed message.
   *
   * Worth a button: the #93 outage was BlueLion's prod vhost serving plain
   * HTTP while our client hardcoded https.request. Nothing errored loudly —
   * pushes simply never left ServicePRO. A one-click probe is how that gets
   * caught next time instead of being noticed weeks later.
   */
  async function testConnection() {
    setBusy('conn')
    setResult(null)
    try {
      const r = await api.get<{ ok?: boolean; message?: string }>('/bluelion/test-connection')
      setResult({
        kind: r?.ok === false ? 'err' : 'ok',
        msg: r?.message || (r?.ok === false ? 'BlueLion did not answer' : 'BlueLion reachable'),
      })
    } catch (e: any) {
      setResult({ kind: 'err', msg: e?.message || 'Connection test failed' })
    } finally {
      setBusy(null)
    }
  }

  async function act(id: string, path: string, body: Record<string, unknown>, okMsg: string) {
    setBusy(id)
    setResult(null)
    try {
      await api.post(path, body)
      setResult({ kind: 'ok', msg: okMsg })
      await load()
      onChanged() // refresh the top-level status counts
    } catch (e: any) {
      setResult({ kind: 'err', msg: e?.message || 'Action failed' })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div>
      <button onClick={toggle} className="flex items-center justify-between w-full text-left">
        <span className="text-xs font-medium text-slate-500 uppercase tracking-wide">
          Queue detail{attentionCount > 0 && <span className="text-amber-600"> · {attentionCount} need action</span>}
        </span>
        <span className="text-xs text-blue-600">{open ? 'hide' : 'show'}</span>
      </button>

      {open && (
        <div className="mt-2 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] text-slate-500">
              Checks that ServicePRO can actually reach BlueLion — scheme, host and auth.
            </p>
            <button
              onClick={testConnection}
              disabled={busy !== null}
              className="px-2.5 py-1 text-xs font-medium rounded border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 disabled:opacity-50 inline-flex items-center gap-1 shrink-0"
            >
              {busy === 'conn' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
              Test connection
            </button>
          </div>

          {recent === null ? (
            <p className="text-xs text-slate-400 py-1">Loading…</p>
          ) : (
            <>
              {errorCount > 0 && (
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[11px] text-slate-500">
                    {errorCount} row{errorCount === 1 ? '' : 's'} failed permanently. If the cause was config or
                    transport, re-queue them all at once.
                  </p>
                  <button
                    onClick={() => act('all', '/bluelion/queue/retry-errors', {}, 'Errors re-queued')}
                    disabled={busy !== null}
                    className="px-2.5 py-1 text-xs font-medium rounded border border-amber-300 bg-amber-50 hover:bg-amber-100 text-amber-800 disabled:opacity-50 inline-flex items-center gap-1 shrink-0"
                  >
                    {busy === 'all' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                    Retry all errors
                  </button>
                </div>
              )}

              {attention.length > 0 && (
                <div className="space-y-1.5">
                  {attention.map(r => (
                    <div key={r.id} className="px-2 py-1.5 rounded border border-amber-200 bg-amber-50/60">
                      <p className="text-xs font-medium text-slate-700 flex items-center justify-between gap-2">
                        <span className="min-w-0 truncate">
                          <span className="font-mono">{r.entityType}</span>
                          <span className="text-amber-700"> · {r.resultStatus || r.status}</span>
                          <span className="text-slate-400"> · {fmtWhen(r.createdAt)}</span>
                        </span>
                        <button
                          onClick={() => act(r.id, `/bluelion/queue/${r.id}/retry`, {}, 'Re-queued')}
                          disabled={busy !== null}
                          className="text-[11px] text-blue-600 hover:bg-blue-50 rounded px-2 py-1 shrink-0 disabled:opacity-50"
                        >
                          {busy === r.id ? '…' : 'Retry'}
                        </button>
                      </p>
                      {r.errorMessage && (
                        <p className="text-[11px] text-amber-800 mt-0.5 break-words" title={r.errorMessage}>
                          {r.errorMessage}
                        </p>
                      )}
                      {r.resultStatus === 'ambiguous' && r.candidates && r.candidates.length > 0 && (
                        <div className="mt-1.5">
                          <p className="text-[10px] uppercase tracking-wide text-slate-500 mb-1">Which person?</p>
                          <div className="flex flex-wrap gap-1">
                            {r.candidates.map(c => (
                              <button
                                key={c.id}
                                onClick={() => act(
                                  r.id,
                                  `/bluelion/queue/${r.id}/resolve`,
                                  { blueLionId: c.id },
                                  `Resolved to ${c.full_name}`,
                                )}
                                disabled={busy !== null}
                                className="px-2 py-1 text-[11px] rounded border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 disabled:opacity-50"
                                title={c.last_trained_on ? `last trained ${c.last_trained_on}` : undefined}
                              >
                                {c.full_name}
                                {c.employer && <span className="text-slate-400"> · {c.employer}</span>}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              <div>
                <p className="text-[10px] uppercase tracking-wide text-slate-500 mb-1">Recent</p>
                {recent.length === 0 ? (
                  <p className="text-xs text-slate-400 italic">
                    Queue is empty — nothing has been enqueued. Run the trainings / services backfill to seed it.
                  </p>
                ) : (
                  <div className="space-y-1">
                    {recent.slice(0, 8).map(r => (
                      <div key={r.id} className="flex items-center justify-between gap-2 text-[11px] px-2 py-1 rounded bg-slate-50">
                        <span className="font-mono text-slate-600 truncate" title={r.externalId}>{r.externalId}</span>
                        <span className="flex items-center gap-1.5 shrink-0">
                          <span className={cn(
                            r.status === 'synced' ? 'text-emerald-700' :
                            r.status === 'error' ? 'text-red-700' :
                            r.status === 'needs_attention' ? 'text-amber-700' : 'text-slate-500',
                          )}>{r.status.replace(/_/g, ' ')}</span>
                          <span className="text-slate-400">{fmtWhen(r.createdAt)}</span>
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
          {result && (
            <p className={cn('text-[11px]', result.kind === 'ok' ? 'text-emerald-700' : 'text-red-700')}>
              {result.msg}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

interface QbTaxRec {
  id: string
  qbListId: string
  fullName: string
  recordType: string
  taxRatePercent: string | null
  isActive: boolean
}
interface TaxReconRow {
  salesTaxRateId: string
  name: string
  county: string | null
  rate: string
  active: boolean
  qbTaxItemName: string | null
  status: 'ok' | 'unmatched' | 'unmapped'
}
interface SalesTaxRecon {
  lastSyncedAt: string | null
  qbRecordCount: number
  qbRecords: QbTaxRec[]
  reconciliation: TaxReconRow[]
  unmatchedCount: number
}

/**
 * QB sales-tax name reconciliation. The recurring 3140 "invalid reference to
 * QuickBooks Item Sales Tax" reject comes from SalesTaxRate.qbTaxItemName
 * holding a name QB doesn't have. "Sync now" pulls QB's real tax items+groups
 * (then run QBWC); the table flags each mapping ok/unmatched/unmapped and lets
 * an admin pick the correct QB name from a dropdown — picking saves immediately.
 */
function QbSalesTaxReconcile() {
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<SalesTaxRecon | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [result, setResult] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null)

  async function load() {
    try {
      const res = await api.get<SalesTaxRecon>('/admin/qb/sales-tax')
      setData(res)
    } catch (e: any) {
      setResult({ kind: 'err', msg: e?.message || 'Failed to load' })
    }
  }

  function toggle() {
    const next = !open
    setOpen(next)
    if (next && data === null) load()
  }

  async function syncNow() {
    setBusy('sync')
    setResult(null)
    try {
      const res = await api.post<{ queued: boolean; message: string }>('/admin/qb/sync-sales-tax', {})
      setResult({ kind: 'ok', msg: res.message })
    } catch (e: any) {
      setResult({ kind: 'err', msg: e?.message || 'Sync failed' })
    } finally {
      setBusy(null)
    }
  }

  async function setMapping(rateId: string, name: string) {
    setBusy(rateId)
    setResult(null)
    try {
      await api.patch('/admin/qb/sales-tax-mapping', { salesTaxRateId: rateId, qbTaxItemName: name })
      await load()
    } catch (e: any) {
      setResult({ kind: 'err', msg: e?.message || 'Update failed' })
    } finally {
      setBusy(null)
    }
  }

  const items = data?.qbRecords.filter(r => r.recordType === 'item') ?? []
  const groups = data?.qbRecords.filter(r => r.recordType === 'group') ?? []
  const allNames = items.concat(groups)

  return (
    <div>
      <button onClick={toggle} className="flex items-center justify-between w-full text-left">
        <span className="text-xs font-medium text-slate-500 uppercase tracking-wide">
          Sales tax mapping
          {data && data.unmatchedCount > 0 && <span className="text-red-600"> · {data.unmatchedCount} unmatched</span>}
        </span>
        <span className="text-xs text-blue-600">{open ? 'hide' : 'show'}</span>
      </button>

      {open && (
        <div className="mt-2 space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-[11px] text-slate-500">
              {data?.lastSyncedAt ? `QB list synced ${fmtTime(data.lastSyncedAt)}` : 'QB tax list not synced yet'}
            </p>
            <button
              onClick={syncNow}
              disabled={busy !== null}
              className="px-2.5 py-1 text-xs font-medium rounded border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 disabled:opacity-50 inline-flex items-center gap-1 shrink-0"
            >
              {busy === 'sync' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
              Sync now
            </button>
          </div>

          {data === null ? (
            <p className="text-xs text-slate-400 py-1">Loading…</p>
          ) : (
            <>
              {data.qbRecordCount === 0 && (
                <p className="text-[11px] text-amber-700">
                  No QB tax records yet — click "Sync now", run QuickBooks Web Connector, then reopen to pick names.
                </p>
              )}
              <div className="space-y-1.5">
                {data.reconciliation.map(r => (
                  <div
                    key={r.salesTaxRateId}
                    className={cn(
                      'flex items-center gap-2 px-2 py-1.5 rounded border',
                      r.status === 'ok' ? 'border-emerald-100 bg-emerald-50/40' :
                      r.status === 'unmatched' ? 'border-red-100 bg-red-50/50' :
                      'border-slate-100 bg-slate-50',
                    )}
                  >
                    <div className="min-w-0 w-32 shrink-0">
                      <p className="text-xs font-medium text-slate-700 truncate" title={r.name}>{r.name}</p>
                      {r.county && <p className="text-[10px] text-slate-400 truncate">{r.county}</p>}
                    </div>
                    <select
                      value={r.qbTaxItemName ?? ''}
                      disabled={busy !== null || data.qbRecordCount === 0}
                      onChange={e => setMapping(r.salesTaxRateId, e.target.value)}
                      className={cn(
                        'flex-1 min-w-0 text-xs rounded border px-1.5 py-1 bg-white disabled:opacity-50',
                        r.status === 'unmatched' ? 'border-red-300 text-red-700' : 'border-slate-300 text-slate-700',
                      )}
                    >
                      <option value="">— none —</option>
                      {r.qbTaxItemName && !allNames.some(x => x.fullName.toLowerCase() === r.qbTaxItemName!.toLowerCase()) && (
                        <option value={r.qbTaxItemName}>{r.qbTaxItemName} (not in QB)</option>
                      )}
                      {groups.length > 0 && (
                        <optgroup label="Sales Tax Groups (combined)">
                          {groups.map(g => <option key={g.qbListId} value={g.fullName}>{g.fullName}</option>)}
                        </optgroup>
                      )}
                      {items.length > 0 && (
                        <optgroup label="Sales Tax Items (component)">
                          {items.map(it => (
                            <option key={it.qbListId} value={it.fullName}>
                              {it.fullName}{it.taxRatePercent != null ? ` (${it.taxRatePercent}%)` : ''}
                            </option>
                          ))}
                        </optgroup>
                      )}
                    </select>
                    <span className="shrink-0 w-4 text-center">
                      {busy === r.salesTaxRateId ? <Loader2 className="w-3.5 h-3.5 animate-spin text-slate-400 inline" /> :
                       r.status === 'ok' ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 inline" /> :
                       r.status === 'unmatched' ? <AlertTriangle className="w-3.5 h-3.5 text-red-600 inline" /> : null}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
          {result && (
            <p className={cn('text-[11px]', result.kind === 'ok' ? 'text-emerald-700' : 'text-red-700')}>
              {result.msg}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

interface QbCustomerRow {
  id: string
  qbListId: string
  fullName: string
  name: string
  sublevel: number
  isActive: boolean
  ignored: boolean
  city: string | null
  state: string | null
  phone: string | null
  suggestions: Array<{ id: string; name: string }>
}

interface QbCustomerReviewData {
  lastPulledAt: string | null
  qbCustomerCount: number
  linkedCount: number
  unmatchedCount: number
  unmatched: QbCustomerRow[]
}

type LinkTarget = Parameters<typeof CustomerSearch>[0]['value']

/**
 * QuickBooks customers that no Sundog company is linked to. The pull links
 * exact-name matches and creates active top-level customers on its own;
 * whatever it skips (jobs, ambiguous names) lands here for a person to link to
 * an existing customer, create, or ignore.
 */
function QbCustomerReview() {
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<QbCustomerReviewData | null>(null)
  const [showJobs, setShowJobs] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [linking, setLinking] = useState<string | null>(null)
  const [target, setTarget] = useState<LinkTarget>(null)
  const [result, setResult] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null)

  async function load(jobs = showJobs) {
    try {
      setData(await api.get<QbCustomerReviewData>(`/admin/qb/customers${jobs ? '?jobs=1' : ''}`))
    } catch (e: any) {
      setResult({ kind: 'err', msg: e?.message || 'Failed to load' })
    }
  }

  function toggle() {
    const next = !open
    setOpen(next)
    if (next && data === null) load()
  }

  async function act(row: QbCustomerRow, label: string, run: () => Promise<unknown>, done: string) {
    setBusy(row.id)
    setResult(null)
    try {
      await run()
      setLinking(null)
      setTarget(null)
      setResult({ kind: 'ok', msg: `${row.fullName}: ${done}` })
      await load()
    } catch (e: any) {
      setResult({ kind: 'err', msg: `${row.fullName}: ${e?.message || `${label} failed`}` })
    } finally {
      setBusy(null)
    }
  }

  const btn = 'px-2 py-0.5 text-[11px] font-medium rounded border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 disabled:opacity-50'

  return (
    <div>
      <button onClick={toggle} className="flex items-center justify-between w-full text-left">
        <span className="text-xs font-medium text-slate-500 uppercase tracking-wide">
          QuickBooks customers not in Sundog
          {data && data.unmatchedCount > 0 && <span className="text-amber-600"> · {data.unmatchedCount}</span>}
        </span>
        <span className="text-xs text-blue-600">{open ? 'hide' : 'show'}</span>
      </button>

      {open && (
        <div className="mt-2 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] text-slate-500">
              {data?.lastPulledAt
                ? `Pulled ${fmtTime(data.lastPulledAt)} · ${data.linkedCount} of ${data.qbCustomerCount} linked`
                : 'Customer list not pulled yet — use "Customers" under Sync now, then run the Web Connector'}
            </p>
            <label className="text-[11px] text-slate-500 inline-flex items-center gap-1 shrink-0">
              <input
                type="checkbox"
                checked={showJobs}
                onChange={e => { setShowJobs(e.target.checked); load(e.target.checked) }}
              />
              Show jobs
            </label>
          </div>

          {data === null ? (
            <p className="text-xs text-slate-400 py-1">Loading…</p>
          ) : data.unmatched.length === 0 ? (
            <p className="text-xs text-slate-400 py-1">Nothing to review.</p>
          ) : (
            <div className="space-y-1.5 max-h-80 overflow-y-auto">
              {data.unmatched.map(row => (
                <div key={row.id} className="px-2 py-1.5 rounded border border-slate-100 bg-slate-50">
                  <div className="flex items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium text-slate-700 truncate" title={row.fullName}>{row.fullName}</p>
                      <p className="text-[10px] text-slate-400 truncate">
                        {[row.city, row.state].filter(Boolean).join(', ') || row.phone || 'no address in QuickBooks'}
                      </p>
                    </div>
                    {busy === row.id ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin text-slate-400" />
                    ) : (
                      <div className="flex gap-1 shrink-0">
                        <button
                          className={btn}
                          disabled={busy !== null}
                          onClick={() => { setLinking(linking === row.id ? null : row.id); setTarget(null) }}
                        >
                          Link…
                        </button>
                        <button
                          className={btn}
                          disabled={busy !== null}
                          onClick={() => act(row, 'Create', () => api.post(`/admin/qb/customers/${row.id}/create-company`, {}), 'customer created')}
                        >
                          Create
                        </button>
                        <button
                          className={btn}
                          disabled={busy !== null}
                          onClick={() => act(row, 'Ignore', () => api.patch(`/admin/qb/customers/${row.id}`, { ignored: true }), 'ignored')}
                        >
                          Ignore
                        </button>
                      </div>
                    )}
                  </div>
                  {row.suggestions.length > 0 && busy !== row.id && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-1">
                      <span className="text-[10px] text-slate-500">Looks like:</span>
                      {row.suggestions.map(s => (
                        <button
                          key={s.id}
                          className="px-2 py-0.5 text-[11px] font-medium rounded border border-emerald-300 bg-emerald-50 hover:bg-emerald-100 text-emerald-800 disabled:opacity-50"
                          disabled={busy !== null}
                          onClick={() => act(row, 'Link', () => api.post(`/admin/qb/customers/${row.id}/link`, { companyId: s.id }), `linked to ${s.name}`)}
                        >
                          Link to {s.name}
                        </button>
                      ))}
                    </div>
                  )}
                  {linking === row.id && (
                    <div className="mt-2 space-y-1.5">
                      <CustomerSearch value={target} onChange={setTarget} />
                      <button
                        className={btn}
                        disabled={!target || busy !== null}
                        onClick={() => act(row, 'Link', () => api.post(`/admin/qb/customers/${row.id}/link`, { companyId: target!.id }), `linked to ${target!.name}`)}
                      >
                        Link to {target?.name ?? 'selected customer'}
                      </button>
                    </div>
                  )}
                </div>
              ))}
              {data.unmatchedCount > data.unmatched.length && (
                <p className="text-[11px] text-slate-400">Showing {data.unmatched.length} of {data.unmatchedCount}.</p>
              )}
            </div>
          )}
          {result && (
            <p className={cn('text-[11px]', result.kind === 'ok' ? 'text-emerald-700' : 'text-red-700')}>
              {result.msg}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function JobRow({ job }: { job: JobInfo }) {
  const ageMs = Date.now() - new Date(job.startedAt).getTime()
  const ageLabel =
    ageMs < 60_000 ? `${Math.max(1, Math.round(ageMs / 1000))}s ago` :
    ageMs < 3_600_000 ? `${Math.round(ageMs / 60_000)}m ago` :
    ageMs < 86_400_000 ? `${Math.round(ageMs / 3_600_000)}h ago` :
    `${Math.round(ageMs / 86_400_000)}d ago`

  const statusTone =
    job.status === 'error' ? 'bg-red-100 text-red-800 border-red-200' :
    job.status === 'running' ? 'bg-blue-100 text-blue-800 border-blue-200' :
    job.status === 'skipped' ? 'bg-slate-100 text-slate-600 border-slate-200' :
    'bg-emerald-100 text-emerald-800 border-emerald-200'

  // Surface a warning if recent runs are mostly errors / a sustained
  // run of skips suggests a stuck lock.
  const recent = job.recentLastHour
  const recentSignal =
    recent.error > 0 ? `${recent.error} error${recent.error === 1 ? '' : 's'} / hr` :
    (recent.skipped > 0 && recent.success === 0) ? `${recent.skipped} skipped / hr` :
    null

  return (
    <div className="flex items-center justify-between px-2 py-1.5 rounded border border-slate-200 bg-white">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono text-slate-700 truncate">{job.jobName}</span>
          <span className={cn('text-[10px] px-1.5 py-0.5 rounded-full border font-medium uppercase tracking-wide', statusTone)}>
            {job.status}
          </span>
        </div>
        <div className="flex items-center gap-2 text-[10px] text-slate-500 mt-0.5">
          <span>{ageLabel}</span>
          {job.durationMs != null && <span>· {job.durationMs}ms</span>}
          {recentSignal && (
            <span className="text-amber-700 font-medium">· {recentSignal}</span>
          )}
        </div>
        {job.errorMessage && job.status === 'error' && (
          <p className="text-[10px] text-red-700 mt-0.5 truncate" title={job.errorMessage}>
            {job.errorMessage}
          </p>
        )}
      </div>
    </div>
  )
}
