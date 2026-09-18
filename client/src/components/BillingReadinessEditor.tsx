import { useState, useEffect } from 'react'
import { Pencil, Check, X, Loader2 } from 'lucide-react'
import { cn } from '@/lib/cn'
import { api, ApiError } from '@/lib/api'

export type BillingReadiness = 'unclassified' | 'ready' | 'not_billable' | 'invoiced' | 'submitted'

interface ReasonCode {
  code: string
  phase: string
  label: string
}

interface Props {
  ticketId: string
  billingReadiness: BillingReadiness
  billingReadinessReasonCode?: string | null
  onUpdated: (patch: { billingReadiness: BillingReadiness; billingReadinessReasonCode: string | null }) => void
}

const READINESS_STYLE: Record<BillingReadiness, string> = {
  unclassified: 'bg-slate-100 text-slate-600 border border-slate-200',
  ready: 'bg-emerald-100 text-emerald-700 border border-emerald-300',
  not_billable: 'bg-slate-200 text-slate-700 border border-slate-300',
  invoiced: 'bg-blue-100 text-blue-700 border border-blue-300',
  submitted: 'bg-purple-100 text-purple-700 border border-purple-300',
}

const READINESS_LABEL: Record<BillingReadiness, string> = {
  unclassified: 'Unclassified',
  ready: 'Ready to bill',
  not_billable: 'Not billable',
  invoiced: 'Invoiced',
  submitted: 'Submitted',
}

// invoiced/submitted are set only by the derived-invoice / OpenInvoice-
// submission processes (server rejects a direct set — services/billingReadiness.ts).
// A human can only ever choose between these three.
const EDITABLE_OPTIONS: BillingReadiness[] = ['unclassified', 'ready', 'not_billable']

/**
 * The ONE billing field ServicePRO owns — solid-filled pills, no source/as-of
 * text (it doesn't need provenance, ServicePRO IS the source). Deliberately
 * styled distinctly from BillingProvenancePill's mirrored facts, per the
 * handoff's "two different treatments, consistently applied" rule.
 */
export function BillingReadinessEditor({ ticketId, billingReadiness, billingReadinessReasonCode, onUpdated }: Props) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<BillingReadiness>(billingReadiness)
  const [reasonCode, setReasonCode] = useState<string>(billingReadinessReasonCode ?? '')
  const [reasonCodes, setReasonCodes] = useState<ReasonCode[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (editing && reasonCodes.length === 0) {
      api.get<ReasonCode[]>('/billing/reason-codes').then(setReasonCodes).catch(() => setReasonCodes([]))
    }
  }, [editing, reasonCodes.length])

  const locked = billingReadiness === 'invoiced' || billingReadiness === 'submitted'

  async function save() {
    setSaving(true)
    setError(null)
    try {
      await api.put(`/tickets/${ticketId}`, {
        billingReadiness: draft,
        billingReadinessReasonCode: draft === 'not_billable' ? reasonCode : null,
      })
      onUpdated({ billingReadiness: draft, billingReadinessReasonCode: draft === 'not_billable' ? reasonCode : null })
      setEditing(false)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update')
    } finally {
      setSaving(false)
    }
  }

  if (!editing) {
    return (
      <div className="flex items-center gap-1.5">
        <span className={cn('inline-flex items-center rounded-full px-2 py-1 text-xs font-semibold', READINESS_STYLE[billingReadiness])}>
          {READINESS_LABEL[billingReadiness]}
        </span>
        {!locked && (
          <button
            onClick={() => { setDraft(billingReadiness); setReasonCode(billingReadinessReasonCode ?? ''); setEditing(true) }}
            className="p-1 text-slate-400 hover:text-slate-600 rounded"
            title="Change billing readiness"
          >
            <Pencil className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-1.5 p-2 border border-slate-200 rounded-lg bg-slate-50 max-w-xs">
      <select
        value={draft}
        onChange={(e) => setDraft(e.target.value as BillingReadiness)}
        className="text-xs border border-slate-300 rounded px-1.5 py-1"
      >
        {EDITABLE_OPTIONS.map((opt) => (
          <option key={opt} value={opt}>{READINESS_LABEL[opt]}</option>
        ))}
      </select>
      {draft === 'not_billable' && (
        <select
          value={reasonCode}
          onChange={(e) => setReasonCode(e.target.value)}
          className="text-xs border border-slate-300 rounded px-1.5 py-1"
        >
          <option value="">Select a reason…</option>
          {reasonCodes.map((rc) => (
            <option key={rc.code} value={rc.code}>{rc.label}</option>
          ))}
        </select>
      )}
      {error && <p className="text-[11px] text-red-600">{error}</p>}
      <div className="flex items-center gap-1.5">
        <button
          onClick={save}
          disabled={saving || (draft === 'not_billable' && !reasonCode)}
          className="flex items-center gap-1 px-2 py-1 bg-blue-800 text-white rounded text-[11px] font-medium disabled:opacity-50"
        >
          {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
          Save
        </button>
        <button
          onClick={() => { setEditing(false); setError(null) }}
          className="flex items-center gap-1 px-2 py-1 text-slate-500 rounded text-[11px]"
        >
          <X className="w-3 h-3" />
          Cancel
        </button>
      </div>
    </div>
  )
}
