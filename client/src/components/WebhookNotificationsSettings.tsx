import { useEffect, useState } from 'react'
import { Bell, ExternalLink, Save, Send } from 'lucide-react'
import { api } from '@/lib/api'

type Channel = 'billing' | 'dispatch' | 'dispatch_d3' | 'rentals' | 'intake'
interface Settings {
  channel: Channel
  enabled: boolean
  source: 'environment' | 'custom'
  hasSavedUrl: boolean
  environmentConfigured: boolean
  configured: boolean
}
const details: Record<Channel, { title: string; description: string }> = {
  billing: { title: 'Billing', description: 'Rentals that are due and have not been sent for billing.' },
  dispatch: { title: 'Field dispatch — D4', description: 'Field tickets routed to D4. Uses the existing Dispatch destination.' },
  dispatch_d3: { title: 'Field dispatch — D3', description: 'Field tickets routed to D3.' },
  rentals: { title: 'Rental creation', description: 'New rental agreements, including dispatch rentals and walk-ins.' },
  intake: { title: 'Shop intake', description: 'New shop work orders received at intake.' },
}
const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Please try again.'

export function WebhookNotificationsSettings() {
  const [settings, setSettings] = useState<Settings[] | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  async function load() {
    setLoading(true)
    setError('')
    try { setSettings((await api.get<{ data: Settings[] }>('/webhook-notifications')).data) }
    catch (err) { setError(errorMessage(err)) }
    finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [])
  return <section className="bg-white rounded-xl border border-slate-200 overflow-hidden" aria-labelledby="webhook-heading">
    <div className="px-5 py-4 border-b border-slate-100">
      <div className="flex items-center gap-3">
        <Bell className="w-5 h-5 text-blue-600" />
        <h2 id="webhook-heading" className="font-semibold text-slate-900">Webhook notifications</h2>
        <span className="ml-auto text-xs rounded-full bg-blue-50 px-2.5 py-1 text-blue-700">RingCentral</span>
      </div>
      <p className="text-sm text-slate-500 mt-2">Connect each notification group to a RingCentral team chat. Changes take effect as soon as you save.</p>
      <a href="https://developers.ringcentral.com/guide/team-messaging/incoming-webhooks/webhook-creation" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-blue-600 mt-2 hover:underline">How to create an incoming webhook <ExternalLink className="h-3 w-3" /></a>
    </div>
    {loading && <p className="p-5 text-sm text-slate-500" role="status">Loading webhook settings…</p>}
    {error && <div className="p-5 text-sm text-red-700" role="alert">{error} <button type="button" onClick={load} className="underline ml-2">Retry</button></div>}
    {settings?.map(setting => <ChannelSettings key={setting.channel} initial={setting} />)}
  </section>
}

