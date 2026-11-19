import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { v4 as uuidv4 } from 'uuid'
import { api } from '@/lib/api'
import { useApiResource } from '@/hooks/useApiResource'
import { useAuth } from '@/contexts/AuthContext'
import { hasPermission } from '@/lib/permissions'
import { cn } from '@/lib/cn'
import { CustomerSearch } from '@/components/CustomerSearch'
import { DateRangePicker, type DateRange } from '@/components/DateRangePicker'
import { ApprovalsHost } from '@/components/ApprovalsHost'
import { RentalReleaseTab } from '@/components/RentalReleaseTab'
import { RentalUnbilledBanner, type RentalReleaseSummary } from '@/components/RentalUnbilledBanner'
import { WidgetGrid } from '@/components/widgets/WidgetGrid'
import { AddWidgetMenu } from '@/components/widgets/AddWidgetMenu'
import { dashboardApi } from '@/lib/dashboardApi'
import { formatCalendarDateNumeric, daysAgoKey as daysAgo, todayKey as today } from '@/lib/dates'
import type {
  WidgetCatalogEntry,
  WidgetInstance,
  WidgetSize,
  WidgetType,
} from '@/lib/widgetTypes'
import {
  PieChart, Pie, Cell, ResponsiveContainer, Tooltip as ReTooltip,
  LineChart, Line, XAxis, YAxis, CartesianGrid, ReferenceLine,
  Legend,
  type DotItemDotProps,
} from 'recharts'
import {
  GraduationCap,
  CreditCard,
  ChevronRight,
  ChevronLeft,
  Loader2,
  AlertTriangle,
  Zap,
  BarChart3,
  TrendingUp,
  Building2,
  DollarSign,
  ClipboardList,
  Wrench,
  Truck,
  FileText,
  Filter,
  X,
  MapPin,
  Layers,
  Activity,
  Shield,
  ShieldAlert,
  CheckSquare,
  Pencil,
  Check,
  RotateCcw,
  Eye,
} from 'lucide-react'

// ─── Types ───────────────────────────────────────────────────

interface PendingCardGroup {
  ticketId: string
  ticketNumber: string | null
  courseName: string
  serviceDate: string
  pendingCount: number
  trainees: Array<{ id: string; employeeName: string; employerName: string | null; contactEmail: string | null }>
}

interface EnverusAlert {
  hasIssues: boolean
  totalIssues: number
  errors: { count: number }
  disputed: { count: number }
}

interface CustomerSummary {
  companyId: string
  companyName: string
  ticketCount: number
  totalRevenue: number
  byType: Record<string, { count: number; revenue: number }>
}

interface TicketRow {
  id: string
  ticketNumber: string
  ticketType: string
  serviceSubtype: string | null
  status: string
  serviceDate: string
  locationDisplay: string | null
  total: number
  techName: string | null
  fieldId: string | null
  fieldName: string | null
  padId: string | null
  padName: string | null
  wellName: string | null
  workPointName: string | null
  workPointType: string | null
}

interface LocationSummary {
  padId: string
  padName: string
  fieldId: string | null
  fieldName: string | null
  ticketCount: number
  totalRevenue: number
}

interface ServiceHistoryData {
  dateRange: { from: string; to: string }
  customers: CustomerSummary[]
  tickets: TicketRow[]
  locations: LocationSummary[]
}

interface BillingBySource {
  sourceType: string
  total: number
  count: number
}

interface BillingByCustomer {
  companyId: string
  companyName: string
  total: number
  invoiceCount: number
}

interface BillingQueueEntry {
  companyId: string
  companyName: string
  count: number
  total: number
}

interface BillingSummaryData {
  monthToDate: {
    total: number
    bySource: BillingBySource[]
    byCustomer: BillingByCustomer[]
  }
  pipeline: {
    ticketsReadyToBill: number
    ticketQueueTotal: number
    ticketQueueByCompany: BillingQueueEntry[]
    shopWOsReadyToBill: number
    activeRentals: number
    activeRentalEstMonthly: number
    draftInvoices: number
    approvedInvoices: number
    queuedInvoices: number
    soCreatedInvoices: number
  }
}

// H2S Analytics types
interface H2SReading {
  ticketId: string
  ticketNumber: string
  serviceDate: string
  value: number
  context: string
  readingType: string
}

interface H2SLocation {
  locationKey: string
  locationName: string
  locationType: 'well' | 'pad' | 'field' | 'unknown'
  wellId: string | null
  padId: string | null
  fieldId: string | null
  readingCount: number
  maxH2S: number
  latestH2S: number | null
  elevated: boolean
  readings: H2SReading[]
}

interface H2SAnalyticsData {
  companyId: string
  totalLocations: number
  elevatedCount: number
  safeCount: number
  locations: H2SLocation[]
}

interface H2SCompanySummary {
  companyId: string
  companyName: string
  ticketCount: number
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

// ─── Helpers ─────────────────────────────────────────────────

function fmt$(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 })
}

function fmt$full(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 })
}

const TICKET_TYPE_LABELS: Record<string, { label: string; color: string }> = {
  field_service: { label: 'Field Service', color: 'bg-blue-100 text-blue-700' },
  training:      { label: 'Training', color: 'bg-purple-100 text-purple-700' },
  inspection:    { label: 'Inspection', color: 'bg-emerald-100 text-emerald-700' },
  rental:        { label: 'Rental', color: 'bg-amber-100 text-amber-700' },
  repair:        { label: 'Repair', color: 'bg-orange-100 text-orange-700' },
  sale:          { label: 'Sale', color: 'bg-slate-100 text-slate-700' },
}

const SOURCE_LABELS: Record<string, string> = {
  billing_group: 'Field Service',
  shop_work_order: 'Shop Service',
  rental_agreement: 'Rentals',
  manual: 'Manual',
}

const STATUS_BADGE: Record<string, string> = {
  draft: 'bg-slate-100 text-slate-600',
  dispatched: 'bg-blue-100 text-blue-700',
  in_progress: 'bg-yellow-100 text-yellow-700',
  completed: 'bg-emerald-100 text-emerald-700',
  supervisor_review: 'bg-purple-100 text-purple-700',
  billing_queue: 'bg-amber-100 text-amber-700',
  invoiced: 'bg-green-100 text-green-700',
  closed: 'bg-slate-100 text-slate-500',
}

const H2S_THRESHOLD = 10
const PIE_COLORS = { safe: '#22c55e', elevated: '#ef4444' }

// ─── Component ───────────────────────────────────────────────

type Tab = 'overview' | 'history' | 'cards' | 'h2s' | 'billing' | 'approvals' | 'rental_billing'

// Roles allowed to see the Approvals tab. Field techs and dispatch are excluded.
const APPROVAL_ROLES = ['field_super', 'billing_ar', 'ar_supervisor', 'boss', 'platform_admin']

