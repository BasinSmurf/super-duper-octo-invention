import { useState } from 'react'
import { useAuth } from '@/contexts/AuthContext'
import { api } from '@/lib/api'
import { KeyRound } from 'lucide-react'

/**
 * "Set a PIN" nag. Shows once per login for any signed-in staffer who has no
 * PIN yet, and can be skipped — but it comes back on the next login until they
 * set one (it's mounted in AppShell, so the dismiss state resets each login).
 *
 * A PIN is the sane login for shared/kiosk devices (no email typing, no Google
 * popup), so we gently pester everyone toward having one.
 */
export function PinSetupNag() {
  const { user, markPinSet } = useAuth()
  const [dismissed, setDismissed] = useState(false)
  const [pin, setPin] = useState('')
  const [confirm, setConfirm] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Only pester once we positively know they have no PIN (hasPin === false),
  // not while the user is still loading (undefined).
  if (user?.hasPin !== false || dismissed) return null

  async function save() {
    if (!/^\d{4,6}$/.test(pin)) { setError('PIN must be 4–6 digits'); return }
    if (pin !== confirm) { setError('PINs don’t match — try again'); return }
    setSaving(true)
    setError(null)
    try {
      await api.put('/auth/pin', { pin })
      markPinSet() // flips hasPin=true → this nag unmounts
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not set PIN')
      setSaving(false)
    }
  }

  const pinInputClass =
    'w-full px-3 py-4 border border-slate-300 rounded-lg text-center text-2xl tracking-[0.5em] focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none'

  return (
    <div className="fixed inset-0 z-[90] bg-slate-900/70 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl p-6 w-full max-w-sm">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-11 h-11 rounded-xl bg-blue-50 flex items-center justify-center shrink-0">
            <KeyRound className="w-6 h-6 text-blue-600" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-slate-900 leading-tight">Set a login PIN</h2>
            <p className="text-sm text-slate-500">Fast sign-in on shared &amp; shop devices — no Google needed.</p>
          </div>
        </div>

        {error && (
          <div className="mb-3 p-2 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">{error}</div>
        )}

        <label className="block text-sm font-medium text-slate-700 mb-1">New PIN</label>
        <input
          autoFocus
          type="password"
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={6}
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
          placeholder="----"
          className={pinInputClass}
        />
        <label className="block text-sm font-medium text-slate-700 mb-1 mt-3">Confirm PIN</label>
        <input
          type="password"
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={6}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value.replace(/\D/g, ''))}
          onKeyDown={(e) => { if (e.key === 'Enter') save() }}
          placeholder="----"
          className={pinInputClass}
        />

        <button
          onClick={save}
          disabled={saving}
          className="mt-5 w-full py-3 bg-blue-700 text-white font-semibold rounded-xl hover:bg-blue-800 active:scale-[0.98] transition-all disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Set my PIN'}
        </button>
        <button
          onClick={() => setDismissed(true)}
          className="mt-2 w-full py-2 text-slate-500 hover:text-slate-700 text-sm"
        >
          Remind me later
        </button>
      </div>
    </div>
  )
}
