import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useAuth } from '@/contexts/AuthContext'
import { usePermissions } from '@/contexts/PermissionsContext'
import { ConfirmDestructiveDialog } from '@/components/ConfirmDestructiveDialog'
import { db } from '@/lib/db'
import { api } from '@/lib/api'
import { cn } from '@/lib/cn'
import { DISCLOSURE_CONDITIONS, ADVERSE_REACTIONS } from '@/components/FitTestEditor'
import { getAvailableTransitions, canEditTicket, TRANSITION_LABELS } from '@/lib/ticketStateMachine'
import { Elements } from '@stripe/react-stripe-js'
import type { Stripe } from '@stripe/stripe-js'
import { getStripe } from '@/lib/stripe'
import { formatCalendarDateLong, formatCalendarDateNumeric } from '@/lib/dates'
import { PaymentForm } from '@/components/PaymentForm'
import { BillingLineagePanel } from '@/components/BillingLineagePanel'
import type { BillingReadiness } from '@/components/BillingReadinessEditor'
import {
  ArrowLeft,
  CreditCard,
  MapPin,
  Calendar,
  User,
  ChevronRight,
  ChevronDown,
  Package,
  Camera,
  FileText,
  ShieldCheck,
  CheckCircle,
  XCircle,
  Loader2,
  Pencil,
  Copy,
  FileDown,
  FlaskConical,
  GraduationCap,
  Ban,
  Trash2,
} from 'lucide-react'

// ---- Types for the API response ----
interface TicketDetail {
  id: string
  ticketNumber: string | null
  ticketType: string
  serviceSubtype: string | null
  status: string
  companyId: string
  fieldId: string | null
  padId: string | null
  wellId: string | null
  locationDisplay: string | null
  assignedTechId: string | null
  serviceDate: string
  arrivalTime: string | null
  departureTime: string | null
  afeNumber: string | null
  poNumber: string | null
  customerRepName: string | null
  customerRepSignature: string | null
  techSignature: string | null
  dispatchNotes: string | null
  workDescription: string | null
  internalNotes: string | null
  subtotal: string | null
  total: string | null
  customData: any
  offlineId: string | null
  offlineCreated: boolean
  billingReadiness: BillingReadiness
  billingReadinessReasonCode: string | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
  // Nested
  company?: { id: string; name: string; cashCcOnly?: boolean } | null
  field?: { id: string; name: string } | null
  pad?: { id: string; name: string } | null
  well?: { id: string; wellName: string | null } | null
  assignedTech?: { id: string; name: string; email?: string } | null
  dispatchedBy?: { id: string; name: string } | null
  createdBy?: { id: string; name: string } | null
  lineItems?: LineItemDetail[]
  attachments?: AttachmentDetail[]
  fitTestRecords?: FitTestDetail[]
  ihTestRecords?: Array<{
    id: string
    testType: string
    locationPoint?: string | null
    instrumentModel?: string | null
    instrumentSerial?: string | null
    testData: any
    notes?: string | null
    testedAt?: string | null
  }>
  trainingRosterRecords?: Array<{
    id: string
    employeeName: string
    employeeId: string | null
    employerName: string | null
    employerCompanyId: string | null
    contactEmail: string | null
    contactPhone: string | null
    courseName: string
    passed: boolean
    cardIssuedOnSite: boolean
    cardIssuedOfficial: boolean
    cardNumber: string | null
    cardExpiryDate: string | null
    notes: string | null
    trainedAt: string
  }>
  // Billing Profile (nested from API)
  billingProfile?: {
    id: string
    signatureRequired?: string
    signatureApprovers?: { name: string; email: string }[] | null
  } | null
  availableTransitions?: string[]
  // Offline
  _offlineStatus?: string
}

interface LineItemDetail {
  id: string
  lineNumber: number
  lineType: string
  description: string | null
  quantity: string
  rate: string | null
  total: string | null
  unitOfMeasure: string | null
  serialNumberInstalled: string | null
  serialNumberRemoved: string | null
  testResult: string | null
  calGasLotNumber: string | null
  sortOrder: number
  notes: string | null
  product?: { id: string; partNumber: string; name: string } | null
}

interface AttachmentDetail {
  id: string
  fileName: string
  fileType: string
  filePath: string | null
  mimeType: string | null
  uploadedAt: string
}

interface FitTestDetail {
  id: string
  employeeName: string
  employeeId: string | null
  employerName: string | null
  jobTitle: string | null
  respiratorMake: string | null
  respiratorModel: string | null
  respiratorSize: string | null
  respiratorType: string | null
  testMethod: string | null
  fitFactor: string | null
  passFail: string
  testDate: string
  notes: string | null
  meqAccepted: boolean
  disclosureConditions: string[] | null
  isCleanShaven: boolean | null
  wearsGlassesContacts: boolean | null
  adverseReactions: string[] | null
  criteriaAcknowledged: boolean
  participantSignature: string | null
}

// ---- Status styling ----
const STATUS_CONFIG: Record<string, { label: string; color: string }> = {
  draft: { label: 'Draft', color: 'bg-slate-100 text-slate-700' },
  dispatched: { label: 'Dispatched', color: 'bg-blue-100 text-blue-700' },
  in_progress: { label: 'In Progress', color: 'bg-amber-100 text-amber-700' },
  completed: { label: 'Completed', color: 'bg-green-100 text-green-700' },
  supervisor_review: { label: 'Review', color: 'bg-purple-100 text-purple-700' },
  awaiting_signature: { label: 'Awaiting Signature', color: 'bg-yellow-100 text-yellow-700' },
  billing_queue: { label: 'Billing', color: 'bg-indigo-100 text-indigo-700' },
  invoiced: { label: 'Invoiced', color: 'bg-emerald-100 text-emerald-700' },
  closed: { label: 'Closed', color: 'bg-slate-200 text-slate-500' },
}

const TICKET_TYPE_LABELS: Record<string, string> = {
  field_service: 'Field Service',
  training: 'Training',
  sale: 'Sale',
  rental: 'Rental',
  repair: 'Repair',
  inspection: 'Inspection',
}

const SUBTYPE_LABELS: Record<string, string> = {
  fit_test: 'Occ Health',
  monitor: 'Monitor',
  air_system: 'Air System',
  bump_test: 'Bump Test',
  calibration: 'Calibration',
  general: 'General',
  ih_h2s: 'H₂S Testing',
  ih_o2_voc: 'O₂/VOC Testing',
  ih_sampling: 'Sampling',
  ih_audiometric: 'Audiometric',
  safety_training: 'Safety Training',
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
  } catch { return iso }
}

function formatTime(iso: string | null): string {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  } catch { return '' }
}

function formatCurrency(val: string | number | null | undefined): string {
  if (val == null || val === '') return ''
  const n = typeof val === 'string' ? parseFloat(val) : val
  if (isNaN(n)) return ''
  return `$${n.toFixed(2)}`
}

