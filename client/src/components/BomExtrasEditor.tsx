import { useState } from 'react'
import { api } from '@/lib/api'
import type { RentalBomExtraSpec } from '@/lib/db-types'

/** Must match the server's bomExtraKey: older extras may carry no id. */
export const bomExtraKey = (e: { id?: string }, index: number) => e.id || `extra-${index}`

/**
 * Gear deploy recorded above the package. An extra deploy couldn't price
 * blocks every invoice on the rental, so the office prices, recounts, or
 * removes it here. The fix applies from the first deployed day.
 */
export function BomExtrasEditor({ id, extras, unit, canEdit, onSaved }: {
  id: string; extras: RentalBomExtraSpec[]; unit: string; canEdit: boolean; onSaved: () => Promise<void>
}) {
  const [rows, setRows] = useState<{ key: string; label: string; qty: string; rate: string }[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  if (!extras.length) return null
  const unpriced = extras.some(e => typeof e.rate !== 'number')

  function open() {
    setRows(extras.map((e, i) => ({ key: bomExtraKey(e, i), label: e.label, qty: String(e.qty || 1), rate: typeof e.rate === 'number' ? String(e.rate) : '' })))
    setError('')
  }
  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (!rows) return
    setBusy(true)
    setError('')
    try {
      await api.put(`/rentals/${id}/bom-extras`, {
        extras: rows.map(r => ({ key: r.key, qty: Number(r.qty), rate: r.rate.trim() === '' ? null : Number(r.rate) })),
      })
      await onSaved()
      setRows(null)
    } catch (err) { setError(err instanceof Error ? err.message : 'Unable to save extras') }
    finally { setBusy(false) }
  }
  const input = 'border border-slate-300 rounded-lg px-2 py-1.5 text-sm w-full'

  if (!rows) return <>
    {extras.map((e, i) => (
      <p key={bomExtraKey(e, i)}>
        {e.qty}× {e.label}
        {typeof e.rate === 'number'
          ? <span className="text-xs text-slate-500">{e.rate === 0 ? ' — included' : ` @ $${e.rate}/${unit}`}</span>
          : <span className="text-xs font-medium text-amber-700"> — no rate set, blocks invoicing</span>}
        {!/\(over baseline\)$/i.test(e.label) && <span className="text-xs text-blue-600"> — over baseline</span>}
      </p>
    ))}
    {canEdit && (
      <button type="button" onClick={open} className={unpriced ? 'text-sm font-medium text-amber-700' : 'text-sm font-medium text-blue-600'}>
        {unpriced ? 'Price over-baseline extras' : 'Edit over-baseline extras'}
      </button>
    )}
  </>

  return <form onSubmit={save} className="space-y-2 border-t border-slate-100 pt-2">
    <p className="text-xs text-slate-500">Set what each extra bills per {unit}, or remove one that didn't really go out. 0 = included. Applies from the first deployed day.</p>
    <fieldset disabled={busy} className="space-y-2">
      {rows.map((r, i) => <div key={r.key} className="grid grid-cols-[1fr_4.5rem_6rem_auto] items-end gap-2">
        <span className="text-sm text-slate-700 pb-1.5 min-w-0 truncate">{r.label}</span>
        <label className="text-xs text-slate-600">Qty
          <input aria-label={`${r.label} quantity`} type="number" min="1" step="1" required value={r.qty} className={input}
            onChange={e => setRows(rows.map((row, index) => index === i ? { ...row, qty: e.target.value } : row))} />
        </label>
        <label className="text-xs text-slate-600">Rate ($/{unit})
          <input aria-label={`${r.label} rate`} type="number" min="0" step="0.01" value={r.rate} placeholder="not set" className={input}
            onChange={e => setRows(rows.map((row, index) => index === i ? { ...row, rate: e.target.value } : row))} />
        </label>
        <button type="button" aria-label={`Remove ${r.label}`} onClick={() => setRows(rows.filter((_, index) => index !== i))} className="text-sm text-red-600 pb-1.5">Remove</button>
      </div>)}
      {!rows.length && <p className="text-sm text-slate-500">All extras removed — the package bills on its own.</p>}
    </fieldset>
    {error && <p className="text-sm text-red-600">{error}</p>}
    <div className="flex gap-2">
      <button type="submit" disabled={busy} className="px-3 py-1.5 bg-blue-700 text-white rounded-lg text-sm font-medium disabled:opacity-50">{busy ? 'Saving…' : 'Save extras'}</button>
      <button type="button" disabled={busy} onClick={() => setRows(null)} className="px-3 py-1.5 border border-slate-300 rounded-lg text-sm">Cancel</button>
    </div>
  </form>
}
