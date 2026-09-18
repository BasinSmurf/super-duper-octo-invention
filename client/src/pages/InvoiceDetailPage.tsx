import { useState, useEffect, useMemo, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { api } from '@/lib/api'
import { cn } from '@/lib/cn'
import { formatCalendarDate } from '@/lib/dates'
import { useAuth } from '@/contexts/AuthContext'
import { usePermissions } from '@/contexts/PermissionsContext'
import { ConfirmDestructiveDialog } from '@/components/ConfirmDestructiveDialog'
import { InvoiceLineEditor, type EditableLineItem } from '@/components/InvoiceLineEditor'
import { BillingLineagePanel } from '@/components/BillingLineagePanel'
import {
  ArrowLeft,
  Loader2,
  CheckCircle2,
  Send,
  XCircle,
  FileText,
  DollarSign,
  Clock,
  ArrowRight,
  AlertTriangle,
  User,
  Calendar,
  Hash,
  Pencil,
  Save,
  X,
  Download,
  RefreshCw,
  ChevronDown,
  Zap,
  Trash2,
  Undo2,
} from 'lucide-react'

interface InvoiceLineItem {
  id: string
  lineNumber: number
  description: string
  productId: string | null
  partNumber: string | null
  quantity: number | string
  unitOfMeasure: string | null
  rate: number | string
  amount: number | string
  isTaxable: boolean
  sourceTicketId: string | null
  sourceTicketNumber: string | null
  sourceShopItemId: string | null
  sourceRentalItemId: string | null
  qbItemFullName: string | null
  qbItemListId: string | null
  notes: string | null
  sortOrder: number
  product?: {
    id: string
    partNumber: string
    name: string
    qbItemListId: string | null
    qbItemFullName: string | null
  } | null
}

interface TaxRate {
  id: string
  name: string
  rate: number | string
}

interface InvoiceDetail {
  id: string
  invoiceNumber: string
  status: string
  sourceType: string
  companyId: string
  companyName: string
  poNumber: string | null
  afeNumber: string | null
  costCenter: string | null
  invoiceDate: string
  dueDate: string | null
  periodStart: string | null
  periodEnd: string | null
  subtotal: number | string
  taxAmount: number | string
  taxJurisdictionId: string | null
  taxRate: number | string
  total: number | string
  notes: string | null
  internalNotes: string | null
  qbSalesOrderTxnId: string | null
  qbSalesOrderNumber: string | null
  qbSalesOrderPushedAt: string | null
  qbInvoiceTxnId: string | null
  qbInvoiceNumber: string | null
  qbInvoiceCreatedAt: string | null
  sourceModifiedAfterSync: boolean
  rejectionReason: string | null
  signatureStatus?: string
  signatureRequest?: {
    id: string
    status: string
    sentToEmail: string
    sentToName: string | null
    sendCount: number
    firstSentAt: string
    lastSentAt: string
  } | null
  createdAt: string
  updatedAt: string
  company?: {
    id: string
    name: string
    billingProfiles?: Array<{
      id: string
      buyerDuns: string | null
      buyerSiteUuid: string | null
      buyerDunsPlus4: string | null
      buyerCode: string | null
      supplierDuns: string | null
      supplierSiteDunsPlus4: string | null
      defaultOrderedByName: string | null
      defaultAfeNumber: string | null
      defaultCostCenter: string | null
      defaultPoNumber: string | null
      defaultServiceApprover: string | null
      defaultPriceBookNumber: string | null
      enverusReceiptMode: string | null
      signatureRequired: string | null
      signatureApprovers: { name: string; email: string }[] | null
    }>
  } | null
  billingGroup?: { id: string; groupKey: string; periodStart: string; periodEnd: string } | null
  approvedBy?: { id: string; name: string } | null
  rejectedBy?: { id: string; name: string } | null
  createdBy?: { id: string; name: string } | null
  lineItems: InvoiceLineItem[]
  locationSummary?: {
    locations: Array<{
      display: string
      ticketNumber?: string
      wellName?: string
      padName?: string
      fieldName?: string
      apiNumber?: string
    }>
  }
}

const STATUS_CONFIG: Record<string, { label: string; color: string; bgColor: string; icon: any }> = {
  draft: { label: 'Draft', color: 'text-slate-600', bgColor: 'bg-slate-100', icon: FileText },
  approved: { label: 'Approved', color: 'text-blue-700', bgColor: 'bg-blue-100', icon: CheckCircle2 },
  awaiting_signature: { label: 'Awaiting Signature', color: 'text-yellow-700', bgColor: 'bg-yellow-100', icon: FileText },
  queued: { label: 'QB Queued', color: 'text-amber-700', bgColor: 'bg-amber-100', icon: Clock },
  so_created: { label: 'Sales Order Created', color: 'text-purple-700', bgColor: 'bg-purple-100', icon: Send },
  invoiced: { label: 'Invoiced', color: 'text-green-700', bgColor: 'bg-green-100', icon: DollarSign },
  sent: { label: 'Sent', color: 'text-emerald-700', bgColor: 'bg-emerald-100', icon: Send },
  paid: { label: 'Paid', color: 'text-emerald-800', bgColor: 'bg-emerald-200', icon: CheckCircle2 },
  void: { label: 'Voided', color: 'text-red-700', bgColor: 'bg-red-100', icon: XCircle },
}

const SOURCE_LABELS: Record<string, string> = {
  billing_group: 'Field Tickets',
  shop_work_order: 'Shop Work Order',
  rental_agreement: 'Rental Agreement',
  manual: 'Manual Entry',
}

export function InvoiceDetailPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { user } = useAuth()
  const { can } = usePermissions()
  const [invoice, setInvoice] = useState<InvoiceDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState(false)
  const [voidOpen, setVoidOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editLines, setEditLines] = useState<EditableLineItem[]>([])
  const [saving, setSaving] = useState(false)
  const [taxRates, setTaxRates] = useState<TaxRate[]>([])
  const [updatingTax, setUpdatingTax] = useState(false)
  const [queueErrors, setQueueErrors] = useState<{ customer?: string; unmappedLines: string[] } | null>(null)
  // Signature state
  const [showSignModal, setShowSignModal] = useState(false)
  const [signApproverEmail, setSignApproverEmail] = useState('')
  const [signApproverName, setSignApproverName] = useState('')
  const [signMessage, setSignMessage] = useState('')
  const [sendingForSign, setSendingForSign] = useState(false)

  useEffect(() => {
    loadInvoice()
  }, [id])

  useEffect(() => {
    api.get<{ data: TaxRate[] }>('/sales-tax-rates?activeOnly=1')
      .then(res => setTaxRates(res.data))
      .catch(() => { /* dropdown just won't populate */ })
  }, [])

  async function handleChangeTaxJurisdiction(taxJurisdictionId: string) {
    if (!invoice) return
    setUpdatingTax(true)
    try {
      await api.patch(`/invoices/${invoice.id}/tax-jurisdiction`, {
        taxJurisdictionId: taxJurisdictionId || null,
      })
      await loadInvoice()
    } catch (err: any) {
      alert(err?.message || 'Failed to update tax jurisdiction')
    }
    setUpdatingTax(false)
  }

  async function loadInvoice() {
    try {
      const data = await api.get<InvoiceDetail>(`/invoices/${id}`)
      setInvoice(data)
    } catch {
      // handle error
    }
    setLoading(false)
  }

  function formatMoney(val: string | number | null | undefined): string {
    const n = typeof val === 'string' ? parseFloat(val) : (val || 0)
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n)
  }

  function formatDate(d: string | null | undefined): string {
    if (!d) return '-'
    return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  }

  async function handleApprove() {
    if (!invoice) return
    setActionLoading(true)
    try {
      await api.patch(`/invoices/${invoice.id}/approve`, {})
      await loadInvoice()
    } catch (err: any) {
      alert(err?.message || 'Failed to approve')
    }
    setActionLoading(false)
  }

  async function handleQueue() {
    if (!invoice) return
    setActionLoading(true)
    setQueueErrors(null)
    try {
      // Use fetch directly to parse structured validation errors
      const token = localStorage.getItem('sundog_token')
      const res = await fetch(`/api/invoices/${invoice.id}/queue`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: '{}',
      })
      if (res.ok) {
        await loadInvoice()
      } else {
        const body = await res.json().catch(() => ({}))
        if (body.validationErrors) {
          setQueueErrors(body.validationErrors)
        } else {
          alert(body.error || 'Failed to queue')
        }
      }
    } catch (err: any) {
      alert(err?.message || 'Failed to queue')
    }
    setActionLoading(false)
  }

  async function handleUnqueue() {
    if (!invoice) return
    setActionLoading(true)
    try {
      await api.patch(`/invoices/${invoice.id}/unqueue`, {})
      await loadInvoice()
    } catch (err: any) {
      alert(err?.message || 'Failed to pull back')
    }
    setActionLoading(false)
  }

  async function handleReject() {
    if (!invoice) return
    const reason = prompt('Rejection reason (optional):')
    if (reason === null) return
    setActionLoading(true)
    try {
      await api.patch(`/invoices/${invoice.id}/reject`, { reason })
      await loadInvoice()
    } catch (err: any) {
      alert(err?.message || 'Failed to reject')
    }
    setActionLoading(false)
  }

  async function handleVoid({ reason, override }: { reason: string; override: boolean }) {
    if (!invoice) return
    setActionLoading(true)
    try {
      const res = await api.patch<{ warnings?: string[] }>(`/invoices/${invoice.id}/void`, { reason: reason || undefined, override })
      if (res?.warnings?.length) alert(res.warnings.join('\n'))
      setVoidOpen(false)
      await loadInvoice()
    } catch (err: any) {
      alert(err?.message || 'Failed to void')
    }
    setActionLoading(false)
  }

  async function handleDelete({ reason, override }: { reason: string; override: boolean }) {
    if (!invoice) return
    setActionLoading(true)
    try {
      const res = await api.delete<{ warnings?: string[] }>(`/invoices/${invoice.id}`, { reason, override })
      if (res?.warnings?.length) alert(res.warnings.join('\n'))
      navigate('/billing')
    } catch (err: any) {
      alert(err?.message || 'Failed to delete')
      setActionLoading(false)
    }
  }

  function startEditing() {
    if (!invoice) return
    setEditLines(
      invoice.lineItems
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map(li => ({
          id: li.id,
          description: li.description,
          productId: li.productId,
          partNumber: li.partNumber,
          qbItemFullName: li.qbItemFullName,
          qbItemListId: li.qbItemListId,
          quantity: typeof li.quantity === 'string' ? parseFloat(li.quantity) : li.quantity,
          unitOfMeasure: li.unitOfMeasure || 'EA',
          rate: typeof li.rate === 'string' ? parseFloat(li.rate) : li.rate,
          amount: typeof li.amount === 'string' ? parseFloat(li.amount) : li.amount,
          isTaxable: li.isTaxable,
          sourceTicketId: li.sourceTicketId,
          sourceTicketNumber: li.sourceTicketNumber,
          sourceShopItemId: li.sourceShopItemId,
          sourceRentalItemId: li.sourceRentalItemId,
          notes: li.notes,
        }))
    )
    setEditing(true)
  }

  async function handleSaveLines() {
    if (!invoice) return
    setSaving(true)
    try {
      await api.put(`/invoices/${invoice.id}/line-items`, {
        lineItems: editLines.map(li => ({
          description: li.description,
          productId: li.productId,
          partNumber: li.partNumber,
          quantity: li.quantity,
          unitOfMeasure: li.unitOfMeasure,
          rate: li.rate,
          amount: li.amount,
          isTaxable: li.isTaxable,
          sourceTicketId: li.sourceTicketId,
          sourceTicketNumber: li.sourceTicketNumber,
          sourceShopItemId: li.sourceShopItemId,
          sourceRentalItemId: li.sourceRentalItemId,
          qbItemFullName: li.qbItemFullName,
          qbItemListId: li.qbItemListId,
          notes: li.notes,
        })),
      })
      setEditing(false)
      await loadInvoice()
    } catch (err: any) {
      alert(err?.message || 'Failed to save line items')
    }
    setSaving(false)
  }

  async function handleDownloadPdf() {
    if (!invoice) return
    try {
      const token = localStorage.getItem('sundog_token')
      const res = await fetch(`/api/invoices/${invoice.id}/pdf`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      if (!res.ok) throw new Error('PDF generation failed')
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `invoice-${invoice.invoiceNumber}.pdf`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (err: any) {
      alert(err?.message || 'Failed to generate PDF')
    }
  }

  // QB mapping warning for draft invoices
  const unmappedBillableCount = useMemo(() => {
    if (!invoice || invoice.status !== 'draft') return 0
    return invoice.lineItems.filter(
      li => parseFloat(String(li.amount)) > 0 && !li.qbItemFullName
    ).length
  }, [invoice])

  // Enverus billing profile (if company has one)
  const enverusProfile = invoice?.company?.billingProfiles?.[0] || null

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 text-slate-400 animate-spin" />
      </div>
    )
  }

  if (!invoice) {
    return (
      <div className="text-center py-20">
        <p className="text-slate-400">Invoice not found</p>
        <button onClick={() => navigate('/billing')} className="mt-4 text-blue-600 text-sm hover:underline">
          Back to Billing
        </button>
      </div>
    )
  }

  const status = STATUS_CONFIG[invoice.status] || { label: invoice.status, color: 'text-slate-600', bgColor: 'bg-slate-100', icon: FileText }
  const StatusIcon = status.icon
  const lineItems = invoice.lineItems.sort((a, b) => a.sortOrder - b.sortOrder)
  // A line is informational (rendered in the notes area) ONLY when it's a
  // genuine auto-generated note — no product, no part number, zero quantity
  // (e.g. training / fit-test attendee lists). Real item & labor lines ALWAYS
  // render as line items, even at $0 — never strip them between ticket and
  // billing on account of a zero or unresolved amount.
  const isNoteLine = (li: typeof lineItems[number]) =>
    !li.productId && !li.partNumber && (parseFloat(String(li.quantity)) || 0) === 0
  const billableLines = lineItems.filter(li => !isNoteLine(li))
  const noteLines = lineItems.filter(isNoteLine)

  return (
    <div className="max-w-3xl mx-auto">
      {/* Back button */}
      <button
        onClick={() => navigate('/billing')}
        className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-700 mb-4"
      >
        <ArrowLeft className="w-4 h-4" />
        Back to Billing
      </button>

      {/* Header */}
      <div className="bg-white rounded-lg border border-slate-200 p-5 mb-4">
        <div className="flex items-start justify-between mb-3">
          <div>
            <h1 className="text-xl font-bold text-slate-900">{invoice.invoiceNumber}</h1>
            <p className="text-sm text-slate-500 mt-0.5">
              {SOURCE_LABELS[invoice.sourceType] || invoice.sourceType}
            </p>
          </div>
          <span className={cn(
            'flex items-center gap-1.5 text-sm font-medium px-3 py-1 rounded-full',
            status.bgColor, status.color,
          )}>
            <StatusIcon className="w-4 h-4" />
            {status.label}
          </span>
        </div>

        {/* Modified warning */}
        {invoice.sourceModifiedAfterSync && (
          <div className="flex items-center gap-2 mb-3 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-700">
            <AlertTriangle className="w-4 h-4 flex-shrink-0" />
            Source data modified after this invoice was created
          </div>
        )}

        {/* Rejection reason — only meaningful while the invoice is back in draft;
            approve clears these fields, but guard against stale data on older invoices */}
        {invoice.rejectionReason && invoice.status === 'draft' && (
          <div className="flex items-center gap-2 mb-3 px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
            <XCircle className="w-4 h-4 flex-shrink-0" />
            Rejected: {invoice.rejectionReason}
          </div>
        )}

        {/* Key details grid */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
          <div>
            <p className="text-xs text-slate-400 mb-0.5">Customer</p>
            <p className="font-medium text-slate-900">{invoice.companyName}</p>
          </div>
          <div>
            <p className="text-xs text-slate-400 mb-0.5">Invoice Date</p>
            <p className="font-medium text-slate-900">{formatCalendarDate(invoice.invoiceDate)}</p>
          </div>
          <div>
            <p className="text-xs text-slate-400 mb-0.5">Total</p>
            <p className="font-bold text-lg text-slate-900">{formatMoney(invoice.total)}</p>
          </div>
          {invoice.poNumber && (
            <div>
              <p className="text-xs text-slate-400 mb-0.5">PO Number</p>
              <p className="font-medium text-slate-900">{invoice.poNumber}</p>
            </div>
          )}
          {invoice.afeNumber && (
            <div>
              <p className="text-xs text-slate-400 mb-0.5">AFE Number</p>
              <p className="font-medium text-slate-900">{invoice.afeNumber}</p>
            </div>
          )}
          {invoice.costCenter && (
            <div>
              <p className="text-xs text-slate-400 mb-0.5">Cost Center</p>
              <p className="font-medium text-slate-900">{invoice.costCenter}</p>
            </div>
          )}
          {invoice.periodStart && invoice.periodEnd && (
            <div>
              <p className="text-xs text-slate-400 mb-0.5">Service Period</p>
              <p className="font-medium text-slate-900">
                {formatCalendarDate(invoice.periodStart)} - {formatCalendarDate(invoice.periodEnd)}
              </p>
            </div>
          )}
          {invoice.dueDate && (
            <div>
              <p className="text-xs text-slate-400 mb-0.5">Due Date</p>
              <p className="font-medium text-slate-900">{formatCalendarDate(invoice.dueDate)}</p>
            </div>
          )}
        </div>

        {/* Location info */}
        {invoice.locationSummary && invoice.locationSummary.locations.length > 0 && (
          <div className="mt-4 pt-3 border-t border-slate-100">
            <p className="text-xs text-slate-400 mb-2">Location</p>
            <div className="space-y-1.5">
              {invoice.locationSummary.locations.map((loc, i) => (
                <div key={i} className="flex items-center gap-2 text-sm">
                  <span className="font-medium text-slate-900">{loc.display}</span>
                  {loc.apiNumber && (
                    <span className="text-[10px] font-mono text-slate-400">API# {loc.apiNumber}</span>
                  )}
                  {loc.ticketNumber && (
                    <span className="text-[10px] text-slate-400">from {loc.ticketNumber}</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* QB tracking */}
        {(invoice.qbSalesOrderNumber || invoice.qbInvoiceNumber) && (
          <div className="mt-4 pt-3 border-t border-slate-100">
            <p className="text-xs text-slate-400 mb-2">QuickBooks</p>
            <div className="flex items-center gap-2 text-sm">
              {invoice.qbSalesOrderNumber && (
                <span className="px-2 py-1 bg-purple-50 text-purple-700 rounded font-medium">
                  SO# {invoice.qbSalesOrderNumber}
                </span>
              )}
              {invoice.qbSalesOrderNumber && invoice.qbInvoiceNumber && (
                <ArrowRight className="w-4 h-4 text-slate-300" />
              )}
              {invoice.qbInvoiceNumber && (
                <span className="px-2 py-1 bg-green-50 text-green-700 rounded font-medium">
                  INV# {invoice.qbInvoiceNumber}
                </span>
              )}
            </div>
            {invoice.qbSalesOrderPushedAt && (
              <p className="text-xs text-slate-400 mt-1">
                SO pushed {formatDate(invoice.qbSalesOrderPushedAt)}
                {invoice.qbInvoiceCreatedAt && ` | Invoice created ${formatDate(invoice.qbInvoiceCreatedAt)}`}
              </p>
            )}
          </div>
        )}

        {/* Billing lineage — mirrored facts (source + as-of), separate from
            the ServicePRO-owned SO#/INV# cache above */}
        <div className="mt-4 pt-3 border-t border-slate-100">
          <BillingLineagePanel identifier={invoice.invoiceNumber} />
        </div>

        {/* Created by / Approved by */}
        <div className="mt-4 pt-3 border-t border-slate-100 flex items-center gap-4 text-xs text-slate-400">
          {invoice.createdBy && (
            <span className="flex items-center gap-1">
              <User className="w-3 h-3" />
              Created by {invoice.createdBy.name}
            </span>
          )}
          {invoice.approvedBy && (
            <span className="flex items-center gap-1">
              <CheckCircle2 className="w-3 h-3" />
              Approved by {invoice.approvedBy.name}
            </span>
          )}
          <span className="flex items-center gap-1">
            <Calendar className="w-3 h-3" />
            {formatDate(invoice.createdAt)}
          </span>
        </div>
      </div>

      {/* QB mapping warning for drafts (when not editing) */}
      {!editing && unmappedBillableCount > 0 && (
        <div className="flex items-center gap-2 mb-4 px-4 py-2.5 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-700">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          {unmappedBillableCount} billable line{unmappedBillableCount > 1 ? 's' : ''} missing QuickBooks item mapping — edit lines to fix before pushing to QB
        </div>
      )}

      {/* Line Items Table */}
      <div className="bg-white rounded-lg border border-slate-200 overflow-hidden mb-4">
        <div className="px-5 py-3 border-b border-slate-100 bg-slate-50 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-700">
            Line Items ({lineItems.length})
          </h2>
          {invoice.status === 'draft' && !editing && (
            <button
              onClick={startEditing}
              className="flex items-center gap-1.5 text-xs text-blue-600 hover:text-blue-800 font-medium"
            >
              <Pencil className="w-3.5 h-3.5" />
              Edit Lines
            </button>
          )}
          {editing && (
            <div className="flex items-center gap-2">
              <button
                onClick={handleSaveLines}
                disabled={saving}
                className="flex items-center gap-1 text-xs px-3 py-1.5 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 font-medium"
              >
                <Save className="w-3.5 h-3.5" />
                {saving ? 'Saving...' : 'Save Changes'}
              </button>
              <button
                onClick={() => setEditing(false)}
                disabled={saving}
                className="flex items-center gap-1 text-xs px-3 py-1.5 border border-slate-300 rounded-md hover:bg-slate-50 text-slate-600 font-medium"
              >
                <X className="w-3.5 h-3.5" />
                Cancel
              </button>
            </div>
          )}
        </div>

        {editing ? (
          <div className="p-4">
            <InvoiceLineEditor lineItems={editLines} onChange={setEditLines} />
          </div>
        ) : lineItems.length === 0 ? (
          <div className="text-center py-8 text-slate-400 text-sm">
            No line items
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {/* Header row */}
            <div className="hidden sm:grid grid-cols-12 gap-2 px-5 py-2 text-xs text-slate-400 font-medium bg-slate-50/50">
              <div className="col-span-1">#</div>
              <div className="col-span-5">Description</div>
              <div className="col-span-2 text-right">Qty</div>
              <div className="col-span-2 text-right">Rate</div>
              <div className="col-span-2 text-right">Amount</div>
            </div>

            {/* Billable lines */}
            {billableLines.map(li => {
              const qty = typeof li.quantity === 'string' ? parseFloat(li.quantity) : li.quantity
              const rate = typeof li.rate === 'string' ? parseFloat(li.rate) : li.rate
              const amount = typeof li.amount === 'string' ? parseFloat(li.amount) : li.amount

              return (
                <div key={li.id} className="px-5 py-3">
                  {/* Desktop */}
                  <div className="hidden sm:grid grid-cols-12 gap-2 items-start">
                    <div className="col-span-1 text-xs text-slate-400">{li.lineNumber}</div>
                    <div className="col-span-5">
                      <p className="text-sm text-slate-900">{li.description}</p>
                      <div className="flex items-center gap-2 mt-0.5">
                        {li.partNumber && (
                          <span className="text-[10px] px-1.5 py-0.5 bg-slate-100 text-slate-500 rounded font-mono">
                            {li.partNumber}
                          </span>
                        )}
                        {li.qbItemFullName && (
                          <span className="text-[10px] px-1.5 py-0.5 bg-purple-50 text-purple-500 rounded font-mono">
                            QB: {li.qbItemFullName}
                          </span>
                        )}
                        {li.sourceTicketNumber && (
                          <span className="text-[10px] text-slate-400">
                            from {li.sourceTicketNumber}
                          </span>
                        )}
                        {li.notes && (
                          <span className="text-[10px] text-slate-400 italic">{li.notes}</span>
                        )}
                      </div>
                    </div>
                    <div className="col-span-2 text-right text-sm text-slate-700">
                      {qty} {li.unitOfMeasure || 'EA'}
                    </div>
                    <div className="col-span-2 text-right text-sm text-slate-700">
                      {formatMoney(rate)}
                    </div>
                    <div className="col-span-2 text-right text-sm font-medium text-slate-900">
                      {formatMoney(amount)}
                    </div>
                  </div>

                  {/* Mobile */}
                  <div className="sm:hidden">
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <p className="text-sm text-slate-900">{li.description}</p>
                        <div className="flex items-center gap-2 mt-0.5">
                          {li.partNumber && (
                            <span className="text-[10px] px-1.5 py-0.5 bg-slate-100 text-slate-500 rounded font-mono">
                              {li.partNumber}
                            </span>
                          )}
                        </div>
                      </div>
                      <p className="text-sm font-medium text-slate-900 ml-4">{formatMoney(amount)}</p>
                    </div>
                    <p className="text-xs text-slate-400 mt-0.5">
                      {qty} {li.unitOfMeasure || 'EA'} @ {formatMoney(rate)}
                    </p>
                  </div>
                </div>
              )
            })}

            {/* Informational note lines (rosters / attendee lists) */}
            {noteLines.map(li => (
              <div key={li.id} className="px-5 py-2 bg-slate-50/50">
                <div className="flex items-start gap-2">
                  <Hash className="w-3.5 h-3.5 text-slate-300 mt-0.5 flex-shrink-0" />
                  <div>
                    <p className="text-xs text-slate-500 italic">{li.description}</p>
                    {li.notes && <p className="text-[10px] text-slate-400 mt-0.5">{li.notes}</p>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Totals */}
        <div className="border-t border-slate-200 px-5 py-3 bg-slate-50">
          <div className="flex justify-end">
            <div className="w-72 space-y-1">
              <div className="flex justify-between text-sm text-slate-600">
                <span>Subtotal</span>
                <span>{formatMoney(invoice.subtotal)}</span>
              </div>

              {/* Tax jurisdiction — editable on drafts, read-only otherwise */}
              {invoice.status === 'draft' ? (
                <div className="flex justify-between items-center text-sm text-slate-600 gap-2">
                  <select
                    value={invoice.taxJurisdictionId || ''}
                    onChange={e => handleChangeTaxJurisdiction(e.target.value)}
                    disabled={updatingTax}
                    className="flex-1 text-xs px-2 py-1 border border-slate-200 rounded bg-white focus:ring-1 focus:ring-blue-500 outline-none disabled:opacity-50"
                    title="Sales tax jurisdiction (where the deliverable was received)"
                  >
                    <option value="">No sales tax</option>
                    {taxRates.map(r => (
                      <option key={r.id} value={r.id}>{r.name}</option>
                    ))}
                  </select>
                  <span className="whitespace-nowrap">{formatMoney(invoice.taxAmount)}</span>
                </div>
              ) : parseFloat(String(invoice.taxAmount)) > 0 ? (
                <div className="flex justify-between text-sm text-slate-600">
                  <span>Sales Tax{Number(invoice.taxRate) > 0 ? ` (${(Number(invoice.taxRate) * 100).toFixed(2).replace(/\.?0+$/, '')}%)` : ''}</span>
                  <span>{formatMoney(invoice.taxAmount)}</span>
                </div>
              ) : null}

              <div className="flex justify-between text-base font-bold text-slate-900 pt-1 border-t border-slate-200">
                <span>Total</span>
                <span>{formatMoney(invoice.total)}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Notes */}
      {(invoice.notes || invoice.internalNotes) && (
        <div className="bg-white rounded-lg border border-slate-200 p-5 mb-4">
          {invoice.notes && (
            <div className="mb-3">
              <p className="text-xs text-slate-400 mb-1">Notes</p>
              <p className="text-sm text-slate-700 whitespace-pre-wrap">{invoice.notes}</p>
            </div>
          )}
          {invoice.internalNotes && (
            <div>
              <p className="text-xs text-slate-400 mb-1">Internal Notes</p>
              <p className="text-sm text-slate-700 whitespace-pre-wrap">{invoice.internalNotes}</p>
            </div>
          )}
        </div>
      )}

      {/* QB Validation Errors */}
      {queueErrors && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg">
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-5 h-5 text-red-600 mt-0.5 shrink-0" />
            <div className="flex-1">
              <p className="text-sm font-medium text-red-800 mb-1">Cannot push to QuickBooks</p>
              {queueErrors.customer && (
                <p className="text-sm text-red-700">{queueErrors.customer}</p>
              )}
              {queueErrors.unmappedLines.length > 0 && (
                <ul className="text-sm text-red-700 mt-1 space-y-0.5">
                  {queueErrors.unmappedLines.map((err, i) => (
                    <li key={i}>{err}</li>
                  ))}
                </ul>
              )}
              <p className="text-xs text-red-600 mt-2">
                Edit line items to fix QB mappings before pushing.
              </p>
            </div>
            <button onClick={() => setQueueErrors(null)} className="text-red-400 hover:text-red-600 text-lg leading-none">&times;</button>
          </div>
        </div>
      )}

      {/* Enverus Submission Panel */}
      {enverusProfile && invoice.status !== 'draft' && invoice.status !== 'void' && (
        <EnverusPanel
          invoiceId={invoice.id}
          profile={enverusProfile}
          invoice={invoice}
          onSubmitted={loadInvoice}
        />
      )}

      {/* DEV: Status Override Toolbar — stripped from production builds by Vite, gated to platform_admin */}
      {import.meta.env.DEV && invoice && user?.role === 'platform_admin' && (
        <DevStatusToolbar
          currentStatus={invoice.status}
          onOverride={async (status: string) => {
            setActionLoading(true)
            try {
              await api.patch(`/invoices/${invoice.id}/dev-override-status`, { status })
              await loadInvoice()
            } catch (e: any) {
              alert(`Dev override failed: ${e.message}`)
            } finally {
              setActionLoading(false)
            }
          }}
          disabled={actionLoading}
        />
      )}

      {/* Action Buttons */}
      <div className="bg-white rounded-lg border border-slate-200 p-4 flex items-center gap-3 flex-wrap">
        {invoice.status === 'draft' && (
          <>
            <button
              onClick={handleApprove}
              disabled={actionLoading}
              className="flex items-center gap-1.5 px-4 py-2 bg-blue-800 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
            >
              <CheckCircle2 className="w-4 h-4" />
              Approve
            </button>
            <button
              onClick={handleReject}
              disabled={actionLoading}
              className="flex items-center gap-1.5 px-4 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
            >
              Reject
            </button>
          </>
        )}
        {invoice.status === 'approved' && (
          <>
            <button
              onClick={handleQueue}
              disabled={actionLoading}
              className="flex items-center gap-1.5 px-4 py-2 bg-purple-700 text-white rounded-lg text-sm font-medium hover:bg-purple-600 disabled:opacity-50"
            >
              <Send className="w-4 h-4" />
              Push to QB
            </button>
            {(() => {
              const profile = invoice.company?.billingProfiles?.[0]
              const sigReq = profile?.signatureRequired
              return (sigReq === 'invoice' || sigReq === 'both') ? (
                <button
                  onClick={() => setShowSignModal(true)}
                  className="flex items-center gap-1.5 px-4 py-2 bg-yellow-600 text-white rounded-lg text-sm font-medium hover:bg-yellow-500"
                >
                  <FileText className="w-4 h-4" />
                  Send for Signature
                </button>
              ) : null
            })()}
            <button
              onClick={handleReject}
              disabled={actionLoading}
              className="flex items-center gap-1.5 px-4 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
              title="Un-approve: send back to draft for editing (frees the source tickets back to the Ready queue)"
            >
              <Undo2 className="w-4 h-4" />
              Return to Draft
            </button>
          </>
        )}
        {invoice.status === 'queued' && (
          <button
            onClick={handleUnqueue}
            disabled={actionLoading}
            className="flex items-center gap-1.5 px-4 py-2 border border-amber-300 rounded-lg text-sm font-medium text-amber-700 hover:bg-amber-50 disabled:opacity-50"
            title="Pull this invoice back out of the QuickBooks queue (only works if QBWC hasn't transmitted it yet)"
          >
            <Undo2 className="w-4 h-4" />
            Pull back from QB queue
          </button>
        )}
        {invoice.status === 'awaiting_signature' && (
          <div className="flex items-center gap-2 text-sm text-yellow-700">
            <FileText className="w-4 h-4" />
            <span className="font-medium">Awaiting Signature</span>
            <span className="text-xs text-yellow-600">— resolve in Signature Queue</span>
            <button
              onClick={() => setShowSignModal(true)}
              className="ml-2 px-3 py-1 text-xs font-medium rounded bg-yellow-600 hover:bg-yellow-500 text-white"
            >
              Resend
            </button>
          </div>
        )}
        {invoice.status !== 'draft' && invoice.status !== 'void' && (
          <button
            onClick={handleDownloadPdf}
            className="flex items-center gap-1.5 px-4 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-600 hover:bg-slate-50"
          >
            <Download className="w-4 h-4" />
            Generate PDF
          </button>
        )}
        {can('invoices:cancel') && invoice.status !== 'void' && (
          <button
            onClick={() => setVoidOpen(true)}
            disabled={actionLoading}
            className="ml-auto flex items-center gap-1.5 px-3 py-2 text-sm text-red-500 hover:text-red-700 hover:bg-red-50 rounded-lg"
          >
            <XCircle className="w-4 h-4" />
            Void Invoice
          </button>
        )}
        {can('invoices:delete') && (
          <button
            onClick={() => setDeleteOpen(true)}
            disabled={actionLoading}
            className={cn(
              'flex items-center gap-1.5 px-3 py-2 text-sm text-red-600 border border-red-200 rounded-lg hover:bg-red-50',
              !can('invoices:cancel') || invoice.status === 'void' ? 'ml-auto' : '',
            )}
          >
            <Trash2 className="w-4 h-4" />
            Delete
          </button>
        )}
        {actionLoading && <Loader2 className="w-4 h-4 text-slate-400 animate-spin" />}
      </div>

      <ConfirmDestructiveDialog
        open={voidOpen}
        mode="void"
        title={`Void invoice ${invoice.invoiceNumber}`}
        message="Voids this invoice. If it hasn't reached QuickBooks, its source tickets are released back to the billing queue."
        confirmLabel="Void invoice"
        showOverride
        overrideLabel="Override: void even if paid (reconcile the payment in QuickBooks manually)."
        busy={actionLoading}
        onConfirm={handleVoid}
        onClose={() => setVoidOpen(false)}
      />
      <ConfirmDestructiveDialog
        open={deleteOpen}
        mode="delete"
        title={`Delete invoice ${invoice.invoiceNumber}`}
        message="Permanently removes this invoice and its line items. Source tickets are released back to the billing queue."
        showOverride
        overrideLabel="Override: delete even if it has reached QuickBooks (reverse it there manually)."
        busy={actionLoading}
        onConfirm={handleDelete}
        onClose={() => setDeleteOpen(false)}
      />

      {/* ---- Send for Signature Modal ---- */}
      {showSignModal && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl p-5 max-w-md w-full mx-4">
            <h3 className="text-base font-semibold text-slate-900 mb-3">Send Invoice for Signature</h3>
            <p className="text-sm text-slate-500 mb-3">The invoice PDF will be emailed to this person with a request to print, sign, and return.</p>
            {(() => {
              const approvers = invoice.company?.billingProfiles?.[0]?.signatureApprovers || []
              return approvers.length > 0 ? (
                <div className="mb-3">
                  <label className="text-xs font-medium text-slate-500 block mb-1">Select Approver</label>
                  <select
                    className="w-full text-sm rounded border border-slate-300 px-2.5 py-1.5"
                    value={signApproverEmail}
                    onChange={e => {
                      const selected = approvers.find((a: any) => a.email === e.target.value)
                      setSignApproverEmail(e.target.value)
                      setSignApproverName(selected?.name || '')
                    }}
                  >
                    <option value="">-- Pick an approver --</option>
                    {approvers.map((a: any, i: number) => (
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
                      type: 'invoice',
                      referenceId: invoice.id,
                      approverEmail: signApproverEmail,
                      approverName: signApproverName || undefined,
                      message: signMessage || undefined,
                    })
                    setShowSignModal(false)
                    await loadInvoice()
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
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Enverus Submission Panel
// ─────────────────────────────────────────────────────────────────────────────

interface EnverusPanelProps {
  invoiceId: string
  profile: NonNullable<InvoiceDetail['company']>['billingProfiles'] extends (infer T)[] | undefined ? NonNullable<T> : never
  invoice: InvoiceDetail
  onSubmitted: () => void
}

/** Generic fetchable-dropdown field state. */
interface FetchableField<T> {
  items: T[]
  loading: boolean
  open: boolean
}

/**
 * Shape shared by /enverus/invoices/status and /enverus/field-tickets/status.
 * enverusLiveData is present only on the OT path, which actually re-polls
 * Enverus; the OI path answers from our own record plus queue history.
 */
interface EnverusStatus {
  invoiceId: string
  invoiceNumber: string | null
  enverusReceiptId: string | null
  enverusStatus: string | null
  enverusSubmittedAt: string | null
  enverusLiveData?: Record<string, unknown> | null
  // Whole queue rows come back; the error column is `errorMessage` and the
  // attempt counter is `retryCount`.
  queueHistory: Array<{
    id: string
    status: string
    action: string | null
    retryCount?: number | null
    errorMessage?: string | null
    createdAt: string
  }>
}

/** Status → badge colours. Anything unrecognised stays neutral rather than green. */
const ENVERUS_STATUS_TONE: Record<string, string> = {
  accepted: 'bg-green-50 border-green-200 text-green-700',
  approved: 'bg-green-50 border-green-200 text-green-700',
  submitted: 'bg-blue-50 border-blue-200 text-blue-700',
  queued: 'bg-blue-50 border-blue-200 text-blue-700',
  disputed: 'bg-red-50 border-red-200 text-red-700',
  rejected: 'bg-red-50 border-red-200 text-red-700',
  cancelled: 'bg-slate-100 border-slate-300 text-slate-600',
  error: 'bg-red-50 border-red-200 text-red-700',
}

function EnverusPanel({ invoiceId, profile, invoice, onSubmitted }: EnverusPanelProps) {
  const buyerDuns = profile.buyerDuns || ''

  // Determine submission mode: openticket (PIDX XML) vs openinvoice (JSON receipt)
  const mode = profile.enverusReceiptMode as string
  const isOT = mode === 'openticket' || mode === 'both'
  const isOI = mode === 'openinvoice' || mode === 'both'
  // When 'both', show a toggle. Default to OT if available.
  const [activeMode, setActiveMode] = useState<'ot' | 'oi'>(isOT ? 'ot' : 'oi')
  const useOT = activeMode === 'ot'

  // Form state — pre-filled from profile defaults / invoice fields
  const [receiptType, setReceiptType] = useState('General')
  const [orderedByName, setOrderedByName] = useState(
    useOT
      ? (profile.defaultServiceApprover || '')
      : (profile.defaultOrderedByName || '')
  )
  const [afeNumber, setAfeNumber] = useState(invoice.afeNumber || profile.defaultAfeNumber || '')
  const [costCenter, setCostCenter] = useState(invoice.costCenter || profile.defaultCostCenter || '')
  const [poNumber, setPoNumber] = useState(invoice.poNumber || profile.defaultPoNumber || '')
  const [contractNumber, setContractNumber] = useState(profile.defaultPriceBookNumber || '')

  // COP "Activity Code" (→ line.major) and "Functional Area" (→ line.minor).
  // Standard Enverus line fields. Auto-fill from the profile defaults, editable/
  // clearable per invoice (some invoices shouldn't carry them).
  const [major, setMajor] = useState((profile as any).defaultMajor || '')
  const [minor, setMinor] = useState((profile as any).defaultMinor || '')

  // Per-buyer display labels for the relabeled line fields (fall back to generic).
  const lineFieldLabels = ((profile as any).lineFieldLabels || {}) as Record<string, string>
  const afeLabel = lineFieldLabels.afeNumber || 'AFE / Facility'
  const costCenterLabel = lineFieldLabels.costCenter || 'Cost Center'
  const majorLabel = lineFieldLabels.major || 'Activity Code'
  const minorLabel = lineFieldLabels.minor || 'Functional Area'

  // Additional data fields (buyer-specific, e.g. COP Invoice Approver / Line-Item
  // Category). Pre-filled from profile defaults, editable per submission. Keeps
  // itemID and any extra keys so they round-trip to Enverus intact.
  const [additionalFields, setAdditionalFields] = useState<Array<{ code?: string; name: string; value: string; itemID?: string; [k: string]: any }>>(
    () => {
      const defaults = (profile as any).defaultAdditionalDataFields as Array<{ code?: string; name: string; value: string; itemID?: string }> | null
      return defaults?.length ? defaults.map(f => ({ ...f })) : []
    }
  )
  const [showAddFields, setShowAddFields] = useState(false)

  // Fetchable dropdown states
  const [reqs, setReqs] = useState<FetchableField<string>>({ items: [], loading: false, open: false })
  const [afeList, setAfeList] = useState<FetchableField<{ number: string; desc: string }>>({ items: [], loading: false, open: false })
  const [ccList, setCcList] = useState<FetchableField<{ number: string; desc: string }>>({ items: [], loading: false, open: false })
  const [poList, setPoList] = useState<FetchableField<{ number: string; desc: string }>>({ items: [], loading: false, open: false })

  // Submission state
  const [submitting, setSubmitting] = useState(false)
  const [submitResult, setSubmitResult] = useState<{ ok: boolean; message: string } | null>(null)

  // ── Status polling ──────────────────────────────────────────────────────
  // The submit endpoints have always had status counterparts and nothing ever
  // called them, so "did Enverus accept it?" was unanswerable from here — you
  // submitted, got an ack, and then waited to be told otherwise.
  //
  // OT polls Enverus live (field-tickets/status re-reads the receipt and
  // writes back an approved/disputed change); OI returns our cached status plus
  // queue history. Two endpoints because they are genuinely different: only one
  // of them talks to Enverus.
  const [status, setStatus] = useState<EnverusStatus | null>(null)
  const [statusLoading, setStatusLoading] = useState(false)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [showHistory, setShowHistory] = useState(false)

  // Generic fetcher for master data
  async function fetchMasterData<T>(
    endpoint: string,
    setter: React.Dispatch<React.SetStateAction<FetchableField<T>>>,
    mapper: (raw: any[]) => T[],
  ) {
    if (!buyerDuns) return
    setter(prev => ({ ...prev, loading: true }))
    try {
      const data = await api.get<{ data: any[] }>(`/enverus/master-data/${endpoint}/${buyerDuns}`)
      const items = mapper(data.data || [])
      setter({ items, loading: false, open: true })
    } catch (err: any) {
      alert(`Failed to fetch ${endpoint}: ${err?.message || 'Unknown error'}`)
      setter(prev => ({ ...prev, loading: false }))
    }
  }

  const fetchRequisitioners = useCallback(() => fetchMasterData<string>(
    'requisitioners', setReqs,
    raw => raw.map(r => r.formattedName || r.name || '').filter(Boolean).sort()
  ), [buyerDuns])

  const fetchAfes = useCallback(() => fetchMasterData(
    'afes', setAfeList,
    raw => raw.map(a => ({
      number: a.afeNumber || a.number || a.afeCode || '',
      desc: a.description || a.afeDescription || a.name || '',
    })).filter(a => a.number)
  ), [buyerDuns])

  const fetchCostCenters = useCallback(() => fetchMasterData(
    'cost-centers', setCcList,
    raw => raw.map(c => ({
      number: c.costCenterNumber || c.number || c.code || '',
      desc: c.description || c.name || '',
    })).filter(c => c.number)
  ), [buyerDuns])

  const fetchPOs = useCallback(() => fetchMasterData(
    'purchase-orders', setPoList,
    raw => raw.map(p => ({
      number: p.purchaseOrderNumber || p.number || p.poNumber || '',
      desc: p.description || p.name || '',
    })).filter(p => p.number)
  ), [buyerDuns])

  /**
   * Fetch status for whichever mode is active. Never throws into the panel —
   * a failed status read must not make a successfully-submitted invoice look
   * broken, so it reports itself in its own line and leaves the rest alone.
   */
  const loadStatus = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setStatusLoading(true)
    setStatusError(null)
    try {
      const path = useOT
        ? `/enverus/field-tickets/status/${invoiceId}`
        : `/enverus/invoices/status/${invoiceId}`
      setStatus(await api.get<EnverusStatus>(path))
    } catch (err: any) {
      setStatusError(err?.message || 'Could not read status')
    } finally {
      setStatusLoading(false)
    }
  }, [invoiceId, useOT])

  // Read status on mount and whenever the mode toggles. Silent on mount so the
  // panel doesn't flash a spinner for an invoice that was never submitted.
  useEffect(() => { void loadStatus({ silent: true }) }, [loadStatus])

  async function handleSubmit() {
    if (useOT) {
      // Open Ticket: service approver optional, contract recommended
      setSubmitting(true)
      setSubmitResult(null)
      try {
        const result = await api.post<{ ok: boolean; message: string }>(
          `/enverus/field-tickets/submit/${invoiceId}?immediate=true`,
          {
            serviceApprover: orderedByName.trim() || undefined,
            contractNumber: contractNumber.trim() || undefined,
            afeNumber: afeNumber.trim() || undefined,
            costCenter: costCenter.trim() || undefined,
            // Send the explicit string (even "") so clearing a prefilled value
            // actually clears it — the builder only falls back to the profile
            // default when the key is absent.
            major: major.trim(),
            minor: minor.trim(),
            additionalDataFields: additionalFields.filter(f => f.value.trim()).map(f => ({
              ...f, value: f.value.trim(),
            })) || undefined,
          }
        )
        setSubmitResult({ ok: result.ok !== false, message: result.message || 'Submitted' })
        onSubmitted()
        void loadStatus()
      } catch (err: any) {
        setSubmitResult({ ok: false, message: err?.message || 'Submission failed' })
      }
      setSubmitting(false)
    } else {
      // Open Invoice: requisitioner required
      if (!orderedByName.trim()) {
        alert('Requisitioner is required')
        return
      }
      setSubmitting(true)
      setSubmitResult(null)
      try {
        const result = await api.post<{ ok: boolean; message: string }>(
          `/enverus/invoices/submit/${invoiceId}?immediate=true`,
          {
            orderedByName: orderedByName.trim(),
            afeNumber: afeNumber.trim() || undefined,
            costCenter: costCenter.trim() || undefined,
            poNumber: poNumber.trim() || undefined,
            receiptType,
            contractNumber: contractNumber.trim() || undefined,
            additionalDataFields: additionalFields.filter(f => f.value.trim()).map(f => ({
              ...f, value: f.value.trim(),
            })) || undefined,
          }
        )
        setSubmitResult({ ok: result.ok !== false, message: result.message || 'Submitted' })
        onSubmitted()
        void loadStatus()
      } catch (err: any) {
        setSubmitResult({ ok: false, message: err?.message || 'Submission failed' })
      }
      setSubmitting(false)
    }
  }

  /** Reusable fetchable combobox row. */
  function FetchCombo({
    label, required, value, onChange, placeholder,
    items, open, loading, onFetch, onToggle, onSelect,
    renderItem,
  }: {
    label: string
    required?: boolean
    value: string
    onChange: (v: string) => void
    placeholder: string
    items: any[]
    open: boolean
    loading: boolean
    onFetch: () => void
    onToggle: (open: boolean) => void
    onSelect: (v: string) => void
    renderItem?: (item: any) => React.ReactNode
  }) {
    return (
      <div className="relative">
        <label className="block text-xs font-medium text-slate-500 mb-1">
          {label} {required && <span className="text-red-400">*</span>}
        </label>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <input
              type="text"
              value={value}
              onChange={e => { onChange(e.target.value); onToggle(false) }}
              placeholder={placeholder}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-teal-500"
            />
            {open && items.length > 0 && (
              <div className="absolute z-10 top-full left-0 right-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
                {items.map((item, i) => (
                  <button
                    key={typeof item === 'string' ? item : item.number || i}
                    onClick={() => { onSelect(typeof item === 'string' ? item : item.number); onToggle(false) }}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-teal-50"
                  >
                    {renderItem ? renderItem(item) : (
                      typeof item === 'string' ? item : (
                        <>
                          <span className="font-mono">{item.number}</span>
                          {item.desc && <span className="text-slate-400 ml-2 text-xs">{item.desc}</span>}
                        </>
                      )
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            onClick={onFetch}
            disabled={loading || !buyerDuns}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap"
          >
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            Fetch
          </button>
        </div>
        {items.length > 0 && !open && (
          <button
            onClick={() => onToggle(true)}
            className="mt-1 text-[10px] text-teal-600 hover:underline flex items-center gap-0.5"
          >
            <ChevronDown className="w-3 h-3" />
            {items.length} available
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="bg-white rounded-lg border border-slate-200 mb-4 overflow-hidden">
      <div className="px-5 py-3 border-b border-slate-100 bg-gradient-to-r from-teal-50 to-slate-50 flex items-center gap-2">
        <Zap className="w-4 h-4 text-teal-600" />
        <h2 className="text-sm font-semibold text-slate-700">
          {useOT ? 'Open Ticket Submission' : 'Open Invoice Submission'}
        </h2>
        {isOT && isOI && (
          <div className="flex gap-1 ml-3">
            <button
              onClick={() => setActiveMode('ot')}
              className={cn('px-2 py-0.5 text-[10px] font-medium rounded', activeMode === 'ot' ? 'bg-teal-100 text-teal-700' : 'text-slate-400 hover:text-slate-600')}
            >OT</button>
            <button
              onClick={() => setActiveMode('oi')}
              className={cn('px-2 py-0.5 text-[10px] font-medium rounded', activeMode === 'oi' ? 'bg-teal-100 text-teal-700' : 'text-slate-400 hover:text-slate-600')}
            >OI</button>
          </div>
        )}
        {buyerDuns && (
          <span className="ml-auto text-[10px] font-mono text-slate-400">Buyer: {buyerDuns}</span>
        )}
      </div>

      <div className="p-5 space-y-4">
        {/* Receipt Type — OI only */}
        {!useOT && (
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Receipt Type</label>
            <select
              value={receiptType}
              onChange={e => setReceiptType(e.target.value)}
              className="w-full sm:w-48 px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-teal-500"
            >
              <option value="General">General</option>
              <option value="LEM">LEM (Labor/Equipment/Material)</option>
              <option value="Hauling">Hauling</option>
              <option value="Chemicals">Chemicals</option>
            </select>
          </div>
        )}

        {/* Service Approver (OT) / Requisitioner (OI) — fetch from Enverus */}
        <FetchCombo
          label={useOT ? 'Service Approver' : 'Requisitioner'}
          required={!useOT}
          value={orderedByName} onChange={setOrderedByName}
          placeholder={useOT ? 'Service approver name' : 'Requisitioner name'}
          items={reqs.items} open={reqs.open} loading={reqs.loading}
          onFetch={fetchRequisitioners}
          onToggle={open => setReqs(p => ({ ...p, open }))}
          onSelect={setOrderedByName}
        />

        {/* Contract / Price Book — prominent for OT, bottom for OI */}
        {useOT && (
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">
              Contract / Price Book <span className="text-amber-500">*</span>
            </label>
            <input
              type="text"
              value={contractNumber}
              onChange={e => setContractNumber(e.target.value)}
              placeholder="Price book name or contract number"
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-teal-500"
            />
          </div>
        )}

        {/* AFE — fetch from Enverus */}
        <FetchCombo
          label={afeLabel}
          value={afeNumber} onChange={setAfeNumber}
          placeholder="AFE or 10-digit API number"
          items={afeList.items} open={afeList.open} loading={afeList.loading}
          onFetch={fetchAfes}
          onToggle={open => setAfeList(p => ({ ...p, open }))}
          onSelect={setAfeNumber}
        />

        {/* Cost Center — fetch from Enverus */}
        <FetchCombo
          label={costCenterLabel}
          value={costCenter} onChange={setCostCenter}
          placeholder="Cost center"
          items={ccList.items} open={ccList.open} loading={ccList.loading}
          onFetch={fetchCostCenters}
          onToggle={open => setCcList(p => ({ ...p, open }))}
          onSelect={setCostCenter}
        />

        {/* Activity Code (major) + Functional Area (minor) — COP OT line fields.
            Only used on certain invoices; leave blank otherwise. Standard Enverus
            line fields, NOT additional data fields. */}
        {useOT && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">{majorLabel}</label>
              <input
                type="text"
                value={major}
                onChange={e => setMajor(e.target.value)}
                placeholder="e.g. FA-L48"
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-teal-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">{minorLabel}</label>
              <input
                type="text"
                value={minor}
                onChange={e => setMinor(e.target.value)}
                placeholder="e.g. L48_OPS_H_S"
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-teal-500"
              />
            </div>
          </div>
        )}

        {/* PO Number — OI only (OT doesn't use header PO) */}
        {!useOT && (
          <FetchCombo
            label="Purchase Order"
            value={poNumber} onChange={setPoNumber}
            placeholder="PO number"
            items={poList.items} open={poList.open} loading={poList.loading}
            onFetch={fetchPOs}
            onToggle={open => setPoList(p => ({ ...p, open }))}
            onSelect={setPoNumber}
          />
        )}

        {/* Contract / Pricebook — OI only (shown at bottom) */}
        {!useOT && (
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Contract / Pricebook</label>
            <input
              type="text"
              value={contractNumber}
              onChange={e => setContractNumber(e.target.value)}
              placeholder="Contract or pricebook name"
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-teal-500"
            />
          </div>
        )}

        {/* Additional Data Fields (buyer-specific, e.g. COP Safety) */}
        {additionalFields.length > 0 && (
          <div className="border border-slate-200 rounded-lg overflow-hidden">
            <button
              type="button"
              onClick={() => setShowAddFields(!showAddFields)}
              className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium text-slate-600 bg-slate-50 hover:bg-slate-100"
            >
              <span>Additional Data Fields ({additionalFields.filter(f => f.value.trim()).length}/{additionalFields.length})</span>
              <span className="text-[10px]">{showAddFields ? '▲' : '▼'}</span>
            </button>
            {showAddFields && (
              <div className="p-3 space-y-2">
                {additionalFields.map((field, idx) => (
                  <div key={field.code || idx}>
                    <label className="block text-[10px] font-medium text-slate-400 mb-0.5">
                      {field.name || field.code}
                    </label>
                    <input
                      type="text"
                      value={field.value}
                      onChange={e => {
                        const updated = [...additionalFields]
                        updated[idx] = { ...updated[idx], value: e.target.value }
                        setAdditionalFields(updated)
                      }}
                      placeholder={field.name || field.code}
                      className="w-full px-3 py-1.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-teal-500"
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {additionalFields.length === 0 && (
          <p className="text-[11px] text-slate-400">
            Buyer custom data fields (e.g. Invoice Approver) are configured on the customer's billing profile.
            Facility Property, Cost Object, Activity Code and Functional Area are sent via the fields above — not here.
          </p>
        )}

        {/* Submit result */}
        {submitResult && (
          <div className={cn(
            'flex items-center gap-2 px-3 py-2 rounded-lg text-sm',
            submitResult.ok
              ? 'bg-green-50 border border-green-200 text-green-700'
              : 'bg-red-50 border border-red-200 text-red-700'
          )}>
            {submitResult.ok ? <CheckCircle2 className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
            {submitResult.message}
          </div>
        )}

        {/* ── Enverus status ──────────────────────────────────────────────
            Only rendered once there is something to report. An invoice that
            was never submitted has no status, and a "not submitted" row on
            every unsubmitted invoice is noise. */}
        {(status?.enverusStatus || status?.enverusReceiptId || (status?.queueHistory?.length ?? 0) > 0) && (
          <div className="border border-slate-200 rounded-lg p-3 space-y-2 bg-slate-50/60">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">
                Enverus status
              </span>
              <button
                onClick={() => loadStatus()}
                disabled={statusLoading}
                className="text-xs text-blue-600 hover:underline disabled:opacity-50 inline-flex items-center gap-1"
              >
                {statusLoading
                  ? <Loader2 className="w-3 h-3 animate-spin" />
                  : <RefreshCw className="w-3 h-3" />}
                {useOT ? 'Re-poll Enverus' : 'Refresh'}
              </button>
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              <span className={cn(
                'px-2 py-0.5 rounded-full border text-xs font-medium',
                ENVERUS_STATUS_TONE[status?.enverusStatus ?? ''] ?? 'bg-slate-100 border-slate-300 text-slate-600',
              )}>
                {status?.enverusStatus || 'no status yet'}
              </span>
              {status?.enverusReceiptId && (
                <span className="text-[11px] font-mono text-slate-500">
                  receipt {status.enverusReceiptId}
                </span>
              )}
              {status?.enverusSubmittedAt && (
                <span className="text-[11px] text-slate-500">
                  sent {new Date(status.enverusSubmittedAt).toLocaleString()}
                </span>
              )}
            </div>

            {/* The OI path answers from our own record, so say so rather than
                letting a stale value read as freshly confirmed. */}
            {!useOT && (
              <p className="text-[11px] text-slate-400">
                Our recorded status — the OpenInvoice path reports back through the queue
                rather than being polled.
              </p>
            )}

            {statusError && (
              <p className="text-[11px] text-amber-600">{statusError}</p>
            )}

            {(status?.queueHistory?.length ?? 0) > 0 && (
              <div>
                <button
                  onClick={() => setShowHistory(v => !v)}
                  className="text-xs text-blue-600 hover:underline"
                >
                  {showHistory ? 'Hide' : 'Show'} queue history ({status!.queueHistory.length})
                </button>
                {showHistory && (
                  <div className="mt-1.5 space-y-1">
                    {status!.queueHistory.map(q => (
                      <div key={q.id} className="text-[11px] flex items-start justify-between gap-2 border-b border-slate-200 pb-1 last:border-0">
                        <span className="text-slate-600">
                          <span className="font-medium">{q.action || 'submit'}</span>
                          {' · '}{q.status}
                          {q.retryCount ? ` · ${q.retryCount} retr${q.retryCount === 1 ? 'y' : 'ies'}` : ''}
                          {q.errorMessage && (
                            <span className="block text-red-600 break-words">
                              {q.errorMessage}
                            </span>
                          )}
                        </span>
                        <span className="text-slate-400 shrink-0">
                          {new Date(q.createdAt).toLocaleString()}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Submit button */}
        <div className="flex items-center gap-3 pt-2">
          <button
            onClick={handleSubmit}
            disabled={submitting}
            className="flex items-center gap-1.5 px-4 py-2 bg-teal-700 text-white rounded-lg text-sm font-medium hover:bg-teal-600 disabled:opacity-50"
          >
            {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            {useOT ? 'Submit Field Ticket' : 'Submit to Enverus'}
          </button>
          {!useOT && !orderedByName.trim() && (
            <span className="text-xs text-amber-600">Requisitioner required</span>
          )}
        </div>
      </div>
    </div>
  )
}

// ---- Dev-only status override toolbar ----
const INVOICE_STATUSES = [
  'draft', 'approved', 'awaiting_signature', 'queued',
  'so_created', 'invoiced', 'sent', 'paid', 'void',
] as const

function DevStatusToolbar({
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
    <div className="border-2 border-dashed border-amber-400 bg-amber-50 rounded-lg p-3">
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
          {INVOICE_STATUSES.map(s => (
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