// ============================================================
// Cash/Card-only payment panel
// ============================================================
// Surfaced on a ticket whenever its customer is flagged cash/card-only, so
// staff can take a card payment at time of service instead of invoicing on
// account. Reuses the shared Stripe PaymentForm + getStripe loader. Hidden once
// a succeeded payment already exists for the ticket (no double-charge).
function CashCcPaymentPanel({ ticketId, ticketNumber, amount }: {
  ticketId: string
  ticketNumber: string | null
  amount: number
}) {
  const [stripePromise, setStripePromise] = useState<Promise<Stripe | null> | null>(null)
  const [alreadyPaid, setAlreadyPaid] = useState<boolean | null>(null)
  const [justPaid, setJustPaid] = useState(false)

  useEffect(() => {
    setStripePromise(getStripe())
    let cancelled = false
    ;(async () => {
      try {
        const res = await api.get<{ data: any[] }>(`/payments?ticketId=${ticketId}&status=succeeded`)
        if (!cancelled) setAlreadyPaid((res.data?.length ?? 0) > 0)
      } catch {
        // If we can't check (e.g. offline), default to showing the form rather
        // than hiding a legitimate way to collect — staff can see the result.
        if (!cancelled) setAlreadyPaid(false)
      }
    })()
    return () => { cancelled = true }
  }, [ticketId])

  if (alreadyPaid === null) return null // still checking

  return (
    <section className="bg-white rounded-lg border border-amber-300 p-4">
      <h3 className="font-semibold text-slate-900 text-sm mb-1 flex items-center gap-2">
        <CreditCard className="w-4 h-4 text-amber-600" />
        Collect Card Payment
      </h3>
      <p className="text-xs text-amber-700 mb-3">
        Cash / Card-only customer — collect payment at time of service.
      </p>
      {alreadyPaid || justPaid ? (
        <p className="text-sm text-emerald-700 font-medium flex items-center gap-1.5">
          <CheckCircle className="w-4 h-4" /> Card payment received
        </p>
      ) : amount <= 0 ? (
        <p className="text-sm text-slate-500">Add line items to total this ticket before collecting payment.</p>
      ) : stripePromise ? (
        <Elements stripe={stripePromise}>
          <PaymentForm
            amount={amount}
            ticketId={ticketId}
            description={`Ticket ${ticketNumber || ticketId}`}
            onSuccess={() => setJustPaid(true)}
          />
        </Elements>
      ) : (
        <Loader2 className="w-4 h-4 animate-spin text-slate-400" />
      )}
    </section>
  )
}

// ============================================================
// Component
// ============================================================

