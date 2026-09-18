import { useState, useEffect, useCallback } from 'react'
import { useSearchParams, Link } from 'react-router-dom'
import { Search, Loader2, ArrowUpRight } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { BillingProvenancePill, formatDate, formatDateShort, type BillingObservationLite } from '@/components/BillingProvenancePill'

interface DocRef {
  id: string
  docType: string
  docNumber: string
  revision: number
  qbTxnId: string | null
  invoiceDate: string | null
  createdAt: string
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
  docRefId: string
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

const RESOLVED_VIA_LABEL: Record<string, string> = {
  doc_number: 'invoice / credit memo number',
  qb_txn_id: 'QuickBooks TxnID',
  submission_external_ref: 'submission reference',
  ticket_number: 'ticket number',
}

/**
 * "I can't figure out where this went" — one search box, one page. Accepts a
 * ticket number, invoice number, credit memo number, QuickBooks TxnID, or an
 * operator's external submission reference; all resolve here via the same
 * GET /api/billing/lineage endpoint.
 */
export function BillingLineageSearchPage() {
  const [params, setParams] = useSearchParams()
  const [q, setQ] = useState(params.get('q') ?? '')
  const [data, setData] = useState<LineageResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const runSearch = useCallback((value: string) => {
    if (!value.trim()) return
    setLoading(true)
    setError(null)
    setData(null)
    api.get<LineageResponse>(`/billing/lineage?q=${encodeURIComponent(value.trim())}`)
      .then(setData)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Search failed'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    const initial = params.get('q')
    if (initial) runSearch(initial)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setParams(q ? { q } : {})
    runSearch(q)
  }

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Billing Lineage</h1>
        <p className="text-sm text-slate-500">Find where a ticket's billing went — by ticket number, invoice number, credit memo number, or QuickBooks TxnID.</p>
      </div>

      <form onSubmit={onSubmit} className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="FS-2026-00002, INV-2026-00001, QB TxnID…"
            className="w-full pl-9 pr-3 py-2 border border-slate-300 rounded-lg text-sm"
          />
        </div>
        <button
          type="submit"
          disabled={loading || !q.trim()}
          className="px-4 py-2 bg-blue-800 text-white rounded-lg text-sm font-medium disabled:opacity-50"
        >
          Search
        </button>
      </form>

      {loading && (
        <div className="flex items-center gap-2 text-sm text-slate-400"><Loader2 className="w-4 h-4 animate-spin" /> Searching…</div>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}

      {data && (
        <div className="space-y-5">
          <p className="text-xs text-slate-400">Resolved via {RESOLVED_VIA_LABEL[data.resolvedVia] ?? data.resolvedVia}</p>

          <section>
            <h2 className="text-sm font-semibold text-slate-700 mb-2">Documents</h2>
            {data.docRefs.length === 0 && <p className="text-sm text-slate-400">No invoice or credit memo yet.</p>}
            <div className="space-y-2">
              {data.docRefs.map((d) => (
                <div key={d.id} className="p-3 border border-slate-200 rounded-lg flex items-center justify-between">
                  <div>
                    {d.invoice ? (
                      <Link to={`/billing/${d.invoice.id}`} className="font-mono text-sm text-blue-700 hover:underline">
                        {d.docNumber}{d.revision > 1 ? ` (rev ${d.revision})` : ''}
                      </Link>
                    ) : (
                      <span className="font-mono text-sm text-slate-500" title="No matching invoice record found for this document reference">
                        {d.docNumber}{d.revision > 1 ? ` (rev ${d.revision})` : ''}
                      </span>
                    )}
                    {d.invoice && <span className="ml-2 text-xs text-slate-500">{d.invoice.companyName} · ${d.invoice.total} · {d.invoice.status}</span>}
                  </div>
                  <div className="flex items-center gap-2 text-xs text-slate-500">
                    {d.qbTxnId && <span className="px-1.5 py-0.5 bg-purple-50 text-purple-600 rounded">QB {d.qbTxnId}</span>}
                    {d.invoiceDate && <span>{formatDate(d.invoiceDate)}</span>}
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section>
            <h2 className="text-sm font-semibold text-slate-700 mb-2">Tickets on these documents</h2>
            {data.lines.length === 0 && <p className="text-sm text-slate-400">No lines traced to a ticket.</p>}
            <div className="space-y-1">
              {data.lines.map((l) => (
                <div key={l.id} className="flex items-center justify-between text-sm px-3 py-1.5 border border-slate-100 rounded">
                  <Link to={`/tickets/${l.ticketId}`} className="font-mono text-blue-700 hover:underline">{l.ticketNumber}</Link>
                  <span className="text-xs text-slate-500">{formatDate(l.serviceDate)} · ${l.amount}</span>
                </div>
              ))}
            </div>
          </section>

          {data.submissions.length > 0 && (
            <section>
              <h2 className="text-sm font-semibold text-slate-700 mb-2">Submissions</h2>
              <div className="space-y-1">
                {data.submissions.map((s) => (
                  <div key={s.id} className="text-sm px-3 py-1.5 border border-slate-100 rounded flex items-center justify-between">
                    <span>{s.destination} — {new Date(s.submittedAt).toLocaleDateString()}</span>
                    <span className={s.outcome === 'rejected' ? 'text-red-600' : s.outcome === 'accepted' ? 'text-green-600' : 'text-slate-500'}>
                      {s.outcome ?? 'pending'}{s.reasonNote ? `: ${s.reasonNote}` : ''}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section>
            <h2 className="text-sm font-semibold text-slate-700 mb-2">Timeline</h2>
            {data.observations.length === 0 && <p className="text-sm text-slate-400">No mirrored facts yet.</p>}
            <ul className="space-y-1.5 border-l-2 border-slate-100 pl-3">
              {data.observations.map((o, i) => (
                <li key={i} className="text-xs flex items-center gap-2">
                  <span className="text-slate-400 w-14 shrink-0">{formatDateShort(o.asOf)}</span>
                  <BillingProvenancePill observation={o} />
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}

      {!loading && !error && !data && (
        <p className="text-sm text-slate-400 flex items-center gap-1">
          Search above, or arrive here from a "View full lineage" link. <ArrowUpRight className="w-3.5 h-3.5" />
        </p>
      )}
    </div>
  )
}
