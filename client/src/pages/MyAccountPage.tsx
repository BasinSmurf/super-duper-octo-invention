import { useState, useEffect } from 'react'
import { api, ApiError } from '@/lib/api'
import { User as UserIcon, KeyRound, Lock, Bell, Check, AlertTriangle } from 'lucide-react'

interface MeResponse {
  id: string
  email: string
  name: string
  phone: string | null
  role: string
  hasPin: boolean
  hasPassword: boolean
  notificationPrefs: { default?: { channel: string; cadence: string } } | null
}

const ROLE_LABELS: Record<string, string> = {
  platform_admin: 'Platform Admin',
  boss: 'Boss',
  field_super: 'Field Supervisor',
  billing_ar: 'Billing / AR',
  dispatch: 'Dispatch',
  field_tech: 'Field Tech',
  customer: 'Customer',
}

const CADENCE_OPTIONS: { value: string; label: string; hint: string }[] = [
  { value: 'immediate', label: 'Immediately', hint: 'Send each notification as it happens' },
  { value: 'daily', label: 'Daily digest', hint: 'One roundup email per day' },
  { value: 'weekly', label: 'Weekly digest', hint: 'One roundup email per week' },
  { value: 'off', label: 'Off', hint: "Don't email me" },
]

function SectionCard({ icon: Icon, title, description, children }: {
  icon: React.ElementType
  title: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6">
      <div className="flex items-center gap-3 mb-1">
        <div className="w-9 h-9 rounded-lg bg-blue-50 flex items-center justify-center shrink-0">
          <Icon className="w-5 h-5 text-blue-700" />
        </div>
        <h2 className="text-base font-bold text-slate-900">{title}</h2>
      </div>
      {description && <p className="text-sm text-slate-500 mb-4 ml-12">{description}</p>}
      <div className={description ? '' : 'mt-4'}>{children}</div>
    </div>
  )
}

function Banner({ kind, children }: { kind: 'success' | 'error'; children: React.ReactNode }) {
  const styles = kind === 'success'
    ? 'bg-green-50 border-green-200 text-green-700'
    : 'bg-red-50 border-red-200 text-red-700'
  const Icon = kind === 'success' ? Check : AlertTriangle
  return (
    <div className={`flex items-center gap-2 p-2.5 rounded-lg border text-sm ${styles}`}>
      <Icon className="w-4 h-4 shrink-0" />
      {children}
    </div>
  )
}