export function DashboardPage() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const canBilling = hasPermission(user?.role, 'billing:view')
  const canApprove = APPROVAL_ROLES.includes(user?.role || '')
  const canReleaseRentals = hasPermission(user?.role, 'rentals:release_billing')
  const canPreviewPortal = user?.role === 'platform_admin'

  // Deep-link support: /dashboard?tab=approvals lands directly on the tab.
  const [searchParams, setSearchParams] = useSearchParams()
  const initialTab = (searchParams.get('tab') as Tab) || 'overview'
  const [tab, setTabState] = useState<Tab>(
    // Only honor the query-param tab if the user has permission to see it
    (initialTab === 'approvals' && !canApprove) || (initialTab === 'rental_billing' && !canReleaseRentals) ? 'overview' : initialTab,
  )

  // Keep URL query param in sync with tab state so supervisors can bookmark.
  function setTab(next: Tab) {
    setTabState(next)
    const params = new URLSearchParams(searchParams)
    if (next === 'overview') {
      params.delete('tab')
    } else {
      params.set('tab', next)
    }
    setSearchParams(params, { replace: true })
  }

  // Approvals tab unread count (for the tab badge)
  const [approvalCount, setApprovalCount] = useState(0)
  useEffect(() => {
    if (!canApprove) return
    let cancelled = false
    async function loadCount() {
      try {
        const data = await api.get<{ summary: { green: number; yellow: number; red: number; unscored: number } }>('/tickets/review-queue')
        if (data && !cancelled) {
          const s = data.summary
          setApprovalCount(s.green + s.yellow + s.red + s.unscored)
        }
      } catch { /* offline or no access */ }
    }
    loadCount()
    // Refresh badge when switching to the tab (catches updates from bulk actions)
    const interval = setInterval(loadCount, 60_000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [canApprove, tab])

  // Rental send-for-billing: last month's stragglers (banner) and what the
  // field should send today (tab badge). The server returns null for roles on
  // neither side of it, so this is safe to ask on every dashboard load.
  const [releaseSummary, setReleaseSummary] = useState<RentalReleaseSummary | null>(null)
  useEffect(() => {
    if (!canReleaseRentals && !canBilling) return
    let cancelled = false
    async function loadSummary() {
      try {
        const res = await api.get<{ data: RentalReleaseSummary | null }>('/rentals/billing-release/summary')
        if (!cancelled) setReleaseSummary(res?.data ?? null)
      } catch { /* offline or no access */ }
    }
    loadSummary()
    // Refetch on tab change so the counts drop right after a send.
    const interval = setInterval(loadSummary, 60_000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [canReleaseRentals, canBilling, tab])

  const requestScope = `${user?.id ?? ''}:${user?.role ?? ''}`
  const canEnverus = hasPermission(user?.role, 'billing:enverus')
  const cards = useApiResource<{ data: PendingCardGroup[]; totalPending: number }>(user ? '/tickets/training/pending-cards' : null, requestScope)
  const pendingCards = cards.data?.data ?? []
  const totalPending = cards.data?.totalPending ?? 0
  const widgetLoading = cards.loading
  const { data: enverusAlerts } = useApiResource<EnverusAlert>(canEnverus ? '/enverus/alerts' : null, requestScope)

  // Overview widget grid (formerly the standalone Home page)
  const [overviewWidgets, setOverviewWidgets] = useState<WidgetInstance[]>([])
  const [overviewCatalog, setOverviewCatalog] = useState<WidgetCatalogEntry[]>([])
  const [overviewIsDefault, setOverviewIsDefault] = useState(false)
  const [overviewLoading, setOverviewLoading] = useState(true)
  const [overviewSaving, setOverviewSaving] = useState(false)
  const [overviewEditing, setOverviewEditing] = useState(false)
  const [overviewError, setOverviewError] = useState<string | null>(null)
  const overviewResizeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const overviewConfigTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [selectedCompany, setSelectedCompany] = useState<{ id: string; name: string } | null>(null)
  const [portalPreviewCustomer, setPortalPreviewCustomer] = useState<PortalPreviewCustomer | null>(null)
  const [dateRange, setDateRange] = useState<DateRange>({ from: daysAgo(90), to: today() })
  const [ticketTypeFilter, setTicketTypeFilter] = useState<string>('')
  const [selectedPadId, setSelectedPadId] = useState<string | null>(null)
  const historyParams = new URLSearchParams({ dateFrom: dateRange.from, dateTo: dateRange.to })
  if (selectedCompany) historyParams.set('companyId', selectedCompany.id)
  if (ticketTypeFilter) historyParams.set('ticketType', ticketTypeFilter)
  const history = useApiResource<ServiceHistoryData>(tab === 'history' ? `/dashboard/service-history?${historyParams}` : null, requestScope)
  const { data: historyData, loading: historyLoading } = history

  const billing = useApiResource<BillingSummaryData>(tab === 'billing' && canBilling ? '/dashboard/billing-summary' : null, requestScope)
  const { data: billingData, loading: billingLoading } = billing

  const [h2sCompany, setH2sCompany] = useState<{ id: string; name: string } | null>(null)
  const [h2sPieFilter, setH2sPieFilter] = useState<'all' | 'safe' | 'elevated'>('all')
  const [h2sLocationKey, setH2sLocationKey] = useState<string | null>(null)
  const h2sList = useApiResource<{ companies: H2SCompanySummary[] }>(tab === 'h2s' ? '/dashboard/h2s-analytics' : null, requestScope)
  const h2sDetail = useApiResource<H2SAnalyticsData>(tab === 'h2s' && h2sCompany ? `/dashboard/h2s-analytics?companyId=${encodeURIComponent(h2sCompany.id)}` : null, requestScope)
  const h2sCompanies = h2sList.data?.companies ?? []
  const { data: h2sData, loading: h2sLoading } = h2sDetail
  const h2sSelectedLocation = h2sData?.locations.find(location => location.locationKey === h2sLocationKey) ?? null

  function selectHistoryCompany(company: { id: string; name: string } | null) {
    setSelectedCompany(company)
    setSelectedPadId(null)
  }
  function selectH2sCompany(company: { id: string; name: string } | null) {
    setH2sCompany(company)
    setH2sLocationKey(null)
    setH2sPieFilter('all')
  }

  // Load the user's saved widget layout for the Overview tab
  useEffect(() => {
    let cancelled = false
    Promise.all([dashboardApi.getCatalog(), dashboardApi.getWidgets()])
      .then(([cat, saved]) => {
        if (cancelled) return
        setOverviewCatalog(cat.widgets)
        setOverviewWidgets(saved.widgets)
        setOverviewIsDefault(saved.isDefault)
      })
      .catch((e) => {
        if (!cancelled) setOverviewError(e.message || 'Failed to load dashboard')
      })
      .finally(() => {
        if (!cancelled) setOverviewLoading(false)
      })
    return () => { cancelled = true }
  }, [])

  const persistOverview = useCallback(async (next: WidgetInstance[]) => {
    const cleaned = next.map((w) =>
      w.id.startsWith('baseline_') ? { ...w, id: uuidv4() } : w,
    )
    setOverviewSaving(true)
    setOverviewError(null)
    try {
      const resp = await dashboardApi.saveWidgets(cleaned)
      setOverviewWidgets(resp.widgets)
      setOverviewIsDefault(resp.isDefault)
    } catch (error) {
      setOverviewError(error instanceof Error ? error.message : 'Save failed')
    } finally {
      setOverviewSaving(false)
    }
  }, [])

  const addOverviewWidget = useCallback((entry: WidgetCatalogEntry) => {
    setOverviewWidgets((prev) => {
      const next = [...prev, { id: uuidv4(), type: entry.type as WidgetType, size: entry.defaultSize }]
      void persistOverview(next)
      return next
    })
  }, [persistOverview])

  const removeOverviewWidget = useCallback((id: string) => {
    setOverviewWidgets((prev) => {
      const next = prev.filter((w) => w.id !== id)
      void persistOverview(next)
      return next
    })
  }, [persistOverview])

  // Per-widget settings (WI-03's aging filters). Debounced like resize so
  // flicking through thresholds doesn't fire a PUT per keystroke of the select.
  const configureOverviewWidget = useCallback((id: string, config: Record<string, unknown>) => {
    setOverviewWidgets((prev) => {
      const next = prev.map((w) => (w.id === id ? { ...w, config } : w))
      if (overviewConfigTimer.current) clearTimeout(overviewConfigTimer.current)
      overviewConfigTimer.current = setTimeout(() => { void persistOverview(next) }, 400)
      return next
    })
  }, [persistOverview])

  const resizeOverviewWidget = useCallback((id: string, size: WidgetSize) => {
    setOverviewWidgets((prev) => {
      const next = prev.map((w) => (w.id === id ? { ...w, size } : w))
      if (overviewResizeTimer.current) clearTimeout(overviewResizeTimer.current)
      overviewResizeTimer.current = setTimeout(() => { void persistOverview(next) }, 400)
      return next
    })
  }, [persistOverview])

  async function resetOverviewWidgets() {
    if (!confirm('Reset dashboard to the defaults for your role?')) return
    setOverviewSaving(true)
    try {
      const resp = await dashboardApi.resetWidgets()
      setOverviewWidgets(resp.widgets)
      setOverviewIsDefault(resp.isDefault)
      setOverviewEditing(false)
    } catch (error) {
      setOverviewError(error instanceof Error ? error.message : 'Reset failed')
    } finally {
      setOverviewSaving(false)
    }
  }

  function openCustomerPortalPreview() {
    if (!portalPreviewCustomer) return
    sessionStorage.setItem('sundog_portal_preview_company_id', portalPreviewCustomer.id)
    sessionStorage.setItem('sundog_portal_preview_company_name', portalPreviewCustomer.name)
    navigate(`/portal?previewCompanyId=${encodeURIComponent(portalPreviewCustomer.id)}`)
  }

  const tabs: { key: Tab; label: string; icon: typeof BarChart3; show: boolean }[] = [
    { key: 'overview', label: 'Overview', icon: BarChart3, show: true },
    { key: 'approvals', label: 'Approvals', icon: CheckSquare, show: canApprove },
    { key: 'rental_billing', label: 'Rental Billing', icon: Truck, show: canReleaseRentals },
    { key: 'history', label: 'Service History', icon: Building2, show: true },
    { key: 'h2s', label: 'H2S Analytics', icon: Activity, show: true },
    { key: 'cards', label: 'Card Issuance', icon: CreditCard, show: true },
    { key: 'billing', label: 'Billing', icon: DollarSign, show: canBilling },
  ]

  return (
    <div>
      <div className="mb-4 flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
        <div><h1 className="text-2xl font-bold text-slate-900">Dashboard</h1>
          {(hasPermission(user?.role, 'reports:financial') || hasPermission(user?.role, 'reports:ops')) && hasPermission(user?.role, 'tickets:view_all') && <button className="text-blue-700 underline mt-2" onClick={() => navigate('/operations-report')}>Daily operations report · jobs and coverage</button>}
        </div>
        {canPreviewPortal && (
          <div className="bg-white border border-slate-200 rounded-lg p-3 w-full xl:w-[460px] shadow-sm">
            <div className="flex items-center justify-between gap-3 mb-2">
              <div>
                <p className="text-sm font-semibold text-slate-900">Customer View</p>
                <p className="text-xs text-slate-500">Preview the external portal without changing accounts.</p>
              </div>
              <button
                type="button"
                onClick={openCustomerPortalPreview}
                disabled={!portalPreviewCustomer}
                className="inline-flex items-center gap-2 px-3 py-2 rounded-md bg-blue-700 text-white text-sm font-semibold hover:bg-blue-800 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Eye className="w-4 h-4" />
                Customer View
              </button>
            </div>
            <CustomerSearch value={portalPreviewCustomer} onChange={setPortalPreviewCustomer} />
          </div>
        )}
      </div>

      <RentalUnbilledBanner
        summary={releaseSummary}
        onOpenReleaseTab={() => setTab('rental_billing')}
        onOpenBilling={() => navigate('/billing?tab=rentals')}
      />

      {/* Tab Bar */}
      <div className="flex gap-1 mb-6 overflow-x-auto border-b border-slate-200">
        {tabs.filter(t => t.show).map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              'flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 -mb-px transition-colors',
              tab === t.key
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300'
            )}
          >
            <t.icon className="w-4 h-4" />
            {t.label}
            {t.key === 'cards' && totalPending > 0 && (
              <span className="ml-1 text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700">
                {totalPending}
              </span>
            )}
            {t.key === 'rental_billing' && (releaseSummary?.needsSending ?? 0) > 0 && (
              <span className="ml-1 text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-red-100 text-red-700">
                {releaseSummary!.needsSending}
              </span>
            )}
            {t.key === 'approvals' && approvalCount > 0 && (
              <span className="ml-1 text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-700">
                {approvalCount}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* ═══ APPROVALS TAB ═══ */}
      {tab === 'approvals' && canApprove && <ApprovalsHost />}

      {/* ═══ RENTAL BILLING TAB (send for billing) ═══ */}
      {tab === 'rental_billing' && canReleaseRentals && <RentalReleaseTab />}

      {/* ═══ OVERVIEW TAB ═══ */}
      {tab === 'overview' && (
        <>
          {/* Enverus Alerts */}
          {canEnverus && enverusAlerts?.hasIssues && (
            <div className="rounded-lg border border-red-300 bg-red-50 p-4 mb-4">
              <div className="flex items-center gap-2 mb-3">
                <Zap className="w-5 h-5 text-red-600" />
                <h2 className="font-semibold text-red-900">Enverus Attention Required</h2>
                <span className="ml-auto text-sm font-bold px-2.5 py-0.5 rounded-full bg-red-200 text-red-800">
                  {enverusAlerts.totalIssues} issue{enverusAlerts.totalIssues !== 1 ? 's' : ''}
                </span>
              </div>
              <div className="space-y-2 text-sm">
                {enverusAlerts.errors.count > 0 && (
                  <div className="flex items-center gap-2 text-red-700">
                    <AlertTriangle className="w-4 h-4" />
                    <span className="font-bold">{enverusAlerts.errors.count} submission{enverusAlerts.errors.count !== 1 ? 's' : ''} failed</span>
                    <span className="text-xs opacity-70">— API rejected</span>
                  </div>
                )}
                {enverusAlerts.disputed.count > 0 && (
                  <div className="flex items-center gap-2 text-amber-700">
                    <AlertTriangle className="w-4 h-4" />
                    <span className="font-bold">{enverusAlerts.disputed.count} receipt{enverusAlerts.disputed.count !== 1 ? 's' : ''} disputed</span>
                    <span className="text-xs opacity-70">— customer rejected</span>
                  </div>
                )}
              </div>
              <button onClick={() => navigate('/billing')} className="mt-3 flex items-center gap-1.5 px-3 py-1.5 bg-red-600 text-white rounded-lg text-xs font-medium hover:bg-red-700">
                Go to Billing <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {/* Widget grid (formerly the standalone Home page).
              Edit / add / resize all auto-save via dashboardApi.
              "Edit layout" toggle just controls per-widget control visibility. */}
          {overviewLoading ? (
            <div className="flex items-center justify-center py-16 text-slate-400">
              <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading your dashboard…
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between mb-4 gap-2 flex-wrap">
                <p className="text-sm text-slate-500">
                  {overviewIsDefault
                    ? 'Showing the default layout for your role — customize any time.'
                    : 'Your dashboard'}
                </p>
                <div className="flex items-center gap-2">
                  {overviewEditing ? (
                    <>
                      <AddWidgetMenu
                        catalog={overviewCatalog}
                        existingTypes={new Set(overviewWidgets.map((w) => w.type))}
                        onAdd={addOverviewWidget}
                      />
                      <button
                        onClick={resetOverviewWidgets}
                        disabled={overviewSaving}
                        className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-slate-600 hover:bg-slate-100"
                        title="Reset to role defaults"
                      >
                        <RotateCcw className="w-4 h-4" /> Reset
                      </button>
                      <button
                        onClick={() => setOverviewEditing(false)}
                        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700"
                      >
                        <Check className="w-4 h-4" /> Done
                      </button>
                      {overviewSaving && (
                        <span className="inline-flex items-center gap-1 text-xs text-slate-400">
                          <Loader2 className="w-3 h-3 animate-spin" /> saving…
                        </span>
                      )}
                    </>
                  ) : (
                    <button
                      onClick={() => setOverviewEditing(true)}
                      className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-slate-300 bg-white text-slate-700 text-sm font-medium hover:bg-slate-50"
                    >
                      <Pencil className="w-4 h-4" /> Edit layout
                    </button>
                  )}
                </div>
              </div>

              {overviewError && (
                <div className="mb-4 px-4 py-2.5 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
                  {overviewError}
                </div>
              )}

              <WidgetGrid
                widgets={overviewWidgets}
                catalog={overviewCatalog}
                editing={overviewEditing}
                onRemove={removeOverviewWidget}
                onResize={resizeOverviewWidget}
                onConfigChange={configureOverviewWidget}
              />
            </>
          )}
        </>
      )}

      {/* ═══ CARD ISSUANCE TAB ═══ */}
      {tab === 'cards' && (
        <div className="bg-white rounded-lg border border-slate-200 p-4">
          <div className="flex items-center gap-2 mb-3">
            <CreditCard className="w-5 h-5 text-amber-500" />
            <h2 className="font-semibold text-slate-900">Pending Card Issuances</h2>
            {totalPending > 0 && (
              <span className="ml-auto text-sm font-medium px-2.5 py-0.5 rounded-full bg-amber-100 text-amber-700">
                {totalPending} pending
              </span>
            )}
          </div>
          {widgetLoading ? (
            <div className="flex items-center justify-center py-6"><Loader2 className="w-5 h-5 text-slate-400 animate-spin" /></div>
          ) : cards.error ? (
            <DashboardLoadError message={cards.error} onRetry={cards.reload} />
          ) : pendingCards.length === 0 ? (
            <p className="text-sm text-slate-400 text-center py-4">No pending card issuances</p>
          ) : (
            <div className="space-y-2">
              {pendingCards.map(group => (
                <button
                  key={group.ticketId}
                  onClick={() => navigate(`/tickets/${group.ticketId}`)}
                  className="w-full flex items-center gap-3 p-3 rounded-lg border border-slate-100 hover:bg-slate-50 transition-colors text-left"
                >
                  <GraduationCap className="w-5 h-5 text-slate-400 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm text-slate-900 truncate">{group.courseName}</p>
                    <p className="text-xs text-slate-500">
                      {group.ticketNumber || 'Pending'} &middot; {formatCalendarDateNumeric(group.serviceDate)} &middot; {group.pendingCount} {group.pendingCount === 1 ? 'card' : 'cards'} pending
                    </p>
                  </div>
                  <ChevronRight className="w-4 h-4 text-slate-400 shrink-0" />
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ═══ H2S ANALYTICS TAB ═══ */}
      {tab === 'h2s' && (
        <H2SAnalyticsTab
          companies={h2sCompanies}
          selectedCompany={h2sCompany}
          onSelectCompany={selectH2sCompany}
          data={h2sData}
          loading={h2sLoading}
          listLoading={h2sList.loading}
          error={h2sCompany ? h2sDetail.error : h2sList.error}
          onRetry={h2sCompany ? h2sDetail.reload : h2sList.reload}
          pieFilter={h2sPieFilter}
          onPieFilter={setH2sPieFilter}
          selectedLocation={h2sSelectedLocation}
          onSelectLocation={location => setH2sLocationKey(location?.locationKey ?? null)}
          navigate={navigate}
        />
      )}

      {/* ═══ SERVICE HISTORY TAB ═══ */}
      {tab === 'history' && (
        <>
          {/* Filters */}
          <div className="bg-white rounded-lg border border-slate-200 p-4 mb-4 space-y-3">
            <div className="flex items-center gap-2 text-sm font-medium text-slate-700">
              <Filter className="w-4 h-4" />
              Filters
            </div>
            <div className="flex flex-wrap gap-3 items-start">
              <div className="w-64">
                {selectedCompany ? (
                  <div className="flex items-center gap-2 px-3 py-2 border border-blue-300 bg-blue-50 rounded-lg">
                    <Building2 className="w-4 h-4 text-blue-600 shrink-0" />
                    <span className="text-sm font-medium text-blue-900 truncate flex-1">{selectedCompany.name}</span>
                    <button
                      type="button"
                      onClick={() => selectHistoryCompany(null)}
                      className="text-blue-400 hover:text-blue-600"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                ) : (
                  <CustomerSearch
                    value={null}
                    onChange={company => selectHistoryCompany(company ? { id: company.id, name: company.name } : null)}
                  />
                )}
              </div>
              <DateRangePicker value={dateRange} onChange={setDateRange} />
              <select
                value={ticketTypeFilter}
                onChange={e => setTicketTypeFilter(e.target.value)}
                className="px-3 py-1.5 border border-slate-300 rounded-md text-xs bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
              >
                <option value="">All types</option>
                <option value="field_service">Field Service</option>
                <option value="training">Training</option>
                <option value="inspection">Inspection</option>
                <option value="rental">Rental</option>
                <option value="repair">Repair</option>
                <option value="sale">Sale</option>
              </select>
            </div>
          </div>

          {historyLoading ? (
            <div className="flex items-center justify-center py-12"><Loader2 className="w-6 h-6 text-slate-400 animate-spin" /></div>
          ) : history.error ? (
            <DashboardLoadError message={history.error} onRetry={history.reload} />
          ) : !historyData || historyData.customers.length === 0 ? (
            <div className="bg-white rounded-lg border border-slate-200 p-8 text-center text-slate-400">
              No service history found for the selected filters.
            </div>
          ) : (
            <>
              {/* Customer summary cards */}
              {!selectedCompany && (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 mb-4">
                  {historyData.customers.map(c => (
                    <button
                      key={c.companyId}
                      onClick={() => selectHistoryCompany({ id: c.companyId, name: c.companyName })}
                      className="bg-white rounded-lg border border-slate-200 p-4 text-left hover:border-blue-300 hover:shadow-sm transition-all"
                    >
                      <div className="flex items-start justify-between mb-2">
                        <h3 className="font-semibold text-sm text-slate-900 truncate pr-2">{c.companyName}</h3>
                        <span className="text-sm font-bold text-emerald-700 whitespace-nowrap">{fmt$(c.totalRevenue)}</span>
                      </div>
                      <p className="text-xs text-slate-500 mb-2">{c.ticketCount} ticket{c.ticketCount !== 1 ? 's' : ''}</p>
                      <div className="flex flex-wrap gap-1">
                        {Object.entries(c.byType).map(([type, data]) => {
                          const info = TICKET_TYPE_LABELS[type] || { label: type, color: 'bg-slate-100 text-slate-600' }
                          return (
                            <span key={type} className={cn('text-[10px] font-medium px-1.5 py-0.5 rounded', info.color)}>
                              {info.label}: {data.count}
                            </span>
                          )
                        })}
                      </div>
                    </button>
                  ))}
                </div>
              )}

              {/* Selected company header */}
              {selectedCompany && (
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 mb-4 flex items-center justify-between">
                  <div>
                    <p className="font-semibold text-blue-900">{selectedCompany.name}</p>
                    <p className="text-xs text-blue-700">
                      {historyData.customers[0]?.ticketCount || 0} tickets &middot; {fmt$(historyData.customers[0]?.totalRevenue || 0)} revenue
                    </p>
                  </div>
                  <button
                    onClick={() => selectHistoryCompany(null)}
                    className="text-xs text-blue-600 hover:text-blue-800 font-medium"
                  >
                    ← All Customers
                  </button>
                </div>
              )}

              {/* Location breakdown (field → pad drill-down) */}
              {selectedCompany && historyData.locations.length > 0 && (
                <div className="bg-white rounded-lg border border-slate-200 p-4 mb-4">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
                      <Layers className="w-4 h-4" />
                      Locations
                    </h3>
                    {selectedPadId && (
                      <button
                        onClick={() => setSelectedPadId(null)}
                        className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 font-medium"
                      >
                        <X className="w-3 h-3" />
                        Clear location filter
                      </button>
                    )}
                  </div>
                  {(() => {
                    const fieldGroups = new Map<string, { fieldName: string; pads: LocationSummary[] }>()
                    for (const loc of historyData.locations) {
                      const key = loc.fieldId || '_none'
                      if (!fieldGroups.has(key)) {
                        fieldGroups.set(key, { fieldName: loc.fieldName || 'No Field', pads: [] })
                      }
                      fieldGroups.get(key)!.pads.push(loc)
                    }
                    return (
                      <div className="space-y-3">
                        {Array.from(fieldGroups.entries()).map(([fieldKey, group]) => (
                          <div key={fieldKey}>
                            <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-1.5">
                              {group.fieldName}
                            </p>
                            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
                              {group.pads.map(loc => (
                                <button
                                  key={loc.padId}
                                  onClick={() => setSelectedPadId(selectedPadId === loc.padId ? null : loc.padId)}
                                  className={cn(
                                    'text-left px-3 py-2 rounded-lg border transition-all text-xs',
                                    selectedPadId === loc.padId
                                      ? 'border-blue-400 bg-blue-50 ring-1 ring-blue-300'
                                      : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50'
                                  )}
                                >
                                  <div className="flex items-center gap-1.5 mb-0.5">
                                    <MapPin className={cn('w-3 h-3 shrink-0', selectedPadId === loc.padId ? 'text-blue-600' : 'text-slate-400')} />
                                    <span className={cn('font-medium truncate', selectedPadId === loc.padId ? 'text-blue-900' : 'text-slate-800')}>
                                      {loc.padName}
                                    </span>
                                  </div>
                                  <p className="text-slate-500 pl-4.5">
                                    {loc.ticketCount} ticket{loc.ticketCount !== 1 ? 's' : ''} &middot; {fmt$(loc.totalRevenue)}
                                  </p>
                                </button>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    )
                  })()}
                </div>
              )}

              {/* Ticket detail table (when company selected) */}
              {selectedCompany && (() => {
                const filteredTickets = selectedPadId
                  ? historyData.tickets.filter(t => t.padId === selectedPadId)
                  : historyData.tickets
                if (filteredTickets.length === 0) return (
                  <div className="bg-white rounded-lg border border-slate-200 p-6 text-center text-slate-400 text-sm">
                    {selectedPadId ? 'No tickets at this location.' : 'No tickets found.'}
                  </div>
                )
                return (
                  <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
                    {selectedPadId && (
                      <div className="px-4 py-2 bg-slate-50 border-b border-slate-200 flex items-center gap-2 text-xs text-slate-600">
                        <MapPin className="w-3.5 h-3.5 text-blue-500" />
                        Showing {filteredTickets.length} ticket{filteredTickets.length !== 1 ? 's' : ''} at{' '}
                        <span className="font-medium text-slate-800">
                          {historyData.locations.find(l => l.padId === selectedPadId)?.padName || 'selected location'}
                        </span>
                      </div>
                    )}
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="bg-slate-50 border-b border-slate-200">
                            <th className="text-left px-4 py-2.5 font-medium text-slate-600 text-xs">Date</th>
                            <th className="text-left px-4 py-2.5 font-medium text-slate-600 text-xs">Ticket</th>
                            <th className="text-left px-4 py-2.5 font-medium text-slate-600 text-xs">Type</th>
                            <th className="text-left px-4 py-2.5 font-medium text-slate-600 text-xs hidden md:table-cell">Location</th>
                            <th className="text-left px-4 py-2.5 font-medium text-slate-600 text-xs hidden lg:table-cell">Tech</th>
                            <th className="text-right px-4 py-2.5 font-medium text-slate-600 text-xs">Amount</th>
                            <th className="text-center px-4 py-2.5 font-medium text-slate-600 text-xs">Status</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {filteredTickets.map(t => {
                            const typeInfo = TICKET_TYPE_LABELS[t.ticketType] || { label: t.ticketType, color: 'bg-slate-100 text-slate-600' }
                            const locParts: string[] = []
                            if (t.fieldName) locParts.push(t.fieldName)
                            if (t.padName) locParts.push(t.padName)
                            if (t.wellName) locParts.push(t.wellName)
                            if (t.workPointName) locParts.push(`${t.workPointName}${t.workPointType ? ` (${t.workPointType})` : ''}`)
                            const locDisplay = locParts.length > 0 ? locParts.join(' → ') : (t.locationDisplay || '—')
                            return (
                              <tr
                                key={t.id}
                                onClick={() => navigate(`/tickets/${t.id}`)}
                                className="hover:bg-slate-50 cursor-pointer transition-colors"
                              >
                                <td className="px-4 py-2.5 text-slate-700 whitespace-nowrap">
                                  {formatCalendarDateNumeric(t.serviceDate)}
                                </td>
                                <td className="px-4 py-2.5 font-medium text-blue-700">{t.ticketNumber}</td>
                                <td className="px-4 py-2.5">
                                  <span className={cn('text-[10px] font-medium px-1.5 py-0.5 rounded', typeInfo.color)}>
                                    {typeInfo.label}
                                  </span>
                                </td>
                                <td className="px-4 py-2.5 text-slate-500 max-w-64 hidden md:table-cell" title={locDisplay}>
                                  <span className="block truncate">{locDisplay}</span>
                                </td>
                                <td className="px-4 py-2.5 text-slate-500 hidden lg:table-cell">{t.techName || '—'}</td>
                                <td className="px-4 py-2.5 text-right font-medium text-slate-700 whitespace-nowrap">
                                  {fmt$full(t.total)}
                                </td>
                                <td className="px-4 py-2.5 text-center">
                                  <span className={cn('text-[10px] font-medium px-1.5 py-0.5 rounded', STATUS_BADGE[t.status] || 'bg-slate-100 text-slate-600')}>
                                    {t.status.replace(/_/g, ' ')}
                                  </span>
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )
              })()}
            </>
          )}
        </>
      )}

      {/* ═══ BILLING TAB ═══ */}
      {tab === 'billing' && canBilling && (
        <>
          {billingLoading ? (
            <div className="flex items-center justify-center py-12"><Loader2 className="w-6 h-6 text-slate-400 animate-spin" /></div>
          ) : billing.error ? (
            <DashboardLoadError message={billing.error} onRetry={billing.reload} />
          ) : !billingData ? (
            <div className="bg-white rounded-lg border border-slate-200 p-8 text-center text-slate-400">
              Unable to load billing data.
            </div>
          ) : (
            <>
              {/* Pipeline Cards */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
                <PipelineCard
                  icon={ClipboardList}
                  label="Waiting to Bill"
                  value={fmt$(billingData.pipeline.ticketQueueTotal)}
                  sub={`${billingData.pipeline.ticketsReadyToBill} tickets`}
                  color="amber"
                />
                <PipelineCard
                  icon={Wrench}
                  label="Shop WOs Ready"
                  value={String(billingData.pipeline.shopWOsReadyToBill)}
                  sub="closed, no invoice"
                  color="orange"
                />
                <PipelineCard
                  icon={Truck}
                  label="Active Rentals"
                  value={String(billingData.pipeline.activeRentals)}
                  sub={`~${fmt$(billingData.pipeline.activeRentalEstMonthly)}/mo`}
                  color="blue"
                />
                <PipelineCard
                  icon={TrendingUp}
                  label="MTD Billed"
                  value={fmt$(billingData.monthToDate.total)}
                  sub={`${new Date().toLocaleString('default', { month: 'long' })} to date`}
                  color="emerald"
                />
              </div>

              {/* Invoice pipeline sub-counts */}
              <div className="bg-white rounded-lg border border-slate-200 p-4 mb-4">
                <h3 className="text-sm font-semibold text-slate-700 mb-3 flex items-center gap-2">
                  <FileText className="w-4 h-4" />
                  Invoice Pipeline
                </h3>
                <div className="flex flex-wrap gap-3">
                  {[
                    { label: 'Drafts', count: billingData.pipeline.draftInvoices, color: 'slate' },
                    { label: 'Approved', count: billingData.pipeline.approvedInvoices, color: 'blue' },
                    { label: 'Queued for QB', count: billingData.pipeline.queuedInvoices, color: 'amber' },
                    { label: 'Sales Orders', count: billingData.pipeline.soCreatedInvoices, color: 'emerald' },
                  ].map(s => (
                    <div key={s.label} className="flex items-center gap-2 px-3 py-2 bg-slate-50 rounded-lg">
                      <span className={cn('w-2 h-2 rounded-full', `bg-${s.color}-500`)} />
                      <span className="text-xs text-slate-600">{s.label}</span>
                      <span className="text-sm font-bold text-slate-900">{s.count}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* MTD by Area */}
              {billingData.monthToDate.bySource.length > 0 && (
                <div className="bg-white rounded-lg border border-slate-200 p-4 mb-4">
                  <h3 className="text-sm font-semibold text-slate-700 mb-3">MTD Revenue by Area</h3>
                  <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                    {billingData.monthToDate.bySource.map(s => (
                      <div key={s.sourceType} className="bg-slate-50 rounded-lg p-3">
                        <p className="text-xs text-slate-500 mb-1">{SOURCE_LABELS[s.sourceType] || s.sourceType}</p>
                        <p className="text-lg font-bold text-slate-900">{fmt$(s.total)}</p>
                        <p className="text-xs text-slate-400">{s.count} invoice{s.count !== 1 ? 's' : ''}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* MTD by Customer — bar chart */}
              {billingData.monthToDate.byCustomer.length > 0 && (
                <div className="bg-white rounded-lg border border-slate-200 p-4 mb-4">
                  <h3 className="text-sm font-semibold text-slate-700 mb-3">MTD Revenue by Customer</h3>
                  <div className="space-y-2">
                    {(() => {
                      const max = Math.max(...billingData.monthToDate.byCustomer.map(c => c.total), 1)
                      return billingData.monthToDate.byCustomer.map(c => (
                        <div key={c.companyId} className="flex items-center gap-3">
                          <span className="text-xs text-slate-700 w-32 truncate shrink-0" title={c.companyName}>{c.companyName}</span>
                          <div className="flex-1 bg-slate-100 rounded-full h-5 overflow-hidden">
                            <div
                              className="bg-blue-500 h-5 rounded-full flex items-center justify-end pr-2 transition-all"
                              style={{ width: `${Math.max((c.total / max) * 100, 8)}%` }}
                            >
                              {(c.total / max) > 0.3 && (
                                <span className="text-[10px] font-medium text-white">{fmt$(c.total)}</span>
                              )}
                            </div>
                          </div>
                          {(c.total / max) <= 0.3 && (
                            <span className="text-xs font-medium text-slate-700 w-20 text-right shrink-0">{fmt$(c.total)}</span>
                          )}
                        </div>
                      ))
                    })()}
                  </div>
                </div>
              )}

              {/* Billing Queue by Customer */}
              {billingData.pipeline.ticketQueueByCompany.length > 0 && (
                <div className="bg-white rounded-lg border border-slate-200 overflow-hidden mb-4">
                  <div className="p-4 border-b border-slate-200">
                    <h3 className="text-sm font-semibold text-slate-700">Billing Queue — Ready to Invoice</h3>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-slate-50 border-b border-slate-200">
                          <th className="text-left px-4 py-2.5 font-medium text-slate-600 text-xs">Customer</th>
                          <th className="text-center px-4 py-2.5 font-medium text-slate-600 text-xs">Tickets</th>
                          <th className="text-right px-4 py-2.5 font-medium text-slate-600 text-xs">Total</th>
                          <th className="text-right px-4 py-2.5 font-medium text-slate-600 text-xs"></th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {billingData.pipeline.ticketQueueByCompany.map(q => (
                          <tr key={q.companyId} className="hover:bg-slate-50">
                            <td className="px-4 py-2.5 font-medium text-slate-900">{q.companyName}</td>
                            <td className="px-4 py-2.5 text-center text-slate-600">{q.count}</td>
                            <td className="px-4 py-2.5 text-right font-medium text-emerald-700">{fmt$full(q.total)}</td>
                            <td className="px-4 py-2.5 text-right">
                              <button
                                onClick={() => navigate('/billing')}
                                className="text-xs text-blue-600 hover:text-blue-800 font-medium"
                              >
                                Invoice →
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}

// ─── H2S Analytics Sub-component ─────────────────────────────

function DashboardLoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
    Could not load this report. {message}
    <button type="button" onClick={onRetry} className="ml-2 font-medium underline">Retry</button>
  </div>
}

function H2SAnalyticsTab({
  companies,
  selectedCompany,
  onSelectCompany,
  data,
  loading,
  listLoading,
  error,
  onRetry,
  pieFilter,
  onPieFilter,
  selectedLocation,
  onSelectLocation,
  navigate,
}: {
  companies: H2SCompanySummary[]
  selectedCompany: { id: string; name: string } | null
  onSelectCompany: (c: { id: string; name: string } | null) => void
  data: H2SAnalyticsData | null
  loading: boolean
  listLoading: boolean
  error: string | null
  onRetry: () => void
  pieFilter: 'all' | 'safe' | 'elevated'
  onPieFilter: (f: 'all' | 'safe' | 'elevated') => void
  selectedLocation: H2SLocation | null
  onSelectLocation: (loc: H2SLocation | null) => void
  navigate: (path: string) => void
}) {
  // Company picker
  if (!selectedCompany) {
    return (
      <div className="space-y-4">
        <div className="bg-white rounded-lg border border-slate-200 p-4">
          <h3 className="text-sm font-semibold text-slate-700 mb-3 flex items-center gap-2">
            <Activity className="w-4 h-4" />
            Select a customer to view H2S analytics
          </h3>
          <div className="w-72">
            <CustomerSearch
              value={null}
              onChange={c => {
                if (c) onSelectCompany({ id: c.id, name: c.name })
              }}
            />
          </div>
        </div>

        {listLoading && <p role="status" className="text-sm text-slate-500">Loading customers…</p>}
        {error && <DashboardLoadError message={error} onRetry={onRetry} />}
        {companies.length > 0 && (
          <div className="bg-white rounded-lg border border-slate-200 p-4">
            <h3 className="text-sm font-semibold text-slate-700 mb-3">Customers with H2S Data</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
              {companies.map(c => (
                <button
                  key={c.companyId}
                  onClick={() => onSelectCompany({ id: c.companyId, name: c.companyName })}
                  className="flex items-center gap-3 px-4 py-3 rounded-lg border border-slate-200 hover:border-blue-300 hover:bg-blue-50 transition-all text-left"
                >
                  <Activity className="w-4 h-4 text-amber-500 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm text-slate-900 truncate">{c.companyName}</p>
                    <p className="text-xs text-slate-500">{c.ticketCount} ticket{c.ticketCount !== 1 ? 's' : ''} with readings</p>
                  </div>
                  <ChevronRight className="w-4 h-4 text-slate-400 shrink-0" />
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    )
  }

  // Timeline view for selected location
  if (selectedLocation) {
    return (
      <div className="space-y-4">
        {/* Breadcrumb */}
        <div className="flex items-center gap-2 text-sm">
          <button
            onClick={() => onSelectCompany(null)}
            className="text-blue-600 hover:text-blue-800"
          >
            H2S Analytics
          </button>
          <ChevronRight className="w-3 h-3 text-slate-400" />
          <button
            onClick={() => onSelectLocation(null)}
            className="text-blue-600 hover:text-blue-800"
          >
            {selectedCompany.name}
          </button>
          <ChevronRight className="w-3 h-3 text-slate-400" />
          <span className="text-slate-700 font-medium">{selectedLocation.locationName}</span>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard label="Readings" value={String(selectedLocation.readingCount)} />
          <StatCard label="Max H2S" value={`${selectedLocation.maxH2S} ppm`} alert={selectedLocation.elevated} />
          <StatCard label="Latest" value={`${selectedLocation.latestH2S ?? '—'} ppm`} />
          <StatCard label="Status" value={selectedLocation.elevated ? 'ELEVATED' : 'SAFE'} alert={selectedLocation.elevated} />
        </div>

        {/* Timeline chart */}
        <div className="bg-white rounded-lg border border-slate-200 p-4">
          <h3 className="text-sm font-semibold text-slate-700 mb-4 flex items-center gap-2">
            <Activity className="w-4 h-4" />
            H2S Readings Over Time — {selectedLocation.locationName}
          </h3>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={selectedLocation.readings.map(r => ({
                  date: r.serviceDate,
                  h2s: r.value,
                  ticket: r.ticketNumber,
                  context: r.context,
                }))}
                margin={{ top: 5, right: 20, bottom: 5, left: 10 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 11, fill: '#64748b' }}
                  tickFormatter={(d: string) => {
                    const parts = d.split('-')
                    return `${parts[1]}/${parts[2]}/${parts[0].slice(2)}`
                  }}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: '#64748b' }}
                  label={{ value: 'ppm', angle: -90, position: 'insideLeft', style: { fontSize: 11, fill: '#94a3b8' } }}
                />
                <ReferenceLine
                  y={H2S_THRESHOLD}
                  stroke="#ef4444"
                  strokeDasharray="6 3"
                  strokeWidth={2}
                  label={{ value: '10 ppm threshold', position: 'right', fill: '#ef4444', fontSize: 11 }}
                />
                <ReTooltip
                  content={({ active, payload }) => {
                    if (!active || !payload?.length) return null
                    const d = payload[0].payload
                    return (
                      <div className="bg-white border border-slate-200 rounded-lg shadow-lg px-3 py-2 text-xs">
                        <p className="font-medium text-slate-900">{d.h2s} ppm</p>
                        <p className="text-slate-500">{d.date}</p>
                        <p className="text-slate-500">Ticket: {d.ticket}</p>
                        {d.context !== 'general' && <p className="text-slate-400">Context: {d.context}</p>}
                      </div>
                    )
                  }}
                />
                <Line
                  type="monotone"
                  dataKey="h2s"
                  stroke="#3b82f6"
                  strokeWidth={2}
                  dot={(props: DotItemDotProps) => {
                    const { cx, cy, payload } = props
                    const reading = payload as { h2s: number }
                    const isOver = reading.h2s >= H2S_THRESHOLD
                    return (
                      <circle
                        key={`dot-${cx}-${cy}`}
                        cx={cx}
                        cy={cy}
                        r={isOver ? 6 : 4}
                        fill={isOver ? '#ef4444' : '#3b82f6'}
                        stroke="#fff"
                        strokeWidth={2}
                      />
                    )
                  }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Readings table */}
        <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200">
            <h3 className="text-sm font-semibold text-slate-700">All Readings</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200">
                  <th className="text-left px-4 py-2 font-medium text-slate-600 text-xs">Date</th>
                  <th className="text-left px-4 py-2 font-medium text-slate-600 text-xs">Ticket</th>
                  <th className="text-right px-4 py-2 font-medium text-slate-600 text-xs">H2S (ppm)</th>
                  <th className="text-left px-4 py-2 font-medium text-slate-600 text-xs">Context</th>
                  <th className="text-left px-4 py-2 font-medium text-slate-600 text-xs">Type</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {[...selectedLocation.readings].reverse().map((r, i) => (
                  <tr
                    key={i}
                    onClick={() => navigate(`/tickets/${r.ticketId}`)}
                    className="hover:bg-slate-50 cursor-pointer transition-colors"
                  >
                    <td className="px-4 py-2 text-slate-700">{r.serviceDate}</td>
                    <td className="px-4 py-2 font-medium text-blue-700">{r.ticketNumber}</td>
                    <td className="px-4 py-2 text-right">
                      <span className={cn(
                        'font-bold',
                        r.value >= H2S_THRESHOLD ? 'text-red-600' : 'text-green-600'
                      )}>
                        {r.value}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-slate-500 capitalize">{r.context}</td>
                    <td className="px-4 py-2 text-slate-500 capitalize">{r.readingType}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    )
  }

  // Main view: pie chart + location list
  return (
    <div className="space-y-4">
      {/* Company header */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Activity className="w-5 h-5 text-blue-600" />
          <div>
            <p className="font-semibold text-blue-900">{selectedCompany.name}</p>
            <p className="text-xs text-blue-700">H2S Analysis</p>
          </div>
        </div>
        <button
          onClick={() => { onSelectCompany(null); onSelectLocation(null); onPieFilter('all') }}
          className="text-xs text-blue-600 hover:text-blue-800 font-medium flex items-center gap-1"
        >
          <ChevronLeft className="w-3 h-3" />
          Change Customer
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12"><Loader2 className="w-6 h-6 text-slate-400 animate-spin" /></div>
      ) : error ? (
        <DashboardLoadError message={error} onRetry={onRetry} />
      ) : !data || data.totalLocations === 0 ? (
        <div className="bg-white rounded-lg border border-slate-200 p-8 text-center text-slate-400">
          No H2S readings found for this customer.
        </div>
      ) : (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-3 gap-3">
            <StatCard label="Total Locations" value={String(data.totalLocations)} />
            <StatCard label="Elevated (10+ ppm)" value={String(data.elevatedCount)} alert={data.elevatedCount > 0} />
            <StatCard label="Safe (0-9 ppm)" value={String(data.safeCount)} safe />
          </div>

          {/* Pie chart + location list side by side */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Pie chart */}
            <div className="bg-white rounded-lg border border-slate-200 p-4">
              <h3 className="text-sm font-semibold text-slate-700 mb-2 flex items-center gap-2">
                <Activity className="w-4 h-4" />
                Location Breakdown
              </h3>
              <p className="text-xs text-slate-500 mb-4">
                Locations by max H2S reading (threshold: {H2S_THRESHOLD} ppm). Click a section to filter.
              </p>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={[
                        { name: 'Safe (0-9 ppm)', value: data.safeCount, key: 'safe' },
                        { name: 'Elevated (10+ ppm)', value: data.elevatedCount, key: 'elevated' },
                      ]}
                      cx="50%"
                      cy="50%"
                      innerRadius={50}
                      outerRadius={90}
                      paddingAngle={data.safeCount > 0 && data.elevatedCount > 0 ? 4 : 0}
                      dataKey="value"
                      cursor="pointer"
                      onClick={entry => {
                        const datum = entry as { key?: 'safe' | 'elevated'; payload?: { key?: 'safe' | 'elevated' } }
                        const key = datum.key || datum.payload?.key
                        if (key === 'safe') onPieFilter(pieFilter === 'safe' ? 'all' : 'safe')
                        else if (key === 'elevated') onPieFilter(pieFilter === 'elevated' ? 'all' : 'elevated')
                      }}
                      label={({ value, percent }) =>
                        value > 0 ? `${value} (${((percent ?? 0) * 100).toFixed(0)}%)` : ''
                      }
                      labelLine={false}
                    >
                      <Cell fill={pieFilter === 'elevated' ? '#e2e8f0' : PIE_COLORS.safe} stroke={pieFilter === 'safe' ? '#16a34a' : 'none'} strokeWidth={pieFilter === 'safe' ? 3 : 0} />
                      <Cell fill={pieFilter === 'safe' ? '#e2e8f0' : PIE_COLORS.elevated} stroke={pieFilter === 'elevated' ? '#dc2626' : 'none'} strokeWidth={pieFilter === 'elevated' ? 3 : 0} />
                    </Pie>
                    <ReTooltip
                      content={({ active, payload }) => {
                        if (!active || !payload?.length) return null
                        const d = payload[0]
                        return (
                          <div className="bg-white border border-slate-200 rounded-lg shadow-lg px-3 py-2 text-xs">
                            <p className="font-medium text-slate-900">{d.name}</p>
                            <p className="text-slate-600">{d.value} location{(d.value as number) !== 1 ? 's' : ''}</p>
                          </div>
                        )
                      }}
                    />
                    <Legend
                      verticalAlign="bottom"
                      height={36}
                      formatter={(value: string) => <span className="text-xs text-slate-600">{value}</span>}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              {pieFilter !== 'all' && (
                <button
                  onClick={() => onPieFilter('all')}
                  className="mt-2 text-xs text-blue-600 hover:text-blue-800 flex items-center gap-1"
                >
                  <X className="w-3 h-3" /> Clear filter
                </button>
              )}
            </div>

            {/* Location list */}
            <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-700">
                  {pieFilter === 'safe' ? 'Safe Locations' : pieFilter === 'elevated' ? 'Elevated Locations' : 'All Locations'}
                </h3>
                <span className="text-xs text-slate-500">
                  {(pieFilter === 'all' ? data.locations : data.locations.filter(l => pieFilter === 'elevated' ? l.elevated : !l.elevated)).length} locations
                </span>
              </div>
              <div className="overflow-y-auto max-h-80 divide-y divide-slate-100">
                {(pieFilter === 'all'
                  ? data.locations
                  : data.locations.filter(l => pieFilter === 'elevated' ? l.elevated : !l.elevated)
                ).map(loc => (
                  <button
                    key={loc.locationKey}
                    onClick={() => onSelectLocation(loc)}
                    className="w-full flex items-center gap-3 px-4 py-3 hover:bg-slate-50 transition-colors text-left"
                  >
                    {loc.elevated ? (
                      <ShieldAlert className="w-5 h-5 text-red-500 shrink-0" />
                    ) : (
                      <Shield className="w-5 h-5 text-green-500 shrink-0" />
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm text-slate-900 truncate">{loc.locationName}</p>
                      <p className="text-xs text-slate-500">
                        {loc.readingCount} reading{loc.readingCount !== 1 ? 's' : ''}
                        {' '}&middot;{' '}
                        Max: <span className={cn('font-bold', loc.elevated ? 'text-red-600' : 'text-green-600')}>{loc.maxH2S} ppm</span>
                        {loc.latestH2S !== null && (
                          <> &middot; Latest: <span className={cn('font-medium', (loc.latestH2S ?? 0) >= H2S_THRESHOLD ? 'text-red-600' : 'text-green-600')}>{loc.latestH2S} ppm</span></>
                        )}
                      </p>
                    </div>
                    <ChevronRight className="w-4 h-4 text-slate-400 shrink-0" />
                  </button>
                ))}
                {((pieFilter === 'all' ? data.locations : data.locations.filter(l => pieFilter === 'elevated' ? l.elevated : !l.elevated)).length === 0) && (
                  <div className="px-4 py-6 text-center text-sm text-slate-400">
                    No locations in this category.
                  </div>
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

// ─── Sub-components ──────────────────────────────────────────

function StatCard({ label, value, alert, safe }: { label: string; value: string; alert?: boolean; safe?: boolean }) {
  return (
    <div className={cn(
      'rounded-lg border p-3',
      alert ? 'bg-red-50 border-red-200' : safe ? 'bg-green-50 border-green-200' : 'bg-white border-slate-200'
    )}>
      <p className="text-xs font-medium text-slate-500 mb-1">{label}</p>
      <p className={cn(
        'text-xl font-bold',
        alert ? 'text-red-700' : safe ? 'text-green-700' : 'text-slate-900'
      )}>{value}</p>
    </div>
  )
}

function PipelineCard({ icon: Icon, label, value, sub, color }: {
  icon: typeof DollarSign
  label: string
  value: string
  sub: string
  color: string
}) {
  const bgMap: Record<string, string> = {
    amber: 'bg-amber-50 border-amber-200',
    orange: 'bg-orange-50 border-orange-200',
    blue: 'bg-blue-50 border-blue-200',
    emerald: 'bg-emerald-50 border-emerald-200',
  }
  const iconMap: Record<string, string> = {
    amber: 'text-amber-600',
    orange: 'text-orange-600',
    blue: 'text-blue-600',
    emerald: 'text-emerald-600',
  }
  return (
    <div className={cn('rounded-lg border p-3', bgMap[color] || 'bg-slate-50 border-slate-200')}>
      <div className="flex items-center gap-1.5 mb-1">
        <Icon className={cn('w-4 h-4', iconMap[color] || 'text-slate-500')} />
        <span className="text-xs font-medium text-slate-600">{label}</span>
      </div>
      <p className="text-xl font-bold text-slate-900">{value}</p>
      <p className="text-xs text-slate-500">{sub}</p>
    </div>
  )
}
