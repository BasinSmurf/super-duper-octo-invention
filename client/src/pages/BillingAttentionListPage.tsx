import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { Loader2, AlertTriangle, Clock } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/cn'
import { BillingProvenancePill, formatDate, type BillingObservationLite } from '@/components/BillingProvenancePill'

interface AttentionRow {
  ticketId: string
  ticketNumber: string
  serviceDate: string
  daysSinceService: number
  amount: string
  docNumber: string
  companyName: string | null
  lastObservation: BillingObservationLite | null
  windowDays: number
  pctWindowConsumed: number
  severity: 'ok' | 'warning' | 'overdue'
  unconfirmedWindow: boolean
}

const SEVERITY_STYLE: Record<AttentionRow['severity'], string> = {
  ok: 'bg-slate-100 text-slate-600',
  warning: 'bg-amber-100 text-amber-700',
  overdue: 'bg-red-100 text-red-700',
}

const SEVERITY_LABEL: Record<AttentionRow['severity'], string> = {
  ok: 'On time',
  warning: 'Warning',
  overdue: 'Overdue',
}

/**
 * Handoff §4.3/§4.4 — the operational worklist, not an AR artifact. Computed
 * on read every load (GET /api/billing/attention-list) — nothing here is
 * ever persisted or exported as an accounting document.
 */
export function BillingAttentionListPage() {
  const [rows, setRows] = useState<AttentionRow[] | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    api.get<AttentionRow[]>('/billing/attention-list')
      .then(setRows)
      .finally(() => setLoading(false))
  }, [])

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Billing Attention</h1>
        <p className="text-sm text-slate-500">
          Open dollars, oldest service date first — an operational worklist, not an AR report. QuickBooks remains the ledger of record.
        </p>
      </div>

      <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800">
        <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
        <p>
          Submission windows below use a single {rows?.[0]?.windowDays ?? 30}-day default for every customer —
          <strong> not a confirmed per-operator MSA window</strong> (that data isn't wired up yet). Treat severity as a rough signal, not a contractual deadline.
        </p>
      </div>

      {loading && (
        <div className="flex items-center gap-2 text-sm text-slate-400"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
      )}

      {!loading && rows && rows.length === 0 && (
        <p className="text-sm text-slate-400">Nothing open — every invoiced line has a paid or written-off observation.</p>
      )}

      {!loading && rows && rows.length > 0 && (
        <div className="border border-slate-200 rounded-lg overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500 uppercase">
              <tr>
                <th className="text-left px-3 py-2">Ticket</th>
                <th className="text-left px-3 py-2">Service Date</th>
                <th className="text-left px-3 py-2">Days</th>
                <th className="text-left px-3 py-2">Document</th>
                <th className="text-left px-3 py-2">Amount</th>
                <th className="text-left px-3 py-2">Last Mirrored Status</th>
                <th className="text-left px-3 py-2">Window</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.docNumber}-${row.ticketId}`} className="border-t border-slate-100">
                  <td className="px-3 py-2">
                    <Link to={`/tickets/${row.ticketId}`} className="font-mono text-blue-700 hover:underline">{row.ticketNumber}</Link>
                    {row.companyName && <div className="text-xs text-slate-400">{row.companyName}</div>}
                  </td>
                  <td className="px-3 py-2 text-slate-600">{formatDate(row.serviceDate)}</td>
                  <td className="px-3 py-2 text-slate-600">{row.daysSinceService}</td>
                  <td className="px-3 py-2">
                    <Link to={`/billing/lineage?q=${encodeURIComponent(row.docNumber)}`} className="font-mono text-blue-700 hover:underline">
                      {row.docNumber}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-slate-600">${row.amount}</td>
                  <td className="px-3 py-2">
                    {row.lastObservation ? <BillingProvenancePill observation={row.lastObservation} /> : <span className="text-xs text-slate-300">—</span>}
                  </td>
                  <td className="px-3 py-2">
                    <span className={cn('inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium', SEVERITY_STYLE[row.severity])}>
                      {row.severity === 'overdue' && <Clock className="w-3 h-3" />}
                      {SEVERITY_LABEL[row.severity]}
                      {row.unconfirmedWindow && <span className="text-[10px] font-normal opacity-70" title="Global default window, not a confirmed per-operator MSA value">(default)</span>}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