export function MyAccountPage() {
  const [me, setMe] = useState<MeResponse | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.get<MeResponse>('/auth/me').then(setMe).catch(() => {}).finally(() => setLoading(false))
  }, [])

  // ── PIN form ──
  const [pin, setPin] = useState('')
  const [pinConfirm, setPinConfirm] = useState('')
  const [pinSaving, setPinSaving] = useState(false)
  const [pinMessage, setPinMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)

  async function savePin() {
    setPinMessage(null)
    if (!/^\d{4,6}$/.test(pin)) { setPinMessage({ kind: 'error', text: 'PIN must be 4–6 digits' }); return }
    if (pin !== pinConfirm) { setPinMessage({ kind: 'error', text: "PINs don't match" }); return }
    setPinSaving(true)
    try {
      await api.put('/auth/pin', { pin })
      setMe((prev) => (prev ? { ...prev, hasPin: true } : prev))
      setPin('')
      setPinConfirm('')
      setPinMessage({ kind: 'success', text: 'PIN updated' })
    } catch (e) {
      setPinMessage({ kind: 'error', text: e instanceof ApiError ? e.message : 'Could not set PIN' })
    } finally {
      setPinSaving(false)
    }
  }

  // ── Password form ──
  const [password, setPassword] = useState('')
  const [passwordConfirm, setPasswordConfirm] = useState('')
  const [passwordSaving, setPasswordSaving] = useState(false)
  const [passwordMessage, setPasswordMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)

  async function savePassword() {
    setPasswordMessage(null)
    if (password.length < 12) { setPasswordMessage({ kind: 'error', text: 'Password must be at least 12 characters' }); return }
    if (password !== passwordConfirm) { setPasswordMessage({ kind: 'error', text: "Passwords don't match" }); return }
    setPasswordSaving(true)
    try {
      await api.put('/auth/me/password', { password })
      setMe((prev) => (prev ? { ...prev, hasPassword: true } : prev))
      setPassword('')
      setPasswordConfirm('')
      setPasswordMessage({ kind: 'success', text: 'Password updated' })
    } catch (e) {
      setPasswordMessage({ kind: 'error', text: e instanceof ApiError ? e.message : 'Could not set password' })
    } finally {
      setPasswordSaving(false)
    }
  }

  // ── Notification cadence ──
  const [cadence, setCadence] = useState('daily')
  const [cadenceSaving, setCadenceSaving] = useState(false)
  const [cadenceMessage, setCadenceMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)

  useEffect(() => {
    if (me?.notificationPrefs?.default?.cadence) {
      setCadence(me.notificationPrefs.default.cadence)
    }
  }, [me?.notificationPrefs])

  async function saveCadence(next: string) {
    setCadence(next)
    setCadenceSaving(true)
    setCadenceMessage(null)
    try {
      await api.put('/auth/me/notifications', { cadence: next })
      setCadenceMessage({ kind: 'success', text: 'Preference saved' })
    } catch (e) {
      setCadenceMessage({ kind: 'error', text: e instanceof ApiError ? e.message : 'Could not save preference' })
    } finally {
      setCadenceSaving(false)
    }
  }

  if (loading) {
    return <div className="p-6 text-slate-500 text-sm">Loading…</div>
  }

  return (
    <div className="max-w-2xl mx-auto p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">My Account</h1>
        <p className="text-sm text-slate-500 mt-0.5">Manage your login and notification preferences.</p>
      </div>

      <SectionCard icon={UserIcon} title="Profile">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm ml-12">
          <dt className="text-slate-500">Name</dt>
          <dd className="text-slate-900 font-medium">{me?.name}</dd>
          <dt className="text-slate-500">Email</dt>
          <dd className="text-slate-900 font-medium">{me?.email}</dd>
          <dt className="text-slate-500">Role</dt>
          <dd className="text-slate-900 font-medium">{ROLE_LABELS[me?.role || ''] || me?.role}</dd>
        </dl>
      </SectionCard>

      <SectionCard
        icon={KeyRound}
        title="Login PIN"
        description="Fast sign-in on shared & shop devices — no Google needed."
      >
          <div className="space-y-3 ml-12">
            {pinMessage && <Banner kind={pinMessage.kind}>{pinMessage.text}</Banner>}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">
                  {me?.hasPin ? 'New PIN' : 'Set PIN'}
                </label>
                <input
                  type="password"
                  inputMode="numeric"
                  maxLength={6}
                  value={pin}
                  onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
                  placeholder="----"
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-center tracking-[0.3em] focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Confirm</label>
                <input
                  type="password"
                  inputMode="numeric"
                  maxLength={6}
                  value={pinConfirm}
                  onChange={(e) => setPinConfirm(e.target.value.replace(/\D/g, ''))}
                  onKeyDown={(e) => { if (e.key === 'Enter') savePin() }}
                  placeholder="----"
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-center tracking-[0.3em] focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                />
              </div>
            </div>
            <button
              onClick={savePin}
              disabled={pinSaving || !pin}
              className="px-4 py-2 bg-blue-700 text-white text-sm font-semibold rounded-lg hover:bg-blue-800 disabled:opacity-50"
            >
              {pinSaving ? 'Saving…' : me?.hasPin ? 'Update PIN' : 'Set PIN'}
            </button>
          </div>
        </SectionCard>

      <SectionCard
        icon={Lock}
        title="Backup Password"
        description="A local fallback login if Google sign-in is ever unavailable."
      >
          <div className="space-y-3 ml-12">
            {passwordMessage && <Banner kind={passwordMessage.kind}>{passwordMessage.text}</Banner>}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">
                  {me?.hasPassword ? 'New password' : 'Set password'}
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="At least 12 characters"
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Confirm</label>
                <input
                  type="password"
                  value={passwordConfirm}
                  onChange={(e) => setPasswordConfirm(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') savePassword() }}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                />
              </div>
            </div>
            <button
              onClick={savePassword}
              disabled={passwordSaving || !password}
              className="px-4 py-2 bg-blue-700 text-white text-sm font-semibold rounded-lg hover:bg-blue-800 disabled:opacity-50"
            >
              {passwordSaving ? 'Saving…' : me?.hasPassword ? 'Update password' : 'Set password'}
            </button>
          </div>
        </SectionCard>

      <SectionCard
        icon={Bell}
        title="Email Notifications"
        description="How often should we email you?"
      >
        <div className="space-y-2 ml-12">
          {cadenceMessage && <div className="mb-2"><Banner kind={cadenceMessage.kind}>{cadenceMessage.text}</Banner></div>}
          {CADENCE_OPTIONS.map((opt) => (
            <label
              key={opt.value}
              className={`flex items-start gap-3 p-3 border rounded-lg cursor-pointer transition-colors ${
                cadence === opt.value ? 'border-blue-500 bg-blue-50' : 'border-slate-200 hover:bg-slate-50'
              }`}
            >
              <input
                type="radio"
                name="cadence"
                checked={cadence === opt.value}
                disabled={cadenceSaving}
                onChange={() => saveCadence(opt.value)}
                className="mt-0.5"
              />
              <div>
                <p className="text-sm font-medium text-slate-900">{opt.label}</p>
                <p className="text-xs text-slate-500">{opt.hint}</p>
              </div>
            </label>
          ))}
        </div>
      </SectionCard>
    </div>
  )
}
