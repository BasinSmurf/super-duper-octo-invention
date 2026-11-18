import { useEffect, useState } from 'react'
import { api } from '@/lib/api'

export function WorkPointVerificationSettings() {
  const [days, setDays] = useState('0')
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  useEffect(() => {
    api.get<{ expiryDays: number }>('/locations/work-point-verification-settings')
      .then(data => { setDays(String(data.expiryDays)); setLoaded(true) })
      .catch(err => setMessage(err.message || 'Unable to load verification settings'))
  }, [])
  return <section className="bg-white border border-gray-200 rounded-lg p-4">
    <h2 className="font-semibold text-gray-900">Work Point verification</h2>
    <p className="text-sm text-gray-500 mt-1">Require a new physical check after this many days. 0 means never expire; 365 means re-check after a year. Applies to existing and future verifications.</p>
    <form className="flex items-end gap-3 mt-3" onSubmit={async event => {
      event.preventDefault(); setBusy(true); setMessage('')
      try {
        const saved = await api.put<{ expiryDays: number }>('/locations/work-point-verification-settings', { expiryDays: Number(days) })
        setDays(String(saved.expiryDays)); setMessage('Verification settings saved')
      } catch (err: any) { setMessage(err.message || 'Unable to save verification settings') }
      finally { setBusy(false) }
    }}>
      <label className="text-sm text-gray-600">Expire after (days)
        <input type="number" min="0" max="36500" step="1" required value={days} disabled={!loaded || busy} onChange={e => setDays(e.target.value)} className="block border rounded-lg p-2 mt-1 w-40" />
      </label>
      <button disabled={!loaded || busy} className="rounded-lg bg-blue-700 text-white px-3 py-2 text-sm disabled:opacity-50">{busy ? 'Saving…' : 'Save'}</button>
    </form>
    {message && <p role="status" className="mt-2 text-sm">{message}</p>}
  </section>
}
