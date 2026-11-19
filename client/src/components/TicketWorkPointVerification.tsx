import { useState } from 'react'
import { api } from '@/lib/api'
import { cn } from '@/lib/cn'
import { WorkPointVerification, verificationCurrent } from './WorkPointVerification'

export interface TicketVerificationPoint {
  id: string; name: string; verified: boolean; dateVerified: string | null
  reelSerialNumber?: string | null; standSerialNumber?: string | null
  customData?: { cylinders?: Array<{ serialNumber?: string; hydroDate?: string }>; bottles?: Array<{ serialNumber?: string; hydroDate?: string }> } | null
}

export function TicketWorkPointVerification({ ticketId, points, expiryDays, canVerify, onSaved }: {
  ticketId: string; points: TicketVerificationPoint[]; expiryDays: number; canVerify: boolean; onSaved: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  if (!points.length) return null
  return <section className="bg-white rounded-lg border border-slate-200 p-4 space-y-4">
    <h3 className="font-semibold text-sm">Work Points</h3>
    {points.map(point => <div key={point.id} className="space-y-2">
      <span className={cn('inline-block font-medium text-sm px-2 py-1 rounded border-2', verificationCurrent(point.verified, point.dateVerified, expiryDays) ? 'border-green-500' : 'border-transparent')}>{point.name}</span>
      {(point.reelSerialNumber || point.standSerialNumber) && <p className="text-xs text-slate-500">Reel: {point.reelSerialNumber || '—'} · Stand: {point.standSerialNumber || '—'}</p>}
      <div className="flex flex-wrap gap-2">{(point.customData?.cylinders || point.customData?.bottles || []).map((c, i) => <span key={i} className="text-xs bg-slate-100 rounded px-2 py-1">{c.serialNumber || 'No S/N'} · Hydro: {c.hydroDate?.slice(0, 10) || 'Not recorded'}</span>)}</div>
      <WorkPointVerification verified={point.verified} dateVerified={point.dateVerified} expiryDays={expiryDays} disabled={!canVerify || busy}
        onChange={async verified => {
          setBusy(true); setError('')
          try { await api.put(`/tickets/${ticketId}/work-points/${point.id}/verification`, { verified }); await onSaved() }
          catch (err: any) { setError(err.message || 'Unable to save verification') }
          finally { setBusy(false) }
        }} />
    </div>)}
    {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
  </section>
}
