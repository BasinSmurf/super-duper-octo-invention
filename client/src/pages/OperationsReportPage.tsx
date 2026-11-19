import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api } from '@/lib/api'

type Row = { number: string; customer: string; owner: string | null; href: string; ageDays: number; ageBasis: string; detail: string; coverage?: string; overdue?: boolean }
type Report = { generatedAt: string; date: string; dateBasis: string; coverageBasis: string; amounts: Record<string, number>; noChargeRecorded: number; jobs: Row[]; coverage: Row[]; exceptions: Row[]; lastSuccessfulQbResponseAt: string | null; lastConnectorContactAt: string | null }

function Records({ title, rows }: { title: string; rows: Row[] }) {
  return <section className="bg-white rounded-lg border p-4 mb-5">
    <h2 className="text-lg font-semibold mb-3">{title} ({rows.length})</h2>
    {!rows.length ? <p className="text-slate-500">No records require attention.</p> : <div className="overflow-x-auto"><table className="w-full text-sm text-left">
      <thead><tr className="border-b"><th className="p-2">Record / customer</th><th className="p-2">Responsible person</th><th className="p-2">Age</th><th className="p-2">Status / next action</th></tr></thead>
      <tbody>{rows.map((r, i) => <tr key={`${r.href}-${i}`} className="border-b align-top">
        <td className="p-2"><Link className="text-blue-700 underline font-medium" to={r.href}>{r.number}</Link><div>{r.customer}</div></td>
        <td className="p-2">{r.owner || 'Unassigned / unknown'}</td><td className="p-2 whitespace-nowrap">{r.ageDays}d<div className="text-xs text-slate-500">since {r.ageBasis}</div></td>
        <td className="p-2">{r.coverage && <strong className={r.coverage === 'covered' ? 'text-green-700' : 'text-amber-800'}>{r.coverage} · </strong>}{r.overdue && <strong className="text-red-700">Overdue · </strong>}{r.detail}</td>
      </tr>)}</tbody>
    </table></div>}
  </section>
}

export function OperationsReportPage() {
  const [params] = useSearchParams()
  const type = params.get('type')
  const title = ({ operations: 'Daily operations report', billing: 'Billing and QuickBooks report', shop: 'Shop blockers report', training: 'Training closeout report' } as Record<string, string>)[type || 'operations'] || 'Operations report'
  const [report, setReport] = useState<Report | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [filter, setFilter] = useState('')
  async function refresh() {
    setLoading(true); setError('')
    try { const result = await api.get<Report>(`/dashboard/operations-report${type ? `?type=${encodeURIComponent(type)}` : ''}`); if (!result) throw new Error('No report returned'); setReport(result) }
    catch { setError('Report could not be refreshed. Any displayed snapshot is stale. Try again.') }
    finally { setLoading(false) }
  }
  useEffect(() => { setReport(null); void refresh() }, [type])
  const matches = (r: Row) => `${r.number} ${r.customer} ${r.owner} ${r.detail} ${r.coverage} ${r.overdue ? 'overdue' : ''}`.toLowerCase().includes(filter.toLowerCase())
  const queues = ['QB rejected', 'QB queued', 'Invoice approval', 'Completed work:'].map(label => {
    const rows = report?.exceptions.filter(r => r.detail.includes(label)) ?? []
    return { label, count: rows.length, oldest: Math.max(0, ...rows.map(r => r.ageDays)) }
  })
  return <main>
    <div className="flex justify-between gap-4 mb-4"><h1 className="text-2xl font-bold">{title}</h1><button className="rounded bg-blue-700 text-white px-4 py-2 disabled:opacity-50" disabled={loading} onClick={refresh}>{loading ? 'Refreshing…' : 'Refresh'}</button></div>
    {error && <p role="alert" className="text-red-700 mb-4">{error}</p>}
    {report && <>
      <p className="text-sm text-slate-600 mb-3">Snapshot: {new Date(report.generatedAt).toLocaleString()} · Report date {report.date}. Refresh to retrieve current records.</p>
      <p className="text-sm mb-2">Last authenticated connector contact: {report.lastConnectorContactAt ? new Date(report.lastConnectorContactAt).toLocaleString() : 'Not yet recorded'}.</p>
      <p className="text-sm mb-4">Last successful QB response: {report.lastSuccessfulQbResponseAt ? new Date(report.lastSuccessfulQbResponseAt).toLocaleString() : 'Not recorded'}. This is the last completed queue response, not a live connection check.</p>
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-3">{Object.entries(report.amounts).map(([stage, amount]) => <div className="bg-white border rounded p-3" key={stage}><div className="text-sm capitalize">{stage === 'accepted' ? 'QB accepted' : stage}</div><div className="text-xl font-bold">{amount.toLocaleString('en-US', { style: 'currency', currency: 'USD' })}</div></div>)}</div>
      <p className="text-xs text-slate-600 mb-4">{report.dateBasis} Approved and queued amounts have not been accepted by QB.</p>
      {report.noChargeRecorded > 0 && <p className="text-sm mb-4">{report.noChargeRecorded} legitimate $0 records closed locally for this invoice date. No QB push required.</p>}
      <p className="text-sm text-slate-600 mb-3">{report.coverageBasis}</p>
      <div className="flex flex-wrap gap-2 mb-4">{queues.map(q => <button key={q.label} onClick={() => setFilter(q.label)} className="border rounded px-3 py-2 text-sm bg-white">{q.label.replace(':', '')}: {q.count}{q.count ? ` · oldest ${q.oldest}d` : ''}</button>)}</div>
      <div className="text-sm mb-3">{[...report.jobs, ...report.coverage].filter(r => r.coverage === 'covered').length} covered · {[...report.jobs, ...report.coverage].filter(r => r.coverage === 'unassigned').length} unassigned · {[...report.jobs, ...report.coverage].filter(r => r.coverage === 'conflicted').length} conflicted · {[...report.jobs, ...report.coverage].filter(r => r.overdue).length} overdue</div>
      <label className="block mb-5">Find a record, customer, person, or issue<input className="block border rounded p-2 w-full mt-1" value={filter} onChange={e => setFilter(e.target.value)} placeholder="Search jobs and exceptions" /></label>
      {(!type || type === 'operations') && <><Records title="Jobs in progress / scheduled" rows={report.jobs.filter(matches)} />
      <Records title="Coverage update — routes" rows={report.coverage.filter(matches)} /></>}
      <Records title="Actionable exceptions — oldest first" rows={report.exceptions.filter(matches)} />
    </>}
  </main>
}
