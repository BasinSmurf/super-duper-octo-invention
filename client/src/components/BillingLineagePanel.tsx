import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { ArrowUpRight, Loader2, AlertTriangle, RotateCw } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { BillingProvenancePill, formatDateShort, type BillingObservationLite } from '@/components/BillingProvenancePill'
import { BillingReadinessEditor, type BillingReadiness } from '@/components/BillingReadinessEditor'

interface DocRef {
  id: string
  docNumber: string
  revision: number
  qbTxnId: string | null
  invoiceDate: string | null
  invoice: { id: string; status: string; total: string; companyName: string; invoiceNumber: string } | null
}

interface DocLine {
  id: string
  docRefId: string
  lineNo: number
  ticketId: string
  ticketNumber: string
  serviceDate: string
  amount: string
}

interface Submission {
  id: string
  destination: string
  submittedAt: string
  submittedBy: string
  externalRef: string | null
  outcome: string | null
  reasonCode: string | null
  reasonNote: string | null
}

interface LineageResponse {
  resolvedVia: string
  docRefs: DocRef[]
  lines: DocLine[]
  submissions: Submission[]
  observations: BillingObservationLite[]
}

interface Props {
  /** Ticket number or invoice number — whichever this page already has. */
  identifier: string
  /** Only passed on the ticket detail page — invoices don't own billingReadiness. */
  readiness?: {
    ticketId: string
    billingReadiness: BillingReadiness
    billingReadinessReasonCode: string | null
    onUpdated: (patch: { billingReadiness: BillingReadiness; billingReadinessReasonCode: string | null }) => void
  }
}

function latestPerFact(observations: BillingObservationLite[]): BillingObservationLite[] {
  const seen = new Map<string, BillingObservationLite>()
  // observations arrive sorted desc by asOf from the API — first wins.
  for (const obs of observations) {
    if (!seen.has(obs.factKey)) seen.set(obs.factKey, obs)
  }
  return [...seen.values()]
}

/**
 * The composed billing lineage panel — used on both TicketDetailPage and
 * InvoiceDetailPage. One fetch to the lineage resolver (services/billing.ts
 * GET /billing/lineage), then: the owned readiness editor (ticket context
 * only), current mirrored facts, a chronological timeline, and a link to the
 * full lineage search page.
 */
export function BillingLineagePanel({ identifier, readiness }: Props) {
  const [data, setData] = useState<LineageResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  // Distinct from notFound: a 404 means "nothing to see, that's expected."
  // Anything else (network blip, 500, timeout) is a real failure and must
  // never render the same "no lineage yet" message — conflating the two is
  // exactly what makes a transient failure look like flaky/missing data for
  // a ticket that's actually fine.
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    let cancelled = false
    setLoading(true)
    setNotFound(false)
    setError(null)
    api.get<LineageResponse>(`/billing/lineage?q=${encodeURIComponent(identifier)}`)
      .then((d) => { if (!cancelled) setData(d) })
      .catch((err) => {
        if (cancelled) return
        if (err instanceof ApiError && err.status === 404) {
          setNotFound(true)
        } else {
          setError(err instanceof ApiError ? err.message : 'Failed to load billing lineage');
        }
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [identifier])

  useEffect(() => load(), [load])

  if (loading) {
    return <div className="flex items-center gap-2 text-sm text-slate-400 py-4"><Loader2 className="w-4 h-4 animate-spin" /> Loading billing lineage…</div>
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 text-sm text-red-600 py-2">
        <AlertTriangle className="w-4 h-4 shrink-0" />
        <span>{error}</span>
        <button onClick={load} className="flex items-center gap-1 text-xs text-blue-700 hover:underline ml-1">
          <RotateCw className="w-3 h-3" /> Retry
        </button>
      </div>
    )
  }

  // Not found just means nothing has ever been invoiced/observed for this
  // identifier yet — a real, common state (a draft ticket with no invoice),
  // not an error. Still show the readiness editor if this is a ticket.
  if (notFound || !data) {
    if (!readiness) return null
    return (
      <div className="space-y-2">
        <BillingReadinessEditor
          ticketId={readiness.ticketId}
          billingReadiness={readiness.billingReadiness}
          billingReadinessReasonCode={readiness.billingReadinessReasonCode}
          onUpdated={readiness.onUpdated}
        />
        <p className="text-xs text-slate-400">No billing lineage yet — nothing invoiced or observed for this ticket.</p>
      </div>
    )
  }

  const current = latestPerFact(data.observations)
  const timeline = [
    ...data.observations.map((o) => ({ kind: 'observation' as const, at: o.asOf, obs: o })),
    ...data.submissions.map((s) => ({ kind: 'submission' as const, at: s.submittedAt, sub: s })),
  ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())

  return (
    <div className="space-y-3">
      {readiness && (
        <BillingReadinessEditor
          ticketId={readiness.ticketId}
          billingReadiness={readiness.billingReadiness}
          billingReadinessReasonCode={readiness.billingReadinessReasonCode}
          onUpdated={readiness.onUpdated}
        />
      )}

      {data.docRefs.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {data.docRefs.map((d) =>
            d.invoice ? (
              <Link
                key={d.id}
                to={`/billing/${d.invoice.id}`}
                className="font-mono text-xs px-1.5 py-0.5 bg-slate-50 text-blue-700 rounded hover:bg-slate-100 hover:underline"
              >
                {d.docNumber}{d.revision > 1 ? ` (rev ${d.revision})` : ''}
              </Link>
            ) : (
              <span
                key={d.id}
                className="font-mono text-xs px-1.5 py-0.5 bg-slate-50 text-slate-500 rounded"
                title="No matching invoice record found for this document reference"
              >
                {d.docNumber}{d.revision > 1 ? ` (rev ${d.revision})` : ''}
              </span>
            ),
          )}
        </div>
      )}

      {current.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {current.map((obs) => <BillingProvenancePill key={obs.factKey} observation={obs} />)}
        </div>
      )}

      {timeline.length > 0 && (
        <ul className="space-y-1 border-l-2 border-slate-100 pl-3">
          {timeline.map((entry, i) => (
            <li key={i} className="text-xs text-slate-600">
              <span className="text-slate-400">{formatDateShort(entry.at)}</span>
              {' — '}
              {entry.kind === 'observation'
                ? <BillingProvenancePill observation={entry.obs} />
                : <span>submitted to {entry.sub.destination}{entry.sub.outcome ? ` — ${entry.sub.outcome}` : ' (pending)'}{entry.sub.reasonNote ? `: ${entry.sub.reasonNote}` : ''}</span>}
            </li>
          ))}
        </ul>
      )}

      <Link
        to={`/billing/lineage?q=${encodeURIComponent(identifier)}`}
        className="inline-flex items-center gap-1 text-xs text-blue-700 hover:underline"
      >
        View full lineage <ArrowUpRight className="w-3 h-3" />
      </Link>
    </div>
  )
}
