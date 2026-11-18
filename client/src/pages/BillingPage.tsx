import { InvoiceCustomerAttribution } from '@/components/InvoiceCustomerAttribution'
import { EnverusWarnings } from '@/components/EnverusWarnings'
import { RebillingReport } from '@/components/RebillingReport'
import { ShopBillingWaiverButton } from '@/components/ShopBillingWaiverButton'
import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '@/lib/api'
import { cn } from '@/lib/cn'
import { useAuth } from '@/contexts/AuthContext'
import { usePermissions } from '@/contexts/PermissionsContext'
import { hasPermission } from '@/lib/permissions'
import { defaultRentalBillingPeriod } from '@/lib/rentalBillingPeriod'
import { invoiceListQuery } from '@/lib/invoiceList'
import { formatCalendarDateNumeric } from '@/lib/dates'
import { BillingProvenancePill, type BillingObservationLite } from '@/components/BillingProvenancePill'
import {
  DollarSign,
  Search,
  Loader2,
  CheckCircle2,
  Clock,
  Send,
  FileText,
  AlertTriangle,
  ArrowRight,
  XCircle,
  Hammer,
  ClipboardList,
  Plus,
  GraduationCap,
  Truck,
  RefreshCw,
  Zap,
  RotateCcw,
  Trash2,
  Wifi,
  WifiOff,
  Database,
  ChevronDown,
  ChevronUp,
  CornerUpLeft,
  ShieldAlert,
} from 'lucide-react'

type TabFilter = 'ready' | 'drafts' | 'approved' | 'in_qb' | 'invoiced' | 'enverus' | 'signatures' | 'all' | 'rebilling'
// Ready-tab type filter — mirrors the sections the Ready tab is broken into.
type ReadyType = 'all' | 'shop' | 'rentals' | 'training' | 'field'

interface Invoice {
  locationName?: string | null
  id: string
  qbExportError?: string | null
  invoiceNumber: string
  status: string
  sourceType: string
  companyId: string
  companyName: string
  qbCustomerOverride?: string | null
  poNumber: string | null
  afeNumber: string | null
  invoiceDate: string
  periodStart: string | null
  periodEnd: string | null
  subtotal: string | number
  total: string | number
  qbSalesOrderNumber: string | null
  qbInvoiceNumber: string | null
  enverusStatus: string | null
  sourceModifiedAfterSync: boolean
  createdAt: string
  approvedBy?: { id: string; name: string } | null
  createdBy?: { id: string; name: string } | null
  _count?: { lineItems: number }
  sourceTickets?: Array<{ id: string; number: string | null }>
}

interface EnverusAlert {
  hasIssues: boolean
  totalIssues: number
  errors: {
    count: number
    items: EnverusQueueEntry[]
  }
  disputed: {
    count: number
    queueItems: EnverusQueueEntry[]
    tickets: Array<{
      id: string
      ticketNumber: string
      enverusReceiptStatus: string
      serviceDate: string
      company: { name: string }
    }>
  }
}

interface EnverusQueueEntry {
  responsePayload?: string | null
  id: string
  entityType: string
  entityId: string
  target: string
  action: string
  status: string
  endpointUrl: string | null
  errorMessage: string | null
  retryCount: number
  enverusItemId: string | null
  entityNumber: string | null
  createdAt: string
  submittedAt: string | null
  respondedAt: string | null
}

interface EnverusQueueStats {
  pending?: number
  submitted?: number
  accepted?: number
  rejected?: number
  error?: number
  retrying?: number
}

interface BillingStats {
  statusCounts?: Record<string, number>
  drafts: number
  approved: number
  queued: number
  salesOrders: number
  invoiced: number
  monthToDateTotal: number | string
  ticketsReadyToBill: number
  shopWOsReadyToBill: number
}

interface UninvoicedShopWO {
  locationName?: string | null
  id: string
  workOrderNumber: string
  status: string
  companyId: string
  isInternal: boolean
  poNumber: string | null
  afeNumber: string | null
  intakeDate: string
  completedDate: string | null
  returnedDate: string | null
  totalItems: number
  completedItems: number
  company: { id: string; name: string }
  createdBy?: { id: string; name: string } | null
  _count: { items: number }
}

interface UninvoicedTicketGroup {
  groupKey: string
  company: { id: string; name: string }
  field: { id: string; name: string } | null
  month: string | null
  monthLabel: string | null
  tickets: Array<{
    locationName?: string | null
    id: string
    ticketNumber: string
    ticketType: string
    serviceSubtype: string | null
    serviceDate: string
    billingGroupKey: string | null
    customData?: { shopWorkOrderNumber?: string; shopWorkOrderId?: string } | null
    total: string | number | null
    assignedTech?: { id: string; name: string } | null
    createdBy?: { id: string; name: string } | null
    _count: { lineItems: number }
  }>
}

interface UninvoicedRental {
  locationName?: string | null
  id: string
  agreementNumber: string | null
  status: string
  startDate: string
  endDate: string | null
  billingRateType: string
  poNumber: string | null
  company: { id: string; name: string }
  createdBy?: { id: string; name: string } | null
  _count: { items: number }
  lastBilledThrough: string | null
  deployedItemCount: number
  finalInvoice?: { id: string; invoiceNumber: string } | null
  needsFinalBill: boolean
  /** Send-for-billing state. `unreleased` / `closed_blocked` only ever reach
   *  this page for an AR Supervisor who asked to see unsent rentals. */
  releaseState: 'unreleased' | 'released' | 'closed_blocked' | 'closed_ready' | null
  releaseBlockers: Array<{ id: string; ticketNumber: string; status: string; serviceDate: string }>
  billingReleasedThrough: string | null
  billingReleasedAt: string | null
  billingReleasedBy?: { id: string; name: string } | null
  billingReleaseForceReason: string | null
  /** Tickets attached to this rental that are still waiting to be billed
   *  through it. They're deliberately absent from the standalone ticket queue
   *  (double-invoice guard), so this card is where they become visible. */
  pendingTickets: Array<{
    id: string
    ticketNumber: string
    status: string
    serviceDate: string
    total: number
  }>
  pendingTicketTotal: number
}

interface UninvoicedTrainingTicket {
  locationName?: string | null
  ticketId: string
  ticketNumber: string
  serviceDate: string
  courseName: string
  bookingCompany: string
  bookingCompanyId?: string | null
  billingBasis?: 'per_student' | 'per_class'
  rosterCount: number
  technicianName?: string | null
  createdByName?: string | null
  employers: Array<{
    employerName: string
    employerCompanyId: string | null
    count: number
    passedCount: number
    names: string[]
  }>
}

const STATUS_BADGE: Record<string, { label: string; color: string; icon: any }> = {
  draft: { label: 'Draft', color: 'bg-slate-100 text-slate-600', icon: FileText },
  approved: { label: 'Approved', color: 'bg-blue-100 text-blue-700', icon: CheckCircle2 },
  queued: { label: 'QB Queued', color: 'bg-amber-100 text-amber-700', icon: Clock },
  so_created: { label: 'QB Accepted · Sales Order', color: 'bg-purple-100 text-purple-700', icon: Send },
  invoiced: { label: 'Invoiced', color: 'bg-green-100 text-green-700', icon: DollarSign },
  sent: { label: 'Sent', color: 'bg-emerald-100 text-emerald-700', icon: Send },
  paid: { label: 'Paid', color: 'bg-emerald-200 text-emerald-800', icon: CheckCircle2 },
  void: { label: 'Voided', color: 'bg-red-100 text-red-700', icon: XCircle },
}

const SOURCE_LABELS: Record<string, string> = {
  billing_group: 'Field Tickets',
  shop_work_order: 'Shop WO',
  rental_agreement: 'Rental',
  manual: 'Manual',
}

