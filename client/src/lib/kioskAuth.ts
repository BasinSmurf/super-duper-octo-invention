/**
 * Kiosk device token. A kiosk is provisioned with its apiToken; the kiosk
 * URL carries it once as ?token=…, which we move into localStorage and strip
 * from the address bar so it isn't shoulder-surfed off the wall display.
 */

const KIOSK_TOKEN_KEY = 'sundog_kiosk_token'

/** Move a ?token= URL param into localStorage, then strip it from the URL. */
export function captureKioskToken(): void {
  try {
    const url = new URL(window.location.href)
    const token = url.searchParams.get('token')
    if (token) {
      localStorage.setItem(KIOSK_TOKEN_KEY, token)
      url.searchParams.delete('token')
      window.history.replaceState({}, '', url.toString())
    }
  } catch {
    /* noop */
  }
}

export function getKioskToken(): string | null {
  try {
    return localStorage.getItem(KIOSK_TOKEN_KEY)
  } catch {
    return null
  }
}
