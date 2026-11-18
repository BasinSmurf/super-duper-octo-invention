export function verificationCurrent(verified?: boolean, dateVerified?: string | null, expiryDays = 0) {
  return !!verified && !!dateVerified && (expiryDays === 0 || Date.now() < new Date(dateVerified).getTime() + expiryDays * 86400000)
}

export function WorkPointVerification({ verified, dateVerified, expiryDays, onChange, disabled = false }: {
  verified?: boolean; dateVerified?: string | null; expiryDays: number; onChange: (checked: boolean) => void; disabled?: boolean
}) {
  const current = verificationCurrent(verified, dateVerified, expiryDays)
  return <div className="space-y-1">
    <label className="flex items-center gap-3 text-sm cursor-pointer">
      <input type="checkbox" role="switch" aria-label="Verified: physically checked serials and hydros" checked={current} disabled={disabled}
        onChange={e => onChange(e.target.checked)} className="peer sr-only" />
      <span aria-hidden="true" className="relative h-6 w-11 shrink-0 rounded-full bg-slate-300 peer-checked:bg-green-600 peer-focus-visible:ring-2 peer-focus-visible:ring-blue-500 peer-disabled:opacity-50 after:absolute after:top-0.5 after:left-0.5 after:h-5 after:w-5 after:rounded-full after:bg-white after:transition-transform peer-checked:after:translate-x-5" />
      <span>Verified — I have physically checked these serials and hydros</span>
    </label>
    <p className="text-xs text-slate-500">{dateVerified ? `Date verified: ${new Date(dateVerified).toLocaleString()}${verified && !current ? ' · Expired — check again' : ''}` : 'Not yet verified'}{current && expiryDays > 0 ? ` · Expires ${new Date(new Date(dateVerified!).getTime() + expiryDays * 86400000).toLocaleDateString()}` : ''}</p>
  </div>
}