export function TicketDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { user } = useAuth()
  const { can } = usePermissions()
  const [voidOpen, setVoidOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [destructiveBusy, setDestructiveBusy] = useState(false)

  async function handleVoidTicket({ reason }: { reason: string }) {
    setDestructiveBusy(true)
    try {
      await api.post(`/tickets/${id}/void`, { reason: reason || undefined })
      try { await db.tickets.update(id as string, { status: 'void' }) } catch { /* not cached */ }
      setVoidOpen(false)
      await loadTicket(id!)
    } catch (err: any) {
      alert(err?.message || 'Failed to void ticket')
    } finally {
      setDestructiveBusy(false)
    }
  }

  async function handleDeleteTicket({ reason }: { reason: string }) {
    setDestructiveBusy(true)
    try {
      await api.delete(`/tickets/${id}`, { reason })
      try {
        await db.tickets.delete(id as string)
        await db.ticketLineItems.where('ticketId').equals(id as string).delete()
        await db.ticketAttachments.where('ticketId').equals(id as string).delete()
      } catch { /* not cached */ }
      navigate('/tickets')
    } catch (err: any) {
      alert(err?.message || 'Failed to delete ticket')
      setDestructiveBusy(false)
    }
  }
  const [ticket, setTicket] = useState<TicketDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [expandedFitTest, setExpandedFitTest] = useState<string | null>(null)
  const [transitioning, setTransitioning] = useState(false)
  const [transitionError, setTransitionError] = useState('')
  // #13 QR self-sign-in (training classes)
  const [signinQr, setSigninQr] = useState<{ url: string; qrDataUrl: string } | null>(null)
  const [signinQrLoading, setSigninQrLoading] = useState(false)
  // Signature modal state
  const [showSignModal, setShowSignModal] = useState(false)
  const [signApproverEmail, setSignApproverEmail] = useState('')
  const [signApproverName, setSignApproverName] = useState('')
  const [signMessage, setSignMessage] = useState('')
  const [sendingForSign, setSendingForSign] = useState(false)
  useEffect(() => {
    if (!id) return
    loadTicket(id)
  }, [id])

  async function loadTicket(ticketId: string) {
    setLoading(true)
    setError('')

    // Try offline first
    let offline: TicketDetail | null = null
    try {
      const local = await db.tickets.get(ticketId)
      if (local) {
        // Build a partial detail from offline data
        const company = local.companyId ? await db.companies.get(local.companyId) : null
        const lineItems = await db.ticketLineItems.where('ticketId').equals(ticketId).toArray()
        const attachments = await db.ticketAttachments.where('ticketId').equals(ticketId).toArray()
        const fitTests = await db.fitTestRecords.where('ticketId').equals(ticketId).toArray()
        const ihTests = await db.ihTestRecords.where('ticketId').equals(ticketId).toArray()
        const trainingRoster = await db.trainingRosterRecords.where('ticketId').equals(ticketId).toArray()

        offline = {
          ...local,
          company: company ? { id: company.id, name: company.name, cashCcOnly: company.cashCcOnly } : null,
          lineItems: lineItems.map((li, i) => ({
            id: li.id,
            lineNumber: li.lineNumber ?? i + 1,
            lineType: li.lineType || 'misc_charge',
            description: li.description ?? null,
            quantity: String(li.quantity ?? 1),
            rate: li.rate != null ? String(li.rate) : null,
            total: li.total != null ? String(li.total) : null,
            unitOfMeasure: li.unitOfMeasure ?? null,
            serialNumberInstalled: li.serialNumberInstalled ?? null,
            serialNumberRemoved: li.serialNumberRemoved ?? null,
            testResult: li.testResult ?? null,
            calGasLotNumber: li.calGasLotNumber ?? null,
            sortOrder: li.sortOrder ?? i,
            notes: li.notes ?? null,
          })),
          attachments: attachments.map(a => ({
            id: a.id,
            fileName: a.fileName,
            fileType: a.fileType,
            filePath: a.filePath ?? null,
            mimeType: a.mimeType ?? null,
            uploadedAt: a.uploadedAt || '',
          })),
          fitTestRecords: fitTests.map(ft => ({
            id: ft.id,
            employeeName: ft.employeeName || '',
            employeeId: ft.employeeId ?? null,
            employerName: ft.employerName ?? null,
            jobTitle: (ft as any).jobTitle ?? null,
            respiratorMake: ft.respiratorMake ?? null,
            respiratorModel: ft.respiratorModel ?? null,
            respiratorSize: ft.respiratorSize ?? null,
            respiratorType: ft.respiratorType ?? null,
            testMethod: ft.testMethod ?? null,
            fitFactor: ft.fitFactor != null ? String(ft.fitFactor) : null,
            passFail: ft.passFail || 'pass',
            testDate: ft.testDate || '',
            notes: ft.notes ?? null,
            meqAccepted: (ft as any).meqAccepted ?? false,
            disclosureConditions: (ft as any).disclosureConditions ?? null,
            isCleanShaven: (ft as any).isCleanShaven ?? null,
            wearsGlassesContacts: (ft as any).wearsGlassesContacts ?? null,
            adverseReactions: (ft as any).adverseReactions ?? null,
            criteriaAcknowledged: (ft as any).criteriaAcknowledged ?? false,
            participantSignature: (ft as any).participantSignature ?? null,
          })),
          ihTestRecords: ihTests.map(r => ({
            id: r.id,
            testType: r.testType,
            locationPoint: r.locationPoint || null,
            instrumentModel: r.instrumentModel || null,
            instrumentSerial: r.instrumentSerial || null,
            testData: r.testData,
            notes: r.notes || null,
            testedAt: r.testedAt || null,
          })),
          trainingRosterRecords: trainingRoster.map(r => ({
            id: r.id,
            employeeName: r.employeeName || '',
            employeeId: r.employeeId || null,
            employerName: r.employerName || null,
            employerCompanyId: r.employerCompanyId || null,
            contactEmail: r.contactEmail || null,
            contactPhone: r.contactPhone || null,
            courseName: r.courseName || '',
            passed: r.passed ?? true,
            cardIssuedOnSite: r.cardIssuedOnSite ?? false,
            cardIssuedOfficial: r.cardIssuedOfficial ?? false,
            cardNumber: r.cardNumber || null,
            cardExpiryDate: r.cardExpiryDate || null,
            notes: r.notes || null,
            trainedAt: r.trainedAt || '',
          })),
        } as TicketDetail
      }
    } catch { /* offline not available */ }

    // Try API for richer data
    try {
      const data = await api.get<TicketDetail>(`/tickets/${ticketId}`)
      if (data && data.id) {
        setTicket(data)
        setLoading(false)
        return
      }
    } catch {
      // API failed — use offline
    }

    if (offline) {
      setTicket(offline)
    } else {
      setError('Ticket not found')
    }
    setLoading(false)
  }

  async function handleTransition(targetStatus: string) {
    if (!id || !ticket) return
    // "Send for Signature" requires a SignatureRequest row + email/eSign dispatch.
    // Open the modal instead of hitting the plain state machine endpoint.
    if (targetStatus === 'awaiting_signature') {
      const defaults = ticket.billingProfile?.signatureApprovers?.[0]
      setSignApproverEmail(defaults?.email || '')
      setSignApproverName(defaults?.name || '')
      setSignMessage('')
      setShowSignModal(true)
      return
    }
    setTransitioning(true)
    setTransitionError('')

    const previousStatus = ticket.status

    // Optimistic local update
    setTicket(prev => prev ? { ...prev, status: targetStatus } : prev)
    try {
      await db.tickets.update(id, { status: targetStatus, updatedAt: new Date().toISOString() })
    } catch { /* offline record may not exist */ }

    // Offline — skip the doomed network round-trip and queue immediately so the
    // transition is instant and reliably resyncs when connectivity returns.
    if (!navigator.onLine) {
      try {
        await db.mutationQueue.add({
          table: 'tickets' as const,
          action: 'update' as const,
          entityId: id,
          offlineId: ticket.offlineId || undefined,
          payload: { status: targetStatus },
          createdAt: new Date().toISOString(),
          status: 'pending' as const,
          retryCount: 0,
        })
        // Mark the local record pending so it shows the "Queued" badge and is
        // protected from the delta-sync orphan prune until this mutation lands.
        try { await db.tickets.update(id, { _offlineStatus: 'pending' }) } catch { /* */ }
        if (targetStatus === 'in_progress') { navigate(`/tickets/${id}/edit`); return }
      } catch {
        setTicket(prev => prev ? { ...prev, status: previousStatus } : prev)
        try { await db.tickets.update(id, { status: previousStatus }) } catch { /* */ }
        setTransitionError('Failed to queue transition')
      } finally {
        setTransitioning(false)
      }
      return
    }

    try {
      // Try the real API transition endpoint first
      await api.post(`/tickets/${id}/transition`, { targetStatus })
      // If transitioning to in_progress, navigate to edit so the tech can work the ticket
      if (targetStatus === 'in_progress') {
        navigate(`/tickets/${id}/edit`)
        return
      }
      // Reload full ticket data after transition
      loadTicket(id)
    } catch {
      // API unavailable — queue the status update for offline sync
      try {
        await db.mutationQueue.add({
          table: 'tickets' as const,
          action: 'update' as const,
          entityId: id,
          offlineId: ticket.offlineId || undefined,
          payload: { status: targetStatus },
          createdAt: new Date().toISOString(),
          status: 'pending' as const,
          retryCount: 0,
        })
        try { await db.tickets.update(id, { _offlineStatus: 'pending' }) } catch { /* */ }
        // Even offline, navigate to edit when starting work
        if (targetStatus === 'in_progress') {
          navigate(`/tickets/${id}/edit`)
          return
        }
      } catch (queueErr) {
        // Revert optimistic update
        setTicket(prev => prev ? { ...prev, status: previousStatus } : prev)
        try { await db.tickets.update(id, { status: previousStatus }) } catch { /* */ }
        setTransitionError('Failed to queue transition')
      }
    } finally {
      setTransitioning(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 text-slate-400 animate-spin" />
      </div>
    )
  }

  if (error || !ticket) {
    return (
      <div className="max-w-2xl mx-auto">
        <button onClick={() => navigate('/tickets')} className="flex items-center gap-2 text-slate-600 hover:text-slate-900 mb-4">
          <ArrowLeft className="w-5 h-5" /> Back
        </button>
        <div className="text-center py-12 text-slate-400">{error || 'Ticket not found'}</div>
      </div>
    )
  }

  const statusCfg = STATUS_CONFIG[ticket.status] || { label: ticket.status, color: 'bg-slate-100 text-slate-600' }
  const typeLabel = TICKET_TYPE_LABELS[ticket.ticketType] || ticket.ticketType
  const subtypeLabel = ticket.serviceSubtype ? SUBTYPE_LABELS[ticket.serviceSubtype] || ticket.serviceSubtype : null
  const isFitTest = ticket.serviceSubtype === 'fit_test'
  const wellIds = ticket.customData?.wellIds as string[] | undefined

  // Compute available transitions — prefer API data, fallback to client-side state machine
  const transitions = (ticket.availableTransitions && ticket.availableTransitions.length > 0)
    ? ticket.availableTransitions
    : (user?.role ? getAvailableTransitions(ticket.status, user.role) : [])

  const isOwnTicket = ticket.assignedTechId === user?.id || ticket.createdBy?.id === user?.id
  const showEdit = user?.role ? canEditTicket(ticket.status, user.role, isOwnTicket) : false

  return (
    <div className="max-w-2xl mx-auto pb-12">
      {/* Header */}
      <div className="flex items-start gap-3 mb-5">
        <button onClick={() => navigate('/tickets')} className="p-2 -ml-2 mt-0.5 text-slate-600 hover:text-slate-900">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-xl font-bold text-slate-900">
              {ticket.ticketNumber || 'Pending...'}
            </h1>
            <span className={cn('text-xs font-semibold px-2.5 py-1 rounded-full', statusCfg.color)}>
              {statusCfg.label}
            </span>
            {ticket._offlineStatus === 'pending' && (
              <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-amber-100 text-amber-700">
                Queued
              </span>
            )}
          </div>
          <p className="text-sm text-slate-500 mt-0.5">
            {typeLabel}{subtypeLabel ? ` \u00b7 ${subtypeLabel}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {can('tickets:cancel') && ticket.status !== 'void' && ticket._offlineStatus !== 'pending' && (
            <button
              type="button"
              onClick={() => setVoidOpen(true)}
              title="Void / mark dead (kept in All)"
              className="p-2 rounded-lg text-slate-400 hover:text-amber-600 hover:bg-amber-50"
            >
              <Ban className="w-4 h-4" />
            </button>
          )}
          {can('tickets:delete') && (
            <button
              type="button"
              onClick={() => setDeleteOpen(true)}
              title="Delete forever"
              className="p-2 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      <ConfirmDestructiveDialog
        open={voidOpen}
        mode="void"
        title={`Void ticket ${ticket.ticketNumber || ''}`}
        message="Marks the ticket dead \u2014 it stays visible in All but drops out of active/billing queues. Any pre-QuickBooks invoice it landed on is retracted."
        confirmLabel="Void ticket"
        busy={destructiveBusy}
        onConfirm={handleVoidTicket}
        onClose={() => setVoidOpen(false)}
      />
      <ConfirmDestructiveDialog
        open={deleteOpen}
        mode="delete"
        title={`Delete ticket ${ticket.ticketNumber || ''}`}
        message="Permanently removes this ticket and all its line items, records and attachments."
        busy={destructiveBusy}
        onConfirm={handleDeleteTicket}
        onClose={() => setDeleteOpen(false)}
      />

      {/* DEV: Status Override Toolbar — stripped from production builds by Vite, gated to platform_admin */}
      {import.meta.env.DEV && ticket && user?.role === 'platform_admin' && (
        <DevTicketStatusToolbar
          currentStatus={ticket.status}
          onOverride={async (status: string) => {
            setTransitioning(true)
            try {
              await api.patch(`/tickets/${id}/dev-override-status`, { status })
              await loadTicket(id!)
            } catch (e: any) {
              setTransitionError(`Dev override failed: ${e.message}`)
            } finally {
              setTransitioning(false)
            }
          }}
          disabled={transitioning}
        />
      )}

      {/* ---- Action Bar: Transitions + Edit ---- */}
      {(transitions.length > 0 || showEdit) && (
        <div className="flex flex-wrap items-center gap-2 mb-4">
          {/* Primary transitions first, then secondary */}
          {transitions
            .sort((a, b) => {
              const aLabel = TRANSITION_LABELS[`${ticket.status}→${a}`]
              const bLabel = TRANSITION_LABELS[`${ticket.status}→${b}`]
              // Primary transitions first
              return (bLabel?.primary ? 1 : 0) - (aLabel?.primary ? 1 : 0)
            })
            .map(target => {
              const key = `${ticket.status}→${target}`
              const config = TRANSITION_LABELS[key] || {
                label: target.replace('_', ' '),
                color: 'bg-slate-200 hover:bg-slate-300 text-slate-700',
                primary: false,
              }
              return (
                <button
                  key={target}
                  onClick={() => handleTransition(target)}
                  disabled={transitioning}
                  className={cn(
                    'px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50',
                    config.color,
                  )}
                >
                  {transitioning ? 'Updating...' : config.label}
                </button>
              )
            })}

          {showEdit && (
            <button
              onClick={() => navigate(`/tickets/${ticket.id}/edit`)}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-white border border-slate-300 text-slate-700 hover:bg-slate-50 transition-colors"
            >
              <Pencil className="w-3.5 h-3.5" />
              Edit
            </button>
          )}

          {/* Use as Template — only for ticket shapes the wizard handles.
              Skips rental (dispatch flow), sale (POS), and repair (shop intake). */}
          {(ticket.ticketType === 'field_service' ||
            ticket.ticketType === 'training' ||
            ticket.ticketType === 'inspection') && (
            <button
              onClick={() => navigate(`/tickets/new?template=${ticket.id}`)}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-white border border-slate-300 text-slate-700 hover:bg-slate-50 transition-colors"
              title="Start a new ticket pre-filled with this ticket's customer, location, and PO"
            >
              <Copy className="w-3.5 h-3.5" />
              Use as Template
            </button>
          )}

        </div>
      )}

      {/* PDF Export — always available */}
      <div className="flex gap-2 mb-4 justify-end">
        {/* Occ Health Report — full per-person fit test + audiometric detail */}
        {isFitTest && (ticket.fitTestRecords?.length ?? 0) > 0 && (
          <button
            onClick={async () => {
              try {
                const token = localStorage.getItem('sundog_token')
                const res = await fetch(`/api/tickets/${ticket.id}/occ-health-pdf`, {
                  headers: token ? { Authorization: `Bearer ${token}` } : {},
                })
                if (!res.ok) throw new Error('Occ Health report export failed')
                const blob = await res.blob()
                const url = URL.createObjectURL(blob)
                const a = document.createElement('a')
                a.href = url
                a.download = `occ-health-${ticket.ticketNumber || ticket.id}.pdf`
                a.click()
                URL.revokeObjectURL(url)
              } catch (e: any) {
                alert(e.message || 'Occ Health report export failed')
              }
            }}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-white border border-slate-300 text-slate-700 hover:bg-slate-50 transition-colors"
          >
            <FileDown className="w-3.5 h-3.5" />
            Occ Health Report
          </button>
        )}
        <button
          onClick={async () => {
            try {
              const token = localStorage.getItem('sundog_token')
              const res = await fetch(`/api/tickets/${ticket.id}/pdf`, {
                headers: token ? { Authorization: `Bearer ${token}` } : {},
              })
              if (!res.ok) throw new Error('PDF export failed')
              const blob = await res.blob()
              const url = URL.createObjectURL(blob)
              const a = document.createElement('a')
              a.href = url
              a.download = `ticket-${ticket.ticketNumber || ticket.id}.pdf`
              a.click()
              URL.revokeObjectURL(url)
            } catch (e: any) {
              alert(e.message || 'PDF export failed')
            }
          }}
          className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-white border border-slate-300 text-slate-700 hover:bg-slate-50 transition-colors"
        >
          <FileDown className="w-3.5 h-3.5" />
          Export PDF
        </button>
      </div>

      {transitionError && (
        <div className="mb-4 px-3 py-2 rounded-lg bg-red-50 text-red-700 text-sm">
          {transitionError}
        </div>
      )}

      {/* ---- Send for Signature Modal ---- */}
      {showSignModal && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl p-5 max-w-md w-full mx-4">
            <h3 className="text-base font-semibold text-slate-900 mb-3">Send Ticket for Signature</h3>
            <p className="text-sm text-slate-500 mb-3">The ticket PDF will be emailed to this person with a request to sign and return.</p>
            {(() => {
              const approvers = ticket.billingProfile?.signatureApprovers || []
              return approvers.length > 0 ? (
                <div className="mb-3">
                  <label className="text-xs font-medium text-slate-500 block mb-1">Select Approver</label>
                  <select
                    className="w-full text-sm rounded border border-slate-300 px-2.5 py-1.5"
                    value={signApproverEmail}
                    onChange={e => {
                      const selected = approvers.find(a => a.email === e.target.value)
                      setSignApproverEmail(e.target.value)
                      setSignApproverName(selected?.name || '')
                    }}
                  >
                    <option value="">-- Pick an approver --</option>
                    {approvers.map((a, i) => (
                      <option key={i} value={a.email}>{a.name} ({a.email})</option>
                    ))}
                  </select>
                  <p className="text-xs text-slate-400 mt-1">Or type a custom email below</p>
                </div>
              ) : null
            })()}
            <div className="space-y-2 mb-3">
              <input type="text" placeholder="Approver name" value={signApproverName} onChange={e => setSignApproverName(e.target.value)} className="w-full text-sm rounded border border-slate-300 px-2.5 py-1.5" />
              <input type="email" placeholder="Approver email" value={signApproverEmail} onChange={e => setSignApproverEmail(e.target.value)} className="w-full text-sm rounded border border-slate-300 px-2.5 py-1.5" />
              <textarea placeholder="Optional message" value={signMessage} onChange={e => setSignMessage(e.target.value)} rows={2} className="w-full text-sm rounded border border-slate-300 px-2.5 py-1.5" />
            </div>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setShowSignModal(false)} className="px-3 py-1.5 text-sm text-slate-600 hover:text-slate-800">Cancel</button>
              <button
                disabled={!signApproverEmail || sendingForSign}
                onClick={async () => {
                  setSendingForSign(true)
                  try {
                    await api.post('/signature-requests/send', {
                      type: 'ticket',
                      referenceId: id,
                      approverEmail: signApproverEmail,
                      approverName: signApproverName || undefined,
                      message: signMessage || undefined,
                    })
                    setShowSignModal(false)
                    if (id) await loadTicket(id)
                  } catch (err: any) {
                    alert(err?.message || 'Failed to send for signature')
                  } finally {
                    setSendingForSign(false)
                  }
                }}
                className="px-3 py-1.5 text-sm font-medium rounded bg-yellow-600 hover:bg-yellow-500 text-white disabled:opacity-50"
              >
                {sendingForSign ? 'Sending...' : 'Send for Signature'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="space-y-4">

        {/* ---- Customer & Location ---- */}
        <section className="bg-white rounded-lg border border-slate-200 p-4">
          <h3 className="font-semibold text-slate-900 text-sm mb-3 flex items-center gap-2">
            <MapPin className="w-4 h-4 text-slate-400" />
            Customer & Location
          </h3>
          <div className="space-y-1.5 text-sm">
            <p>
              <span className="text-slate-500">Customer:</span>{' '}
              <span className="font-medium">{ticket.company?.name || 'Unknown'}</span>
            </p>
            {ticket.locationDisplay && (
              <p>
                <span className="text-slate-500">Location:</span>{' '}
                <span className="font-medium">{ticket.locationDisplay}</span>
              </p>
            )}
            {!ticket.locationDisplay && (ticket.pad || ticket.well) && (
              <p>
                <span className="text-slate-500">Location:</span>{' '}
                <span className="font-medium">
                  {[ticket.pad?.name, ticket.well?.wellName].filter(Boolean).join(' > ')}
                </span>
              </p>
            )}
            {wellIds && wellIds.length > 1 && (
              <p>
                <span className="text-slate-500">Wells:</span>{' '}
                <span className="font-medium">{wellIds.length} wells on this pad</span>
              </p>
            )}
            {ticket.poNumber && (
              <p><span className="text-slate-500">PO/AFE:</span> <span className="font-medium">{ticket.poNumber}</span></p>
            )}
            {ticket.afeNumber && (
              <p><span className="text-slate-500">AFE:</span> <span className="font-medium">{ticket.afeNumber}</span></p>
            )}
          </div>
        </section>

        {/* ---- Date & Time ---- */}
        <section className="bg-white rounded-lg border border-slate-200 p-4">
          <h3 className="font-semibold text-slate-900 text-sm mb-3 flex items-center gap-2">
            <Calendar className="w-4 h-4 text-slate-400" />
            Date & Time
          </h3>
          <div className="space-y-1.5 text-sm">
            <p>
              <span className="text-slate-500">Service Date:</span>{' '}
              <span className="font-medium">{formatCalendarDateLong(ticket.serviceDate)}</span>
            </p>
            {ticket.arrivalTime && (
              <p>
                <span className="text-slate-500">Arrived:</span>{' '}
                <span className="font-medium">{formatTime(ticket.arrivalTime)}</span>
              </p>
            )}
            {ticket.departureTime && (
              <p>
                <span className="text-slate-500">Departed:</span>{' '}
                <span className="font-medium">{formatTime(ticket.departureTime)}</span>
              </p>
            )}
            {ticket.arrivalTime && ticket.departureTime && (
              <p>
                <span className="text-slate-500">Duration:</span>{' '}
                <span className="font-medium">
                  {(() => {
                    const mins = Math.round((new Date(ticket.departureTime).getTime() - new Date(ticket.arrivalTime!).getTime()) / 60000)
                    const h = Math.floor(mins / 60)
                    const m = mins % 60
                    return h > 0 ? `${h}h ${m}m` : `${m}m`
                  })()}
                </span>
              </p>
            )}
          </div>
        </section>

        {/* ---- Techs & People ---- */}
        <section className="bg-white rounded-lg border border-slate-200 p-4">
          <h3 className="font-semibold text-slate-900 text-sm mb-3 flex items-center gap-2">
            <User className="w-4 h-4 text-slate-400" />
            People
          </h3>
          <div className="space-y-1.5 text-sm">
            {ticket.assignedTech && (
              <p><span className="text-slate-500">Tech:</span> <span className="font-medium">{ticket.assignedTech.name}</span></p>
            )}
            {ticket.createdBy && (
              <p><span className="text-slate-500">Created by:</span> <span className="font-medium">{ticket.createdBy.name}</span></p>
            )}
            {ticket.customerRepName && (
              <p><span className="text-slate-500">Customer Rep:</span> <span className="font-medium">{ticket.customerRepName}</span></p>
            )}
          </div>
        </section>

        {/* ---- Notes ---- */}
        {(ticket.dispatchNotes || ticket.workDescription || ticket.internalNotes) && (
          <section className="bg-white rounded-lg border border-slate-200 p-4">
            <h3 className="font-semibold text-slate-900 text-sm mb-3 flex items-center gap-2">
              <FileText className="w-4 h-4 text-slate-400" />
              Notes
            </h3>
            <div className="space-y-3 text-sm">
              {ticket.dispatchNotes && (
                <div>
                  <p className="text-xs font-medium text-slate-500 mb-0.5">Dispatch Notes</p>
                  <p className="text-slate-700 whitespace-pre-wrap">{ticket.dispatchNotes}</p>
                </div>
              )}
              {ticket.workDescription && (
                <div>
                  <p className="text-xs font-medium text-slate-500 mb-0.5">Work Notes</p>
                  <p className="text-slate-700 whitespace-pre-wrap">{ticket.workDescription}</p>
                </div>
              )}
              {ticket.internalNotes && (
                <div>
                  <p className="text-xs font-medium text-slate-500 mb-0.5">Internal Notes</p>
                  <p className="text-slate-700 whitespace-pre-wrap">{ticket.internalNotes}</p>
                </div>
              )}
            </div>
          </section>
        )}

        {/* ---- Line Items ---- */}
        {ticket.lineItems && ticket.lineItems.length > 0 && (
          <section className="bg-white rounded-lg border border-slate-200 p-4">
            <h3 className="font-semibold text-slate-900 text-sm mb-3 flex items-center gap-2">
              <Package className="w-4 h-4 text-slate-400" />
              Products & Services
              <span className="text-slate-400 font-normal">({ticket.lineItems.length})</span>
            </h3>
            <div className="divide-y divide-slate-100">
              {ticket.lineItems.map((item, i) => (
                <div key={item.id} className="py-2 first:pt-0 last:pb-0">
                  <div className="flex items-start gap-2">
                    <span className="text-xs font-mono text-slate-400 w-5 pt-0.5">{i + 1}.</span>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-slate-900 text-sm">
                        {item.product?.name || item.description || item.lineType.replace('_', ' ')}
                      </p>
                      {item.product?.partNumber && (
                        <p className="text-xs text-slate-400">{item.product.partNumber}</p>
                      )}
                      {item.description && item.product?.name && (
                        <p className="text-xs text-slate-500 mt-0.5">{item.description}</p>
                      )}
                      <div className="flex flex-wrap gap-x-4 gap-y-0.5 mt-0.5 text-xs text-slate-500">
                        {item.serialNumberInstalled && <span>SN Install: {item.serialNumberInstalled}</span>}
                        {item.serialNumberRemoved && <span>SN Removed: {item.serialNumberRemoved}</span>}
                        {item.testResult && <span>Result: <span className={item.testResult === 'pass' ? 'text-green-600 font-medium' : 'text-red-600 font-medium'}>{item.testResult}</span></span>}
                        {item.calGasLotNumber && <span>Cal Gas: {item.calGasLotNumber}</span>}
                        {item.notes && <span>{item.notes}</span>}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-sm text-slate-700">x{item.quantity}</p>
                      {item.rate && <p className="text-xs text-slate-400">{formatCurrency(item.rate)}</p>}
                      {item.total && <p className="text-sm font-medium text-slate-900">{formatCurrency(item.total)}</p>}
                    </div>
                  </div>
                </div>
              ))}
            </div>
            {(ticket.subtotal || ticket.total) && (
              <div className="mt-3 pt-3 border-t border-slate-200 flex justify-end">
                <div className="text-right">
                  {ticket.subtotal && ticket.subtotal !== ticket.total && (
                    <p className="text-xs text-slate-500">Subtotal: {formatCurrency(ticket.subtotal)}</p>
                  )}
                  {ticket.total && (
                    <p className="text-sm font-bold text-slate-900">Total: {formatCurrency(ticket.total)}</p>
                  )}
                </div>
              </div>
            )}
          </section>
        )}

        {/* ---- Cash/Card-only: collect card payment ---- */}
        {ticket.company?.cashCcOnly && (
          <CashCcPaymentPanel
            ticketId={ticket.id}
            ticketNumber={ticket.ticketNumber}
            amount={parseFloat(ticket.total || '0') || 0}
          />
        )}

        {/* ---- Fit Test Records ---- */}
        {isFitTest && ticket.fitTestRecords && ticket.fitTestRecords.length > 0 && (
          <section className="bg-white rounded-lg border border-slate-200 p-4">
            <h3 className="font-semibold text-slate-900 text-sm mb-3 flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-slate-400" />
              Occ Health Records
              <span className="text-slate-400 font-normal">({ticket.fitTestRecords.length})</span>
              {(() => {
                const pass = ticket.fitTestRecords!.filter(r => r.passFail === 'pass').length
                const fail = ticket.fitTestRecords!.filter(r => r.passFail === 'fail').length
                return (
                  <>
                    {pass > 0 && <span className="text-green-600 text-xs font-medium">{pass} pass</span>}
                    {fail > 0 && <span className="text-red-600 text-xs font-medium">{fail} fail</span>}
                  </>
                )
              })()}
            </h3>
            <div className="space-y-2">
              {ticket.fitTestRecords.map((ft) => {
                const isExpanded = expandedFitTest === ft.id
                const respType = ft.respiratorType ? ft.respiratorType.replace('_', ' ') : ''
                const hasDisclosure = ft.disclosureConditions && Array.isArray(ft.disclosureConditions) && ft.disclosureConditions.length > 0

                return (
                  <div key={ft.id} className="border border-slate-100 rounded-lg overflow-hidden">
                    <button
                      type="button"
                      onClick={() => setExpandedFitTest(isExpanded ? null : ft.id)}
                      className="w-full flex items-center gap-3 p-3 hover:bg-slate-50 transition-colors"
                    >
                      {ft.passFail === 'pass' ? (
                        <CheckCircle className="w-5 h-5 text-green-500 shrink-0" />
                      ) : (
                        <XCircle className="w-5 h-5 text-red-500 shrink-0" />
                      )}
                      <div className="flex-1 min-w-0 text-left">
                        <p className="font-medium text-slate-900 text-sm">{ft.employeeName}</p>
                        <p className="text-xs text-slate-500">
                          {[ft.employerName, respType, ft.respiratorMake, ft.respiratorSize].filter(Boolean).join(' \u00b7 ')}
                        </p>
                      </div>
                      <span className={cn(
                        'text-xs font-semibold px-2 py-0.5 rounded-full',
                        ft.passFail === 'pass' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700',
                      )}>
                        {ft.passFail === 'pass' ? 'PASS' : 'FAIL'}
                      </span>
                      <ChevronRight className={cn('w-4 h-4 text-slate-400 transition-transform', isExpanded && 'rotate-90')} />
                    </button>

                    {isExpanded && (
                      <div className="px-3 pb-3 pt-1 border-t border-slate-100 space-y-2 text-sm">
                        <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                          {ft.employeeId && <p><span className="text-slate-500">Employee ID:</span> {ft.employeeId}</p>}
                          {ft.jobTitle && <p><span className="text-slate-500">Title:</span> {ft.jobTitle}</p>}
                          {ft.respiratorMake && <p><span className="text-slate-500">Make:</span> {ft.respiratorMake}</p>}
                          {ft.respiratorModel && <p><span className="text-slate-500">Model:</span> {ft.respiratorModel}</p>}
                          {ft.respiratorSize && <p><span className="text-slate-500">Size:</span> {ft.respiratorSize}</p>}
                          {ft.testMethod && <p><span className="text-slate-500">Method:</span> {ft.testMethod.replace('_', ' ')}</p>}
                          {ft.fitFactor && <p><span className="text-slate-500">Fit Factor:</span> {ft.fitFactor}</p>}
                          {(ft as any).respiratorClass && <p><span className="text-slate-500">Class:</span> {String((ft as any).respiratorClass).toUpperCase()}</p>}
                          {ft.meqAccepted && (
                            <p className="text-blue-700 font-medium">
                              MEQ Current{(ft as any).meqDate ? ` — ${formatCalendarDateNumeric((ft as any).meqDate)}` : ''}
                            </p>
                          )}
                        </div>
                        {(ft as any).secondMask && (() => {
                          const m2 = (ft as any).secondMask
                          return (
                            <p className="text-slate-600">
                              <span className="text-slate-500">2nd mask:</span>{' '}
                              {[m2.respiratorType?.replace('_', ' '), m2.respiratorClass?.toUpperCase(), m2.make, m2.model, m2.size,
                                m2.fitFactor != null ? `FF ${m2.fitFactor}` : null].filter(Boolean).join(' · ')}
                            </p>
                          )
                        })()}
                        {ft.notes && <p className="text-slate-600"><span className="text-slate-500">Notes:</span> {ft.notes}</p>}

                        {/* Disclosure summary */}
                        {hasDisclosure && (
                          <div className="mt-2 pt-2 border-t border-slate-100">
                            <p className="text-xs font-semibold text-slate-700 mb-1">Disclosure</p>
                            <div className="text-xs text-slate-500 space-y-0.5">
                              <p>
                                Conditions: {ft.disclosureConditions!.length}/{DISCLOSURE_CONDITIONS.length} acknowledged
                              </p>
                              {ft.isCleanShaven !== null && (
                                <p>Clean shaven: {ft.isCleanShaven ? 'Yes' : 'No'}</p>
                              )}
                              {ft.wearsGlassesContacts !== null && (
                                <p>Glasses/contacts: {ft.wearsGlassesContacts ? 'Yes' : 'No'}</p>
                              )}
                              {ft.adverseReactions && ft.adverseReactions.length > 0 && (
                                <p className="text-orange-600">
                                  Adverse reactions: {ft.adverseReactions.map(k => ADVERSE_REACTIONS.find(a => a.key === k)?.label || k).join(', ')}
                                </p>
                              )}
                              <p>{ft.criteriaAcknowledged ? 'Criteria acknowledged' : 'Criteria NOT acknowledged'}</p>
                            </div>
                          </div>
                        )}

                        {/* Participant signature */}
                        {ft.participantSignature && (
                          <div className="mt-2">
                            <p className="text-xs font-semibold text-slate-700 mb-1">Participant Signature</p>
                            <img src={ft.participantSignature} alt="Signature" className="h-16 border border-slate-200 rounded bg-white" />
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </section>
        )}

        {/* ---- IH Test Records ---- */}
        {ticket.ihTestRecords && ticket.ihTestRecords.length > 0 && (
          <section className="bg-white rounded-lg border border-slate-200 p-4">
            <h3 className="font-semibold text-slate-900 text-sm mb-3 flex items-center gap-2">
              <FlaskConical className="w-4 h-4 text-slate-400" />
              IH Test Records
              <span className="text-slate-400 font-normal">({ticket.ihTestRecords.length})</span>
            </h3>
            <div className="space-y-3">
              {ticket.ihTestRecords.map((rec) => {
                const subtypeLabel = SUBTYPE_LABELS[rec.testType] || rec.testType
                return (
                  <div key={rec.id} className="border border-slate-200 rounded-lg p-3">
                    <div className="flex items-center justify-between mb-2">
                      <span className="font-medium text-slate-900 text-sm">{subtypeLabel}</span>
                      {rec.testedAt && (
                        <span className="text-xs text-slate-400">{formatDate(rec.testedAt)}</span>
                      )}
                    </div>

                    {/* Location / Instrument info */}
                    <div className="text-xs text-slate-600 space-y-0.5 mb-2">
                      {rec.locationPoint && <p><span className="text-slate-400">Location:</span> {rec.locationPoint}</p>}
                      {rec.instrumentModel && <p><span className="text-slate-400">Instrument:</span> {rec.instrumentModel}{rec.instrumentSerial ? ` (S/N: ${rec.instrumentSerial})` : ''}</p>}
                    </div>

                    {/* Subtype-specific data rendering */}
                    {rec.testType === 'ih_h2s' && rec.testData?.readings && (
                      <div className="mt-2">
                        <p className="text-xs font-semibold text-slate-700 mb-1">H₂S Readings</p>
                        <div className="space-y-1">
                          {rec.testData.readings.map((r: any, i: number) => (
                            <div key={r.id || i} className="flex items-center gap-2 text-xs">
                              <span className="text-slate-500 w-24 truncate">{r.locationPoint || `Point ${i + 1}`}</span>
                              <span className="font-mono">{r.ppmReading ?? '—'} PPM</span>
                              {r.backgroundPpm != null && <span className="text-slate-400">(bg: {r.backgroundPpm})</span>}
                              {r.durationMinutes && <span className="text-slate-400">{r.durationMinutes} min</span>}
                              <span className={cn('px-1.5 py-0.5 rounded font-medium',
                                r.result === 'pass' ? 'bg-green-100 text-green-700' :
                                r.result === 'fail' ? 'bg-red-100 text-red-700' : 'bg-slate-100 text-slate-500'
                              )}>{r.result?.toUpperCase() || 'N/A'}</span>
                            </div>
                          ))}
                        </div>
                        {rec.testData.weatherConditions && (
                          <p className="text-xs text-slate-400 mt-1">Weather: {rec.testData.weatherConditions}{rec.testData.windDirection ? `, ${rec.testData.windDirection}` : ''}{rec.testData.temperature != null ? `, ${rec.testData.temperature}°F` : ''}</p>
                        )}
                      </div>
                    )}

                    {rec.testType === 'ih_o2_voc' && rec.testData?.samplePoints && (
                      <div className="mt-2">
                        <p className="text-xs font-semibold text-slate-700 mb-1">O₂/VOC Sample Points</p>
                        <div className="space-y-1">
                          {rec.testData.samplePoints.map((sp: any, i: number) => (
                            <div key={sp.id || i} className="flex items-center gap-2 text-xs">
                              <span className="text-slate-500 w-24 truncate">{sp.pointName || `Point ${i + 1}`}</span>
                              {sp.o2Percent != null && <span className="font-mono">O₂: {sp.o2Percent}%</span>}
                              {sp.vocPpm != null && <span className="font-mono">VOC: {sp.vocPpm} PPM</span>}
                              {sp.notes && <span className="text-slate-400 truncate">{sp.notes}</span>}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {rec.testType === 'ih_sampling' && rec.testData?.samples && (
                      <div className="mt-2">
                        <p className="text-xs font-semibold text-slate-700 mb-1">Samples</p>
                        <div className="space-y-1">
                          {rec.testData.samples.map((s: any, i: number) => (
                            <div key={s.id || i} className="text-xs">
                              <div className="flex items-center gap-2">
                                <span className="font-medium text-slate-700">{s.sampleType || 'Sample'}</span>
                                <span className="text-slate-400">@ {s.collectionPoint || '—'}</span>
                              </div>
                              <div className="flex items-center gap-2 text-slate-400 ml-2">
                                {s.labId && <span>Lab ID: {s.labId}</span>}
                                {s.deliveryDate && <span>Delivered: {formatDate(s.deliveryDate)}</span>}
                              </div>
                              {s.notes && <p className="text-slate-400 ml-2">{s.notes}</p>}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {rec.testType === 'ih_audiometric' && rec.testData?.personnel && (
                      <div className="mt-2">
                        <p className="text-xs font-semibold text-slate-700 mb-1">Personnel ({rec.testData.personnel.length})</p>
                        <div className="space-y-1">
                          {rec.testData.personnel.map((p: any, i: number) => (
                            <div key={p.id || i} className="flex items-center gap-2 text-xs">
                              <span className="text-slate-700 font-medium">{p.employeeName || '—'}</span>
                              {p.employeeId && <span className="text-slate-400">#{p.employeeId}</span>}
                              {p.employerName && <span className="text-slate-400">({p.employerName})</span>}
                              <span className={cn('px-1.5 py-0.5 rounded font-medium',
                                p.result === 'pass' ? 'bg-green-100 text-green-700' :
                                p.result === 'fail' ? 'bg-red-100 text-red-700' :
                                p.result === 'referred' ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-500'
                              )}>{p.result === 'referred' ? 'Referred' : p.result?.toUpperCase() || 'N/A'}</span>
                              {p.notes && <span className="text-slate-400 truncate">{p.notes}</span>}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {rec.notes && <p className="text-xs text-slate-600 mt-2"><span className="text-slate-400">Notes:</span> {rec.notes}</p>}
                  </div>
                )
              })}
            </div>
          </section>
        )}

        {/* ---- #13 QR self-sign-in (open training classes) ---- */}
        {ticket.ticketType === 'training' && ['draft', 'dispatched', 'in_progress'].includes(ticket.status) && (
          <section className="bg-white rounded-lg border border-slate-200 p-4">
            <h3 className="font-semibold text-slate-900 text-sm mb-1 flex items-center gap-2">
              <GraduationCap className="w-4 h-4 text-slate-400" />
              Student Sign-In
            </h3>
            <p className="text-xs text-slate-500 mb-3">
              Students scan the QR on their phone and sign in with name + signature — straight onto the roster.
            </p>
            {signinQr ? (
              <div className="flex flex-col sm:flex-row items-center gap-4">
                <img src={signinQr.qrDataUrl} alt="Sign-in QR code" className="w-44 h-44 border border-slate-200 rounded-lg" />
                <div className="flex-1 min-w-0 space-y-2 text-center sm:text-left">
                  <p className="text-xs font-mono text-slate-500 break-all">{signinQr.url}</p>
                  <div className="flex gap-2 justify-center sm:justify-start">
                    <button
                      type="button"
                      onClick={() => { navigator.clipboard?.writeText(signinQr.url) }}
                      className="px-3 py-1.5 text-xs font-medium border border-slate-300 rounded-lg text-slate-600 hover:bg-slate-50"
                    >
                      Copy link
                    </button>
                    <button
                      type="button"
                      onClick={() => loadTicket(ticket.id)}
                      className="px-3 py-1.5 text-xs font-medium border border-slate-300 rounded-lg text-slate-600 hover:bg-slate-50"
                    >
                      Refresh roster ({ticket.trainingRosterRecords?.length ?? 0})
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <button
                type="button"
                disabled={signinQrLoading}
                onClick={async () => {
                  setSigninQrLoading(true)
                  try {
                    const r = await api.post<{ url: string; qrDataUrl: string }>(`/train/link/${ticket.id}`, {})
                    setSigninQr(r)
                  } catch {
                    // class closed or offline — leave button
                  }
                  setSigninQrLoading(false)
                }}
                className="px-4 py-2 rounded-lg bg-blue-700 text-white text-sm font-medium hover:bg-blue-600 disabled:opacity-50"
              >
                {signinQrLoading ? 'Generating…' : 'Generate sign-in QR'}
              </button>
            )}
          </section>
        )}

        {/* ---- Training Roster ---- */}
        {ticket.trainingRosterRecords && ticket.trainingRosterRecords.length > 0 && (
          <section className="bg-white rounded-lg border border-slate-200 p-4">
            <h3 className="font-semibold text-slate-900 text-sm mb-3 flex items-center gap-2">
              <GraduationCap className="w-4 h-4 text-slate-400" />
              Training Roster
              <span className="text-slate-400 font-normal">
                ({ticket.trainingRosterRecords.length})
              </span>
            </h3>

            {/* Group by employer for display */}
            {(() => {
              const grouped = new Map<string, typeof ticket.trainingRosterRecords>()
              for (const rec of ticket.trainingRosterRecords!) {
                const key = rec.employerName || 'Unknown'
                if (!grouped.has(key)) grouped.set(key, [])
                grouped.get(key)!.push(rec)
              }
              return Array.from(grouped.entries()).map(([employer, recs]) => (
                <div key={employer} className="mb-3 last:mb-0">
                  <p className="text-xs font-semibold text-slate-500 mb-1">
                    {employer} ({recs!.length})
                  </p>
                  <div className="space-y-1">
                    {recs!.map(rec => (
                      <div key={rec.id} className="flex items-center gap-2 text-sm py-1">
                        <span className="flex-1">
                          {rec.employeeName}
                          {rec.employeeId && <span className="text-xs text-slate-400 ml-1">#{rec.employeeId}</span>}
                        </span>
                        <span className={cn('text-xs font-medium px-2 py-0.5 rounded-full',
                          rec.passed ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700',
                        )}>
                          {rec.passed ? 'PASS' : 'FAIL'}
                        </span>
                        {rec.cardIssuedOnSite && (
                          <span className="text-xs text-blue-600">Card On-Site</span>
                        )}
                        {!rec.cardIssuedOnSite && rec.cardIssuedOfficial && (
                          <span className="text-xs text-green-600">Card Issued</span>
                        )}
                        {!rec.cardIssuedOnSite && !rec.cardIssuedOfficial && (
                          <span className="text-xs text-amber-600">Card Pending</span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))
            })()}

            {/* Course info from customData */}
            {ticket.customData && (ticket.customData as any)?.courseName && (
              <p className="text-xs text-slate-400 mt-2 pt-2 border-t border-slate-100">
                Course: {(ticket.customData as any).courseName === 'Other'
                  ? (ticket.customData as any).courseOther
                  : (ticket.customData as any).courseName}
              </p>
            )}
          </section>
        )}

        {/* ---- Attachments / Photos ---- */}
        {ticket.attachments && ticket.attachments.length > 0 && (
          <section className="bg-white rounded-lg border border-slate-200 p-4">
            <h3 className="font-semibold text-slate-900 text-sm mb-3 flex items-center gap-2">
              <Camera className="w-4 h-4 text-slate-400" />
              Attachments
              <span className="text-slate-400 font-normal">({ticket.attachments.length})</span>
            </h3>
            <div className="grid grid-cols-3 gap-2">
              {ticket.attachments.map(att => (
                <div key={att.id} className="aspect-square bg-slate-100 rounded-lg overflow-hidden flex items-center justify-center text-xs text-slate-400">
                  {att.filePath ? (
                    <img src={att.filePath} alt={att.fileName} className="w-full h-full object-cover" />
                  ) : (
                    <div className="text-center p-2">
                      <Camera className="w-6 h-6 mx-auto mb-1" />
                      <p className="truncate">{att.fileName}</p>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}

        {/* ---- Signatures ---- */}
        {(ticket.customerRepSignature || ticket.techSignature) && (
          <section className="bg-white rounded-lg border border-slate-200 p-4">
            <h3 className="font-semibold text-slate-900 text-sm mb-3">Signatures</h3>
            <div className="grid grid-cols-2 gap-4">
              {ticket.customerRepSignature && (
                <div>
                  <p className="text-xs text-slate-500 mb-1">Customer</p>
                  <img src={ticket.customerRepSignature} alt="Customer signature" className="h-20 w-full object-contain border border-slate-200 rounded bg-white" />
                </div>
              )}
              {ticket.techSignature && (
                <div>
                  <p className="text-xs text-slate-500 mb-1">Tech</p>
                  <img src={ticket.techSignature} alt="Tech signature" className="h-20 w-full object-contain border border-slate-200 rounded bg-white" />
                </div>
              )}
            </div>
          </section>
        )}

        {/* ---- Billing ---- */}
        {ticket.ticketNumber && (
          <section className="bg-white rounded-lg border border-slate-200 p-4">
            <h3 className="font-semibold text-slate-900 text-sm mb-3">Billing</h3>
            <BillingLineagePanel
              identifier={ticket.ticketNumber}
              readiness={{
                ticketId: ticket.id,
                billingReadiness: ticket.billingReadiness,
                billingReadinessReasonCode: ticket.billingReadinessReasonCode,
                onUpdated: (patch) => setTicket((t) => (t ? { ...t, ...patch } : t)),
              }}
            />
          </section>
        )}

        {/* ---- Metadata ---- */}
        <section className="bg-slate-50 rounded-lg border border-slate-200 p-4 text-xs text-slate-400">
          <div className="flex flex-wrap gap-x-6 gap-y-1">
            <span>ID: {ticket.id.slice(0, 8)}</span>
            <span>Created: {formatDate(ticket.createdAt)}</span>
            {ticket.completedAt && <span>Completed: {formatDate(ticket.completedAt)}</span>}
            {ticket.offlineCreated && <span className="text-amber-500">Offline created</span>}
          </div>
        </section>

      </div>
    </div>
  )
}

// ---- Dev-only status override toolbar ----
const TICKET_STATUSES = [
  'draft', 'dispatched', 'in_progress', 'completed',
  'supervisor_review', 'awaiting_signature', 'billing_queue', 'invoiced', 'closed',
] as const

function DevTicketStatusToolbar({
  currentStatus,
  onOverride,
  disabled,
}: {
  currentStatus: string
  onOverride: (status: string) => void
  disabled: boolean
}) {
  const [open, setOpen] = useState(false)

  return (
    <div className="border-2 border-dashed border-amber-400 bg-amber-50 rounded-lg p-3 mb-4">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 text-xs font-bold text-amber-700 uppercase tracking-wide"
      >
        <span className="bg-amber-500 text-white px-1.5 py-0.5 rounded text-[10px]">DEV</span>
        Status Override
        <ChevronDown className={cn('w-3 h-3 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="flex flex-wrap gap-1.5 mt-2">
          {TICKET_STATUSES.map(s => (
            <button
              key={s}
              onClick={() => onOverride(s)}
              disabled={disabled || s === currentStatus}
              className={cn(
                'px-2.5 py-1 rounded text-xs font-medium transition-colors',
                s === currentStatus
                  ? 'bg-amber-300 text-amber-900 cursor-default'
                  : 'bg-white border border-amber-300 text-amber-800 hover:bg-amber-100 disabled:opacity-50',
              )}
            >
              {s.replace(/_/g, ' ')}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
