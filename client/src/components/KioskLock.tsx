import { useEffect, useRef, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '@/contexts/AuthContext'
import { getKioskToken } from '@/lib/kioskAuth'
import { ShieldAlert } from 'lucide-react'

/**
 * Device-scoped idle auto-logout for CLAIM (intake) kiosks.
 *
 * Mounted once, app-wide. The claim board stays open on the device token — the
 * personal login only kicks in when someone opens the intake wizard
 * (/shop/intake is a protected route). The gap that motivated this: that login
 * never expired, so the next person inherited the last person's session.
 *
 * So on a CLAIM kiosk *with an idle-logout window configured*, whenever a user
 * is signed in, we auto-log-out after N idle minutes and return the device to
 * its open board — forcing the next intake to log in fresh.
 *
 * The timer is device-wide on purpose: intake work leaves the claim board for
 * /shop/intake, so a timer scoped to one page would die mid-intake. It stays
 * inert on every non-kiosk device (no kiosk token), on the read-only BOARD /
 * INHOUSE / STATION / TRAINING / RENTALS_* displays, and whenever nobody is
 * signed in.
 */

interface KioskConfig {
  role:
    | 'BOARD' | 'INHOUSE' | 'STATION' | 'CLAIM' | 'TRAINING'
    | 'RENTALS_DISPATCH' | 'RENTALS_WALKIN'
  idleLogoutMinutes: number | null
  site: { shortCode: string }
}

const WARN_SECONDS = 30
// Coalesce ambient activity (pointer moves) so we're not re-arming timers on
// every mousemove; a real user trips this well within the window.
const RESET_THROTTLE_MS = 1000
const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'touchstart', 'mousemove'] as const

export function KioskLock() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const [kiosk, setKiosk] = useState<KioskConfig | null>(null)
  const [warning, setWarning] = useState(false)
  const [secondsLeft, setSecondsLeft] = useState(WARN_SECONDS)

  const warningRef = useRef(false)
  const stayHereRef = useRef<(() => void) | null>(null)

  // Learn this device's kiosk identity once (kiosk-token devices only).
  useEffect(() => {
    const token = getKioskToken()
    if (!token) return
    let cancelled = false
    fetch('/api/kiosks/me', { headers: { 'X-Kiosk-Token': token } })
      .then((r) => (r.ok ? r.json() : null))
      .then((cfg: KioskConfig | null) => { if (!cancelled && cfg) setKiosk(cfg) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  const timeoutMs =
    kiosk?.role === 'CLAIM' && kiosk.idleLogoutMinutes && kiosk.idleLogoutMinutes > 0
      ? kiosk.idleLogoutMinutes * 60_000
      : 0
  const locked = timeoutMs > 0

  const homePath = kiosk ? `/kiosk/claim/${kiosk.site.shortCode}` : '/login'

  const doLogout = useCallback(() => {
    warningRef.current = false
    setWarning(false)
    logout()
    // Return the device to its open board rather than leaving the next person
    // stranded on a half-filled /shop/intake form (which, now signed out, would
    // otherwise bounce to /login). They'll re-auth when they start a new intake.
    navigate(homePath, { replace: true })
  }, [logout, navigate, homePath])

  // Idle countdown — only while a user is signed in on a locked device.
  useEffect(() => {
    if (!locked || !user) return

    let idleId: ReturnType<typeof setTimeout>
    let warnId: ReturnType<typeof setInterval> | undefined
    let lastReset = 0

    const clearAll = () => {
      clearTimeout(idleId)
      if (warnId) clearInterval(warnId)
    }

    const beginWarning = () => {
      warningRef.current = true
      setWarning(true)
      let s = WARN_SECONDS
      setSecondsLeft(s)
      warnId = setInterval(() => {
        s -= 1
        setSecondsLeft(s)
        if (s <= 0) { clearAll(); doLogout() }
      }, 1000)
    }

    const armIdle = () => {
      idleId = setTimeout(beginWarning, Math.max(0, timeoutMs - WARN_SECONDS * 1000))
    }

    const reset = () => {
      // While the warning modal is up, only the explicit button dismisses it —
      // ignore ambient activity so the countdown is meaningful.
      if (warningRef.current) return
      const now = Date.now()
      if (now - lastReset < RESET_THROTTLE_MS) return
      lastReset = now
      clearAll()
      armIdle()
    }

    // Exposed to the "I'm still here" button.
    stayHereRef.current = () => {
      clearAll()
      warningRef.current = false
      setWarning(false)
      armIdle()
    }

    ACTIVITY_EVENTS.forEach((e) => window.addEventListener(e, reset, { passive: true }))
    armIdle()

    return () => {
      clearAll()
      ACTIVITY_EVENTS.forEach((e) => window.removeEventListener(e, reset))
      stayHereRef.current = null
    }
  }, [locked, user, timeoutMs, doLogout])

  if (!locked) return null

  // The board stays open on the device token; we only surface UI for a signed-in
  // intake session, and only once the idle countdown is running.
  if (warning) {
    return (
      <div className="fixed inset-0 z-[110] bg-slate-900/80 flex items-center justify-center p-6">
        <div className="bg-white rounded-2xl p-8 max-w-md w-full text-center">
          <ShieldAlert className="w-14 h-14 text-amber-500 mx-auto mb-3" />
          <p className="text-2xl font-bold text-slate-900">Still there?</p>
          <p className="text-slate-500 mt-1">
            Logging out in <span className="font-bold text-slate-900">{secondsLeft}s</span> to protect
            the next person's login.
          </p>
          <button
            onClick={() => stayHereRef.current?.()}
            className="mt-6 w-full py-4 bg-blue-700 text-white text-lg font-semibold rounded-xl hover:bg-blue-800 active:scale-[0.98] transition-all"
          >
            I'm still here
          </button>
          <button
            onClick={() => doLogout()}
            className="mt-2 w-full py-2 text-slate-500 hover:text-slate-700 text-sm"
          >
            Log out now
          </button>
        </div>
      </div>
    )
  }

  return null
}
