import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getKioskToken, captureKioskToken } from '@/lib/kioskAuth'
import { Loader2, WifiOff, GraduationCap, Clock, User } from 'lucide-react'

interface TrainingClass {
  id: string
  courseName: string
  startTime: string
  endTime: string
  trainerName: string | null
  locationName: string | null
  capacity: number | null
  signedInCount: number
  status: 'open' | 'scheduled'
  signinToken: string | null
  signinUrl: string | null
  qrDataUrl: string | null
}

interface TodayResponse {
  generatedAt: string
  today: string
  location: { id: string; name: string } | null
  classes: TrainingClass[]
}

const REFRESH_MS = 30_000

/** Kiosk fetch — sends the kiosk token, never redirects on 401. */
async function kioskFetch<T>(path: string): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const jwt = localStorage.getItem('sundog_token')
  if (jwt) headers['Authorization'] = `Bearer ${jwt}`
  const token = getKioskToken()
  if (token) headers['X-Kiosk-Token'] = token

  const res = await fetch(`/api${path}`, { headers })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error || `Request failed (${res.status})`)
  }
  return res.json()
}

/** "13:30" → "1:30 PM" for the wall display. */
function fmtTime(hm: string): string {
  const [h, m] = hm.split(':').map(Number)
  const period = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${h12}:${String(m).padStart(2, '0')} ${period}`
}

export function TrainingKioskPage() {
  const navigate = useNavigate()
  const [data, setData] = useState<TodayResponse | null>(null)
  const [online, setOnline] = useState(true)
  const [loading, setLoading] = useState(true)
  const [now, setNow] = useState(new Date())
  const loadingRef = useRef(false)

  useEffect(() => { captureKioskToken() }, [])

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    let cancelled = false
    async function load() {
      if (loadingRef.current) return
      loadingRef.current = true
      try {
        const res = await kioskFetch<TodayResponse>('/train-kiosk/today')
        if (cancelled) return
        setData(res)
        setOnline(true)
      } catch {
        if (!cancelled) setOnline(false)
      } finally {
        loadingRef.current = false
        if (!cancelled) setLoading(false)
      }
    }
    load()
    const t = setInterval(load, REFRESH_MS)
    return () => { cancelled = true; clearInterval(t) }
  }, [])

  const todayLabel = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })

  if (loading && !data) {
    return (
      <div className="fixed inset-0 z-50 bg-slate-50 flex items-center justify-center">
        <Loader2 className="w-10 h-10 text-slate-400 animate-spin" />
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-50 bg-slate-100 flex flex-col">
      {/* Header */}
      <div className="bg-blue-900 text-white px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <GraduationCap className="w-8 h-8" />
          <div>
            <h1 className="text-2xl font-bold leading-tight">Class Sign-In</h1>
            <p className="text-sm text-white/70">
              {data?.location?.name ? `${data.location.name} · ` : ''}Basin Safety
            </p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          {!online && (
            <span title="Reconnecting…">
              <WifiOff className="w-6 h-6 text-amber-400" />
            </span>
          )}
          <div className="text-right">
            <p className="text-lg font-semibold leading-tight">
              {now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
            </p>
            <p className="text-xs text-white/70">{todayLabel}</p>
          </div>
        </div>
      </div>

      {/* Class grid */}
      <div className="flex-1 overflow-auto p-5">
        {!data || data.classes.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-slate-400 gap-3">
            <GraduationCap className="w-16 h-16" />
            <p className="text-2xl">No classes scheduled today</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
            {data.classes.map(cls => (
              <ClassCard key={cls.id} cls={cls} onManual={() => navigate(`/train/${cls.signinToken}?kiosk=1`)} />
            ))}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="bg-white border-t border-slate-200 px-6 py-2 text-center text-sm text-slate-500">
        Scan the code with your phone, or tap <span className="font-medium text-slate-700">Sign in here</span> on a class to use this screen.
      </div>
    </div>
  )
}

function ClassCard({ cls, onManual }: { cls: TrainingClass; onManual: () => void }) {
  const open = cls.status === 'open' && cls.qrDataUrl && cls.signinToken
  return (
    <div className={`rounded-2xl border-2 p-5 flex flex-col ${open ? 'bg-white border-slate-200' : 'bg-slate-50 border-dashed border-slate-300'}`}>
      <div className="flex-1">
        <p className="text-xl font-bold text-slate-900 leading-tight">{cls.courseName}</p>
        <div className="mt-2 space-y-1 text-sm text-slate-600">
          <p className="flex items-center gap-1.5">
            <Clock className="w-4 h-4 text-slate-400" />
            {fmtTime(cls.startTime)} – {fmtTime(cls.endTime)}
          </p>
          {cls.trainerName && (
            <p className="flex items-center gap-1.5">
              <User className="w-4 h-4 text-slate-400" />
              {cls.trainerName}
            </p>
          )}
        </div>
      </div>

      {open ? (
        <>
          <div className="mt-4 flex flex-col items-center">
            <img src={cls.qrDataUrl!} alt="Sign-in QR code" className="w-44 h-44 rounded-lg" />
            <p className="text-xs text-slate-500 mt-2">Scan to sign in on your phone</p>
          </div>
          <div className="mt-4 flex items-center justify-between">
            <span className="text-sm font-medium text-emerald-700 bg-emerald-50 px-2.5 py-1 rounded-full">
              {cls.signedInCount} signed in{cls.capacity ? ` / ${cls.capacity}` : ''}
            </span>
            <button
              onClick={onManual}
              className="px-4 py-2 bg-blue-800 text-white rounded-lg font-semibold hover:bg-blue-700 active:scale-95 transition-all"
            >
              Sign in here
            </button>
          </div>
        </>
      ) : (
        <div className="mt-4 rounded-lg bg-white/60 border border-slate-200 py-6 text-center">
          <p className="text-sm font-medium text-slate-500">Not open for sign-in yet</p>
          <p className="text-xs text-slate-400 mt-0.5">The trainer will start the class.</p>
        </div>
      )}
    </div>
  )
}
