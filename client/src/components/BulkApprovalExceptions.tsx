import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '@/lib/api'
import type { BillingApprovalPlan, BillingApprovalAllocation } from './BillingApprovalSplitDialog'

export interface ApprovalException { ticketId: string; ticketNumber: string; error: string; plan?: BillingApprovalPlan }

export function BulkApprovalExceptions({ exceptions, onApproved, onClose }: {
  exceptions: ApprovalException[]; onApproved: (id: string) => void; onClose: () => void
}) {
  const [choices, setChoices] = useState<Record<string, BillingApprovalAllocation['parts']>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const parts = (item: ApprovalException, row: BillingApprovalPlan['rows'][number]) => choices[`${item.ticketId}:${row.key}`] ?? [{ profileId: row.defaultProfileId || '', quantity: row.quantity }]
  const ready = (item: ApprovalException) => !!item.plan && item.plan.rows.every(row => {
    const values = parts(item, row)
    return values.every(part => row.profileIds.includes(part.profileId) && Number.isFinite(part.quantity) && (row.quantity === 0 ? part.quantity === 0 : part.quantity > 0)
      && Math.abs(part.quantity * 100 - Math.round(part.quantity * 100)) < 0.000001)
      && new Set(values.map(part => part.profileId)).size === values.length
      && Math.abs(values.reduce((sum, part) => sum + part.quantity, 0) - row.quantity) < 0.000001
  })
  function change(item: ApprovalException, row: BillingApprovalPlan['rows'][number], index: number, patch: Partial<BillingApprovalAllocation['parts'][number]>) {
    setChoices(previous => ({ ...previous, [`${item.ticketId}:${row.key}`]: parts(item, row).map((part, i) => i === index ? { ...part, ...patch } : part) }))
  }
  async function approve() {
    if (busy) return
    setBusy(true)
    try {
      for (const item of exceptions.filter(ready)) {
        try {
          await api.post(`/tickets/${item.ticketId}/transition`, { targetStatus: 'billing_queue', splitBilling: true,
            approvalPlanVersion: item.plan!.version, approvalAllocations: item.plan!.rows.map(row => ({ key: row.key, parts: parts(item, row) })) })
          onApproved(item.ticketId)
        } catch (err) { setErrors(previous => ({ ...previous, [item.ticketId]: err instanceof Error ? err.message : 'Approval failed' })) }
      }
    } finally { setBusy(false) }
  }
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
    <section role="dialog" aria-modal="true" aria-labelledby="bulk-exceptions-title" className="max-h-[90vh] w-full max-w-4xl overflow-auto rounded-xl bg-white p-5 shadow-xl">
      <h2 id="bulk-exceptions-title" className="text-lg font-semibold">Review approval exceptions ({exceptions.length})</h2>
      <p className="mt-1 text-sm text-slate-600">Tickets with valid default allocations were approved. Resolve the remaining allocations here, or open a ticket to correct another issue.</p>
      {exceptions.map(item => <div key={item.ticketId} className="mt-4 rounded border p-3">
        <Link to={`/tickets/${item.ticketId}`} className="font-semibold text-blue-700 underline">{item.ticketNumber}</Link>
        <p className="text-sm text-amber-800">{errors[item.ticketId] || item.error}</p>
        {item.plan?.rows.map(row => <div key={row.key} className="mt-2 rounded border p-2 text-sm">
          <p>{row.description} · {row.quantity} {row.unitOfMeasure}</p>
          {parts(item, row).map((part, index) => <div key={index} className="mt-2 flex items-center gap-2">
            <select aria-label={`${item.ticketNumber} ${row.description} billing group ${index + 1}`} disabled={busy} value={part.profileId} className="min-w-0 flex-1 rounded border p-2"
              onChange={event => change(item, row, index, { profileId: event.target.value })}>
              <option value="">Choose billing group</option>
              {item.plan!.groups.filter(group => row.profileIds.includes(group.id)).map(group => <option key={group.id} value={group.id}>{group.label}</option>)}
            </select>
            {row.unitOfMeasure !== 'assignment' && <input type="number" aria-label={`${item.ticketNumber} ${row.description} quantity ${index + 1}`} min="0" step="0.01" value={part.quantity} disabled={busy}
              onChange={event => change(item, row, index, { quantity: Number(event.target.value) })} className="w-24 rounded border p-2" />}
            {index > 0 && <button disabled={busy} onClick={() => setChoices(previous => ({ ...previous, [`${item.ticketId}:${row.key}`]: parts(item, row).filter((_, i) => i !== index) }))}>Remove</button>}
          </div>)}
          {row.unitOfMeasure !== 'assignment' && row.quantity > 0 && parts(item, row).length < row.profileIds.length && <button disabled={busy} className="mt-2 text-blue-700"
            onClick={() => setChoices(previous => ({ ...previous, [`${item.ticketId}:${row.key}`]: [...parts(item, row), { profileId: '', quantity: 0 }] }))}>Split quantity with another group</button>}
        </div>)}
      </div>)}
      <div className="mt-4 flex justify-end gap-2">
        <button disabled={busy} onClick={onClose} className="rounded border px-4 py-2">Close</button>
        <button disabled={busy || !exceptions.some(ready)} onClick={() => void approve()} className="rounded bg-blue-800 px-4 py-2 text-white disabled:opacity-40">{busy ? 'Approving…' : 'Approve resolved tickets'}</button>
      </div>
    </section>
  </div>
}
