import { useEffect, useState } from 'react'
import { api, ApiError } from '@/lib/api'
import { Link } from 'react-router-dom'

type Subscription = { id: string; name: string; description: string; eligible: boolean; cadence: string; assignedByAdmin: boolean }
type Response = { deliveryEnabled: boolean; timezone: string; reports: Subscription[] }
export function ReportSubscriptions({ userId }: { userId?: string }) {
  const endpoint = userId ? `/users/${userId}/reports` : '/auth/me/reports'
  const [data, setData] = useState<Response | null>(null)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    let current = true
    setData(null); setError(''); setMessage('')
    api.get<Response>(endpoint).then(result => { if (current && result) setData(result) }).catch(() => { if (current) setError('Could not load report subscriptions. Reopen to try again.') })
    return () => { current = false }
  }, [endpoint])
  async function save(report: Subscription, cadence: string) {
    setSaving(true); setError(''); setMessage('')
    try {
      const result = await api.put<Response>(`${endpoint}/${report.id}`, { cadence })
      if (result) setData(result)
      setMessage(`${report.name}: ${cadence === 'off' ? 'unsubscribed' : `${cadence} delivery saved`}.`)
    } catch (err) { setError(err instanceof ApiError ? err.message : 'Could not save. Your previous setting is unchanged.') }
    finally { setSaving(false) }
  }
  return <section className="bg-white border rounded-xl p-5 space-y-3">
    <h2 className="font-semibold text-lg">{userId ? 'Assign report' : 'Report subscriptions'}</h2>
    <p className="text-sm text-slate-600">Choose each report separately. Reports are off until selected. Account owners can change reports assigned by an administrator.</p>
    {error && <p role="alert" className="text-red-700">{error}</p>}
    {message && <p role="status" className="text-green-700">{message}</p>}
    {!data && !error && <p>Loading reports…</p>}
    {data && <>
      <p className="text-xs text-slate-500">Scheduled after 7:00 AM {data.timezone}; weekly reports arrive Monday. Reports are current snapshots at delivery time.</p>
      {!data.deliveryEnabled && <p className="bg-amber-50 text-amber-900 p-3 rounded">Email delivery is not enabled on this server. Your selections will be saved for when delivery is enabled.</p>}
      {data.reports.map(report => <div key={report.id} className="border-t pt-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex-1 min-w-48"><label htmlFor={`report-${report.id}`} className="font-medium">{report.name}</label><p className="text-sm text-slate-500">{report.description}</p>
          {report.assignedByAdmin && <p className="text-xs text-blue-700">Assigned by administrator</p>}
          {!userId && report.eligible && <Link to={`/operations-report?type=${report.id}`} className="text-xs text-blue-700 underline">View report</Link>}
          {!report.eligible && <p className="text-xs text-amber-800">Recipient lacks access or is inactive. Delivery is paused; existing subscription can be turned off.</p>}
        </div>
        <select id={`report-${report.id}`} aria-label={`${report.name} delivery`} value={report.cadence} disabled={saving} onChange={e => save(report, e.target.value)} className="border rounded p-2">
          <option value="off">Off</option><option value="daily" disabled={!report.eligible}>Daily</option><option value="weekly" disabled={!report.eligible}>Weekly</option>
        </select>
      </div>)}
    </>}
  </section>
}
