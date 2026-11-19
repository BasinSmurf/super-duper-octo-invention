import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { ProductSearch } from './ProductSearch'

interface Row {
  productId: string
  qbItemListId: string
  partNumber: string
  standardName: string
  description: string
}

export function CustomerDescriptions({ companyId, canEdit }: { companyId: string; canEdit: boolean }) {
  const [rows, setRows] = useState<Row[]>([])
  const [saved, setSaved] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoaded(false)
    setError('')
    api.get<{ data: Row[] }>(`/companies/${companyId}/customer-descriptions`)
      .then(({ data }) => { if (!cancelled) { setRows(data); setSaved(data); setLoaded(true) } })
      .catch(err => { if (!cancelled) setError(err.message || 'Unable to load customer descriptions') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [companyId])

  async function save() {
    setSaving(true)
    setError('')
    setMessage('')
    try {
      const { data } = await api.put<{ data: Row[] }>(`/companies/${companyId}/customer-descriptions`, {
        data: rows.map(({ productId, description }) => ({ productId, description })),
      })
      setRows(data)
      setSaved(data)
      setMessage('Customer descriptions saved.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to save customer descriptions')
    } finally { setSaving(false) }
  }

  const dirty = JSON.stringify(rows) !== JSON.stringify(saved)
  return <section className="mt-3 pt-3 border-t border-gray-100">
    <h3 className="text-sm font-semibold text-gray-700">Alternate wording</h3>
    <p className="text-xs text-gray-500 mt-1 mb-3">Choose a QB item and enter this customer’s description. Used on new invoices, PDFs and billing submissions, including Enverus. Existing invoices keep their saved wording.</p>
    {loading ? <p className="text-sm text-gray-500">Loading descriptions…</p> : <>
      {rows.length === 0 && loaded && <p className="text-sm text-gray-500 mb-3">No overrides. Standard item descriptions will be used.</p>}
      <fieldset disabled={saving} className="space-y-3 disabled:opacity-60">
        {rows.map((row, index) => <div key={row.qbItemListId} className="rounded border border-gray-200 p-3">
          <div className="flex items-start justify-between gap-3">
            <div><p className="text-sm font-medium">{row.partNumber}</p><p className="text-xs text-gray-500">Standard: {row.standardName}</p></div>
            {canEdit && <button type="button" className="text-xs text-red-600" onClick={() => { setRows(rows.filter((_, i) => i !== index)); setMessage('') }}>Remove</button>}
          </div>
          <label className="block mt-2 text-xs text-gray-600">Customer description
            <textarea value={row.description} readOnly={!canEdit} maxLength={1000} rows={2}
              className="block mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
              onChange={e => { setRows(rows.map((item, i) => i === index ? { ...item, description: e.target.value } : item)); setMessage('') }} />
          </label>
        </div>)}
        {canEdit && loaded && <>
          <ProductSearch placeholder="Find QB item by part number or name…" onSelect={product => {
            setMessage('')
            if (!product.qbItemListId) { setError('Choose an item linked to QuickBooks.'); return }
            if (rows.some(row => row.qbItemListId === product.qbItemListId)) { setError('This item already has an override. Edit its description above.'); return }
            setError('')
            setRows([...rows, { productId: product.id, qbItemListId: product.qbItemListId, partNumber: product.partNumber, standardName: product.name, description: '' }])
          }} />
          <div className="flex gap-2">
            <button type="button" disabled={!dirty || rows.some(row => !row.description.trim())} onClick={save}
              className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white disabled:opacity-50">{saving ? 'Saving…' : 'Save wording'}</button>
            {dirty && <button type="button" className="text-sm text-gray-600" onClick={() => { setRows(saved); setError(''); setMessage('') }}>Cancel</button>}
          </div>
        </>}
      </fieldset>
    </>}
    {error && <p role="alert" className="mt-2 text-sm text-red-600">{error}</p>}
    {message && <p role="status" className="mt-2 text-sm text-green-700">{message}</p>}
  </section>
}
