import { useEffect, useState } from 'react'
import { AlertTriangle, Check, KeyRound, UserRound } from 'lucide-react'
import { api, ApiError } from '@/lib/api'

interface MeResponse {
  id: string
  email: string
  name: string
  role: string
  hasPassword: boolean
}

function Banner({ kind, children }: { kind: 'success' | 'error'; children: React.ReactNode }) {
  const styles = kind === 'success'
    ? 'bg-green-50 border-green-200 text-green-700'
    : 'bg-red-50 border-red-200 text-red-700'
  const Icon = kind === 'success' ? Check : AlertTriangle
  return (
    <div className={`flex items-center gap-2 p-3 border text-sm ${styles}`}>
      <Icon className="w-4 h-4 shrink-0" />
      {children}
    </div>
  )
}

export function PortalAccountPage() {
  const [me, setMe] = useState<MeResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [password, setPassword] = useState('')
  const [passwordConfirm, setPasswordConfirm] = useState('')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)

  useEffect(() => {
    api.get<MeResponse>('/auth/me').then(setMe).catch(() => {}).finally(() => setLoading(false))
  }, [])

  async function savePassword() {
    setMessage(null)
    if (password.length < 12) {
      setMessage({ kind: 'error', text: 'Password must be at least 12 characters.' })
      return
    }
    if (password !== passwordConfirm) {
      setMessage({ kind: 'error', text: "Passwords don't match." })
      return
    }
    setSaving(true)
    try {
      await api.put('/auth/me/password', { password })
      setMe((prev) => prev ? { ...prev, hasPassword: true } : prev)
      setPassword('')
      setPasswordConfirm('')
      setMessage({ kind: 'success', text: 'Password updated.' })
    } catch (e) {
      setMessage({ kind: 'error', text: e instanceof ApiError ? e.message : 'Could not update password.' })
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <p className="text-slate-500 text-sm py-10 text-center">Loading…</p>

  return (
    <div className="max-w-3xl space-y-4">
      <div className="bg-white border border-slate-200 p-4">
        <h1 className="text-2xl font-extrabold text-black">Account</h1>
        <p className="text-sm text-slate-600 mt-1">Manage your portal profile and password.</p>
      </div>

      <section className="bg-white border border-slate-200 p-5">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 bg-blue-50 flex items-center justify-center shrink-0">
            <UserRound className="w-5 h-5 text-blue-700" />
          </div>
          <div>
            <h2 className="font-extrabold text-black">Profile</h2>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm mt-3">
              <dt className="text-slate-500">Name</dt>
              <dd className="font-semibold text-black">{me?.name}</dd>
              <dt className="text-slate-500">Email</dt>
              <dd className="font-semibold text-black">{me?.email}</dd>
              <dt className="text-slate-500">Access</dt>
              <dd className="font-semibold text-black">Customer portal</dd>
            </dl>
          </div>
        </div>
      </section>

      <section className="bg-white border border-slate-200 p-5">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 bg-blue-50 flex items-center justify-center shrink-0">
            <KeyRound className="w-5 h-5 text-blue-700" />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="font-extrabold text-black">{me?.hasPassword ? 'Reset Password' : 'Set Password'}</h2>
            <p className="text-sm text-slate-600 mt-1">Use this password with the Password tab on the ServicePRO login screen.</p>

            <div className="space-y-3 mt-4">
              {message && <Banner kind={message.kind}>{message.text}</Banner>}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-600 mb-1">
                    {me?.hasPassword ? 'New password' : 'Password'}
                  </label>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="At least 12 characters"
                    className="w-full px-3 py-2 border border-slate-300 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-600 mb-1">Confirm</label>
                  <input
                    type="password"
                    value={passwordConfirm}
                    onChange={(e) => setPasswordConfirm(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') savePassword() }}
                    className="w-full px-3 py-2 border border-slate-300 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                  />
                </div>
              </div>
              <button
                onClick={savePassword}
                disabled={saving || !password}
                className="px-4 py-2 bg-blue-700 text-white text-sm font-bold hover:bg-blue-800 disabled:opacity-50"
              >
                {saving ? 'Saving…' : me?.hasPassword ? 'Update password' : 'Set password'}
              </button>
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}
