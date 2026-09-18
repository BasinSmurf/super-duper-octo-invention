import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '@/lib/api'

interface Row { id: string; workOrderNumber: string; companyName: string; invoiceNumbers: string[]; blockers: string[] }

export function ShopBillingWaiverButton({ onComplete }: { onComplete: () => void }) {
  const [rows, setRows] = useState<Row[] | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState('')
  async function preview() {
    setBusy(true); setError(''); setResult('')
    try {
      const response = await api.get<{ data: Row[] }>('/invoices/shop-billing-waiver/preview')
      setRows(response.data); setSelected(new Set(response.data.filter(r => !r.blockers.length).map(r => r.id)))
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not load preview') }
    finally { setBusy(false) }
  }
  async function submit() {
    setBusy(true); setError('')
    try {
      const response = await api.post<{ waived: number; voidedInvoices: number }>('/invoices/shop-billing-waiver', { ids: [...selected], reason: reason.trim() })
      setResult(`${response.waived} workorders closed without billing. ${response.voidedInvoices} local invoice${response.voidedInvoices === 1 ? '' : 's'} voided.`)
      setRows(null); setReason(''); onComplete()
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not waive billing') }
    finally { setBusy(false) }
  }
  return <div className="mb-4">
    <button type="button" onClick={preview} disabled={busy} className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-900 disabled:opacity-50">{busy ? 'Working…' : 'Close shop WOs without billing'}</button>
    {result && <p role="status" className="mt-2 text-sm text-green-700">{result}</p>}
    {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
    {rows !== null && <section aria-label="Close shop workorders without billing" className="mt-3 rounded-lg border border-amber-300 bg-white p-4 space-y-3">
      <h2 className="font-semibold">Review shop billing waivers</h2>
      <p className="text-sm text-slate-600">This list covers all shop billing stages, regardless of the current tab or search. Selected workorders stay closed, their local invoices are voided, and they leave the billing queue. No invoice or payment is created.</p>
      <div className="flex gap-3 text-sm">
        <button type="button" disabled={busy} onClick={() => setSelected(new Set(rows.filter(r => !r.blockers.length).map(r => r.id)))} className="text-blue-700">Select eligible</button>
        <button type="button" disabled={busy} onClick={() => setSelected(new Set())} className="text-blue-700">Clear selection</button>
        <span>{selected.size} selected · {rows.filter(r => r.blockers.length).length} require review</span>
      </div>
      <div className="max-h-80 overflow-auto divide-y border rounded">
        {!rows.length && <p className="p-3 text-sm text-slate-500">No shop workorders awaiting billing.</p>}
        {rows.map(row => <label key={row.id} className="flex items-start gap-3 p-3 text-sm">
          <input type="checkbox" aria-label={`Waive ${row.workOrderNumber}`} disabled={busy || !!row.blockers.length} checked={selected.has(row.id)} onChange={e => setSelected(prev => { const next = new Set(prev); if (e.target.checked) next.add(row.id); else next.delete(row.id); return next })} />
          <span><Link to={`/shop/${row.id}`} className="font-medium text-blue-700">{row.workOrderNumber}</Link> · {row.companyName}
            <span className="block text-slate-500">{row.invoiceNumbers.join(', ') || 'No active invoice'}</span>
            {row.blockers.map(b => <span key={b} className="block text-amber-800">{b}</span>)}
          </span>
        </label>)}
      </div>
      <label className="block text-sm font-medium">Reason (required)
        <textarea value={reason} onChange={e => setReason(e.target.value)} disabled={busy} maxLength={2000} className="mt-1 block w-full rounded border border-slate-300 p-2" placeholder="Why is this work being closed without billing?" />
      </label>
      <div className="flex gap-3">
        <button type="button" onClick={submit} disabled={busy || !selected.size || !reason.trim()} className="rounded bg-amber-700 px-3 py-2 text-sm text-white disabled:opacity-50">{busy ? 'Applying…' : `Confirm: waive billing for ${selected.size} workorders`}</button>
        <button type="button" disabled={busy} onClick={() => { setRows(null); setError('') }} className="text-sm text-slate-600">Cancel</button>
      </div>
    </section>}
  </div>
}