function ChannelSettings({ initial }: { initial: Settings }) {
  const [saved, setSaved] = useState(initial)
  const [enabled, setEnabled] = useState(initial.enabled)
  const [source, setSource] = useState(initial.source)
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState<'save' | 'test' | null>(null)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const dirty = enabled !== saved.enabled || source !== saved.source || (source === 'custom' && url.length > 0)
  const needsUrl = source === 'custom' && !saved.hasSavedUrl && !url.trim()
  const id = `webhook-${saved.channel}`
  function clearFeedback() { setError(''); setMessage('') }

  async function save() {
    setBusy('save'); clearFeedback()
    try {
      const result = await api.put<{ data: Settings }>(`/webhook-notifications/${saved.channel}`, {
        enabled, source, ...(source === 'custom' && url.trim() ? { url: url.trim() } : {}),
      })
      setSaved(result.data); setEnabled(result.data.enabled); setSource(result.data.source); setUrl('')
      setMessage('Settings saved. Future notifications will use this configuration.')
    } catch (err) { setError(errorMessage(err)) }
    finally { setBusy(null) }
  }
  async function test() {
    setBusy('test'); clearFeedback()
    try {
      const result = await api.post<{ message: string }>(`/webhook-notifications/${saved.channel}/test`)
      setMessage(result.message)
    } catch (err) { setError(errorMessage(err)) }
    finally { setBusy(null) }
  }
  return <div className="p-5 border-b border-slate-100 last:border-b-0">
    <div className="flex flex-wrap items-center gap-2 mb-1">
      <h3 className="font-medium text-slate-900">{details[saved.channel].title}</h3>
      <span className={`text-xs rounded-full px-2 py-0.5 ${saved.enabled && saved.configured ? 'bg-green-50 text-green-700' : 'bg-slate-100 text-slate-600'}`}>
        {!saved.enabled ? 'Paused' : saved.configured ? 'Configured' : 'Not connected'}
      </span>
      {dirty && <span className="text-xs text-amber-700">Unsaved changes</span>}
    </div>
    <p className="text-sm text-slate-500 mb-4">{details[saved.channel].description}</p>
    <fieldset disabled={busy !== null} className="space-y-3 disabled:opacity-70">
      <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
        <input type="checkbox" checked={enabled} onChange={e => { setEnabled(e.target.checked); clearFeedback() }} className="h-4 w-4 accent-blue-600" />
        Enable {details[saved.channel].title.toLowerCase()} notifications
      </label>
      <div>
        <label htmlFor={`${id}-source`} className="block text-sm font-medium text-slate-700 mb-1">Destination</label>
        <select id={`${id}-source`} value={source} onChange={e => { setSource(e.target.value as Settings['source']); setUrl(''); clearFeedback() }} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm bg-white">
          <option value="environment">Use server environment setting</option>
          <option value="custom">Use a webhook URL saved here</option>
        </select>
      </div>
      {source === 'environment' ? <p className="text-xs text-slate-500">
        {saved.environmentConfigured ? 'A server webhook is configured for this group (or the shared fallback).' : 'No server webhook is configured. Choose a saved webhook URL to connect this group.'}
        {saved.hasSavedUrl && ' Saving this choice removes the URL previously saved here.'}
      </p> : <div>
        <label htmlFor={`${id}-url`} className="block text-sm font-medium text-slate-700 mb-1">{saved.hasSavedUrl ? 'Replace webhook URL' : 'Webhook URL'}</label>
        <input id={`${id}-url`} type="password" autoComplete="new-password" spellCheck={false} value={url} onChange={e => { setUrl(e.target.value); clearFeedback() }} placeholder={saved.hasSavedUrl ? 'Leave blank to keep the saved URL' : 'https://hooks.ringcentral.com/webhook/…'} aria-describedby={`${id}-help`} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
        <p id={`${id}-help`} className="text-xs text-slate-500 mt-1">Paste the incoming webhook URL for the destination chat. Saved URLs are kept hidden.</p>
      </div>}
      <div className="flex flex-wrap gap-2 items-center pt-1">
        <button type="button" onClick={save} disabled={!dirty || needsUrl} className="inline-flex items-center gap-2 rounded-lg bg-blue-600 text-white px-3 py-2 text-sm font-medium disabled:opacity-50 hover:bg-blue-700"><Save className="w-4 h-4" />{busy === 'save' ? 'Saving…' : 'Save changes'}</button>
        <button type="button" onClick={test} disabled={dirty || !saved.enabled || !saved.configured} className="inline-flex items-center gap-2 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 disabled:opacity-50 hover:bg-slate-50"><Send className="w-4 h-4" />{busy === 'test' ? 'Sending…' : 'Send test notification'}</button>
        {dirty && <button type="button" onClick={() => { setEnabled(saved.enabled); setSource(saved.source); setUrl(''); clearFeedback() }} className="text-sm text-slate-500 hover:underline">Discard changes</button>}
      </div>
      <p className="text-xs text-slate-500">{dirty ? 'Save your changes before testing.' : 'Sending a test posts a message to the connected chat.'}</p>
    </fieldset>
    {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
    {message && <p role="status" className="mt-3 text-sm text-green-700">{message}</p>}
  </div>
}
