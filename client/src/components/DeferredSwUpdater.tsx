import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import { applyServiceWorkerUpdate } from '@/lib/sw-register'

/** Routes that hold unsaved in-memory form state — never auto-reload on these.
 *  Covers the ticket wizard (/tickets/new, /tickets/:id/edit), shop intake,
 *  and the point-of-sale screen. */
function isEditingRoute(path: string): boolean {
  return (
    path.endsWith('/new') ||
    path.endsWith('/edit') ||
    path.startsWith('/shop/intake') ||
    path.startsWith('/pos')
  )
}

/**
 * Deferred auto-update.
 *
 * A new service worker installs and precaches silently in the background, then
 * sits "waiting" (registerType: 'prompt' keeps it from self-activating). This
 * applies it — skip-waiting + reload — on the next navigation that lands on a
 * NON-editing route. Net effect: the fleet self-updates without anyone tapping
 * the refresh toast, but a tech is never reloaded out of a half-filled wizard.
 *
 * The visible tap-to-refresh toast (SwUpdatePrompt) stays as a manual override.
 * And if a device only ever sits on editing routes, the waiting worker still
 * activates on the next cold launch (when all clients are closed).
 */
export function DeferredSwUpdater({ pending }: { pending: boolean }) {
  const location = useLocation()
  const pendingRef = useRef(pending)

  useEffect(() => {
    pendingRef.current = pending
  }, [pending])

  // Intentionally keyed on pathname ONLY — this must fire on navigation, not
  // when `pending` flips. An update that arrives while the user is sitting
  // still waits for their next move rather than yanking the page out from
  // under them. (pending is read via ref so it's current without being a dep.)
  useEffect(() => {
    if (!pendingRef.current) return
    if (isEditingRoute(location.pathname)) return
    void applyServiceWorkerUpdate()
  }, [location.pathname])

  return null
}
