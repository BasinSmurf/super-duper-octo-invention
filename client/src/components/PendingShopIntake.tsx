import { useEffect, useState } from 'react'
import { pendingShopIntake, retryShopIntake } from '@/lib/shopIntakeRecovery'
import type { MutationQueueEntry } from '@/lib/db-types'

export function PendingShopIntake({ orderId, companyName, onSaved, onBack }: {
  orderId: string
  companyName: string
  onSaved: () => Promise<void>
  onBack: () => void
}) {
  const [mutation, setMutation] = useState<MutationQueueEntry>()
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let cancelled = false
    pendingShopIntake(orderId).then(value => {
      if (!cancelled) { setMutation(value); setError(value?.errorMessage || '') }
    }).catch(() => { if (!cancelled) setError('Could not read the saved intake on this device.') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [orderId])
  const equipment = Array.isArray(mutation?.payload.items) ? mutation.payload.items : []
  async function retry() {
    setBusy(true)
    setError('')
    try { await retryShopIntake(orderId); await onSaved() }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not save intake') }
    finally { setBusy(false) }
  }
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <button type="button" onClick={onBack} className="text-blue-800">Back to Shop Service</button>
      <h1 className="text-xl font-bold">Intake pending — {companyName}</h1>
      <p className="rounded border border-amber-300 bg-amber-50 p-3 text-sm">This job has not been confirmed on the server. The equipment below is saved on this device. Retry this intake instead of creating another job. Do not clear browser data.</p>
      {loading ? <p>Loading saved equipment…</p> : (
        <ul className="divide-y rounded border bg-white">
          {equipment.map((item: any, index: number) => (
            <li key={index} className="p-3">
              <span className="font-semibold">{item.serialNumber || `Item ${index + 1}`}</span>
              <p className="text-sm text-slate-600">{item.equipmentCategory?.replaceAll('_', ' ')} · {item.serviceType?.replaceAll('_', ' ')}{item.customData?.binLocation ? ` · ${item.customData.binLocation}` : ''}</p>
              {item.reportedIssue && <p className="text-sm">{item.reportedIssue}</p>}
              {Array.isArray(item.components) && item.components.map((part: any, n: number) => <p key={n} className="pl-4 text-sm">Component: {part.serialNumber}</p>)}
            </li>
          ))}
        </ul>
      )}
      {!loading && !mutation && <p>No queued intake was found on this device. Check the original device or contact support.</p>}
      {error && <p role="alert" className="rounded bg-red-50 p-3 text-red-800">{error}</p>}
      <button type="button" disabled={busy || loading || !mutation} onClick={retry} className="rounded bg-blue-800 px-4 py-2 text-white disabled:opacity-50">{busy ? 'Saving intake…' : 'Retry saving this intake'}</button>
    </div>
  )
}
