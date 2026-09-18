import { registerSW } from 'virtual:pwa-register'

type SwCallbacks = {
  onNeedRefresh: () => void
  onOfflineReady: () => void
}

let updateSWFn: ((reloadPage?: boolean) => Promise<void>) | null = null

/**
 * Initialize the service worker registration with Workbox/vite-plugin-pwa.
 * Call once on app startup.
 */
export function initServiceWorker(callbacks: SwCallbacks) {
  updateSWFn = registerSW({
    onNeedRefresh() {
      callbacks.onNeedRefresh()
    },
    onOfflineReady() {
      callbacks.onOfflineReady()
    },
    onRegisteredSW(_swUrl, registration) {
      // Periodic update check every 60 minutes
      if (registration) {
        setInterval(() => {
          registration.update()
        }, 60 * 60 * 1000)
      }
    },
  })
}

/**
 * Trigger the waiting service worker to activate (skip waiting + reload).
 *
 * Bulletproof flow — the vite-plugin-pwa updateSW() can silently no-op if
 * its captured registration doesn't see a `waiting` worker (happens on
 * iOS standalone PWA and after a toast re-fires). We:
 *   1. Ask it to send SKIP_WAITING (no reload — we drive that).
 *   2. Independently look up the registration ourselves and post
 *      SKIP_WAITING to any waiting worker we find, as a backstop.
 *   3. Wait briefly for `controllerchange`; if it never fires, force a
 *      reload anyway so the user isn't left staring at a flashing button.
 */
export async function applyServiceWorkerUpdate() {
  const reload = () => window.location.reload()

  // Race: whichever trigger lands first wins.
  let reloaded = false
  const reloadOnce = () => {
    if (reloaded) return
    reloaded = true
    reload()
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('controllerchange', reloadOnce, { once: true })
  }

  // 1. Plugin-managed path
  try {
    if (updateSWFn) await updateSWFn(false)
  } catch {
    // ignore — we have a backstop below
  }

  // 2. Direct-registration backstop
  try {
    if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.getRegistration()
      if (reg?.waiting) {
        reg.waiting.postMessage({ type: 'SKIP_WAITING' })
      } else if (reg) {
        // No waiting worker — trigger a fresh update check. If one
        // shows up, post to it. If not, we still reload below.
        await reg.update().catch(() => {})
        reg.waiting?.postMessage({ type: 'SKIP_WAITING' })
      }
    }
  } catch {
    // ignore
  }

  // 3. Hard-timeout reload. If `controllerchange` already fired, this is a noop.
  setTimeout(reloadOnce, 1500)
}
