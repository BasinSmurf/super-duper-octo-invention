/**
 * VendorReceiveDialog — WI-09: the moment a unit comes back from a vendor.
 *
 * Sending out and getting back already worked. What the receive moment never
 * captured was anything billing could act on without opening the PDF.
 *
 * THE DISPOSITION IS FIRST AND HAS NO DEFAULT. It is the one field that cannot
 * be inferred later, and a pre-selected value would be answered by whoever is
 * in a hurry — which is everyone at a receiving counter. An unselected radio is
 * a question; a defaulted one is a formality.
 *
 * THE TWO NOTE FIELDS ARE DELIBERATELY DIFFERENT. The allocation note explains
 * the keyed number ("only lines 1 and 3 of this invoice"); the billing note is
 * a message to a person on the billing card. Neither is ever parsed — the
 * server-side projection makes that structurally true — and the UI says so
 * plainly rather than hoping nobody assumes otherwise.
 */

import { useState } from 'react'
import { AlertTriangle, Loader2, X } from 'lucide-react'
import { UnitAttachments } from '@/components/UnitAttachments'
import { ShopServicePicker, type ShopServiceCharge } from '@/components/ShopServicePicker'
import { VENDOR_RECEIVE_CAPTURE } from '@/lib/attachmentCapture'

export type VendorDisposition = 'warranty' | 'pass_thru_repair' | 'no_charge' | 'internal'

interface DispositionOption {
  value: VendorDisposition
  label: string
  detail: string
  billing: string
}

/** Mirrors VENDOR_DISPOSITION_LABEL on the server; the server is authoritative. */
const DISPOSITIONS: DispositionOption[] = [
  {
    value: 'pass_thru_repair',
    label: 'Billable vendor work',
    detail: 'Choose bill through or override with our service below.',
    billing: 'Pass-through or catalog service',
  },
  {
    value: 'warranty',
    label: 'Warranty',
    detail: 'The vendor covered it.',
    billing: 'Not billed',
  },
  {
    value: 'no_charge',
    label: 'No charge / goodwill',
    detail: 'We chose to eat it.',
    billing: 'Not billed',
  },
  {
    value: 'internal',
    label: 'Internal',
    detail: 'Basin’s own equipment. The vendor cost is still recorded.',
    billing: 'Not billed — internal cost',
  },
]

export interface ReceiveSubmission {
  vendorDisposition: VendorDisposition
  vendorBillingMode?: 'passthrough' | 'catalog_service'
  vendorService?: ShopServiceCharge
  vendorInvoiceNumber: string | null
  vendorInvoiceTotal: string | null
  vendorInvoiceAllocationNote: string | null
  vendorBillingNotes: string | null
  receivedBackNotes: string | null
}

interface Props {
  itemId: string
  serialNumber: string
  /** True when the unit went out on warranty — pre-frames, never pre-selects. */
  wasWarranty: boolean
  busy: boolean
  onCancel: () => void
  onSubmit: (payload: ReceiveSubmission) => Promise<void>
}

