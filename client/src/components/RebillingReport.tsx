import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '@/lib/api'
import { formatCalendarDateNumeric } from '@/lib/dates'

interface Report {
  groups: Array<{ companyId: string; customer: string; billedTo: string; qbInvoiceCount: number; qbInvoiceTotal: number; pendingCount: number; pendingTotal: number }>
  invoices: Array<{ id: string; invoiceNumber: string; companyName: string; qbCustomerOverride: string; invoiceDate: string; total: string | number; status: string; qbInvoiceTxnId: string | null; qbInvoiceNumber: string | null }>
  total: number
  hasMore: boolean
}
const money = (value: string | number) => Number(value).toLocaleString('en-US', { style: 'currency', currency: 'USD' })

export function RebillingReport({ search }: { search: string }) {
  const [from, setFrom] = useState('')
  const [through, setThrough] = useState('')
  const [page, setPage] = useState(0)
  const [revision, setRevision] = useState(0)
  const [report, setReport] = useState<Report | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => { setPage(0) }, [search, from, through])
  useEffect(() => {
    let current = true
    setLoading(true)
    setError('')
    const query = new URLSearchParams({ search, from, through, page: String(page) })
    api.get<Report>(`/billing/rebilling?${query}`).then(result => {
      if (current) setReport(result)
    }).catch(err => {
      if (current) { setReport(null); setError(err?.message || 'Could not load rebilling report') }
    }).finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [search, from, through, page, revision])

  return (
    <section className="bg-white rounded-lg border border-slate-200 p-4 space-y-4">
      <div>
        <h2 className="font-semibold text-slate-900">Tier 1 / rebilling by original customer</h2>
        <p className="text-sm text-slate-600 mt-1">Work stays attributed to the original customer. The QB billed customer is shown separately.</p>
        <p className="text-xs text-slate-500 mt-1">SP invoice totals, by invoice date. Voided invoices excluded. Confirmed QB invoices are separate from drafts and sales orders. Changes and credits made in QB may differ.</p>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm text-slate-600">Invoice date from<input aria-label="Invoice date from" type="date" value={from} onInput={e => setFrom(e.currentTarget.value)} onChange={e => setFrom(e.target.value)} className="block border rounded p-2 mt-1" /></label>
        <label className="text-sm text-slate-600">Through<input aria-label="Invoice date through" type="date" value={through} onInput={e => setThrough(e.currentTarget.value)} onChange={e => setThrough(e.target.value)} className="block border rounded p-2 mt-1" /></label>
        <button onClick={() => setRevision(value => value + 1)} className="border rounded px-3 py-2 text-sm">Refresh report</button>
      </div>
      {error ? <p role="alert" className="text-red-700">{error}</p> : loading ? <p role="status" className="text-slate-500">Loading report…</p> : report && <>
        {report.groups.length === 0 ? <p className="text-slate-500">No rebilled invoices match these customers and dates.</p> : <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="text-slate-500 border-b"><tr><th className="p-2">Work for</th><th className="p-2">QB billed to</th><th className="p-2 text-right">QB invoiced</th><th className="p-2 text-right">Not yet QB invoiced</th></tr></thead>
              <tbody>{report.groups.map(group => <tr key={`${group.companyId}:${group.billedTo}`} className="border-b">
                <td className="p-2 font-medium">{group.customer}</td><td className="p-2">{group.billedTo}</td>
                <td className="p-2 text-right">{money(group.qbInvoiceTotal)}<span className="block text-xs text-slate-500">{group.qbInvoiceCount} {group.qbInvoiceCount === 1 ? 'invoice' : 'invoices'}</span></td>
                <td className="p-2 text-right">{money(group.pendingTotal)}<span className="block text-xs text-slate-500">{group.pendingCount} {group.pendingCount === 1 ? 'invoice' : 'invoices'}</span></td>
              </tr>)}</tbody>
              <tfoot><tr className="font-semibold"><td className="p-2" colSpan={2}>Total matching work</td><td className="p-2 text-right">{money(report.groups.reduce((sum, group) => sum + group.qbInvoiceTotal, 0))}</td><td className="p-2 text-right">{money(report.groups.reduce((sum, group) => sum + group.pendingTotal, 0))}</td></tr></tfoot>
            </table>
          </div>
          <h3 className="font-medium">Associated invoices ({report.total})</h3>
          <div className="space-y-2">{report.invoices.map(invoice => <Link key={invoice.id} to={`/billing/${invoice.id}`} className="block rounded border p-3 hover:border-blue-400 text-sm">
            <span className="font-medium text-blue-700">{invoice.invoiceNumber}</span><span className="float-right">{money(invoice.total)}</span>
            <span className="block mt-1">Work for {invoice.companyName} · QB billed to {invoice.qbCustomerOverride}</span>
            <span className="block text-xs text-slate-500 mt-1">{formatCalendarDateNumeric(invoice.invoiceDate)} · {invoice.qbInvoiceTxnId ? `QB invoice ${invoice.qbInvoiceNumber || '(confirmed)'}` : `Not yet QB invoiced · ${invoice.status.replaceAll('_', ' ')}`}</span>
          </Link>)}</div>
          <div className="flex items-center gap-3 text-sm"><button disabled={page === 0} onClick={() => setPage(value => value - 1)} className="border rounded px-3 py-1 disabled:opacity-40">Previous</button><span>Page {page + 1}</span><button disabled={!report.hasMore} onClick={() => setPage(value => value + 1)} className="border rounded px-3 py-1 disabled:opacity-40">Next</button></div>
        </>}
      </>}
    </section>
  )
}