export function BillingPage() {
  const [trainingPayers, setTrainingPayers] = useState<Record<string, string>>({})
  const navigate = useNavigate()
  const { user } = useAuth()
  const { can } = usePermissions()
  const canEnverus = hasPermission(user?.role, 'billing:enverus')
  // AR Supervisor escape hatch: list rentals the field has not sent, to force them.
  const canForceRelease = can('rentals:force_billing_release')
  const [showUnreleased, setShowUnreleased] = useState(false)
  const showUnreleasedRef = useRef(false)
  const [invoices, setInvoices] = useState<Invoice[]>([])
  // Latest mirrored fact per (invoiceNumber, factKey) — one batch fetch for
  // the whole visible list, not one lineage lookup per card. See
  // GET /billing/observations/latest in server/src/routes/billing.ts.
  const [latestObservations, setLatestObservations] = useState<Record<string, Record<string, Omit<BillingObservationLite, 'factKey'>>>>({})
  const [stats, setStats] = useState<BillingStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<TabFilter>('ready')
  const [search, setSearch] = useState('')
  // `/billing?tab=rentals` (the rental "final bill" link and the dashboard
  // unbilled-rentals banner) opens the Ready queue already narrowed to rentals.
  const [readyType, setReadyType] = useState<ReadyType>(() =>
    new URLSearchParams(window.location.search).get('tab') === 'rentals' ? 'rentals' : 'all')
  const [invoiceTotal, setInvoiceTotal] = useState(0)
  const [invoiceOffset, setInvoiceOffset] = useState(0)
  const [invoiceListLoading, setInvoiceListLoading] = useState(false)
  const [invoiceListError, setInvoiceListError] = useState(false)
  const invoiceRequest = useRef(0)
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [collapsedGroupKeys, setCollapsedGroupKeys] = useState<Set<string>>(new Set())
  // Kick-back modal target: one billing-queue ticket, or every ticket in a
  // Ready group. `key` is the actionLoading key for the button that opened it.
  // `invoice` is set when the ticket is being taken off a draft invoice rather
  // than out of the Ready queue.
  const [returnModal, setReturnModal] = useState<{ key: string; label: string; tickets: { id: string; ticketNumber: string }[]; invoice?: { id: string; invoiceNumber: string } } | null>(null)
  const [returnNote, setReturnNote] = useState('')

  // Uninvoiced items
  const [uninvoicedWOs, setUninvoicedWOs] = useState<UninvoicedShopWO[]>([])
  const [uninvoicedTicketGroups, setUninvoicedTicketGroups] = useState<UninvoicedTicketGroup[]>([])
  const [uninvoicedTraining, setUninvoicedTraining] = useState<UninvoicedTrainingTicket[]>([])
  const [uninvoicedRentals, setUninvoicedRentals] = useState<UninvoicedRental[]>([])
  // Which billing queues failed to load this pass — surfaced so an empty
  // section reads as "couldn't load" rather than "nothing to bill".
  const [loadErrors, setLoadErrors] = useState<string[]>([])
  const [rentalPeriods, setRentalPeriods] = useState<Record<string, { start: string; end: string }>>({})
  const [rentalPreview, setRentalPreview] = useState<{ id: string; start: string; end: string; data: { periodStart: string; periodEnd: string; days: { total: number; paused: number; manned: number; unmanned: number }; attendanceBased: boolean; subtotal: number; taxAmount: number; total: number; lineItems: { description: string; quantity: number; unitOfMeasure: string; rate: number; amount: number }[]; rateChanges: { effectiveDate: string; manned: number; unmanned: number }[]; equipment: { serial: string; deployed: string; returned: string | null; replacesItemId: string | null }[]; lateMannedDays?: { date: string; ticketNumbers: string[]; billedOn: string; difference: number }[] } } | null>(null)

  // Enverus alerts & queue
  const [enverusAlerts, setEnverusAlerts] = useState<EnverusAlert | null>(null)
  const [enverusQueueStats, setEnverusQueueStats] = useState<EnverusQueueStats | null>(null)
  const [enverusQueue, setEnverusQueue] = useState<EnverusQueueEntry[]>([])
  const [enverusQueueLoading, setEnverusQueueLoading] = useState(false)

  // Enverus toolbox
  const [connTest, setConnTest] = useState<{ ok: boolean; message: string; latencyMs?: number } | null>(null)
  const [connTestLoading, setConnTestLoading] = useState(false)
  const [masterDuns, setMasterDuns] = useState('074292095')
  const [masterDataType, setMasterDataType] = useState<'afes' | 'cost-centers' | 'requisitioners' | 'purchase-orders' | 'buyer-rules' | 'customers'>('afes')
  const [masterDataResult, setMasterDataResult] = useState<unknown[] | null>(null)
  const [masterDataLoading, setMasterDataLoading] = useState(false)
  const [masterDataError, setMasterDataError] = useState<string | null>(null)
  const [toolboxOpen, setToolboxOpen] = useState(true)
  const [masterDataOpen, setMasterDataOpen] = useState(false)
  const [testReceiptLoading, setTestReceiptLoading] = useState(false)
  const [testReceiptResult, setTestReceiptResult] = useState<unknown | null>(null)
  const [testRequisitioner, setTestRequisitioner] = useState('')
  const [testProductCode, setTestProductCode] = useState('MISC')
  const [testReceiptType, setTestReceiptType] = useState('General')  // General confirmed accepted; LEM also valid but needs chargeType+AFE
  const [testChargeType, setTestChargeType] = useState('Labor')  // chargeType is REQUIRED on each line item for LEM receipts (Labor, Equipment, Material)
  const [testAfe, setTestAfe] = useState('')  // AFE / Charge To — REQUIRED for LEM per Continental guidelines
  const [requisitionerList, setRequisitionerList] = useState<string[]>([])
  const [requisitionerLoading, setRequisitionerLoading] = useState(false)
  const [showPayloadPreview, setShowPayloadPreview] = useState(false)
  const [rawApiOpen, setRawApiOpen] = useState(false)
  const [rawApiPath, setRawApiPath] = useState('/supply-chain/v1/receipts')
  const [rawApiMethod, setRawApiMethod] = useState('GET')
  const [rawApiLoading, setRawApiLoading] = useState(false)
  const [rawApiResult, setRawApiResult] = useState<unknown | null>(null)

  // Signature queue
  const [signatureRequests, setSignatureRequests] = useState<any[]>([])
  const [sigLoading, setSigLoading] = useState(false)
  const [sigActionLoading, setSigActionLoading] = useState<string | null>(null)


  async function loadInvoicePage(append = false) {
    if (tab === 'ready' || tab === 'enverus' || tab === 'signatures' || tab === 'rebilling') return
    const request = ++invoiceRequest.current
    const offset = append ? invoiceOffset : 0
    setInvoiceListLoading(true)
    setInvoiceListError(false)
    try {
      const result = await api.get<{ data: Invoice[]; total: number }>(invoiceListQuery(tab, search, offset))
      if (request !== invoiceRequest.current) return
      setInvoices(previous => append ? [...previous, ...result.data.filter(row => !previous.some(i => i.id === row.id))] : result.data)
      setInvoiceTotal(result.total)
      setInvoiceOffset(offset + result.data.length)
      const docNumbers = result.data.map(i => i.invoiceNumber).filter(Boolean)
      if (docNumbers.length) {
        api.get<Record<string, Record<string, Omit<BillingObservationLite, 'factKey'>>>>(
          `/billing/observations/latest?docNumbers=${docNumbers.map(encodeURIComponent).join(',')}`,
        ).then(rows => { if (request === invoiceRequest.current) setLatestObservations(previous => append ? { ...previous, ...rows } : rows) }).catch(() => {})
      }
    } catch {
      if (request === invoiceRequest.current) setInvoiceListError(true)
    } finally {
      if (request === invoiceRequest.current) setInvoiceListLoading(false)
    }
  }

  useEffect(() => { loadData() }, [])
  useEffect(() => {
    ++invoiceRequest.current
    setInvoices([])
    setLatestObservations({})
    setInvoiceTotal(0)
    setInvoiceOffset(0)
    setInvoiceListLoading(true)
    const timer = setTimeout(() => { void loadInvoicePage() }, 200)
    return () => { clearTimeout(timer); ++invoiceRequest.current }
  }, [tab, search])

  const loadEnverusData = useCallback(async () => {
    if (!canEnverus) return
    try {
      const [alertsResult, statsResult] = await Promise.all([
        api.get<EnverusAlert>('/enverus/alerts'),
        api.get<EnverusQueueStats>('/enverus/queue/stats'),
      ])
      if (alertsResult) setEnverusAlerts(alertsResult)
      if (statsResult) setEnverusQueueStats(statsResult)
    } catch {
      // Enverus not configured or offline
    }
  }, [canEnverus])

  async function loadData() {
    try {
      // allSettled, not all: these six are INDEPENDENT billing queues, and with
      // Promise.all a single failing one (one 500 on shop-wos) rejected the whole
      // batch into the catch below, leaving every list empty and the Ready tab
      // reading "All caught up!" while real work sat unbilled. A queue that can't
      // load must not be able to hide the other five.
      const settled = await Promise.allSettled([
        loadInvoicePage(),
        api.get<BillingStats>('/invoices/stats'),
        api.get<{ data: UninvoicedShopWO[] }>('/invoices/uninvoiced/shop-wos'),
        api.get<{ data: UninvoicedTicketGroup[] }>('/invoices/uninvoiced/tickets'),
        api.get<{ data: UninvoicedTrainingTicket[] }>('/invoices/uninvoiced/training-tickets'),
        api.get<{ data: UninvoicedRental[] }>(`/invoices/uninvoiced/rentals${showUnreleasedRef.current ? '?includeUnreleased=1' : ''}`),
      ])
      const failedQueues: string[] = []
      const QUEUE_LABELS = ['Invoices', 'Stats', 'Shop WOs', 'Tickets', 'Training', 'Rentals']
      settled.forEach((r, i) => {
        if (r.status === 'rejected') {
          failedQueues.push(QUEUE_LABELS[i]!)
          console.error(`[Billing] ${QUEUE_LABELS[i]} failed to load:`, r.reason)
        }
      })
      setLoadErrors(failedQueues)
      const valueOf = <T,>(i: number): T | undefined =>
        settled[i]!.status === 'fulfilled' ? ((settled[i] as PromiseFulfilledResult<T>).value) : undefined
      const statsResult = valueOf<BillingStats>(1)
      const woResult = valueOf<{ data: UninvoicedShopWO[] }>(2)
      const ticketResult = valueOf<{ data: UninvoicedTicketGroup[] }>(3)
      const trainingResult = valueOf<{ data: UninvoicedTrainingTicket[] }>(4)
      const rentalResult = valueOf<{ data: UninvoicedRental[] }>(5)
      if (statsResult) setStats(statsResult)
      if (woResult?.data) setUninvoicedWOs(woResult.data)
      if (ticketResult?.data) setUninvoicedTicketGroups(ticketResult.data)
      if (trainingResult?.data) setUninvoicedTraining(trainingResult.data)
      if (rentalResult?.data) {
        setUninvoicedRentals(rentalResult.data)
        // Catch up one calendar month at a time, starting after the last invoice.
        const periods: Record<string, { start: string; end: string }> = {}
        for (const r of rentalResult.data) {
          periods[r.id] = defaultRentalBillingPeriod({ ...r, endDate: r.needsFinalBill ? r.endDate : null,
            releasedThrough: r.releaseState === 'released' ? r.billingReleasedThrough : null })
        }
        setRentalPeriods(periods)
      }
    } catch {
      // Offline or error
    }
    setLoading(false)

    // Load Enverus data in parallel (non-blocking)
    loadEnverusData()
  }

  // The server filters the complete collection before applying pagination.
  const filtered = invoices

  // Ready-tab lists with the search box applied. The Type dropdown gates which
  // sections render; search narrows the items within them.
  const readyLists = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) {
      return {
        wos: uninvoicedWOs,
        rentals: uninvoicedRentals,
        training: uninvoicedTraining,
        groups: uninvoicedTicketGroups,
      }
    }
    return {
      wos: uninvoicedWOs.filter(wo =>
        wo.workOrderNumber?.toLowerCase().includes(q) ||
        wo.company.name.toLowerCase().includes(q) ||
        wo.poNumber?.toLowerCase().includes(q) ||
        (wo.createdBy?.name || '').toLowerCase().includes(q)
      ),
      rentals: uninvoicedRentals.filter(r =>
        (r.agreementNumber || '').toLowerCase().includes(q) ||
        r.company.name.toLowerCase().includes(q) ||
        (r.poNumber || '').toLowerCase().includes(q) ||
        (r.createdBy?.name || '').toLowerCase().includes(q)
      ),
      training: uninvoicedTraining.filter(tt =>
        tt.ticketNumber.toLowerCase().includes(q) ||
        tt.courseName.toLowerCase().includes(q) ||
        tt.bookingCompany.toLowerCase().includes(q) ||
        (tt.technicianName || '').toLowerCase().includes(q) ||
        (tt.createdByName || '').toLowerCase().includes(q) ||
        tt.employers.some(e => e.employerName.toLowerCase().includes(q))
      ),
      groups: uninvoicedTicketGroups.filter(g =>
        g.company.name.toLowerCase().includes(q) ||
        (g.field?.name || '').toLowerCase().includes(q) ||
        (g.monthLabel || '').toLowerCase().includes(q) ||
        g.tickets.some(t =>
          t.ticketNumber.toLowerCase().includes(q) ||
          (t.assignedTech?.name || '').toLowerCase().includes(q) ||
          (t.createdBy?.name || '').toLowerCase().includes(q)
        )
      ),
    }
  }, [uninvoicedWOs, uninvoicedRentals, uninvoicedTraining, uninvoicedTicketGroups, search])

  const showReadyShop = readyType === 'all' || readyType === 'shop'
  const showReadyRentals = readyType === 'all' || readyType === 'rentals'
  const showReadyTraining = readyType === 'all' || readyType === 'training'
  const showReadyField = readyType === 'all' || readyType === 'field'

  // The billing_queue ticket groups now hold shop-repair (RP) tickets too. Shop
  // work bills AS an RP ticket, so the "Shop Work Orders" filter must surface
  // those, and "Field Tickets" must exclude them. Filter tickets within each
  // group by the active Type, dropping groups that empty out.
  const groupTicketFilter = (t: { serviceSubtype: string | null }) =>
    readyType === 'shop' ? t.serviceSubtype === 'shop_repair'
    : readyType === 'field' ? t.serviceSubtype !== 'shop_repair'
    : true // 'all'
  const visibleGroups = (showReadyField || showReadyShop)
    ? readyLists.groups
        .map(g => ({ ...g, tickets: g.tickets.filter(groupTicketFilter) }))
        .filter(g => g.tickets.length > 0)
    : []
  const groupsSectionLabel =
    readyType === 'shop' ? 'Shop Repair Tickets'
    : readyType === 'field' ? 'Field Tickets'
    : 'Tickets in Billing Queue'

  const readyCount = uninvoicedWOs.length + uninvoicedTicketGroups.reduce((sum, g) => sum + g.tickets.length, 0) + uninvoicedTraining.length + uninvoicedRentals.length
  const counts = stats?.statusCounts || {}
  const draftCount = counts.draft || 0
  const approvedCount = (counts.approved || 0) + (counts.awaiting_signature || 0)
  const inQbCount = (counts.so_created || 0) + (counts.queued || 0)
  const invoicedCount = (counts.invoiced || 0) + (counts.sent || 0) + (counts.paid || 0)

  const enverusIssueCount = enverusAlerts?.totalIssues || 0

  const TABS: Array<{ key: TabFilter; label: string; count: number; alert?: boolean }> = [
    { key: 'ready', label: 'Ready', count: readyCount },
    { key: 'drafts', label: 'Drafts', count: draftCount },
    { key: 'approved', label: 'Approved', count: approvedCount },
    { key: 'in_qb', label: 'QB Pipeline', count: inQbCount },
    { key: 'invoiced', label: 'Invoiced', count: invoicedCount },
    { key: 'signatures' as TabFilter, label: 'Signatures', count: signatureRequests.length, alert: signatureRequests.length > 0 },
    ...(canEnverus ? [{ key: 'enverus' as TabFilter, label: 'Enverus', count: enverusIssueCount, alert: enverusIssueCount > 0 }] : []),
    { key: 'all', label: 'All', count: Object.values(counts).reduce((sum, count) => sum + count, 0) },
    { key: 'rebilling', label: 'Tier 1 / rebilling', count: 0 },
  ]

  // Load Enverus queue detail when switching to the Enverus tab
  useEffect(() => {
    if (tab === 'enverus' && !enverusQueueLoading && enverusQueue.length === 0) {
      setEnverusQueueLoading(true)
      api.get<{ data: EnverusQueueEntry[] }>('/enverus/queue?limit=100')
        .then(result => {
          if (result?.data) setEnverusQueue(result.data)
        })
        .catch(() => {})
        .finally(() => setEnverusQueueLoading(false))
    }
  }, [tab])

  // Load signature requests on mount + when tab changes to signatures
  const loadSignatureRequests = useCallback(async () => {
    setSigLoading(true)
    try {
      const result = await api.get<{ data: any[] }>('/signature-requests?status=PENDING')
      setSignatureRequests(result?.data || [])
    } catch { /* ignore */ }
    setSigLoading(false)
  }, [])

  useEffect(() => { loadSignatureRequests() }, [])  // initial badge count
  useEffect(() => {
    if (tab === 'signatures') loadSignatureRequests()
  }, [tab])

  async function handleSigResolve(sigId: string) {
    if (!confirm('Mark this signature request as received? The ticket/invoice will advance to the next billing stage.')) return
    setSigActionLoading(sigId)
    try {
      await api.patch(`/signature-requests/${sigId}/resolve`, {})
      await loadSignatureRequests()
    } catch (err: any) {
      alert(err?.message || 'Failed to resolve')
    }
    setSigActionLoading(null)
  }

  async function handleSigVoid(sigId: string) {
    if (!confirm('Void this signature request? The ticket/invoice will revert to its previous status.')) return
    setSigActionLoading(sigId)
    try {
      await api.patch(`/signature-requests/${sigId}/void`, {})
      await loadSignatureRequests()
    } catch (err: any) {
      alert(err?.message || 'Failed to void')
    }
    setSigActionLoading(null)
  }

  async function handleEnverusRetry(queueId: string) {
    setActionLoading(queueId)
    try {
      await api.post(`/enverus/queue/${queueId}/retry`, {})
      // Reload queue data
      const [qResult, aResult, sResult] = await Promise.all([
        api.get<{ data: EnverusQueueEntry[] }>('/enverus/queue?limit=100'),
        api.get<EnverusAlert>('/enverus/alerts'),
        api.get<EnverusQueueStats>('/enverus/queue/stats'),
      ])
      if (qResult?.data) setEnverusQueue(qResult.data)
      if (aResult) setEnverusAlerts(aResult)
      if (sResult) setEnverusQueueStats(sResult)
    } catch (err: any) {
      alert(err?.message || 'Failed to retry')
    }
    setActionLoading(null)
  }

  async function handleEnverusDelete(queueId: string) {
    if (!confirm('Remove this queue entry?')) return
    setActionLoading(queueId)
    try {
      await api.delete(`/enverus/queue/${queueId}`)
      setEnverusQueue(prev => prev.filter(e => e.id !== queueId))
      loadEnverusData()
    } catch (err: any) {
      alert(err?.message || 'Failed to delete')
    }
    setActionLoading(null)
  }

  async function handleTestConnection() {
    setConnTestLoading(true)
    setConnTest(null)
    try {
      const result = await api.get<{ ok: boolean; message: string; latencyMs?: number }>('/enverus/test-connection')
      setConnTest(result || { ok: false, message: 'No response' })
    } catch (err: any) {
      setConnTest({ ok: false, message: err?.message || 'Connection failed' })
    }
    setConnTestLoading(false)
  }

  // Build the test receipt body (used for both preview and actual fire)
  function buildTestReceiptBody() {
    const duns = masterDuns.trim() || '074292095'
    const body: Record<string, unknown> = {
      buyerDuns: duns,
      productServiceCode: testProductCode.trim() || 'MISC',
    }
    if (testRequisitioner.trim()) {
      body.requisitioner = testRequisitioner.trim()
    }
    if (testReceiptType.trim()) {
      body.receiptType = testReceiptType.trim()
    }
    // chargeType + AFE only for LEM receipts (FORBIDDEN on General)
    if (testReceiptType.trim().toLowerCase() === 'lem') {
      if (testChargeType.trim()) {
        body.chargeType = testChargeType.trim()
      }
      if (testAfe.trim()) {
        body.afe = testAfe.trim()
      }
    }
    return body
  }

  async function handleFireTestReceipt() {
    const body = buildTestReceiptBody()
    setTestReceiptLoading(true)
    setTestReceiptResult(null)

    try {
      const result = await api.post<unknown>('/enverus/test-receipt', body)
      setTestReceiptResult(result)
    } catch (err: any) {
      console.error('[Enverus] Test receipt error:', err)
      setTestReceiptResult({ ok: false, error: err?.message || 'Request failed' })
    }
    setTestReceiptLoading(false)
  }

  async function handleLoadRequisitioners() {
    const duns = masterDuns.trim() || '074292095'
    setRequisitionerLoading(true)
    try {
      const result = await api.get<{ data: unknown[]; count?: number }>(
        `/enverus/master-data/requisitioners/${duns}?refresh=true`
      )
      const rawData = result?.data || []
      // Enverus requisitioner records have { formattedName, email, userId }
      // Try all plausible name fields in case the shape varies by buyer
      const names = rawData
        .map((r: any) => {
          if (typeof r === 'string') return r
          return r.formattedName || r.name || r.orderedByName || r.requisitionerName || r.Name || r.value || ''
        })
        .filter(Boolean)

      if (names.length === 0 && rawData.length > 0) {
        console.warn('[Enverus] Got records but could not extract names. First record:', rawData[0])
        alert(`Got ${rawData.length} record(s) but couldn't extract names.\n\nFirst record keys: ${rawData[0] && typeof rawData[0] === 'object' ? Object.keys(rawData[0] as object).join(', ') : typeof rawData[0]}\n\nCheck browser console for details.`)
      }

      setRequisitionerList(names)
      if (names.length > 0 && !testRequisitioner) {
        setTestRequisitioner(names[0])
      }
    } catch (err: any) {
      console.warn('Failed to load requisitioners:', err)
      alert(`Failed to load requisitioners: ${err?.message || 'Unknown error'}`)
      setRequisitionerList([])
    }
    setRequisitionerLoading(false)
  }

  // Sniff valid receipt types by querying existing receipts for this buyer
  async function handleSniffReceiptTypes() {
    const duns = masterDuns.trim() || '074292095'
    setRequisitionerLoading(true) // reuse loading state
    try {
      // Query recent receipts for this buyer via raw proxy to see what receiptType values exist
      const result = await api.post<{ ok: boolean; body: any }>('/enverus/raw-proxy', {
        method: 'GET',
        path: `/supply-chain/v1/receipts`,
        queryParams: {
          $filter: `buyerParty/partyDUNS eq '${duns}'`,
          $top: '50',
          $select: 'receiptNumber,receiptType,status,totalAmount',
        },
      })
      const receipts = result?.body?.value || []
      if (receipts.length === 0) {
        alert(`No existing receipts found for DUNS ${duns}.\n\nTry the Raw API Explorer:\n/supply-chain/v1/receipts?$top=10\n\nto see ALL receipts (any buyer).`)
        setRequisitionerLoading(false)
        return
      }

      // Extract unique receipt types
      const types = new Set<string>()
      for (const r of receipts) {
        if (r.receiptType) types.add(String(r.receiptType))
      }

      const typeList = [...types].sort()
      if (typeList.length > 0) {
        alert(`Found ${typeList.length} receipt type(s) in ${receipts.length} existing receipts:\n\n${typeList.map(t => `  • "${t}"`).join('\n')}\n\nTry one of these!`)
        // Auto-set the first found type
        setTestReceiptType(typeList[0])
      } else {
        // No receiptType field in any receipt — show all fields for debugging
        const allKeys = new Set<string>()
        for (const r of receipts) {
          for (const k of Object.keys(r)) allKeys.add(k)
        }
        alert(`Found ${receipts.length} receipts but none have a receiptType field.\n\nAvailable fields: ${[...allKeys].join(', ')}\n\nCheck browser console for full data.`)
      }
    } catch (err: any) {
      console.error('[Enverus] Receipt sniff failed:', err)
      alert(`Failed to query receipts: ${err?.message || 'Unknown error'}`)
    }
    setRequisitionerLoading(false)
  }

  // Probe ALL plausible receipt type values against buyer-field-rules to find which are valid
  async function handleProbeReceiptTypes() {
    const duns = masterDuns.trim() || '074292095'
    setRequisitionerLoading(true)
    const variants = [
      'general', 'General', 'GENERAL',
      'lem', 'LEM', 'Lem',
      'hauling', 'Hauling', 'HAULING',
      'chemicals', 'Chemicals', 'CHEMICALS',
      'service', 'Service', 'SERVICE',
      'field_ticket', 'Field Ticket', 'rental', 'Rental',
      'hauling_permian', 'Hauling - Permian',
    ]

    // Fire all in parallel
    const probes = variants.map(async (type) => {
      try {
        const result = await api.post<{ ok: boolean; statusCode: number; body: any }>('/enverus/raw-proxy', {
          method: 'GET',
          path: `/supply-chain/v1/receipts/buyer-field-rules/${duns}/type/${type}`,
        })
        return { type, ok: result?.ok ?? false, status: result?.statusCode ?? 0 }
      } catch {
        return { type, ok: false, status: 0 }
      }
    })

    const allResults = await Promise.all(probes)
    const valid = allResults.filter(r => r.ok)
    const invalid = allResults.filter(r => !r.ok)

    if (valid.length > 0) {
      const msg = `VALID receipt types for DUNS ${duns}:\n\n${valid.map(r => `  ✅ "${r.type}" (${r.status})`).join('\n')}\n\nInvalid (${invalid.length}):\n${invalid.map(r => `  ❌ "${r.type}" (${r.status})`).join('\n')}`
      alert(msg)
      // Auto-set the first valid type
      setTestReceiptType(valid[0].type)
    } else {
      alert(`NO valid receipt types found for DUNS ${duns} out of ${variants.length} variants tested.\n\nAll returned errors. Check browser console for details.\n\nThis might mean buyer-field-rules uses a different URL pattern, or the buyer has no configured types.`)
    }
    setRequisitionerLoading(false)
  }

  async function handleFetchMasterData() {
    if (masterDataType !== 'customers' && !masterDuns.trim()) return
    setMasterDataLoading(true)
    setMasterDataResult(null)
    setMasterDataError(null)
    try {
      const endpoint = masterDataType === 'customers'
        ? '/enverus/master-data/customers'
        : `/enverus/master-data/${masterDataType}/${masterDuns.trim()}`
      const result = await api.get<{ data: unknown; cached?: boolean }>(endpoint)
      if (result?.data) {
        // Normalize: some endpoints return arrays (AFEs, POs), some return objects (buyer-rules)
        const d = result.data
        if (Array.isArray(d)) {
          setMasterDataResult(d)
        } else if (d && typeof d === 'object') {
          // Wrap single object in array so the table renderer can display it
          setMasterDataResult([d])
        } else {
          setMasterDataResult([])
        }
      } else {
        setMasterDataResult([])
      }
    } catch (err: any) {
      setMasterDataError(err?.message || 'Failed to fetch master data')
    }
    setMasterDataLoading(false)
  }

  async function handleRawApiCall() {
    if (!rawApiPath.trim()) return
    setRawApiLoading(true)
    setRawApiResult(null)
    try {
      const result = await api.post<unknown>('/enverus/raw-proxy', {
        method: rawApiMethod,
        path: rawApiPath.trim(),
      })
      setRawApiResult(result)
    } catch (err: any) {
      setRawApiResult({ ok: false, error: err?.message || 'Request failed' })
    }
    setRawApiLoading(false)
  }

  async function handleGenerateFromWO(woId: string) {
    setActionLoading(woId)
    try {
      await api.post('/invoices/generate/from-shop-wo', { shopWorkOrderId: woId })
      await loadData()
      setTab('drafts')
    } catch (err: any) {
      alert(err?.message || 'Failed to generate invoice')
    }
    setActionLoading(null)
  }

  // Kick back: bounce tickets from the Ready queue back to Approvals
  // (supervisor_review) with a note. Captured in a small modal.
  // One call per ticket through the single-transition route on purpose —
  // /tickets/bulk-transition doesn't record the returnedForReview note that
  // the Approvals dashboard shows.
  async function handleReturnForReview() {
    if (!returnModal) return
    const reason = returnNote.trim()
    setActionLoading(returnModal.key)
    const draft = returnModal.invoice
    const settled = await Promise.allSettled(returnModal.tickets.map(t => draft
      // Off a draft: the server removes the ticket's lines and moves it in one step.
      ? api.patch(`/invoices/${draft.id}/kick-back-ticket`, { ticketId: t.id, reason })
      : api.post(`/tickets/${t.id}/transition`, { targetStatus: 'supervisor_review', reason }),
    ))
    const failures = settled.flatMap((r, i) => r.status === 'rejected'
      ? [`${returnModal.tickets[i]!.ticketNumber}: ${(r.reason as any)?.message || 'failed'}`]
      : [])
    if (failures.length) {
      alert(`Kicked back ${settled.length - failures.length} of ${settled.length}. Not kicked back:\n${failures.join('\n')}`)
    }
    setReturnModal(null)
    setReturnNote('')
    await loadData()
    setActionLoading(null)
  }

  function openKickBack(key: string, label: string, tickets: { id: string; ticketNumber: string }[], invoice?: { id: string; invoiceNumber: string }) {
    setReturnModal({ key, label, tickets, invoice })
    setReturnNote('')
  }

  async function handleGenerateFromTickets(companyId: string, ticketIds: string[], loadingKey?: string) {
    setActionLoading(loadingKey || companyId)
    try {
      await api.post('/invoices/generate/from-tickets', { companyId, ticketIds })
      await loadData()
      setTab('drafts')
    } catch (err: any) {
      alert(err?.message || 'Failed to generate invoice')
    }
    setActionLoading(null)
  }

  async function handleGenerateFromTraining(ticketId: string) {
    setActionLoading(ticketId)
    try {
      await api.post<{ count: number }>('/invoices/generate/from-training-ticket', { ticketId, billingCompanyId: trainingPayers[ticketId] || undefined })
      await loadData()
      setTab('drafts')
    } catch (err: any) {
      alert(err?.message || 'Failed to generate training invoices')
    }
    setActionLoading(null)
  }

  // AR Supervisor: put a rental in the queue without the field sending it.
  // Skips the ticket-approval gate, so the server requires and records a reason.
  async function handleForceRelease(rental: UninvoicedRental) {
    const waiting = rental.releaseBlockers.length
    const reason = prompt(
      `Force ${rental.agreementNumber || 'this rental'} into billing without the field sending it?`
      + (waiting ? `\n\n${waiting} ticket${waiting === 1 ? ' is' : 's are'} not approved yet and will NOT bill on this invoice.` : '')
      + '\n\nReason (required, recorded on the rental):',
    )
    if (!reason?.trim()) return
    setActionLoading(rental.id)
    try {
      const res = await api.post<{ results: { success: boolean; error?: string }[] }>('/rentals/billing-release', {
        ids: [rental.id], force: true, reason: reason.trim(),
      })
      const failed = res.results.find(r => !r.success)
      if (failed) alert(failed.error || 'Failed to force this rental into billing')
      await loadData()
    } catch (err: any) {
      alert(err?.message || 'Failed to force this rental into billing')
    } finally {
      setActionLoading(null)
    }
  }

  async function handleGenerateFromRental(rentalId: string, preview = false) {
    const period = rentalPeriods[rentalId]
    if (!period?.start || !period?.end) {
      alert('Set a billing period first')
      return
    }
    setActionLoading(rentalId)
    try {
      const result = await api.post<NonNullable<typeof rentalPreview>['data']>('/invoices/generate/from-rental', {
        rentalAgreementId: rentalId,
        periodStart: period.start,
        periodEnd: period.end,
        preview,
      })
      if (preview) setRentalPreview({ id: rentalId, start: period.start, end: period.end, data: result })
      else { setRentalPreview(null); await loadData(); setTab('drafts') }
    } catch (err: any) {
      alert(err?.message || 'Failed to generate rental invoice')
    }
    setActionLoading(null)
  }

  async function handleApprove(invoice: Invoice) {
    setActionLoading(invoice.id)
    try {
      await api.patch(`/invoices/${invoice.id}/approve`, {})
      await loadData()
    } catch (err: any) {
      alert(err?.message || 'Failed to approve')
    }
    setActionLoading(null)
  }

  async function handleQueue(invoice: Invoice) {
    setActionLoading(invoice.id)
    try {
      await api.patch(`/invoices/${invoice.id}/queue`, {})
      await loadData()
    } catch (err: any) {
      alert(err?.message || 'Failed to queue')
    }
    setActionLoading(null)
  }

  // Approved → back to draft for editing. Draft → the server voids the draft
  // and kicks its tickets back to the Approvals dashboard with the note.
  async function handleReject(invoice: Invoice) {
    const isDraft = invoice.status === 'draft'
    const reason = prompt(isDraft
      ? `Reject ${invoice.invoiceNumber}: this voids the draft and sends its tickets back to the Approvals dashboard.\n\nNote for the reviewer (required):`
      : `Send ${invoice.invoiceNumber} back to draft for editing. Its tickets stay on the draft.\n\nReason (optional):`)
    if (reason === null) return
    if (isDraft && !reason.trim()) {
      alert('A note for the reviewer is required.')
      return
    }
    setActionLoading(invoice.id)
    try {
      const result = await api.patch<{ warnings?: string[] }>(`/invoices/${invoice.id}/reject`, { reason })
      if (result?.warnings?.length) alert(result.warnings.join('\n'))
      await loadData()
    } catch (err: any) {
      alert(err?.message || 'Failed to reject')
    }
    setActionLoading(null)
  }

  async function handleVoid(invoice: Invoice) {
    if (!confirm(`Void invoice ${invoice.invoiceNumber}? This cannot be undone.`)) return
    const reason = prompt('Void reason:')
    setActionLoading(invoice.id)
    try {
      await api.patch(`/invoices/${invoice.id}/void`, { reason: reason || undefined })
      await loadData()
    } catch (err: any) {
      alert(err?.message || 'Failed to void')
    }
    setActionLoading(null)
  }

  // Send to OI — submit the invoice as a receipt
  async function handleSubmitToOI(invoice: Invoice) {
    setActionLoading(invoice.id)
    try {
      const result = await api.post<{
        ok: boolean; message: string; enverusItemId?: string; enverusResponse?: unknown
      }>(`/enverus/invoices/submit/${invoice.id}?immediate=true`, {})
      if (result?.ok) {
        await loadData()
      } else {
        alert(result?.message || 'OI submission failed')
      }
    } catch (err: any) {
      alert(err?.message || 'OI submission failed')
    }
    setActionLoading(null)
  }

  // Send to OT — submit the underlying ticket(s) as receipt(s)
  async function handleSubmitToOT(invoice: Invoice) {
    const tickets = invoice.sourceTickets || []
    if (tickets.length === 0) {
      alert('No source tickets found for this invoice')
      return
    }
    setActionLoading(invoice.id)
    try {
      const results = await Promise.all(
        tickets.map(t =>
          api.post<{ ok: boolean; message: string; enverusItemId?: string }>(`/enverus/receipts/submit/${t.id}?immediate=true`, {})
            .catch((err: any) => ({ ok: false, message: err?.message || 'Failed', ticketId: t.id }))
        )
      )
      const failures = results.filter(r => !r.ok)
      if (failures.length > 0) {
        alert(`OT: ${results.length - failures.length}/${results.length} tickets submitted. ${failures.length} failed.`)
      }
      await loadData()
    } catch (err: any) {
      alert(err?.message || 'OT submission failed')
    }
    setActionLoading(null)
  }

  function formatMoney(val: string | number | null): string {
    const n = typeof val === 'string' ? parseFloat(val) : (val || 0)
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n)
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Billing</h1>
          <p className="text-sm text-slate-500 mt-0.5">Invoices, approvals & QB sync</p>
        </div>
      </div>

      {/* Enverus Alert Banner — WORLD ON FIRE */}
      {canEnverus && enverusAlerts?.hasIssues && (
        <div className="space-y-2 mb-4">
          {(enverusAlerts.errors.count > 0) && (
            <button
              onClick={() => setTab('enverus')}
              className="w-full flex items-center gap-3 px-4 py-3 bg-red-600 text-white rounded-lg animate-pulse hover:bg-red-700 transition-colors text-left"
            >
              <AlertTriangle className="w-5 h-5 shrink-0" />
              <span className="font-bold text-sm">
                {enverusAlerts.errors.count} Enverus submission{enverusAlerts.errors.count !== 1 ? 's' : ''} FAILED
              </span>
              <span className="text-xs opacity-80 ml-auto">needs immediate attention</span>
            </button>
          )}
          {(enverusAlerts.disputed.count > 0) && (
            <button
              onClick={() => setTab('enverus')}
              className="w-full flex items-center gap-3 px-4 py-3 bg-amber-500 text-slate-900 rounded-lg hover:bg-amber-400 transition-colors text-left"
            >
              <AlertTriangle className="w-5 h-5 shrink-0" />
              <span className="font-bold text-sm">
                {enverusAlerts.disputed.count} receipt{enverusAlerts.disputed.count !== 1 ? 's' : ''} DISPUTED by customer
              </span>
              <span className="text-xs opacity-70 ml-auto">review required</span>
            </button>
          )}
        </div>
      )}

      {can('shop_orders:waive_billing') && <ShopBillingWaiverButton onComplete={() => { void loadData() }} />}
      {/* Stats cards */}
      {stats && (
        <div className={cn('grid gap-3 mb-4', canEnverus ? 'grid-cols-2 sm:grid-cols-5' : 'grid-cols-2 sm:grid-cols-4')}>
          <div className="bg-white rounded-lg border border-slate-200 p-3">
            <p className="text-xs text-slate-500">Tickets Ready</p>
            <p className="text-xl font-bold text-slate-900">{stats.ticketsReadyToBill}</p>
          </div>
          <div className="bg-white rounded-lg border border-slate-200 p-3">
            <p className="text-xs text-slate-500">Shop WOs Ready</p>
            <p className="text-xl font-bold text-slate-900">{stats.shopWOsReadyToBill}</p>
          </div>
          <div className="bg-white rounded-lg border border-slate-200 p-3">
            <p className="text-xs text-slate-500">In QB Pipeline</p>
            <p className="text-xl font-bold text-purple-700">{stats.salesOrders + stats.queued}</p>
          </div>
          <div className="bg-white rounded-lg border border-slate-200 p-3">
            <p className="text-xs text-slate-500">Month to Date</p>
            <p className="text-xl font-bold text-green-700">{formatMoney(stats.monthToDateTotal)}</p>
          </div>
          {/* Enverus stat card */}
          {canEnverus && enverusQueueStats && (
            <div className={cn(
              'bg-white rounded-lg border p-3',
              (enverusQueueStats.error || 0) > 0
                ? 'border-red-300 bg-red-50'
                : (enverusQueueStats.rejected || 0) > 0
                  ? 'border-amber-300 bg-amber-50'
                  : 'border-slate-200',
            )}>
              <p className="text-xs text-slate-500 flex items-center gap-1">
                <Zap className="w-3 h-3" /> Enverus
              </p>
              <div className="flex items-center gap-1.5 mt-1 text-xs flex-wrap">
                {(enverusQueueStats.submitted || 0) > 0 && (
                  <span className="px-1.5 py-0.5 bg-yellow-100 text-yellow-700 rounded font-medium">
                    {enverusQueueStats.submitted} pending
                  </span>
                )}
                {(enverusQueueStats.accepted || 0) > 0 && (
                  <span className="px-1.5 py-0.5 bg-green-100 text-green-700 rounded font-medium">
                    {enverusQueueStats.accepted} approved
                  </span>
                )}
                {(enverusQueueStats.error || 0) > 0 && (
                  <span className="px-1.5 py-0.5 bg-red-100 text-red-700 rounded font-bold animate-pulse">
                    {enverusQueueStats.error} errors
                  </span>
                )}
                {(enverusQueueStats.rejected || 0) > 0 && (
                  <span className="px-1.5 py-0.5 bg-amber-100 text-amber-700 rounded font-bold">
                    {enverusQueueStats.rejected} disputed
                  </span>
                )}
                {Object.values(enverusQueueStats).every(v => !v) && (
                  <span className="text-slate-400">No activity</span>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {loadErrors.length > 0 && (
        <div className="mb-3 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
          Couldn't load: {loadErrors.join(', ')}. Those sections may be incomplete — this is not
          proof there's nothing to bill.
        </div>
      )}

      {/* Search — now on every tab, including Ready */}
      <div className="relative mb-4">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder={tab === 'rebilling' ? 'Search original customer or QB billed customer…' : tab === 'ready' ? 'Search by customer, WO#, ticket#, PO, tech, created by...' : 'Search by invoice#, customer, QB billed customer, PO, SO#, created by...'}
          className="w-full pl-10 pr-4 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
        />
      </div>

      {/* Tabs */}
      <div className="flex gap-0.5 bg-slate-100 p-1 rounded-lg mb-4 overflow-x-auto">
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              'flex-1 py-2 text-xs sm:text-sm font-medium rounded-md transition-colors whitespace-nowrap px-1',
              tab === t.key ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700',
              t.alert && tab !== t.key && 'text-red-600 font-bold',
            )}
          >
            {t.alert && <span className="inline-block w-2 h-2 bg-red-500 rounded-full mr-1 animate-pulse" />}
            {t.label}
            {t.count > 0 && (
              <span className={cn(
                'ml-1 text-[10px] sm:text-xs',
                tab === t.key ? 'opacity-70' : 'opacity-50',
                t.alert && 'text-red-500 font-bold opacity-100',
              )}>
                {t.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* READY TAB — uninvoiced items */}
      {tab === 'ready' && (
        loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 text-slate-400 animate-spin" />
          </div>
        ) : readyCount === 0 ? (
          <div className="text-center py-12 text-slate-400">
            <CheckCircle2 className="w-10 h-10 mx-auto mb-2 opacity-50" />
            <p className="font-medium">All caught up!</p>
            <p className="text-sm mt-1">No work orders or tickets waiting for invoices.</p>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Type filter — mirrors the sections the Ready tab is broken into */}
            <div className="flex items-center gap-2">
              <label htmlFor="ready-type" className="text-xs font-medium text-slate-500">Type</label>
              <select
                id="ready-type"
                value={readyType}
                onChange={e => setReadyType(e.target.value as ReadyType)}
                className="px-3 py-1.5 text-sm border border-slate-300 rounded-lg bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
              >
                <option value="all">All Types</option>
                <option value="shop">Shop Work Orders</option>
                <option value="rentals">Rentals</option>
                <option value="training">Training</option>
                <option value="field">Field Tickets</option>
              </select>
              {canForceRelease && (
                <label className="flex items-center gap-2 text-sm text-slate-600 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={showUnreleased}
                    onChange={e => {
                      showUnreleasedRef.current = e.target.checked
                      setShowUnreleased(e.target.checked)
                      void loadData()
                    }}
                    className="w-4 h-4 rounded border-slate-300"
                  />
                  Show rentals the field has not sent
                </label>
              )}
            </div>

            {/* Uninvoiced Shop WOs */}
            {showReadyShop && readyLists.wos.length > 0 && (
              <div>
                <h2 className="text-sm font-semibold text-slate-700 mb-2 flex items-center gap-2">
                  <Hammer className="w-4 h-4" />
                  Shop Work Orders ({readyLists.wos.length})
                </h2>
                <div className="space-y-2">
                  {readyLists.wos.map(wo => (
                    <div key={wo.id} className="bg-white rounded-lg border border-slate-200 p-4">
                      <div className="flex items-center justify-between mb-1">
                        <button
                          onClick={() => navigate(`/shop/${wo.id}`)}
                          className="font-medium text-blue-700 hover:text-blue-900 hover:underline"
                          title="Open work order"
                        >
                          {wo.workOrderNumber}
                        </button>
                        <span className="text-xs text-slate-400">
                          {wo._count.items} items
                        </span>
                      </div>
                      <p className="text-sm text-slate-600">{wo.company.name}</p>
                      {wo.locationName && <p className="text-sm text-slate-600">{wo.locationName}</p>}
                      <div className="flex items-center gap-3 text-xs text-slate-400 mt-1">
                        {wo.completedDate && <span>Completed {formatCalendarDateNumeric(wo.completedDate)}</span>}
                        {wo.poNumber && <span>PO: {wo.poNumber}</span>}
                      </div>
                      <button
                        onClick={() => handleGenerateFromWO(wo.id)}
                        disabled={actionLoading === wo.id}
                        className="mt-3 flex items-center gap-1.5 px-3 py-1.5 bg-blue-800 text-white rounded-lg text-xs font-medium hover:bg-blue-700 disabled:opacity-50"
                      >
                        {actionLoading === wo.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                        Generate Invoice
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Uninvoiced Rentals */}
            {showReadyRentals && readyLists.rentals.length > 0 && (
              <div>
                <h2 className="text-sm font-semibold text-slate-700 mb-2 flex items-center gap-2">
                  <Truck className="w-4 h-4" />
                  Rentals to Bill ({readyLists.rentals.length})
                </h2>
                <div className="space-y-2">
                  {readyLists.rentals.map(rental => {
                    const period = rentalPeriods[rental.id] || { start: '', end: '' }
                    const isFinal = rental.needsFinalBill
                    // Only present when an AR Supervisor asked for unsent rentals.
                    const notSent = rental.releaseState === 'unreleased' || rental.releaseState === 'closed_blocked'
                    return (
                      <div
                        key={rental.id}
                        className={cn(
                          'bg-white rounded-lg border p-4',
                          isFinal ? 'border-amber-300 ring-1 ring-amber-200' : 'border-slate-200',
                        )}
                      >
                        <div className="flex items-center justify-between mb-1 gap-2 flex-wrap">
                          <button
                            onClick={() => navigate(`/rentals/${rental.id}`)}
                            className="font-medium text-blue-700 hover:text-blue-900 hover:underline"
                            title="Open rental agreement"
                          >
                            {rental.agreementNumber || rental.id.slice(0, 8)}
                          </button>
                          <div className="flex items-center gap-1.5">
                            {isFinal && (
                              <span className="text-xs px-2 py-0.5 bg-amber-100 text-amber-800 rounded-full font-semibold">
                                Final Bill
                              </span>
                            )}
                            <span className="text-xs px-2 py-0.5 bg-purple-50 text-purple-700 rounded-full font-medium">
                              {rental.billingRateType}
                            </span>
                          </div>
                        </div>
                        <p className="text-sm text-slate-600">{rental.company.name}</p>
                        {rental.locationName && <p className="text-sm text-slate-600">{rental.locationName}</p>}
                        <div className="flex items-center gap-3 text-xs text-slate-400 mt-1 flex-wrap">
                          <span>{rental.deployedItemCount} deployed / {rental._count.items} total</span>
                          {rental.poNumber && <span>PO: {rental.poNumber}</span>}
                          <span>Since {formatCalendarDateNumeric(rental.startDate)}</span>
                          {isFinal && rental.endDate && (
                            <span className="text-amber-700 font-medium">
                              Completed {formatCalendarDateNumeric(rental.endDate)}
                            </span>
                          )}
                        </div>
                        {rental.lastBilledThrough && (
                          <p className="text-xs text-emerald-600 mt-1">
                            Last billed through {formatCalendarDateNumeric(rental.lastBilledThrough)}
                          </p>
                        )}
                        {isFinal && !rental.lastBilledThrough && (
                          <p className="text-xs text-amber-700 mt-1">
                            Never billed — generate the only invoice for this rental.
                          </p>
                        )}
                        {rental.releaseState === 'released' && rental.billingReleasedThrough && (
                          <p className="text-xs text-slate-500 mt-1">
                            Sent for billing through {formatCalendarDateNumeric(rental.billingReleasedThrough)}
                            {rental.billingReleasedBy ? ` by ${rental.billingReleasedBy.name}` : ' at cutover'}
                            {rental.billingReleaseForceReason && <span className="text-amber-700 font-medium"> · forced: {rental.billingReleaseForceReason}</span>}
                          </p>
                        )}
                        {rental.releaseState === 'closed_ready' && rental.billingReleaseForceReason && (
                          <p className="text-xs text-amber-700 font-medium mt-1">Forced into billing: {rental.billingReleaseForceReason}</p>
                        )}
                        {notSent && (
                          <div className="mt-2 rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
                            <p className="font-medium">
                              {rental.releaseState === 'closed_blocked'
                                ? 'Closed, but not in the billing queue yet: tickets still need supervisor approval.'
                                : 'Not sent for billing by the field.'}
                            </p>
                            {rental.releaseBlockers.length > 0 && (
                              <p className="mt-1">
                                Not approved: {rental.releaseBlockers.map(b => b.ticketNumber).join(', ')}. These will not bill until a supervisor approves them.
                              </p>
                            )}
                          </div>
                        )}

                        {/* Tickets riding this rental. Without this they show
                            nowhere: the standalone ticket queue excludes every
                            rental-linked ticket so it can't double-bill. */}
                        {rental.pendingTickets.length > 0 && (
                          <div className="mt-2 rounded-md bg-slate-50 border border-slate-200 px-2.5 py-2">
                            <p className="text-xs font-medium text-slate-600 mb-1">
                              {!isFinal && rental.status === 'completed' && (
                                <span className="text-amber-700">Arrived after the final invoice — </span>
                              )}
                              {rental.pendingTickets.length} ticket{rental.pendingTickets.length === 1 ? '' : 's'} bill through this rental
                              {rental.pendingTicketTotal > 0 && (
                                <span className="text-slate-500 font-normal">
                                  {' '}· ${Number(rental.pendingTicketTotal).toFixed(2)}
                                </span>
                              )}
                            </p>
                            <div className="flex flex-wrap gap-x-3 gap-y-1">
                              {rental.pendingTickets.map(t => (
                                <button
                                  key={t.id}
                                  onClick={() => navigate(`/tickets/${t.id}`)}
                                  className="text-xs text-blue-700 hover:underline"
                                  title={`${t.status} · ${formatCalendarDateNumeric(t.serviceDate)}`}
                                >
                                  {t.ticketNumber}
                                  <span className="text-slate-400">
                                    {' '}{t.total > 0 ? `$${Number(t.total).toFixed(2)}` : '(log only)'}
                                  </span>
                                </button>
                              ))}
                            </div>
                          </div>
                        )}

                        {rental.finalInvoice ? <div className="mt-3 rounded border border-amber-300 bg-amber-50 p-3 text-sm">
                          <p className="font-medium">Final invoice {rental.finalInvoice.invoiceNumber} already exists.</p>
                          <p className="mt-1">Review these late charges with the final invoice. Correct or void and replace it as needed; do not generate another final.</p>
                          <button onClick={() => navigate(`/billing/${rental.finalInvoice!.id}`)} className="mt-2 text-blue-700 underline">Review final invoice</button>
                        </div> : <>
                        {/* Period pickers */}
                        <div className="flex items-center gap-2 mt-3">
                          <div className="flex-1">
                            <label className="text-[10px] text-slate-400 block mb-0.5">Period Start</label>
                            <input
                              type="date"
                              value={period.start}
                              onChange={e => setRentalPeriods(prev => ({
                                ...prev,
                                [rental.id]: { ...prev[rental.id], start: e.target.value },
                              }))}
                              className="w-full px-2 py-1.5 text-xs border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                            />
                          </div>
                          <div className="flex-1">
                            <label className="text-[10px] text-slate-400 block mb-0.5">Period End</label>
                            <input
                              type="date"
                              value={period.end}
                              onChange={e => setRentalPeriods(prev => ({
                                ...prev,
                                [rental.id]: { ...prev[rental.id], end: e.target.value },
                              }))}
                              className="w-full px-2 py-1.5 text-xs border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                            />
                          </div>
                        </div>

                        <button className="mt-3 mr-3 px-3 py-1.5 border border-purple-300 text-purple-800 rounded-lg text-xs" disabled={actionLoading === rental.id} onClick={() => handleGenerateFromRental(rental.id, true)}>Preview billing</button>
                        {rentalPreview?.id === rental.id && rentalPreview.start === period.start && rentalPreview.end === period.end && <div className="mt-3 bg-purple-50 border rounded p-3 text-xs space-y-2">
                          <p className="font-semibold">Billing preview · {rentalPreview.data.periodStart} through {rentalPreview.data.periodEnd}</p>
                          <p>{rentalPreview.data.days.total - rentalPreview.data.days.paused} active days · {rentalPreview.data.days.paused} paused days{rentalPreview.data.attendanceBased ? ` · ${rentalPreview.data.days.manned} manned / ${rentalPreview.data.days.unmanned} unmanned days` : ''}</p>
                          <div className="overflow-x-auto"><table className="w-full text-left"><thead><tr><th>Charge</th><th>Quantity</th><th>Effective rate</th><th>Amount</th></tr></thead><tbody>{rentalPreview.data.lineItems.map((line, i) => <tr key={i}><td className="py-1 pr-2 whitespace-pre-line">{line.description}</td><td>{line.quantity} {line.unitOfMeasure}</td><td>${line.rate.toFixed(2)}</td><td>${line.amount.toFixed(2)}</td></tr>)}</tbody></table></div>
                          {(rentalPreview.data.lateMannedDays ?? []).map(late => <p key={late.date} className="rounded border border-amber-300 bg-amber-50 p-2 text-amber-900">{late.date} was billed unmanned on {late.billedOn}; manned ticket {late.ticketNumbers.join(', ')} arrived late. A $0 adjustment line is added at ${late.difference.toFixed(2)}/day — set its quantity to 1 on the draft to bill the difference.</p>)}
                          {rentalPreview.data.rateChanges.map(change => <p key={change.effectiveDate}>Rate change {change.effectiveDate}: manned ${change.manned}, unmanned ${change.unmanned}</p>)}
                          {rentalPreview.data.equipment.map((item, i) => <p key={i}>{item.serial}: deployed {item.deployed.slice(0, 10)}{item.returned ? ` · picked up ${item.returned.slice(0, 10)}` : ' · still deployed'}{item.replacesItemId ? ' · replacement/swap' : ''}</p>)}
                          <p>Subtotal: ${rentalPreview.data.subtotal.toFixed(2)}</p><p>Sales tax: ${rentalPreview.data.taxAmount.toFixed(2)}</p><p className="font-semibold">Total including tax: ${rentalPreview.data.total.toFixed(2)}</p>
                          <p>Preview only. Generate recalculates using current records. Explicit $0 rates mean included/free; missing prices must be entered. Delivery/pickup placeholders need actual quantities before approval.</p>
                        </div>}
                        {notSent ? (
                          <button
                            onClick={() => handleForceRelease(rental)}
                            disabled={actionLoading === rental.id}
                            className="mt-3 flex items-center gap-1.5 px-3 py-1.5 text-white rounded-lg text-xs font-medium disabled:opacity-50 bg-red-700 hover:bg-red-600"
                          >
                            {actionLoading === rental.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldAlert className="w-3.5 h-3.5" />}
                            Force into billing
                          </button>
                        ) : (
                        <button
                          onClick={() => handleGenerateFromRental(rental.id)}
                          disabled={actionLoading === rental.id}
                          className={cn(
                            'mt-3 flex items-center gap-1.5 px-3 py-1.5 text-white rounded-lg text-xs font-medium disabled:opacity-50',
                            isFinal
                              ? 'bg-amber-700 hover:bg-amber-600'
                              : 'bg-purple-700 hover:bg-purple-600',
                          )}
                        >
                          {actionLoading === rental.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                          {isFinal ? 'Generate Final Invoice' : 'Generate Invoice'}
                        </button>
                        )}
                        </>}
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {/* Uninvoiced Training Tickets */}
            {showReadyTraining && readyLists.training.length > 0 && (
              <div>
                <h2 className="text-sm font-semibold text-slate-700 mb-2 flex items-center gap-2">
                  <GraduationCap className="w-4 h-4" />
                  Training Tickets ({readyLists.training.length})
                </h2>
                <div className="space-y-2">
                  {readyLists.training.map(tt => (
                    <div key={tt.ticketId} className="bg-white rounded-lg border border-slate-200 p-4">
                      <div className="flex items-center justify-between mb-1">
                        <button
                          onClick={() => navigate(`/tickets/${tt.ticketId}`)}
                          className="font-medium text-blue-700 hover:text-blue-900 hover:underline"
                          title="Open ticket"
                        >
                          {tt.ticketNumber}
                        </button>
                        <span className="text-xs px-2 py-0.5 bg-indigo-50 text-indigo-700 rounded-full font-medium">
                          {tt.courseName.replace(/_/g, ' ')}
                        </span>
                      </div>
                      <p className="text-sm text-slate-600">
                        {tt.bookingCompany}
                      </p>
                      {tt.locationName && <p className="text-sm text-slate-600">{tt.locationName}</p>}
                      <p className="text-sm text-slate-600">
                        {formatCalendarDateNumeric(tt.serviceDate)}
                        &middot; {tt.rosterCount} trainee{tt.rosterCount !== 1 ? 's' : ''}
                      </p>
                      {tt.employers.length > 0 && (
                        <div className="mt-2 space-y-1">
                          {tt.employers.map((emp, i) => (
                            <div key={i} className="flex items-center gap-2 text-xs">
                              <span className={cn(
                                'px-1.5 py-0.5 rounded',
                                emp.employerCompanyId ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700',
                              )}>
                                {emp.employerName}
                              </span>
                              <span className="text-slate-500">
                                {emp.passedCount} passed / {emp.count} total
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                      {tt.billingBasis === 'per_class' && (
                        <label className="mt-3 block text-sm text-slate-700">
                          Customer paying the class fee
                          <select aria-label={`Class fee customer for ${tt.ticketNumber}`} value={trainingPayers[tt.ticketId] || ''}
                            onChange={e => setTrainingPayers(current => ({ ...current, [tt.ticketId]: e.target.value }))}
                            className="ml-2 border rounded px-2 py-1">
                            <option value="">Select customer</option>
                            {tt.bookingCompanyId && !tt.employers.some(e => e.employerCompanyId === tt.bookingCompanyId) && <option value={tt.bookingCompanyId}>{tt.bookingCompany}</option>}
                            {tt.employers.filter(e => e.employerCompanyId).map(e => <option key={e.employerCompanyId} value={e.employerCompanyId!}>{e.employerName}</option>)}
                          </select>
                          <span className="block text-xs text-slate-500">One class fee goes to this customer. Each employer receives its own no-charge attendee list.</span>
                        </label>
                      )}
                      <div className="mt-3 flex items-center gap-2 flex-wrap">
                      <button
                        onClick={() => handleGenerateFromTraining(tt.ticketId)}
                        disabled={actionLoading === tt.ticketId || (tt.billingBasis === 'per_class' && !trainingPayers[tt.ticketId])}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-700 text-white rounded-lg text-xs font-medium hover:bg-indigo-600 disabled:opacity-50"
                      >
                        {actionLoading === tt.ticketId ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                        Generate Invoice{(() => {
                          const count = tt.employers.length + (tt.billingBasis === 'per_class' && trainingPayers[tt.ticketId] && !tt.employers.some(e => e.employerCompanyId === trainingPayers[tt.ticketId]) ? 1 : 0)
                          return count > 1 ? `s (${count})` : ''
                        })()}
                      </button>
                      <button
                        onClick={() => openKickBack(`return-${tt.ticketId}`, tt.ticketNumber, [{ id: tt.ticketId, ticketNumber: tt.ticketNumber }])}
                        disabled={actionLoading === `return-${tt.ticketId}`}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-orange-700 bg-orange-50 border border-orange-200 rounded-lg text-xs font-medium hover:bg-orange-100 disabled:opacity-50"
                        title="Send back to the Approvals dashboard with a note"
                      >
                        {actionLoading === `return-${tt.ticketId}` ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CornerUpLeft className="w-3.5 h-3.5" />}
                        Kick Back
                      </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Uninvoiced Tickets (grouped by customer + field + month) */}
            {(showReadyField || showReadyShop) && visibleGroups.length > 0 && (
              <div>
                <h2 className="text-sm font-semibold text-slate-700 mb-2 flex items-center gap-2">
                  <ClipboardList className="w-4 h-4" />
                  {groupsSectionLabel} ({visibleGroups.length})
                </h2>
                <div className="space-y-2">
                  {visibleGroups.map(group => {
                    const isExpanded = !collapsedGroupKeys.has(group.groupKey)
                    const groupTotal = group.tickets.reduce((sum, t) => sum + (t.total ? parseFloat(String(t.total)) : 0), 0)
                    const locationName = [...new Set(group.tickets.map(t => t.locationName).filter(Boolean))].join(', ') || group.field?.name

                    return (
                      <div key={group.groupKey} className="bg-white rounded-lg border border-slate-200 overflow-hidden">
                        {/* Card header — click to expand */}
                        <button
                          type="button"
                          onClick={() => setCollapsedGroupKeys(prev => {
                            const next = new Set(prev)
                            if (isExpanded) next.add(group.groupKey)
                            else next.delete(group.groupKey)
                            return next
                          })}
                          className="w-full flex items-center gap-3 p-4 text-left hover:bg-slate-50 transition-colors"
                        >
                          <div className="flex-1 min-w-0">
                            <p className="font-medium text-slate-900 truncate">{group.company.name}</p>
                            {locationName && <p className="font-medium text-slate-900">{locationName}</p>}
                            <div className="flex items-center gap-2 mt-0.5">
                              {group.monthLabel && (
                                <span className="text-xs text-blue-600 font-medium">{group.monthLabel}</span>
                              )}
                              {!locationName && !group.monthLabel && (
                                <span className="text-xs text-slate-400 italic">No field / ungrouped</span>
                              )}
                            </div>
                          </div>
                          <div className="text-right shrink-0">
                            <p className="text-xs text-slate-400">{group.tickets.length} ticket{group.tickets.length !== 1 ? 's' : ''}</p>
                            {groupTotal > 0 && (
                              <p className="text-sm font-semibold text-slate-700">{formatMoney(groupTotal)}</p>
                            )}
                          </div>
                          {isExpanded ? <ChevronUp className="w-4 h-4 text-slate-400 shrink-0" /> : <ChevronDown className="w-4 h-4 text-slate-400 shrink-0" />}
                        </button>

                        {/* Collapsed: batch invoice button */}
                        {!isExpanded && (
                          <div className="px-4 pb-3 border-t border-slate-100 flex items-center gap-2">
                            <button
                              onClick={(e) => {
                                e.stopPropagation()
                                handleGenerateFromTickets(group.company.id, group.tickets.map(t => t.id), group.groupKey)
                              }}
                              disabled={actionLoading === group.groupKey}
                              className="mt-2 flex items-center gap-1.5 px-3 py-1.5 bg-blue-800 text-white rounded-lg text-xs font-medium hover:bg-blue-700 disabled:opacity-50"
                            >
                              {actionLoading === group.groupKey ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                              Generate Invoice ({group.tickets.length} tickets)
                            </button>
                            <button
                              onClick={() => openKickBack(`return-group-${group.groupKey}`, `${group.tickets.length} ticket${group.tickets.length !== 1 ? 's' : ''} for ${group.company.name}`, group.tickets)}
                              disabled={actionLoading === `return-group-${group.groupKey}`}
                              className="mt-2 flex items-center gap-1.5 px-3 py-1.5 text-orange-700 bg-orange-50 border border-orange-200 rounded-lg text-xs font-medium hover:bg-orange-100 disabled:opacity-50"
                              title="Send every ticket in this group back to the Approvals dashboard with a note"
                            >
                              {actionLoading === `return-group-${group.groupKey}` ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CornerUpLeft className="w-3.5 h-3.5" />}
                              Kick Back All
                            </button>
                          </div>
                        )}

                        {/* Expanded: ticket list with individual invoice buttons */}
                        {isExpanded && (
                          <div className="px-4 pb-4 border-t border-slate-100">
                            {/* Batch buttons at top */}
                            <div className="mt-3 mb-3 flex items-stretch gap-2">
                              <button
                                onClick={() => handleGenerateFromTickets(group.company.id, group.tickets.map(t => t.id), group.groupKey)}
                                disabled={actionLoading === group.groupKey}
                                className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 bg-blue-800 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
                              >
                                {actionLoading === group.groupKey ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                                Invoice All {group.tickets.length} Tickets Together
                              </button>
                              {group.tickets.length > 1 && (
                                <button
                                  onClick={() => openKickBack(`return-group-${group.groupKey}`, `${group.tickets.length} tickets for ${group.company.name}`, group.tickets)}
                                  disabled={actionLoading === `return-group-${group.groupKey}`}
                                  className="shrink-0 flex items-center justify-center gap-1.5 px-3 py-2 text-orange-700 bg-orange-50 border border-orange-200 rounded-lg text-sm font-medium hover:bg-orange-100 disabled:opacity-50"
                                  title="Send every ticket in this group back to the Approvals dashboard with a note"
                                >
                                  {actionLoading === `return-group-${group.groupKey}` ? <Loader2 className="w-4 h-4 animate-spin" /> : <CornerUpLeft className="w-4 h-4" />}
                                  Kick Back All
                                </button>
                              )}
                            </div>

                            {/* Individual tickets */}
                            <div className="space-y-1.5">
                              {group.tickets.map(t => (
                                <div key={t.id} className="flex items-center gap-2 p-2 rounded-lg hover:bg-slate-50 text-sm">
                                  <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-1.5">
                                      <button
                                        onClick={(e) => { e.stopPropagation(); navigate(`/tickets/${t.id}`) }}
                                        className="font-mono text-xs text-blue-700 hover:text-blue-900 hover:underline"
                                        title="Open ticket"
                                      >
                                        {t.ticketNumber}
                                      </button>
                                      {t.serviceSubtype?.startsWith('ih_') && (
                                        <span className="px-1 py-0 bg-teal-50 text-teal-700 rounded text-[10px] font-medium">
                                          {t.serviceSubtype.replace('ih_', '').replace('_', '/')}
                                        </span>
                                      )}
                                      {t.ticketType === 'training' && (
                                        <span className="px-1 py-0 bg-indigo-50 text-indigo-700 rounded text-[10px] font-medium">training</span>
                                      )}
                                      {t.serviceSubtype === 'shop_repair' && (t.customData as any)?.shopWorkOrderNumber && (
                                        <span className="px-1 py-0 bg-amber-50 text-amber-700 rounded text-[10px] font-medium" title="Shop work order this repair ticket bills for">
                                          {(t.customData as any).shopWorkOrderNumber}
                                        </span>
                                      )}
                                    </div>
                                    <p className="text-xs text-slate-400 mt-0.5">
                                      {formatCalendarDateNumeric(t.serviceDate)}
                                      {t.total ? ` — ${formatMoney(t.total)}` : ''}
                                    </p>
                                  </div>
                                  <button
                                    onClick={() => openKickBack(`return-${t.id}`, t.ticketNumber, [{ id: t.id, ticketNumber: t.ticketNumber }])}
                                    disabled={actionLoading === `return-${t.id}`}
                                    className="shrink-0 flex items-center gap-1 px-2 py-1 text-xs font-medium text-orange-700 bg-orange-50 rounded-md hover:bg-orange-100 disabled:opacity-50"
                                    title="Send back to the Approvals dashboard with a note"
                                  >
                                    {actionLoading === `return-${t.id}` ? <Loader2 className="w-3 h-3 animate-spin" /> : <CornerUpLeft className="w-3 h-3" />}
                                    Kick Back
                                  </button>
                                  <button
                                    onClick={() => handleGenerateFromTickets(group.company.id, [t.id], `single-${t.id}`)}
                                    disabled={actionLoading === `single-${t.id}`}
                                    className="shrink-0 flex items-center gap-1 px-2 py-1 text-xs font-medium text-blue-700 bg-blue-50 rounded-md hover:bg-blue-100 disabled:opacity-50"
                                  >
                                    {actionLoading === `single-${t.id}` ? <Loader2 className="w-3 h-3 animate-spin" /> : <FileText className="w-3 h-3" />}
                                    Invoice
                                  </button>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {/* Nothing matches the current Type / search filter (but items exist) */}
            {!(showReadyShop && readyLists.wos.length > 0) &&
              !(showReadyRentals && readyLists.rentals.length > 0) &&
              !(showReadyTraining && readyLists.training.length > 0) &&
              !((showReadyField || showReadyShop) && visibleGroups.length > 0) && (
                <div className="text-center py-10 text-slate-400">
                  <Search className="w-8 h-8 mx-auto mb-2 opacity-40" />
                  <p className="text-sm">No ready items match this filter.</p>
                </div>
              )}
          </div>
        )
      )}

      {/* ENVERUS TAB — toolbox + queue management */}
      {tab === 'enverus' && canEnverus && (
        <div className="space-y-4">
          {/* ── Toolbox ── */}
          <div className="bg-white rounded-lg border border-slate-200">
            <button
              onClick={() => setToolboxOpen(v => !v)}
              className="w-full flex items-center justify-between px-4 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50 rounded-t-lg"
            >
              <span className="flex items-center gap-2">
                <Database className="w-4 h-4" />
                Enverus Toolbox
              </span>
              {toolboxOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </button>

            {toolboxOpen && (
              <div className="px-4 pb-4 space-y-4 border-t border-slate-100">
                {/* Test Connection */}
                <div className="pt-3">
                  <div className="flex items-center gap-3">
                    <button
                      onClick={handleTestConnection}
                      disabled={connTestLoading}
                      className="flex items-center gap-2 px-4 py-2 bg-slate-800 text-white rounded-lg text-sm font-medium hover:bg-slate-700 disabled:opacity-50 transition-colors"
                    >
                      {connTestLoading ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : connTest?.ok ? (
                        <Wifi className="w-4 h-4 text-green-400" />
                      ) : connTest && !connTest.ok ? (
                        <WifiOff className="w-4 h-4 text-red-400" />
                      ) : (
                        <Wifi className="w-4 h-4" />
                      )}
                      Test Connection
                    </button>

                    {connTest && (
                      <div className={cn(
                        'flex items-center gap-2 text-sm px-3 py-1.5 rounded-lg',
                        connTest.ok ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700',
                      )}>
                        {connTest.ok ? (
                          <CheckCircle2 className="w-4 h-4" />
                        ) : (
                          <XCircle className="w-4 h-4" />
                        )}
                        <span>{connTest.message}</span>
                        {connTest.latencyMs != null && (
                          <span className="text-xs opacity-70">{connTest.latencyMs}ms</span>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                {/* Fire Test Receipt */}
                <div className="border-t border-slate-100 pt-3">
                  <div className="space-y-3">
                    {/* Row 1: Buyer DUNS + Requisitioner + Product Code */}
                    <div className="grid grid-cols-[1fr_1.5fr_0.8fr] gap-3">
                      <div>
                        <label className="text-[10px] font-medium text-slate-500 block mb-1">
                          Buyer DUNS <span className="text-red-400">*</span>
                        </label>
                        <input
                          type="text"
                          value={masterDuns}
                          onChange={e => setMasterDuns(e.target.value)}
                          placeholder="e.g. 074292095"
                          className="w-full px-3 py-1.5 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500 outline-none font-mono"
                        />
                        <div className="flex gap-1 mt-1">
                          {[['074292095', 'Continental'], ['024681877', 'Grayson Mill']].map(([duns, label]) => (
                            <button
                              key={duns}
                              onClick={() => setMasterDuns(duns)}
                              className={cn(
                                'px-1.5 py-0 text-[10px] rounded transition-colors',
                                masterDuns === duns
                                  ? 'bg-purple-500 text-white font-bold'
                                  : 'bg-slate-100 text-slate-500 hover:bg-slate-200',
                              )}
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div>
                        <div className="flex items-center gap-1 mb-1">
                          <label className="text-[10px] font-medium text-slate-500">Requisitioner</label>
                          <button
                            onClick={handleLoadRequisitioners}
                            disabled={requisitionerLoading}
                            className="text-[10px] text-orange-600 hover:text-orange-700 font-medium"
                          >
                            {requisitionerLoading ? 'loading...' : requisitionerList.length > 0 ? 'reload' : 'fetch list'}
                          </button>
                        </div>
                        {requisitionerList.length > 0 ? (
                          <select
                            value={testRequisitioner}
                            onChange={e => setTestRequisitioner(e.target.value)}
                            className="w-full px-3 py-1.5 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500 outline-none bg-white"
                          >
                            <option value="">(omit)</option>
                            {requisitionerList.map(name => (
                              <option key={name} value={name}>{name}</option>
                            ))}
                          </select>
                        ) : (
                          <input
                            type="text"
                            value={testRequisitioner}
                            onChange={e => setTestRequisitioner(e.target.value)}
                            placeholder="click 'fetch list' first"
                            className="w-full px-3 py-1.5 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500 outline-none"
                          />
                        )}
                      </div>
                      <div>
                        <label className="text-[10px] font-medium text-slate-500 block mb-1">Product Code</label>
                        <input
                          type="text"
                          value={testProductCode}
                          onChange={e => setTestProductCode(e.target.value)}
                          placeholder="MISC"
                          className="w-full px-3 py-1.5 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500 outline-none font-mono"
                        />
                      </div>
                    </div>

                    {/* Row 2: Receipt Type + conditional LEM fields + Fire button */}
                    <div className={cn(
                      'grid gap-3 items-end',
                      testReceiptType.toLowerCase() === 'lem'
                        ? 'grid-cols-[1.2fr_1fr_1fr_auto]'
                        : 'grid-cols-[1fr_auto]',
                    )}>
                      <div>
                        <div className="flex items-center gap-1.5 mb-1">
                          <label className="text-[10px] font-medium text-slate-500">
                            Receipt Type <span className="text-red-400">*</span>
                          </label>
                          <button onClick={handleSniffReceiptTypes} className="text-[10px] text-blue-600 hover:text-blue-700 font-medium">sniff</button>
                          <button onClick={handleProbeReceiptTypes} className="text-[10px] text-purple-600 hover:text-purple-700 font-bold">PROBE</button>
                        </div>
                        <input
                          type="text"
                          value={testReceiptType}
                          onChange={e => setTestReceiptType(e.target.value)}
                          placeholder="e.g. General, lem"
                          className="w-full px-3 py-1.5 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500 outline-none font-mono"
                        />
                        <div className="flex flex-wrap gap-1 mt-1">
                          {['General', 'LEM', 'Hauling', 'Chemicals'].map(t => (
                            <button
                              key={t}
                              onClick={() => setTestReceiptType(t)}
                              className={cn(
                                'px-1.5 py-0 text-[10px] rounded transition-colors',
                                testReceiptType === t
                                  ? 'bg-orange-500 text-white font-bold'
                                  : 'bg-slate-100 text-slate-500 hover:bg-slate-200',
                              )}
                            >
                              {t}
                            </button>
                          ))}
                        </div>
                      </div>
                      {testReceiptType.toLowerCase() === 'lem' && (
                        <>
                          <div>
                            <label className="text-[10px] font-medium text-slate-500 block mb-1">
                              Charge Type <span className="text-red-400">*</span>
                            </label>
                            <input
                              type="text"
                              value={testChargeType}
                              onChange={e => setTestChargeType(e.target.value)}
                              placeholder="Labor"
                              className="w-full px-3 py-1.5 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500 outline-none font-mono"
                            />
                            <div className="flex gap-1 mt-1">
                              {['Labor', 'Equipment', 'Material'].map(t => (
                                <button
                                  key={t}
                                  onClick={() => setTestChargeType(t)}
                                  className={cn(
                                    'px-1.5 py-0 text-[10px] rounded transition-colors',
                                    testChargeType === t
                                      ? 'bg-blue-500 text-white font-bold'
                                      : 'bg-slate-100 text-slate-500 hover:bg-slate-200',
                                  )}
                                >
                                  {t}
                                </button>
                              ))}
                            </div>
                          </div>
                          <div>
                            <label className="text-[10px] font-medium text-slate-500 block mb-1">
                              AFE <span className="text-red-400">*</span>
                            </label>
                            <input
                              type="text"
                              value={testAfe}
                              onChange={e => setTestAfe(e.target.value)}
                              placeholder="1021443001"
                              className="w-full px-3 py-1.5 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500 outline-none font-mono"
                            />
                            <div className="flex gap-1 mt-1">
                              <button
                                onClick={() => setTestAfe('1021443001')}
                                className={cn(
                                  'px-1.5 py-0 text-[10px] rounded transition-colors',
                                  testAfe === '1021443001'
                                    ? 'bg-green-500 text-white font-bold'
                                    : 'bg-slate-100 text-slate-500 hover:bg-slate-200',
                                )}
                              >
                                CLR test
                              </button>
                            </div>
                          </div>
                        </>
                      )}
                      <button
                        onClick={handleFireTestReceipt}
                        disabled={testReceiptLoading}
                        className="flex items-center gap-2 px-5 py-2 bg-orange-600 text-white rounded-lg text-sm font-medium hover:bg-orange-500 disabled:opacity-50 transition-colors whitespace-nowrap self-start mt-5"
                      >
                        {testReceiptLoading ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <Zap className="w-4 h-4" />
                        )}
                        Fire Test
                      </button>
                    </div>

                    {/* Help text + payload preview toggle */}
                    <div className="flex items-center gap-3 text-xs text-slate-400">
                      <p>
                        Sends a $1.00 test receipt to DUNS {masterDuns || '074292095'}.
                        <span className="text-amber-500 font-medium"> LEM requires chargeType + AFE.</span>
                        {' '}Continental not in sandbox — use Grayson Mill.
                      </p>
                      <button
                        onClick={() => setShowPayloadPreview(v => !v)}
                        className="shrink-0 text-orange-500 hover:text-orange-600 font-medium underline"
                      >
                        {showPayloadPreview ? 'hide' : 'payload'}
                      </button>
                    </div>
                    {showPayloadPreview && (
                      <div className="bg-slate-900 rounded-lg p-3 text-xs font-mono text-green-400 whitespace-pre-wrap overflow-x-auto max-h-48 overflow-y-auto">
                        {JSON.stringify(buildTestReceiptBody(), null, 2)}
                      </div>
                    )}
                  </div>

                  {testReceiptResult ? (() => {
                    const r = testReceiptResult as any
                    const msgs = r?.messages as Array<{ type: string; field?: string; message: string }> | undefined
                    const errors = msgs?.filter(m => m.type === 'error') || []
                    const warnings = msgs?.filter(m => m.type === 'warning') || []
                    return (
                      <div className={cn(
                        'mt-3 border rounded-lg overflow-hidden',
                        r?.ok ? 'border-green-300' : 'border-red-300',
                      )}>
                        <div className={cn(
                          'px-3 py-2 text-sm font-medium flex items-center justify-between',
                          r?.ok ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700',
                        )}>
                          <span>
                            {r?.ok ? `Receipt accepted! ${r?.receiptNumber || ''}` : 'Receipt rejected'}
                            {r?.statusCode && ` (${r.statusCode})`}
                          </span>
                          <button onClick={() => setTestReceiptResult(null)} className="text-xs opacity-60 hover:opacity-100">Clear</button>
                        </div>

                        {/* Server-side debug panel — shows exactly what was sent */}
                        {r?.debug && (
                          <div className="px-3 py-2 bg-slate-50 border-b border-slate-200 text-xs font-mono space-y-0.5">
                            <div className="text-slate-400 font-sans font-medium text-[10px] uppercase tracking-wider mb-1">Debug (v{r._v})</div>
                            <div>
                              <span className="text-slate-500">receiptType in payload: </span>
                              <span className={r.debug.payloadHasReceiptType ? 'text-amber-600 font-bold' : 'text-green-600 font-bold'}>
                                {r.debug.payloadHasReceiptType ? `YES → "${r.debug.payloadReceiptType}"` : 'NO (omitted ✓)'}
                              </span>
                            </div>
                            <div>
                              <span className="text-slate-500">client sent receiptType: </span>
                              <span className="text-slate-700">{JSON.stringify(r.debug.clientSentReceiptType)}</span>
                            </div>
                            <div>
                              <span className="text-slate-500">receipt keys: </span>
                              <span className="text-slate-700">{r.debug.receiptKeys?.join(', ')}</span>
                            </div>
                          </div>
                        )}

                        {/* Parsed error/warning messages */}
                        {msgs && msgs.length > 0 && (
                          <div className="px-3 py-2 space-y-1.5 border-b border-slate-100">
                            {errors.map((m, i) => (
                              <div key={`e${i}`} className="flex items-start gap-2 text-xs">
                                <XCircle className="w-3.5 h-3.5 text-red-500 shrink-0 mt-0.5" />
                                <div>
                                  {m.field && <span className="font-mono text-red-600 mr-1">{m.field}:</span>}
                                  <span className="text-red-700">{m.message}</span>
                                </div>
                              </div>
                            ))}
                            {warnings.map((m, i) => (
                              <div key={`w${i}`} className="flex items-start gap-2 text-xs">
                                <AlertTriangle className="w-3.5 h-3.5 text-amber-500 shrink-0 mt-0.5" />
                                <div>
                                  {m.field && <span className="font-mono text-amber-600 mr-1">{m.field}:</span>}
                                  <span className="text-amber-700">{m.message}</span>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}

                        {/* Sent payload (collapsed) */}
                        <details className="text-xs">
                          <summary className="px-3 py-1.5 text-slate-400 hover:text-slate-600 cursor-pointer">Sent payload (what Enverus received)</summary>
                          <div className="max-h-48 overflow-auto p-3 bg-slate-900">
                            <pre className="text-xs text-green-400 whitespace-pre-wrap font-mono">
                              {JSON.stringify(r?.payload, null, 2)}
                            </pre>
                          </div>
                        </details>

                        {/* Raw response (collapsed) */}
                        <details className="text-xs">
                          <summary className="px-3 py-1.5 text-slate-400 hover:text-slate-600 cursor-pointer">Enverus response</summary>
                          <div className="max-h-48 overflow-auto p-3">
                            <pre className="text-xs text-slate-700 whitespace-pre-wrap font-mono">
                              {JSON.stringify(r?.response || r?.rawResponse || r, null, 2)}
                            </pre>
                          </div>
                        </details>
                      </div>
                    )
                  })() : null}
                </div>

                {/* Master Data Browser */}
                <div className="border-t border-slate-100 pt-3">
                  <button
                    onClick={() => setMasterDataOpen(v => !v)}
                    className="flex items-center gap-2 text-sm font-medium text-slate-600 hover:text-slate-900 mb-2"
                  >
                    {masterDataOpen ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                    Master Data Browser
                  </button>

                  {masterDataOpen && (
                    <div className="space-y-3">
                      <div className="flex items-end gap-2 flex-wrap">
                        {masterDataType !== 'customers' && (
                          <div className="flex-1 min-w-[160px]">
                            <label className="text-[10px] font-medium text-slate-500 block mb-1">Buyer DUNS</label>
                            <input
                              type="text"
                              value={masterDuns}
                              onChange={e => setMasterDuns(e.target.value)}
                              placeholder="e.g. 074292095"
                              className="w-full px-3 py-1.5 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none font-mono"
                            />
                          </div>
                        )}
                        <div className="min-w-[140px]">
                          <label className="text-[10px] font-medium text-slate-500 block mb-1">Data Type</label>
                          <select
                            value={masterDataType}
                            onChange={e => setMasterDataType(e.target.value as typeof masterDataType)}
                            className="w-full px-3 py-1.5 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none bg-white"
                          >
                            <option value="afes">AFEs</option>
                            <option value="cost-centers">Cost Centers</option>
                            <option value="requisitioners">Requisitioners</option>
                            <option value="purchase-orders">Purchase Orders</option>
                            <option value="buyer-rules">Buyer Rules</option>
                            <option value="customers">Customers (all buyers)</option>
                          </select>
                        </div>
                        <button
                          onClick={handleFetchMasterData}
                          disabled={masterDataLoading || (masterDataType !== 'customers' && !masterDuns.trim())}
                          className="flex items-center gap-1.5 px-4 py-1.5 bg-blue-800 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
                        >
                          {masterDataLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
                          Fetch
                        </button>
                      </div>

                      {/* Master data results */}
                      {masterDataError && (
                        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                          <span className="font-medium">Error:</span> {masterDataError}
                        </div>
                      )}

                      {masterDataResult !== null && (
                        <div className="border border-slate-200 rounded-lg overflow-hidden">
                          <div className="px-3 py-2 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
                            <span className="text-xs font-medium text-slate-600">
                              {masterDataResult.length} result{masterDataResult.length !== 1 ? 's' : ''}
                              {' — '}{masterDataType.replace('-', ' ')}{masterDataType !== 'customers' ? ` for DUNS ${masterDuns}` : ''}
                            </span>
                            <button
                              onClick={() => setMasterDataResult(null)}
                              className="text-xs text-slate-400 hover:text-slate-600"
                            >
                              Clear
                            </button>
                          </div>
                          {masterDataResult.length === 0 ? (
                            <div className="p-4 text-center text-sm text-slate-400">No records found</div>
                          ) : (() => {
                            const first = masterDataResult[0]
                            const keys = first && typeof first === 'object' ? Object.keys(first as Record<string, unknown>) : []
                            // If all values are primitives, show table; otherwise show raw JSON
                            const allPrimitive = keys.length > 0 && keys.every(k => {
                              const v = (first as Record<string, unknown>)[k]
                              return v === null || v === undefined || typeof v !== 'object'
                            })
                            return allPrimitive && masterDataResult.length > 0 ? (
                              <div className="max-h-64 overflow-auto">
                                <table className="w-full text-xs">
                                  <thead className="bg-slate-50 sticky top-0">
                                    <tr>
                                      {keys.slice(0, 8).map(key => (
                                        <th key={key} className="text-left px-3 py-1.5 font-medium text-slate-500 border-b border-slate-200">
                                          {key}
                                        </th>
                                      ))}
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {masterDataResult.slice(0, 50).map((row, i) => {
                                      const obj = row as Record<string, unknown>
                                      return (
                                        <tr key={i} className="border-b border-slate-100 hover:bg-slate-50">
                                          {keys.slice(0, 8).map(key => (
                                            <td key={key} className="px-3 py-1.5 text-slate-700 max-w-[200px] truncate">
                                              {String(obj[key] ?? '')}
                                            </td>
                                          ))}
                                        </tr>
                                      )
                                    })}
                                  </tbody>
                                </table>
                                {masterDataResult.length > 50 && (
                                  <div className="px-3 py-2 bg-slate-50 text-xs text-slate-400 border-t">
                                    Showing first 50 of {masterDataResult.length}
                                  </div>
                                )}
                              </div>
                            ) : (
                              <div className="max-h-64 overflow-auto p-3">
                                <pre className="text-xs text-slate-700 whitespace-pre-wrap font-mono">
                                  {JSON.stringify(masterDataResult.length === 1 ? masterDataResult[0] : masterDataResult, null, 2)}
                                </pre>
                              </div>
                            )
                          })()}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Raw API Explorer */}
                <div className="border-t border-slate-100 pt-3">
                  <button
                    onClick={() => setRawApiOpen(v => !v)}
                    className="flex items-center gap-2 text-sm font-medium text-slate-600 hover:text-slate-900 mb-2"
                  >
                    {rawApiOpen ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                    Raw API Explorer
                  </button>

                  {rawApiOpen && (
                    <div className="space-y-2">
                      <p className="text-xs text-slate-400">Hit any Enverus endpoint through our authenticated mTLS connection</p>
                      <div className="flex items-end gap-2 flex-wrap">
                        <div className="w-20">
                          <label className="text-[10px] font-medium text-slate-500 block mb-1">Method</label>
                          <select
                            value={rawApiMethod}
                            onChange={e => setRawApiMethod(e.target.value)}
                            className="w-full px-2 py-1.5 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500 outline-none bg-white font-mono"
                          >
                            <option value="GET">GET</option>
                            <option value="POST">POST</option>
                          </select>
                        </div>
                        <div className="flex-1 min-w-[250px]">
                          <label className="text-[10px] font-medium text-slate-500 block mb-1">Path (after /docp)</label>
                          <input
                            type="text"
                            value={rawApiPath}
                            onChange={e => setRawApiPath(e.target.value)}
                            placeholder="/supply-chain/v1/receipts"
                            className="w-full px-3 py-1.5 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500 outline-none font-mono"
                          />
                        </div>
                        <button
                          onClick={handleRawApiCall}
                          disabled={rawApiLoading}
                          className="flex items-center gap-2 px-4 py-2 bg-slate-700 text-white rounded-lg text-sm font-medium hover:bg-slate-600 disabled:opacity-50 transition-colors"
                        >
                          {rawApiLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
                          Send
                        </button>
                      </div>

                      {/* Quick-link buttons for common paths */}
                      <div className="flex flex-wrap gap-1">
                        {[
                          ['/supply-chain/v1/receipts?$top=5', 'Recent Receipts'],
                          [`/supply-chain/v1/receipts?$filter=buyerParty/partyDUNS eq '${masterDuns || '074292095'}'&$top=10&$select=receiptNumber,receiptType,status,totalAmount`, 'Receipts for buyer'],
                          ['/supply-chain/v1/receipts/185999', 'Receipt #185999 (full)'],
                          [`/supply-chain/v1/receipts/buyer-field-rules/${masterDuns || '074292095'}/type/lem`, 'Rules /lem'],
                          [`/supply-chain/v1/receipts/buyer-field-rules/${masterDuns || '074292095'}/type/general`, 'Rules /general'],
                          [`/supply-chain/v1/receipts/buyer-field-rules/${masterDuns || '074292095'}/type/service`, 'Rules /service'],
                          [`/supply-chain/v1/receipt.ordered-by-names?$filter=buyerDUNS eq '${masterDuns || '074292095'}'&$top=5`, 'Requisitioners'],
                          ['/supply-chain/v2/afes?$top=5', 'AFEs (top 5)'],
                          ['/supply-chain/v1/customer-management/customers', 'Customers'],
                        ].map(([path, label]) => (
                          <button
                            key={path}
                            onClick={() => { setRawApiPath(path); setRawApiMethod('GET') }}
                            className="px-2 py-0.5 text-[10px] bg-slate-100 hover:bg-slate-200 text-slate-600 rounded font-mono transition-colors"
                          >
                            {label}
                          </button>
                        ))}
                      </div>

                      {rawApiResult ? (
                        <div className="border border-slate-200 rounded-lg overflow-hidden">
                          <div className={`px-3 py-1.5 text-xs font-medium ${(rawApiResult as any)?.ok ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
                            {(rawApiResult as any)?.statusCode || 'Error'} — {(rawApiResult as any)?.ok ? 'OK' : 'Failed'}
                          </div>
                          <div className="max-h-80 overflow-auto p-3">
                            <pre className="text-xs text-slate-700 whitespace-pre-wrap font-mono">
                              {JSON.stringify((rawApiResult as any)?.body || rawApiResult, null, 2)}
                            </pre>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  )}
                </div>

              </div>
            )}
          </div>

          {/* ── Queue Section ── */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
                <Zap className="w-4 h-4" />
                Submission Queue
              </h3>
              <button
                onClick={() => {
                  setEnverusQueueLoading(true)
                  Promise.all([
                    api.get<{ data: EnverusQueueEntry[] }>('/enverus/queue?limit=100'),
                    api.get<EnverusAlert>('/enverus/alerts'),
                    api.get<EnverusQueueStats>('/enverus/queue/stats'),
                  ]).then(([qResult, aResult, sResult]) => {
                    if (qResult?.data) setEnverusQueue(qResult.data)
                    if (aResult) setEnverusAlerts(aResult)
                    if (sResult) setEnverusQueueStats(sResult)
                  }).catch(() => {}).finally(() => setEnverusQueueLoading(false))
                }}
                disabled={enverusQueueLoading}
                className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700"
              >
                <RefreshCw className={cn('w-3.5 h-3.5', enverusQueueLoading && 'animate-spin')} />
                Refresh
              </button>
            </div>

            {enverusQueueLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-5 h-5 text-slate-400 animate-spin" />
              </div>
            ) : enverusQueue.length === 0 ? (
              <div className="text-center py-8 text-slate-400 bg-white rounded-lg border border-slate-200">
                <Zap className="w-8 h-8 mx-auto mb-2 opacity-40" />
                <p className="text-sm font-medium">No queue entries</p>
                <p className="text-xs mt-1">Submit tickets or invoices to Enverus to see activity here.</p>
              </div>
            ) : (
              <div className="space-y-2">
                {enverusQueue.map(entry => (
                  <div
                    key={entry.id}
                    className={cn(
                      'bg-white rounded-lg border p-4',
                      entry.status === 'error' && 'border-red-300 bg-red-50',
                      entry.status === 'rejected' && 'border-amber-300 bg-amber-50',
                      entry.status === 'accepted' && 'border-green-200',
                      entry.status === 'submitted' && 'border-yellow-200',
                      !['error', 'rejected', 'accepted', 'submitted'].includes(entry.status) && 'border-slate-200',
                    )}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-slate-900 text-sm">
                          {entry.entityType === 'receipt' ? 'Receipt' : 'Invoice'}
                          {entry.entityNumber ? ` ${entry.entityNumber}` : ''}: {entry.action}
                        </span>
                        <span className={cn(
                          'text-[10px] font-bold px-2 py-0.5 rounded-full uppercase',
                          entry.status === 'error' && 'bg-red-200 text-red-800',
                          entry.status === 'rejected' && 'bg-amber-200 text-amber-800',
                          entry.status === 'accepted' && 'bg-green-200 text-green-800',
                          entry.status === 'submitted' && 'bg-yellow-200 text-yellow-800',
                          entry.status === 'pending' && 'bg-blue-200 text-blue-800',
                          entry.status === 'retrying' && 'bg-orange-200 text-orange-800',
                          entry.status === 'superseded' && 'bg-slate-200 text-slate-600',
                        )}>
                          {entry.status === 'superseded' ? 'Recovered' : entry.status}
                        </span>
                      </div>
                      <span className="text-xs text-slate-400">
                        {new Date(entry.createdAt).toLocaleString()}
                      </span>
                    </div>

                    <div className="text-xs text-slate-500 space-y-0.5 mt-1">
                      <p>Entity: {entry.entityId.slice(0, 8)}... &middot; Target: {entry.target}</p>
                      {entry.enverusItemId && <p>Enverus ID: {entry.enverusItemId}</p>}
                      {entry.retryCount > 0 && <p>Retries: {entry.retryCount}</p>}
                      {entry.submittedAt && <p>Submitted: {new Date(entry.submittedAt).toLocaleString()}</p>}
                      {entry.respondedAt && <p>Responded: {new Date(entry.respondedAt).toLocaleString()}</p>}
                    </div>

                    {entry.status === 'superseded' && <p className="mt-2 text-xs text-slate-600">A later submission succeeded. This attempt is retained as history.</p>}
                    {entry.status === 'superseded' && entry.errorMessage && <details className="mt-2 text-xs text-slate-500">
                      <summary className="cursor-pointer">Original failure</summary>
                      <pre className="mt-1 whitespace-pre-wrap break-all">{entry.errorMessage}</pre>
                    </details>}
                    {entry.errorMessage && entry.status !== 'superseded' && (
                      <div className="mt-2 p-2 bg-red-100 border border-red-200 rounded text-xs text-red-700 font-mono break-all">
                        {entry.errorMessage}
                      </div>
                    )}

                    <EnverusWarnings sources={[entry.responsePayload]} />
                    {/* Actions */}
                    <div className="flex items-center gap-2 mt-3">
                      {['error', 'rejected'].includes(entry.status) && (
                        <button
                          onClick={() => handleEnverusRetry(entry.id)}
                          disabled={actionLoading === entry.id}
                          className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-800 text-white rounded-lg text-xs font-medium hover:bg-blue-700 disabled:opacity-50"
                        >
                          {actionLoading === entry.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
                          Retry
                        </button>
                      )}
                      <button
                        onClick={() => handleEnverusDelete(entry.id)}
                        disabled={actionLoading === entry.id}
                        className="flex items-center gap-1 px-2 py-1.5 text-xs text-red-500 hover:text-red-700 hover:bg-red-50 rounded ml-auto"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        Remove
                      </button>
                      {actionLoading === entry.id && <Loader2 className="w-4 h-4 text-slate-400 animate-spin" />}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* SIGNATURE QUEUE TAB */}
      {tab === 'signatures' && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-700">Pending Signature Requests</h2>
            <button
              onClick={loadSignatureRequests}
              className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800"
            >
              <RefreshCw className={cn('w-3.5 h-3.5', sigLoading && 'animate-spin')} />
              Refresh
            </button>
          </div>

          {sigLoading && signatureRequests.length === 0 ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-6 h-6 text-slate-400 animate-spin" />
            </div>
          ) : signatureRequests.length === 0 ? (
            <div className="text-center py-12 text-slate-400">
              <CheckCircle2 className="w-10 h-10 mx-auto mb-2 opacity-50" />
              <p className="font-medium">No pending signature requests</p>
              <p className="text-xs mt-1">Tickets and invoices requiring signatures will appear here.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {signatureRequests.map((sig: any) => {
                const isTicket = !!sig.ticket
                const ref = isTicket ? sig.ticket : sig.invoice
                const refNumber = isTicket ? ref?.ticketNumber : ref?.invoiceNumber
                const company = isTicket ? ref?.company?.name : ref?.companyName
                const total = ref?.total != null ? `$${Number(ref.total).toFixed(2)}` : ''
                const isActioning = sigActionLoading === sig.id

                return (
                  <div key={sig.id} className="bg-white rounded-lg border border-slate-200 p-4">
                    <div className="flex items-start justify-between mb-2">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className={cn(
                            'text-xs font-semibold px-2 py-0.5 rounded-full',
                            isTicket ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700',
                          )}>
                            {isTicket ? 'Ticket' : 'Invoice'}
                          </span>
                          <span
                            className="font-medium text-slate-900 hover:text-blue-700 cursor-pointer"
                            onClick={() => navigate(isTicket ? `/tickets/${ref?.id}` : `/billing/${ref?.id}`)}
                          >
                            {refNumber || '—'}
                          </span>
                          {total && <span className="text-sm text-slate-500">{total}</span>}
                        </div>
                        <p className="text-sm text-slate-600 mt-0.5">{company}</p>
                        {sig.locationName && <p className="text-sm text-slate-600">{sig.locationName}</p>}
                      </div>
                      <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-yellow-100 text-yellow-700">
                        Email — Pending
                      </span>
                    </div>

                    {/* Send details */}
                    <div className="text-xs text-slate-500 space-y-0.5 mb-3">
                      <p>Sent to: <span className="text-slate-700">{sig.sentToName ? `${sig.sentToName} (${sig.sentToEmail})` : sig.sentToEmail}</span></p>
                      <p>Sent by: <span className="text-slate-700">{sig.sentBy?.name || '—'}</span></p>
                      <p>
                        First sent: {new Date(sig.firstSentAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                        {sig.sendCount > 1 && (
                          <span className="ml-2 text-amber-600 font-medium">
                            · Resent {sig.sendCount - 1}x (last: {new Date(sig.lastSentAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })})
                          </span>
                        )}
                      </p>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-2 flex-wrap">
                      <button
                        onClick={() => handleSigResolve(sig.id)}
                        disabled={isActioning}
                        className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-green-600 hover:bg-green-500 text-white rounded disabled:opacity-50"
                      >
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        Mark Received
                      </button>
                      <button
                        onClick={() => handleSigVoid(sig.id)}
                        disabled={isActioning}
                        className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-red-600 hover:text-red-700 hover:bg-red-50 rounded border border-slate-200 disabled:opacity-50"
                      >
                        <XCircle className="w-3.5 h-3.5" />
                        Void
                      </button>
                      {isActioning && <Loader2 className="w-4 h-4 text-slate-400 animate-spin" />}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* INVOICE TABS — existing invoices */}
      {tab === 'rebilling' && <RebillingReport search={search} />}
      {tab !== 'ready' && tab !== 'enverus' && tab !== 'signatures' && tab !== 'rebilling' && (
        invoiceListError ? (
          <div className="text-center py-8 text-red-600">
            <p>Invoices could not be loaded.</p>
            <button className="mt-2 underline" onClick={() => loadInvoicePage()}>Retry invoices</button>
          </div>
        ) : loading || (invoiceListLoading && !filtered.length) ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 text-slate-400 animate-spin" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-12 text-slate-400">
            <DollarSign className="w-10 h-10 mx-auto mb-2 opacity-50" />
            <p className="font-medium">
              {tab === 'drafts' ? 'No draft invoices' :
               tab === 'approved' ? 'Nothing awaiting QB push' :
               tab === 'in_qb' ? 'No invoices queued or Sales Orders pending in QB' :
               tab === 'invoiced' ? 'No invoiced items' :
               'No invoices yet'}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {filtered.map(inv => {
              const badge = inv.qbExportError ? { label: 'Error', color: 'bg-red-100 text-red-700', icon: AlertTriangle } : STATUS_BADGE[inv.status] || { label: inv.status, color: 'bg-slate-100 text-slate-600', icon: FileText }
              const BadgeIcon = badge.icon
              const isLoading = actionLoading === inv.id

              return (
                <div
                  key={inv.id}
                  onClick={() => navigate(`/billing/${inv.id}`)}
                  className="bg-white rounded-lg border border-slate-200 p-4 cursor-pointer hover:border-blue-300 hover:shadow-sm transition-all"
                >
                  {/* Header row */}
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-slate-900">{inv.invoiceNumber}</span>
                      {inv.sourceModifiedAfterSync && (
                        <span className="flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700">
                          <AlertTriangle className="w-3 h-3" />
                          Modified
                        </span>
                      )}
                    </div>
                    <span className={cn(
                      'flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full',
                      badge.color,
                    )}>
                      <BadgeIcon className="w-3 h-3" />
                      {badge.label}
                    </span>
                  </div>

                  {inv.qbExportError && (
                    <p className="mt-1 text-sm text-red-700 break-words">{inv.qbExportError}</p>
                  )}
                  {/* Customer + source */}
                  <p className="text-sm text-slate-600">
                    {inv.companyName}
                    <span className="ml-2 text-xs text-slate-400">
                      {SOURCE_LABELS[inv.sourceType] || inv.sourceType}
                    </span>
                  </p>

                  {inv.locationName && <p className="text-sm text-slate-600">{inv.locationName}</p>}
                  <InvoiceCustomerAttribution customer={inv.companyName} billedTo={inv.qbCustomerOverride} />
                  {/* Details row */}
                  <div className="flex items-center gap-3 text-xs text-slate-400 mt-1.5">
                    <span>{formatCalendarDateNumeric(inv.invoiceDate)}</span>
                    {inv._count && <span>{inv._count.lineItems} lines</span>}
                    {inv.poNumber && <span>PO: {inv.poNumber}</span>}
                    <span className="font-medium text-slate-600">{formatMoney(inv.total)}</span>
                  </div>

                  {/* Original source ticket(s) — preserved after the ticket becomes an invoice */}
                  {(inv.sourceTickets?.length || 0) > 0 && (
                    <div className="flex items-center gap-1.5 mt-1.5 text-xs flex-wrap" onClick={e => e.stopPropagation()}>
                      <span className="text-slate-400">Ticket{inv.sourceTickets!.length !== 1 ? 's' : ''}:</span>
                      {inv.sourceTickets!.map(st => (
                        st.number ? (
                          <span key={st.id} className="inline-flex items-start gap-1">
                            <button
                              onClick={() => navigate(`/tickets/${st.id}`)}
                              className="font-mono px-1.5 py-0.5 bg-slate-50 text-blue-700 rounded hover:bg-slate-100 hover:underline"
                              title="Open original ticket"
                            >
                              {st.number}
                            </button>
                            <TicketReceiptStatus ticketId={st.id} ticketNumber={st.number} />
                            {/* One bad ticket shouldn't send the whole stack back.
                                With a single ticket, Reject to Approvals is the same thing. */}
                            {inv.status === 'draft' && inv.sourceTickets!.length > 1 && (
                              <button
                                onClick={() => openKickBack(`return-${st.id}`, `${st.number} off ${inv.invoiceNumber}`, [{ id: st.id, ticketNumber: st.number! }], { id: inv.id, invoiceNumber: inv.invoiceNumber })}
                                disabled={actionLoading === `return-${st.id}`}
                                className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-orange-700 bg-orange-50 rounded hover:bg-orange-100 disabled:opacity-50"
                                title={`Take ${st.number} off this draft and send it back to the Approvals dashboard with a note`}
                              >
                                {actionLoading === `return-${st.id}` ? <Loader2 className="w-3 h-3 animate-spin" /> : <CornerUpLeft className="w-3 h-3" />}
                                Kick Back
                              </button>
                            )}
                          </span>
                        ) : null
                      ))}
                    </div>
                  )}

                  {/* QB + Enverus tracking row */}
                  {(inv.qbSalesOrderNumber || inv.qbInvoiceNumber || inv.enverusStatus) && (
                    <div className="flex items-center gap-2 mt-1.5 text-xs flex-wrap">
                      {inv.qbSalesOrderNumber && (
                        <span className="px-1.5 py-0.5 bg-purple-50 text-purple-600 rounded">
                          SO# {inv.qbSalesOrderNumber}
                        </span>
                      )}
                      {inv.qbSalesOrderNumber && inv.qbInvoiceNumber && (
                        <ArrowRight className="w-3 h-3 text-slate-300" />
                      )}
                      {inv.qbInvoiceNumber && (
                        <span className="px-1.5 py-0.5 bg-green-50 text-green-600 rounded">
                          INV# {inv.qbInvoiceNumber}
                        </span>
                      )}
                      {inv.enverusStatus && (
                        <span className={cn(
                          'px-1.5 py-0.5 rounded font-medium flex items-center gap-1',
                          inv.enverusStatus === 'accepted' && 'bg-green-100 text-green-700',
                          inv.enverusStatus === 'submitted' && 'bg-yellow-100 text-yellow-700',
                          inv.enverusStatus === 'error' && 'bg-red-100 text-red-700 animate-pulse',
                          inv.enverusStatus === 'disputed' && 'bg-amber-100 text-amber-700 animate-pulse',
                          !['accepted', 'submitted', 'error', 'disputed'].includes(inv.enverusStatus) && 'bg-slate-100 text-slate-600',
                        )}>
                          <Zap className="w-3 h-3" />
                          OI: {inv.enverusStatus}
                        </span>
                      )}
                    </div>
                  )}

                  {/* Mirrored billing facts — source + as-of, distinct from
                      the bare SO#/INV#/OI badges above (ServicePRO's own
                      cache of what it pushed). One batch fetch for the whole
                      list, see loadData(). */}
                  {latestObservations[inv.invoiceNumber] && Object.keys(latestObservations[inv.invoiceNumber]).length > 0 && (
                    <div className="flex items-center gap-1.5 mt-1.5 flex-wrap" onClick={e => e.stopPropagation()}>
                      {Object.entries(latestObservations[inv.invoiceNumber]).map(([factKey, obs]) => (
                        <BillingProvenancePill key={factKey} observation={{ factKey, ...obs }} />
                      ))}
                      <button
                        onClick={() => navigate(`/billing/lineage?q=${encodeURIComponent(inv.invoiceNumber)}`)}
                        className="text-[11px] text-blue-700 hover:underline"
                      >
                        Lineage →
                      </button>
                    </div>
                  )}

                  {/* Action buttons */}
                  <div className="flex items-center gap-2 mt-3" onClick={e => e.stopPropagation()}>
                    {inv.status === 'draft' && (
                      <>
                        <button
                          onClick={() => handleApprove(inv)}
                          disabled={isLoading}
                          className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-800 text-white rounded-lg text-xs font-medium hover:bg-blue-700 disabled:opacity-50"
                        >
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          Approve
                        </button>
                        <button
                          onClick={() => handleReject(inv)}
                          disabled={isLoading}
                          className="flex items-center gap-1.5 px-3 py-1.5 text-orange-700 bg-orange-50 border border-orange-200 rounded-lg text-xs font-medium hover:bg-orange-100 disabled:opacity-50"
                          title="Void this draft and send its tickets back to the Approvals dashboard with a note"
                        >
                          <CornerUpLeft className="w-3.5 h-3.5" />
                          Reject to Approvals
                        </button>
                      </>
                    )}
                    {inv.status === 'approved' && (
                      <>
                        <button
                          onClick={() => handleQueue(inv)}
                          disabled={isLoading}
                          className="flex items-center gap-1.5 px-3 py-1.5 bg-purple-700 text-white rounded-lg text-xs font-medium hover:bg-purple-600 disabled:opacity-50"
                        >
                          <Send className="w-3.5 h-3.5" />
                          Push to QB
                        </button>
                        <button
                          onClick={() => handleReject(inv)}
                          disabled={isLoading}
                          className="flex items-center gap-1.5 px-3 py-1.5 border border-slate-300 rounded-lg text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                          title="Un-approve: back to draft for editing. Its tickets stay on the draft."
                        >
                          Back to Draft
                        </button>
                      </>
                    )}
                    {canEnverus && (inv.status === 'invoiced' || inv.status === 'sent') && (
                      <>
                        <button
                          onClick={() => handleSubmitToOI(inv)}
                          disabled={isLoading}
                          className={cn(
                            'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium disabled:opacity-50',
                            inv.enverusStatus
                              ? 'bg-amber-100 text-amber-700 hover:bg-amber-200'
                              : 'bg-indigo-600 text-white hover:bg-indigo-700',
                          )}
                          title="Submit invoice as receipt to OpenInvoice"
                        >
                          <Zap className="w-3.5 h-3.5" />
                          {inv.enverusStatus ? `OI (${inv.enverusStatus})` : 'Send to OI'}
                        </button>
                        {(inv.sourceTickets?.length || 0) > 0 && (
                          <button
                            onClick={() => handleSubmitToOT(inv)}
                            disabled={isLoading}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium disabled:opacity-50 bg-purple-600 text-white hover:bg-purple-700"
                            title={`Submit ${inv.sourceTickets!.length} ticket(s) as receipt to OpenTicket`}
                          >
                            <Zap className="w-3.5 h-3.5" />
                            Send to OT
                            {inv.sourceTickets!.length > 1 && <span className="opacity-70">({inv.sourceTickets!.length})</span>}
                          </button>
                        )}
                      </>
                    )}
                    {can('invoices:cancel') && inv.status !== 'void' && inv.status !== 'paid' && (
                      <button
                        onClick={() => handleVoid(inv)}
                        disabled={isLoading}
                        className="ml-auto flex items-center gap-1 px-2 py-1.5 text-xs text-red-500 hover:text-red-700 hover:bg-red-50 rounded"
                      >
                        <XCircle className="w-3.5 h-3.5" />
                        Void
                      </button>
                    )}
                    {isLoading && <Loader2 className="w-4 h-4 text-slate-400 animate-spin ml-2" />}
                  </div>
                </div>
              )
            })}
            <p className="text-center text-xs text-slate-500">Showing {filtered.length} of {invoiceTotal} invoices</p>
            {invoiceOffset < invoiceTotal && (
              <button className="w-full rounded border border-slate-200 p-3 text-sm" disabled={invoiceListLoading} onClick={() => loadInvoicePage(true)}>
                {invoiceListLoading ? 'Loading invoices…' : 'Load more invoices'}
              </button>
            )}
          </div>
        )
      )}

      {/* Kick-back modal */}
      {returnModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-md">
            <div className="p-5 border-b border-slate-200">
              <h3 className="text-lg font-semibold text-slate-900 flex items-center gap-2">
                <CornerUpLeft className="w-5 h-5 text-orange-600" />
                Kick back {returnModal.label}
              </h3>
              <p className="text-sm text-slate-500 mt-1">
                {returnModal.tickets.length === 1 ? 'This ticket goes' : 'These tickets go'} back
                to the Approvals dashboard (supervisor review). Your note shows there so the
                reviewer knows what to fix.
                {returnModal.invoice && ` Its lines come off draft ${returnModal.invoice.invoiceNumber}; the other tickets stay on it.`}
              </p>
              {returnModal.tickets.length > 1 && (
                <p className="text-xs text-slate-500 mt-2 font-mono">
                  {returnModal.tickets.map(t => t.ticketNumber).join(', ')}
                </p>
              )}
            </div>
            <div className="p-5">
              <label className="block text-sm font-medium text-slate-700 mb-1">
                Note <span className="text-red-600">*</span>
              </label>
              <textarea
                value={returnNote}
                onChange={e => setReturnNote(e.target.value)}
                rows={4}
                placeholder="e.g. PO number is wrong, labor rate needs a second look…"
                className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:border-orange-500 focus:ring-1 focus:ring-orange-500"
              />
            </div>
            <div className="px-5 py-4 border-t border-slate-200 flex items-center justify-end gap-2">
              <button
                onClick={() => { setReturnModal(null); setReturnNote('') }}
                className="px-4 py-2 rounded-lg text-sm font-medium text-slate-600 hover:bg-slate-100"
              >
                Cancel
              </button>
              <button
                onClick={handleReturnForReview}
                disabled={!returnNote.trim() || actionLoading !== null}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-orange-600 text-white hover:bg-orange-500 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
              >
                {actionLoading === returnModal.key ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <CornerUpLeft className="w-4 h-4" />
                )}
                Kick back to Approvals
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}


// ─────────────────────────────────────────────────────────────────────────────
// Per-ticket OpenTicket receipt status
// ─────────────────────────────────────────────────────────────────────────────
//
// The OT path submits each SOURCE TICKET as its own receipt
// (/enverus/receipts/submit/:ticketId), so the invoice-level "OI:" badge above
// says nothing about it. /enverus/receipts/status/:ticketId and
// /enverus/receipts/cancel/:ticketId have existed unused since the OT work
// landed; this is the surface for both.
//
// Fetches ONLY when expanded, on purpose: the status endpoint re-polls Enverus
// live, and the billing list renders many invoices with many tickets each.
// Auto-loading would turn one page view into dozens of upstream calls.

interface TicketReceiptStatusResp {
  ticketId: string
  ticketNumber: string | null
  enverusReceiptId: string | null
  enverusReceiptStatus: string | null
  enverusLiveData?: Record<string, unknown> | null
  // The server returns whole queue rows; the error column is `errorMessage`.
  queueHistory: Array<{
    id: string; status: string; action: string | null; createdAt: string
    errorMessage?: string | null
  }>
}

const RECEIPT_TONE: Record<string, string> = {
  approved: 'bg-green-100 text-green-700',
  submitted: 'bg-yellow-100 text-yellow-700',
  disputed: 'bg-amber-100 text-amber-700',
  cancelled: 'bg-slate-100 text-slate-500',
  error: 'bg-red-100 text-red-700',
}

function TicketReceiptStatus({ ticketId, ticketNumber }: { ticketId: string; ticketNumber: string | null }) {
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<TicketReceiptStatusResp | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [cancelling, setCancelling] = useState(false)

  async function load() {
    setLoading(true)
    setErr(null)
    try {
      setData(await api.get<TicketReceiptStatusResp>(`/enverus/receipts/status/${ticketId}`))
    } catch (e: any) {
      setErr(e?.message || 'Could not read receipt status')
    } finally {
      setLoading(false)
    }
  }

  function toggle() {
    const next = !open
    setOpen(next)
    if (next && !data) void load()
  }

  async function cancel() {
    // Irreversible from here: it queues a receipt.cancel to Enverus and marks
    // the ticket cancelled locally, so it asks first.
    if (!confirm(`Cancel the Enverus receipt for ticket ${ticketNumber || ticketId}?`)) return
    setCancelling(true)
    setErr(null)
    try {
      await api.post(`/enverus/receipts/cancel/${ticketId}`, {})
      await load()
    } catch (e: any) {
      setErr(e?.message || 'Cancel failed')
    } finally {
      setCancelling(false)
    }
  }

  const status = data?.enverusReceiptStatus ?? null

  return (
    <span className="inline-flex flex-col">
      <button
        onClick={toggle}
        className="text-[11px] text-slate-400 hover:text-blue-700 hover:underline"
        title="OpenTicket receipt status for this ticket"
      >
        OT {open ? '▴' : '▾'}
      </button>

      {open && (
        <span className="mt-1 p-2 rounded border border-slate-200 bg-white text-[11px] space-y-1 min-w-[190px]">
          {loading && <span className="text-slate-400">Reading Enverus…</span>}
          {err && <span className="block text-red-600">{err}</span>}
          {data && !loading && (
            <>
              <span className="flex items-center gap-1.5 flex-wrap">
                <span className={cn(
                  'px-1.5 py-0.5 rounded font-medium',
                  RECEIPT_TONE[status ?? ''] ?? 'bg-slate-100 text-slate-600',
                )}>
                  {status || 'not submitted'}
                </span>
                {data.enverusReceiptId && (
                  <span className="font-mono text-slate-500">{data.enverusReceiptId}</span>
                )}
              </span>

              {data.queueHistory.length > 0 && (
                <span className="block text-slate-500">
                  last: {data.queueHistory[0]!.action || 'submit'} · {data.queueHistory[0]!.status}
                  {data.queueHistory[0]!.errorMessage && (
                    <span className="block text-red-600 break-words">{data.queueHistory[0]!.errorMessage}</span>
                  )}
                </span>
              )}

              <span className="flex items-center gap-2 pt-0.5">
                <button onClick={() => void load()} className="text-blue-600 hover:underline">
                  Re-poll
                </button>
                {/* Only offer cancel when there is a receipt to cancel — the
                    endpoint 400s otherwise, and an always-visible destructive
                    button next to nothing is just a trap. */}
                {(data.enverusReceiptId || status) && status !== 'cancelled' && (
                  <button
                    onClick={cancel}
                    disabled={cancelling}
                    className="text-red-600 hover:underline disabled:opacity-50"
                  >
                    {cancelling ? 'Cancelling…' : 'Cancel receipt'}
                  </button>
                )}
              </span>
            </>
          )}
        </span>
      )}
    </span>
  )
}
