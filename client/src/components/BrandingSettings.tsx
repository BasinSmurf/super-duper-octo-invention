import { useState } from 'react'
import { api } from '@/lib/api'
import { useBranding } from '@/lib/branding'
import { CompanyBrand } from './CompanyBrand'

export function BrandingSettings() {
  const { branding, refreshBranding } = useBranding()
  const [nameOverride, setName] = useState<string | null>(null)
  const name = nameOverride ?? branding.companyName
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  async function save(action: () => Promise<unknown>, resetName = false) {
    setBusy(true); setError(''); setMessage('')
    try { await action(); await refreshBranding(); if (resetName) setName(null); setMessage('Company branding saved.') }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not save branding') }
    finally { setBusy(false) }
  }
  return <section className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
    <div><h2 className="text-lg font-semibold text-slate-900">White labelling</h2>
      <p className="text-sm text-slate-500">Set the company name and logo shown in the app, generated PDFs, and signature-request emails.</p></div>
    <div className="rounded-lg border border-slate-200 p-4"><CompanyBrand className="max-h-20 max-w-full object-contain" /></div>
    <form className="flex flex-wrap items-end gap-3" onSubmit={event => { event.preventDefault(); void save(() => api.put('/branding', { companyName: name }), true) }}>
      <label className="flex-1 min-w-48 text-sm font-medium text-slate-700">Company name
        <input value={name} onChange={event => setName(event.target.value)} required maxLength={100} disabled={busy}
          className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2" /></label>
      <button type="submit" disabled={busy || !name.trim()} className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white disabled:opacity-50">Save name</button>
    </form>
    <div className="flex flex-wrap items-center gap-3">
      <label className="text-sm font-medium text-slate-700">Company logo
        <input type="file" accept="image/png,image/jpeg,image/webp" disabled={busy} className="mt-1 block text-sm"
          onChange={event => {
            const file = event.target.files?.[0]; event.target.value = ''
            if (!file) return
            if (file.size > 5 * 1024 * 1024) { setError('Choose a logo smaller than 5 MB.'); return }
            const form = new FormData(); form.append('file', file)
            void save(() => api.upload('/branding/logo', form))
          }} /></label>
      {branding.hasCustomLogo && <button type="button" disabled={busy} onClick={() => void save(() => api.delete('/branding/logo'))}
        className="rounded-lg border border-slate-300 px-3 py-2 text-sm disabled:opacity-50">Use default logo</button>}
    </div>
    <p className="text-xs text-slate-500">PNG, JPEG, or WebP. Maximum 5 MB. Logos are public so they can appear on the login page and in emails.</p>
    {busy && <p role="status" className="text-sm text-slate-600">Saving…</p>}
    {message && <p role="status" className="text-sm text-green-700">{message}</p>}
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
  </section>
}
