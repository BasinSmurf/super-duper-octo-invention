/**
 * Active-site context for the multi-site expansion.
 *
 * The site a user is "working at" is per-session, not persisted server-side
 * (master doc §5.3). It defaults later phases' board / printer / intake
 * context. Stored in sessionStorage so it survives reloads but resets on a
 * fresh session.
 */

const ACTIVE_SITE_KEY = 'sundog.activeSiteId'
const SITE_CHANGE_EVENT = 'sundog:active-site-change'
const SITE_LIST_KEY = 'sundog.activeSites'

export type CachedSite = { id: string; name: string; shortCode: string }

export function getActiveSiteId(): string | null {
  try {
    return sessionStorage.getItem(ACTIVE_SITE_KEY)
  } catch {
    return null
  }
}

export function setActiveSiteId(id: string): void {
  try {
    sessionStorage.setItem(ACTIVE_SITE_KEY, id)
  } catch {
    /* sessionStorage unavailable — switcher just won't persist */
  }
  // Notify in-session listeners (sessionStorage 'storage' events don't fire in
  // the same tab) so site-scoped views refetch/refilter on switch.
  window.dispatchEvent(new CustomEvent(SITE_CHANGE_EVENT, { detail: id }))
}

export function onActiveSiteChange(handler: (id: string | null) => void): () => void {
  const listener = () => handler(getActiveSiteId())
  window.addEventListener(SITE_CHANGE_EVENT, listener)
  return () => window.removeEventListener(SITE_CHANGE_EVENT, listener)
}

/**
 * Last-known active site list, cached across sessions.
 *
 * Sites are a handful of rows that change roughly never, and there is no Dexie
 * table for them — so a device with no network has no way to answer "which
 * shops exist" and any UI that needs the list falls back to a hardcoded guess.
 * That guess is how a field-inspection intake ended up naming a destination by
 * a short code the server couldn't resolve, silently.
 *
 * localStorage, not sessionStorage: unlike the ACTIVE site (a per-session
 * working context, §5.3), the LIST is device-level reference data and is most
 * useful precisely in the session that starts offline.
 */
export function cacheActiveSites(sites: CachedSite[]): void {
  if (sites.length === 0) return // never cache an empty list over a good one
  try {
    localStorage.setItem(SITE_LIST_KEY, JSON.stringify(sites))
  } catch {
    /* storage unavailable or full — callers treat the cache as best-effort */
  }
}

export function getCachedActiveSites(): CachedSite[] {
  try {
    const raw = localStorage.getItem(SITE_LIST_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // Written by an older build, hand-edited, or half-migrated — anything that
    // isn't a usable {id, name, shortCode} is dropped rather than handed on as
    // a site with an undefined short code, which is the exact failure the
    // cache exists to prevent.
    return parsed.filter(
      (s): s is CachedSite =>
        !!s && typeof s.id === 'string' && typeof s.name === 'string' && typeof s.shortCode === 'string',
    )
  } catch {
    return []
  }
}
