import { Link } from 'react-router-dom'
import { useAuth } from '@/contexts/AuthContext'
import { useApiResource } from '@/hooks/useApiResource'
import { formatCalendarDate } from '@/lib/dates'

interface BillingSummary {
  pipeline: { approvedInvoices: number; queuedInvoices: number; soCreatedInvoices: number }
}
interface TicketVolume {
  from: string; to: string; total: number; days: { date: string; count: number }[]
}

function RequestStatus({ loading, error, reload }: { loading: boolean; error: string | null; reload: () => void }) {
  if (loading) return <p role="status" className="text-sm text-slate-400">Loading…</p>
  return <div role="alert" className="space-y-2 text-sm text-red-700">
    <p>{error || 'The report did not return data.'}</p>
    <button type="button" onClick={reload} className="rounded border border-red-200 px-2 py-1 hover:bg-red-50">Retry</button>
  </div>
}

export function QbSyncQueueWidget() {
  const { user } = useAuth()
  const report = useApiResource<BillingSummary>(user ? '/dashboard/billing-summary' : null, `${user?.id}:${user?.role}`)
  const pipeline = report.data?.pipeline
  if (report.loading || report.error || !pipeline) return <RequestStatus {...report} />
  const stages = [
    { label: 'Approved · ready to push', count: pipeline.approvedInvoices },
    { label: 'Queued for QuickBooks', count: pipeline.queuedInvoices },
    { label: 'Sales orders · awaiting conversion', count: pipeline.soCreatedInvoices },
  ]
  return <div className="space-y-3">
    <dl className="space-y-2 text-sm">{stages.map(stage => <div key={stage.label} className="flex items-center justify-between gap-3">
      <dt className="text-slate-600">{stage.label}</dt><dd className="font-semibold tabular-nums text-slate-900">{stage.count.toLocaleString()}</dd>
    </div>)}</dl>
    {stages.every(stage => stage.count === 0) && <p className="text-xs text-slate-500">No invoices awaiting QuickBooks processing.</p>}
    <Link to="/billing" className="inline-block text-sm text-blue-700 hover:underline">Open billing</Link>
  </div>
}

export function TicketVolumeWidget() {
  const { user } = useAuth()
  const report = useApiResource<TicketVolume>(user ? '/dashboard/ticket-volume' : null, `${user?.id}:${user?.role}`)
  const data = report.data
  if (report.loading || report.error || !data) return <RequestStatus {...report} />
  const peak = Math.max(1, ...data.days.map(day => day.count))
  const label = (date: string) => formatCalendarDate(date, { month: 'short', day: 'numeric' })
  return <div className="space-y-3">
    <div><p className="text-2xl font-semibold tabular-nums text-slate-900">{data.total.toLocaleString()}</p>
      <p className="text-xs text-slate-500">Tickets · {label(data.from)}–{label(data.to)}</p>
      <p className="text-xs text-slate-500">By service date · Central time · excludes drafts and voids</p></div>
    {data.total === 0 ? <p className="text-sm text-slate-400">No tickets in this period.</p> : <div aria-hidden="true">
      <div className="flex h-28 items-end gap-1 border-b border-slate-200">{data.days.map(day => <div key={day.date}
        title={`${label(day.date)}: ${day.count} tickets`} className="min-w-0 flex-1 rounded-t bg-blue-500"
        style={{ height: `${100 * day.count / peak}%` }} />)}</div>
      <div className="mt-1 flex justify-between text-[10px] text-slate-400"><span>{label(data.from)}</span><span>{label(data.to)}</span></div>
    </div>}
    <details className="text-xs text-slate-600"><summary className="cursor-pointer">Daily counts</summary>
      <div className="mt-2 max-h-48 overflow-auto"><table className="w-full text-left"><caption className="sr-only">Tickets by service date</caption>
        <thead><tr><th scope="col">Service date</th><th scope="col" className="text-right">Tickets</th></tr></thead>
        <tbody>{data.days.map(day => <tr key={day.date}><th scope="row" className="py-1 font-normal">{formatCalendarDate(day.date)}</th><td className="text-right tabular-nums">{day.count}</td></tr>)}</tbody>
      </table></div>
    </details>
    <Link to="/tickets" className="inline-block text-sm text-blue-700 hover:underline">Browse tickets</Link>
  </div>
}
