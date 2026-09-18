import { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react'
import { useAuth } from './AuthContext'
import { useOnlineStatus } from '@/hooks/useOnlineStatus'
import { isFieldMobileRole } from '@/lib/roleMobility'
import type { SyncState } from '@/lib/syncEngine'

// ---------------------------------------------------------------------------
// Context shape
// ---------------------------------------------------------------------------

interface SyncContextValue {
  /** Current sync engine state */
  syncState: SyncState
  /** Whether the device has network */
  isOnline: boolean
  /**
   * Whether offline sync is a thing at all for this user (ADR-0005:
   * role-mobility gated, not surface-gated). False for office-only roles —
   * the sync engine + Dexie chunk is never even fetched for them.
   */
  enabled: boolean
  /** Manually trigger a sync now */
  syncNow: () => Promise<void>
  /** Force wipe watermarks and re-hydrate all data */
  forceHydrate: () => Promise<void>
}

const SyncContext = createContext<SyncContextValue | null>(null)

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

const SYNC_INTERVAL = 60_000 // 1 minute
const TRIGGER_THROTTLE = 5_000 // collapse event-driven sync bursts within 5s

const IDLE_STATE: SyncState = {
  status: 'idle',
  lastSyncedAt: null,
  tableCounts: {},
  error: null,
  pendingMutations: 0,
  pushWarnings: [],
}

export function SyncProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth()
  const isOnline = useOnlineStatus()
  const enabled = isFieldMobileRole(user?.role)

  const [syncState, setSyncState] = useState<SyncState>(IDLE_STATE)

  // Track whether we've initialized for this user session
  const initializedRef = useRef(false)
  // Throttle event-driven syncs so a burst of focus/visibility/online events
  // (common on mobile when waking the device) collapses into one push+pull.
  const lastTriggerRef = useRef(0)
  // Holds the dynamically-imported engine once loaded, so syncNow/forceHydrate
  // and the event-driven effect can reach it without a second import.
  const engineRef = useRef<typeof import('@/lib/syncEngine') | null>(null)

  // Wire up sync engine callbacks. The import itself is role-gated — an
  // office-only user's browser never fetches syncEngine.js (and therefore
  // never fetches db.ts's chunk either), not just skips calling it.
  useEffect(() => {
    if (!user || !enabled) {
      engineRef.current?.stopSync()
      initializedRef.current = false
      return
    }

    let cancelled = false
    import('@/lib/syncEngine').then((engine) => {
      if (cancelled) return
      engineRef.current = engine
      engine.initSync({ onStateChange: setSyncState })
      engine.startPeriodicSync(SYNC_INTERVAL)
      initializedRef.current = true
    })

    return () => {
      cancelled = true
      engineRef.current?.stopSync()
    }
  }, [user, enabled])

  // Event-driven resync. iOS Safari has NO Background Sync API, so a backgrounded
  // PWA never gets an OS wake-up to drain the queue. The reliable substitute is
  // to sync the moment the app regains the foreground or the network returns —
  // which is exactly when a field tech drives back into coverage and reopens it.
  //
  // NOTE: do NOT resetStuckMutations() here. pushMutations already retries every
  // pending/error/uploading mutation that's still under MAX_RETRIES, so a plain
  // runFullSync() drains the queue. resetStuckMutations() zeroes retryCount,
  // which — fired on every focus/visibility/online event — let a permanently-
  // rejected mutation revive forever (it could never accumulate to the retry
  // ceiling). That infinite loop is reserved for the explicit "Sync Now" button.
  useEffect(() => {
    if (!user || !enabled) return

    const triggerSync = (force = false) => {
      if (!navigator.onLine) return
      const now = Date.now()
      if (!force && now - lastTriggerRef.current < TRIGGER_THROTTLE) return
      lastTriggerRef.current = now
      engineRef.current?.runFullSync()
    }

    // Network came back — always sync (bypass throttle).
    const onOnline = () => triggerSync(true)
    // App returned to the foreground (tab switch, app resume, screen unlock).
    const onVisible = () => { if (document.visibilityState === 'visible') triggerSync() }
    // Desktop/window focus — covers cases visibilitychange doesn't fire for.
    const onFocus = () => triggerSync()

    window.addEventListener('online', onOnline)
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onFocus)

    return () => {
      window.removeEventListener('online', onOnline)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onFocus)
    }
  }, [user, enabled])

  const syncNow = useCallback(async () => {
    const engine = engineRef.current ?? (enabled ? await import('@/lib/syncEngine') : null)
    if (!engine) return
    engineRef.current = engine
    // Reset any stuck mutations so they get retried
    await engine.resetStuckMutations()
    await engine.runFullSync()
  }, [enabled])

  const forceHydrate = useCallback(async () => {
    const engine = engineRef.current ?? (enabled ? await import('@/lib/syncEngine') : null)
    if (!engine) return
    engineRef.current = engine
    await engine.forceFullHydrate()
  }, [enabled])

  return (
    <SyncContext.Provider value={{ syncState, isOnline, enabled, syncNow, forceHydrate }}>
      {children}
    </SyncContext.Provider>
  )
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useSync(): SyncContextValue {
  const ctx = useContext(SyncContext)
  if (!ctx) throw new Error('useSync must be used within <SyncProvider>')
  return ctx
}
