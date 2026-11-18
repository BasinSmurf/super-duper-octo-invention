import { useState } from 'react'
import { api } from '@/lib/api'
import type { RentalBillingPolicy } from '@/lib/db-types'

export function RentalBillingSettings({ id, policy, canEdit, onSaved }: {
  id: string; policy?: RentalBillingPolicy; canEdit: boolean; onSaved: () => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [pauses, setPauses] = useState<RentalBillingPolicy['pauses']>([])
  const [automatic, setAutomatic] = useState(false)
  const [manned, setManned] = useState('')
  const [unmanned, setUnmanned] = useState('')
  const [effectiveDate, setEffectiveDate] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  function open() {
    setPauses((policy?.pauses || []).map(p => ({ ...p })))
    setAutomatic(!!policy?.ticketRates)
    const latest = policy?.rateChanges?.at(-1) || policy?.ticketRates
    setManned(latest ? String(latest.manned) : '')
    setUnmanned(latest ? String(latest.unmanned) : '')
    setEffectiveDate(new Date().toISOString().slice(0, 10))
    setError('')
    setEditing(true)
  }
  async function save(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await api.put(`/rentals/${id}/billing-policy`, {
        pauses, effectiveDate, ticketRates: automatic ? { manned: Number(manned), unmanned: Number(unmanned) } : null,
      })
      await onSaved()
      setEditing(false)
    } catch (err) { setError(err instanceof Error ? err.message : 'Unable to save billing settings') }
    finally { setBusy(false) }
  }
  const input = 'border border-slate-300 rounded-lg px-3 py-2 text-sm w-full'
  return <section className="bg-white rounded-lg border border-slate-200 p-4 mb-4">
    <div className="flex items-center justify-between gap-3">
      <h3 className="text-sm font-medium text-slate-700">Rental billing</h3>
      {canEdit && !editing && <button type="button" onClick={open} className="text-sm font-medium text-blue-600">Pause billing / Edit rates</button>}
    </div>
    <p className="text-xs text-slate-500 mt-2">Pause billing for a weekend or other date range. Both dates are included; equipment stays deployed and billing resumes the next day.</p>
    {!editing ? <div className="text-sm mt-3 space-y-2">
      {(policy?.pauses || []).map((p, i) => <p key={i}>Billing paused: {p.startDate} through {p.endDate}</p>)}
      {!policy?.pauses?.length && <p className="text-slate-500">No billing pauses.</p>}
      {policy?.rateChanges?.map(change => <p key={change.effectiveDate}>From {change.effectiveDate}: ${change.manned.toFixed(2)}/day manned; ${change.unmanned.toFixed(2)}/day unmanned.</p>)}
      {policy?.ticketRates && <p>Initial rates: Daily ticket: ${policy.ticketRates.manned.toFixed(2)}/day manned. No daily ticket: ${policy.ticketRates.unmanned.toFixed(2)}/day unmanned.</p>}
    </div> : <form onSubmit={save} className="mt-4 space-y-4">
      <fieldset disabled={busy} className="space-y-4">
        {pauses.map((pause, i) => <div key={i} className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
          <label className="text-xs text-slate-600">Pause start
            <input aria-label={`Pause ${i + 1} start`} type="date" required value={pause.startDate} className={input}
              onChange={e => setPauses(pauses.map((p, index) => index === i ? { ...p, startDate: e.target.value } : p))} />
          </label>
          <label className="text-xs text-slate-600">Pause end
            <input aria-label={`Pause ${i + 1} end`} type="date" required min={pause.startDate} value={pause.endDate} className={input}
              onChange={e => setPauses(pauses.map((p, index) => index === i ? { ...p, endDate: e.target.value } : p))} />
          </label>
          <button type="button" aria-label={`Remove pause ${i + 1}`} onClick={() => setPauses(pauses.filter((_, index) => index !== i))} className="text-sm text-red-600 py-2">Remove</button>
        </div>)}
        <button type="button" onClick={() => setPauses([...pauses, { startDate: '', endDate: '' }])} className="text-sm text-blue-600">+ Pause billing</button>
        <label className="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" checked={automatic} onChange={e => setAutomatic(e.target.checked)} />
          Bill manned when a daily ticket exists; otherwise unmanned
        </label>
        {automatic && <>
          {policy?.ticketRates && <label className="text-xs text-slate-600 block">New rates effective from
            <input type="date" required value={effectiveDate} onChange={e => setEffectiveDate(e.target.value)} className={input} />
          </label>}
          <div className="grid grid-cols-2 gap-3">
            <label className="text-xs text-slate-600">Manned job rate ($/day)
              <input type="number" min="0" step="0.01" required value={manned} onChange={e => setManned(e.target.value)} className={input} />
            </label>
            <label className="text-xs text-slate-600">Unmanned job rate ($/day)
              <input type="number" min="0" step="0.01" required value={unmanned} onChange={e => setUnmanned(e.target.value)} className={input} />
            </label>
          </div>
          <p className="text-xs text-slate-500">These daily rates replace the base trailer/package charge (or equipment rates on jobs without a priced composition). Separately priced extras and ticket charges still apply. Linked manned-trailer daily tickets count once per day; drafts, dispatches, and void tickets do not count. Paused dates have no rental charge.</p>
        </>}
        <p className="text-xs text-slate-500">Changes apply to newly generated invoices. Existing invoices stay unchanged. Weekly and monthly rental charges are prorated for paused days.</p>
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        <div className="flex gap-3">
          <button type="submit" className="bg-blue-600 text-white rounded-lg px-3 py-2 text-sm">{busy ? 'Saving…' : 'Save billing settings'}</button>
          <button type="button" onClick={() => setEditing(false)} className="text-sm text-slate-600">Cancel</button>
        </div>
      </fieldset>
    </form>}
  </section>
}
