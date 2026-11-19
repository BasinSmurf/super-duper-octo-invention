import { useState } from 'react'

export interface BillingApprovalPlan {
  version: string
  defaultProfileId?: string
  requiresReview: boolean
  groups: { id: string; label: string }[]
  rows: { key: string; ticketNumber: string; description: string; quantity: number; rate: number; amount: number; unitOfMeasure: string; profileIds: string[]; defaultProfileId: string | null }[]
}
export interface BillingApprovalAllocation { key: string; parts: { profileId: string; quantity: number }[] }

export function BillingApprovalSplitDialog({ plan, onConfirm, onCancel, onRefresh }: {
  plan: BillingApprovalPlan
  onConfirm: (allocations: BillingApprovalAllocation[], splitEnabled: boolean) => Promise<void>
  onCancel: () => void
  onRefresh: () => Promise<void>
}) {
  const [allocations, setAllocations] = useState<BillingApprovalAllocation[]>(() => plan.rows.map(row => ({
    key: row.key, parts: [{ profileId: row.defaultProfileId || '', quantity: row.quantity }],
  })))
  const [splitEnabled, setSplitEnabled] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const complete = allocations.every((allocation, index) => {
    const row = plan.rows[index]!
    return allocation.parts.every(part => row.profileIds.includes(part.profileId) && Number.isFinite(part.quantity) &&
      (row.quantity === 0 ? part.quantity === 0 : part.quantity > 0) && Math.abs(part.quantity * 100 - Math.round(part.quantity * 100)) < 0.000001) &&
      new Set(allocation.parts.map(part => part.profileId)).size === allocation.parts.length &&
      Math.abs(allocation.parts.reduce((sum, part) => sum + part.quantity, 0) - row.quantity) < 0.000001
  })
  function change(row: number, part: number, patch: Partial<BillingApprovalAllocation['parts'][number]>) {
    setAllocations(values => values.map((allocation, i) => i === row ? { ...allocation,
      parts: allocation.parts.map((value, j) => j === part ? { ...value, ...patch } : value) } : allocation))
  }
  async function submit() {
    if ((splitEnabled && !complete) || busy) return
    setBusy(true); setError('')
    try { await onConfirm(allocations, splitEnabled) }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not approve ticket') }
    finally { setBusy(false) }
  }
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
    <section role="dialog" aria-modal="true" aria-labelledby="approval-split-title" className="max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded-xl bg-white p-5 shadow-xl">
      <h2 id="approval-split-title" className="text-lg font-semibold">Billing allocation</h2>
      <p className="mt-1 text-sm text-slate-600">Keep one field ticket. Optionally create separate invoices by approval group, allocating shared time and mileage before approval.</p>
      <label className="mt-4 flex items-center gap-2 text-sm font-medium">
        <input type="checkbox" checked={splitEnabled} disabled={busy} onChange={event => setSplitEnabled(event.target.checked)} />
        Split billing across approval groups
      </label>
      {!splitEnabled && <p className="mt-2 text-sm text-slate-600">Keep all charges together: {plan.groups.find(group => group.id === plan.defaultProfileId)?.label || 'Default billing profile'}.</p>}
      {splitEnabled && <div className="mt-4 space-y-4">{plan.rows.map((row, rowIndex) => <div key={row.key} className="rounded border p-3">
        <p className="font-medium">{row.description}</p>
        <p className="text-xs text-slate-500">{row.unitOfMeasure === 'assignment' ? 'Choose the group responsible for shared fees.' : `${row.ticketNumber} · ${row.quantity} ${row.unitOfMeasure} × $${row.rate.toFixed(2)} · $${row.amount.toFixed(2)}`}</p>
        {allocations[rowIndex]!.parts.map((part, partIndex) => <div key={partIndex} className="mt-2 flex items-center gap-2">
          <select aria-label={`${row.description} approval group ${partIndex + 1}`} value={part.profileId} disabled={busy}
            onChange={event => change(rowIndex, partIndex, { profileId: event.target.value })} className="min-w-0 flex-1 rounded border p-2 text-sm">
            <option value="">Choose approval group</option>
            {plan.groups.filter(group => row.profileIds.includes(group.id)).map(group => <option key={group.id} value={group.id}>{group.label}</option>)}
          </select>
          {row.unitOfMeasure !== 'assignment' && <input aria-label={`${row.description} quantity ${partIndex + 1}`} type="number" min="0" step="0.01" value={part.quantity} disabled={busy || row.unitOfMeasure === 'assignment'}
            onChange={event => change(rowIndex, partIndex, { quantity: Number(event.target.value) })} className="w-24 rounded border p-2 text-sm" />}
          {partIndex > 0 && <button disabled={busy} className="text-xs text-red-700" onClick={() => setAllocations(values => values.map((value, i) =>
            i === rowIndex ? { ...value, parts: value.parts.filter((_, j) => j !== partIndex) } : value))}>Remove</button>}
        </div>)}
        {row.unitOfMeasure !== 'assignment' && row.quantity > 0 && allocations[rowIndex]!.parts.length < row.profileIds.length && <button disabled={busy} className="mt-2 text-xs text-blue-700"
          onClick={() => setAllocations(values => values.map((value, i) => i === rowIndex ? { ...value, parts: [...value.parts, { profileId: '', quantity: 0 }] } : value))}>Split quantity with another group</button>}
      </div>)}</div>}
      {error && <p role="alert" className="mt-3 text-sm text-red-700">{error} <button disabled={busy} onClick={() => void onRefresh().catch(err => setError(err instanceof Error ? err.message : 'Could not refresh allocation'))} className="underline">Refresh charges</button></p>}
      {splitEnabled && !complete && <p className="mt-3 text-sm text-amber-800">Choose groups and allocate each line's full quantity without duplication.</p>}
      <div className="mt-4 flex justify-end gap-2">
        <button disabled={busy} onClick={onCancel} className="rounded border px-4 py-2">Cancel</button>
        <button disabled={busy || (splitEnabled && !complete)} onClick={() => void submit()} className="rounded bg-blue-800 px-4 py-2 text-white disabled:opacity-40">{busy ? 'Approving…' : splitEnabled ? 'Approve ticket with allocation' : 'Approve without splitting'}</button>
      </div>
    </section>
  </div>
}