export function VendorReceiveDialog({
  itemId, serialNumber, wasWarranty, busy, onCancel, onSubmit,
}: Props) {
  const [disposition, setDisposition] = useState<VendorDisposition | null>(null)
  const [invoiceNumber, setInvoiceNumber] = useState('')
  const [billingMode, setBillingMode] = useState<'passthrough' | 'catalog_service' | null>(null)
  const [services, setServices] = useState<ShopServiceCharge[]>([])
  const [invoiceTotal, setInvoiceTotal] = useState('')
  const [allocationNote, setAllocationNote] = useState('')
  const [billingNotes, setBillingNotes] = useState('')
  const [receivedNotes, setReceivedNotes] = useState('')
  const [error, setError] = useState('')
  const [savedKinds, setSavedKinds] = useState<string[]>([])
  const hasReturnDocument = savedKinds.includes('vendor_invoice')
    || (disposition === 'warranty' && savedKinds.includes('packing_slip'))

  // Mirrors the server rule rather than replacing it: a pass-thru with nothing
  // to pass through bills the customer nothing and says nothing about it. The
  // server refuses it too; this just means the tech finds out while they are
  // still holding the invoice.
  const needsTotal = disposition === 'pass_thru_repair' && !invoiceTotal.trim()
  const needsBilling = disposition === 'pass_thru_repair' && (!billingMode
    || (billingMode === 'catalog_service' && (services.length !== 1
      || !Number.isFinite(services[0].rate) || services[0].rate < 0
      || !Number.isFinite(services[0].quantity) || services[0].quantity <= 0)))
  const canSubmit = !!disposition && !needsTotal && !needsBilling && hasReturnDocument && !busy

  async function submit() {
    if (!disposition || !canSubmit) return
    setError('')
    try {
      await onSubmit({
        vendorDisposition: disposition,
        ...(disposition === 'pass_thru_repair' && billingMode ? {
          vendorBillingMode: billingMode,
          ...(billingMode === 'catalog_service' ? { vendorService: services[0] } : {}),
        } : {}),
        vendorInvoiceNumber: invoiceNumber.trim() || null,
        vendorInvoiceTotal: invoiceTotal.trim() || null,
        vendorInvoiceAllocationNote: allocationNote.trim() || null,
        vendorBillingNotes: billingNotes.trim() || null,
        receivedBackNotes: receivedNotes.trim() || null,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not record the receive')
    }
  }

  return (
    <div className="mt-3 p-3 rounded-lg border border-emerald-200 bg-emerald-50 space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold text-emerald-900">
          Receive back from vendor — <span className="font-mono">{serialNumber}</span>
        </h4>
        <button type="button" onClick={onCancel} disabled={busy} className="text-emerald-700 hover:text-emerald-900">
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* 1. The one field that cannot be reconstructed later. */}
      <div>
        <label className="block text-[10px] font-medium text-emerald-800 uppercase tracking-wide mb-1">
          Billable to customer <span className="text-red-600">*</span>
        </label>
        <div className="grid gap-1.5 sm:grid-cols-2">
          {DISPOSITIONS.map(d => (
            <button
              key={d.value}
              type="button"
              onClick={() => setDisposition(d.value)}
              className={`text-left px-2.5 py-2 rounded-lg border text-xs transition ${
                disposition === d.value
                  ? 'border-emerald-600 bg-white ring-2 ring-emerald-500'
                  : 'border-slate-300 bg-white hover:border-emerald-400'
              }`}
            >
              <span className="font-semibold text-slate-800">{d.label}</span>
              {wasWarranty && d.value === 'warranty' && (
                <span className="ml-1 text-[10px] text-emerald-700">(sent out on warranty)</span>
              )}
              <span className="block text-slate-500 mt-0.5">{d.detail}</span>
              <span className="block text-[10px] text-slate-400 mt-0.5">→ {d.billing}</span>
            </button>
          ))}
        </div>
      </div>

      {disposition === 'pass_thru_repair' && (
        <div className="rounded-lg border border-emerald-200 bg-white p-3 space-y-2">
          <p className="text-sm font-semibold text-emerald-900">How should we bill this vendor work?</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {([
              ['passthrough', 'Bill through vendor cost'],
              ['catalog_service', 'Override with our service'],
            ] as const).map(([mode, label]) => (
              <button key={mode} type="button" disabled={busy} aria-pressed={billingMode === mode}
                onClick={() => setBillingMode(mode)}
                className={`rounded-lg border px-3 py-2 text-left text-xs ${billingMode === mode ? 'border-emerald-600 ring-2 ring-emerald-500' : 'border-slate-300'}`}>
                {label}
              </button>
            ))}
          </div>
          {billingMode === 'passthrough' && <p className="text-xs text-slate-600">The vendor invoice total below becomes the customer charge.</p>}
          {billingMode === 'catalog_service' && <>
            <p className="text-xs text-slate-600">Select the service to bill at our selling price. The vendor invoice stays as our cost and is not added to the customer charge.</p>
            <ShopServicePicker value={services} onChange={next => setServices(next.slice(-1))} disabled={busy} />
            {services[0] && <p className="text-sm font-semibold text-emerald-900">Customer service: {services[0].partNumber} — ${(services[0].quantity * services[0].rate).toFixed(2)}</p>}
          </>}
          {needsBilling && <p className="text-xs text-red-700">Choose a billing option{billingMode === 'catalog_service' ? ' and a service with a selling price' : ''} before receiving.</p>}
        </div>
      )}

      {/* 2. The keyed total — so billing never has to open the PDF. */}
      <div className="grid gap-2 sm:grid-cols-3">
        <div>
          <label className="block text-[10px] font-medium text-emerald-800 uppercase tracking-wide mb-1">
            Vendor invoice total / our cost {disposition === 'pass_thru_repair' && <span className="text-red-600">*</span>}
          </label>
          <input
            inputMode="decimal"
            value={invoiceTotal}
            onChange={e => setInvoiceTotal(e.target.value)}
            placeholder="0.00"
            className={`w-full px-3 py-2 border rounded-lg text-sm ${
              needsTotal ? 'border-red-400 bg-red-50' : 'border-slate-300'
            }`}
          />
        </div>
        <div className="sm:col-span-2">
          <label className="block text-[10px] font-medium text-emerald-800 uppercase tracking-wide mb-1">
            Vendor invoice #
          </label>
          <input
            value={invoiceNumber}
            onChange={e => setInvoiceNumber(e.target.value)}
            placeholder="e.g. DFE-4471"
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
          />
        </div>
      </div>

      {needsTotal && (
        <p className="flex items-start gap-1.5 text-[11px] text-red-700">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
          Billable vendor work needs the invoice total recorded as our cost.
          Choose bill through or override above.
        </p>
      )}

      <div>
        <label className="block text-[10px] font-medium text-emerald-800 uppercase tracking-wide mb-1">
          Is that the whole invoice?
        </label>
        <input
          value={allocationNote}
          onChange={e => setAllocationNote(e.target.value)}
          placeholder="e.g. only lines 1 and 3 — the rest is on SW-2026-00044"
          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
        />
      </div>

      <div className="rounded-lg border border-emerald-200 bg-white p-2.5">
        <p className="text-[10px] font-medium text-emerald-800 uppercase tracking-wide mb-1.5">
          {disposition === 'warranty' ? 'Vendor invoice or packing slip' : 'Vendor invoice'} <span className="text-red-600">*</span>
        </p>
        <p className="text-[11px] text-slate-500 mb-2">
          Required to receive back. Stays with this shop ticket for billing.
          {disposition === 'warranty' && ' A packing slip can replace the invoice for warranty returns.'}
        </p>
        <UnitAttachments
          shopItemId={itemId}
          serialNumber={serialNumber}
          disabled={busy}
          scope="ticket"
          onSavedKindsChange={setSavedKinds}
          capture={disposition === 'warranty'
            ? [{ kind: 'vendor_invoice', label: 'Vendor Invoice' }, { kind: 'packing_slip', label: 'Packing Slip' }]
            : [{ kind: 'vendor_invoice', label: 'Vendor Invoice' }]}
        />
        {!hasReturnDocument && (
          <p className="text-[11px] text-red-700 mt-2">
            Attach {disposition === 'warranty' ? 'an invoice or packing slip' : 'a vendor invoice'} and wait for it to upload before receiving back.
          </p>
        )}
      </div>

      {/* Condition evidence follows the serial into its permanent record. */}
      <div className="rounded-lg border border-emerald-200 bg-white p-2.5">
        <p className="text-[10px] font-medium text-emerald-800 uppercase tracking-wide mb-1.5">
          Test paperwork &amp; unit evidence
        </p>
        <p className="text-[11px] text-slate-500 mb-2">
          Test paperwork follows this unit&rsquo;s serial into its permanent record in Vault/BlueLion.
        </p>
        <UnitAttachments
          shopItemId={itemId}
          serialNumber={serialNumber}
          disabled={busy}
          capture={VENDOR_RECEIVE_CAPTURE}
          scope="serial"
        />
      </div>

      <div>
        <label className="block text-[10px] font-medium text-emerald-800 uppercase tracking-wide mb-1">
          Billing notes
        </label>
        <textarea
          rows={3}
          value={billingNotes}
          onChange={e => setBillingNotes(e.target.value)}
          placeholder="e.g. lines 1, 3, 5 from the DFE invoice are billable to items 1-4 on this ticket"
          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
        />
        <p className="text-[11px] text-slate-500 mt-1">
          Passed straight to the billing card for a person to read. Never parsed — amounts
          come from the billing choice and entered prices above.
        </p>
      </div>

      <div>
        <label className="block text-[10px] font-medium text-emerald-800 uppercase tracking-wide mb-1">
          Condition on arrival
        </label>
        <input
          value={receivedNotes}
          onChange={e => setReceivedNotes(e.target.value)}
          placeholder="e.g. box was open on arrival"
          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
        />
      </div>

      {error && <p className="text-xs text-red-700">{error}</p>}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={!canSubmit}
          className="px-4 py-2 rounded-lg text-xs font-semibold bg-emerald-700 text-white hover:bg-emerald-600 disabled:opacity-40 flex items-center gap-1.5"
        >
          {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          Receive back
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="px-3 py-2 rounded-lg text-xs font-medium border border-slate-300 text-slate-600 bg-white"
        >
          Cancel
        </button>
        {!disposition && (
          <span className="text-[11px] text-slate-600">
            Pick how this is billed to finish the receive.
          </span>
        )}
      </div>
    </div>
  )
}
