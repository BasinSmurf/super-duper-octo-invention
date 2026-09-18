import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '@/lib/api'
import { todayKey } from '@/lib/dates'

interface Report {
  total: number; workorders: number; items: number; fallbackRates: number; unpricedLines: number; byCategory: Record<string, number>
  rows: { id: string; workOrderNumber: string; companyName: string; completedDate: string; estimatedDate: boolean; retailValue: number; itemCount: number }[]
}
const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })

export function InternalShopValueWidget() {
  const today = todayKey()
  const [from, setFrom] = useState(`${today.slice(0, 4)}-01-01`)
  const [to, setTo] = useState(today)
  const [report, setReport] = useState<Report | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    let cancelled = false
    setReport(null); setError(''); setLoading(false)
    if (!from || !to || from > to) { setError('Choose a valid date range.'); return }
    setLoading(true)
    api.get<Report>(`/dashboard/internal-shop-value?from=${from}&to=${to}`).then(data => { if (!cancelled) setReport(data) })
      .catch(e => { if (!cancelled) setError(e.message || 'Could not load internal work') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [from, to])
  return <div className="space-y-3">
    <p className="text-xs text-slate-500">Completed internal shop work at current retail rates, before tax. No invoices or revenue are created. Vendor charges and extras use recorded amounts; customer discounts and Tier 1 fees are excluded.</p>
    <div className="flex flex-wrap gap-2 text-xs">
      <label>From <input aria-label="Internal work from" type="date" value={from} onChange={e => setFrom(e.target.value)} className="rounded border p-1" /></label>
      <label>Through <input aria-label="Internal work through" type="date" value={to} onChange={e => setTo(e.target.value)} className="rounded border p-1" /></label>
    </div>
    {loading && <p role="status" className="text-sm text-slate-500">Calculating retail value…</p>}
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    {report && <>
      <div><p className="text-2xl font-semibold text-slate-900">{money(report.total)}</p><p className="text-xs text-slate-500">Retail estimate · {report.workorders} workorders · {report.items} units</p></div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">{Object.entries(report.byCategory).map(([kind, amount]) => <span key={kind} className="capitalize">{kind.replace(/_/g, ' ')}: <strong>{money(amount)}</strong></span>)}</div>
      {(report.fallbackRates > 0 || report.unpricedLines > 0) && <p className="text-xs text-amber-800">{report.fallbackRates} catalog rates unavailable (recorded values used); {report.unpricedLines} lines with a zero or missing rate. Review before using this as a complete valuation.</p>}
      <div className="max-h-72 overflow-auto"><table className="w-full text-xs text-left"><thead><tr className="border-b"><th className="py-2">Workorder</th><th>Completed</th><th className="text-right">Retail value</th></tr></thead>
        <tbody>{report.rows.map(row => <tr key={row.id} className="border-b border-slate-100"><td className="py-2"><Link className="text-blue-700" to={`/shop/${row.id}`}>{row.workOrderNumber}</Link><span className="block text-slate-500">{row.companyName}</span></td><td>{row.completedDate}{row.estimatedDate ? '*' : ''}</td><td className="text-right">{money(row.retailValue)}</td></tr>)}</tbody>
      </table>{!report.rows.length && <p className="py-3 text-slate-500">No completed internal work in this period.</p>}</div>
      {report.rows.some(r => r.estimatedDate) && <p className="text-xs text-slate-500">* Completion date missing; last-updated date used.</p>}
    </>}
  </div>
}
