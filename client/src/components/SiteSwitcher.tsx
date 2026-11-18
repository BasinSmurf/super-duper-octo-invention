import { HelpTip } from '@/components/HelpTip'
import { useState, useEffect } from 'react'
import { MapPin } from 'lucide-react'
import { api } from '@/lib/api'
import { getActiveSiteId, setActiveSiteId, cacheActiveSites, getCachedActiveSites } from '@/lib/site'
import { useAuth } from '@/contexts/AuthContext'

interface Site {
  id: string
  name: string
  shortCode: string
}

/**
 * Top-of-sidebar working-site indicator. A dropdown when Basin has more than
 * one active site, a static label when there's only one. Selection persists
 * in sessionStorage (see lib/site.ts).
 */
export function SiteSwitcher() {
  const { user } = useAuth()
  // Seeded from the device cache so a cold offline load still knows which
  // shops exist. Overwritten by the live list the moment the fetch lands.
  const [sites, setSites] = useState<Site[]>(() => getCachedActiveSites())
  const [activeId, setActiveId] = useState<string | null>(getActiveSiteId())

  useEffect(() => {
    api
      .get<{ data: Site[] }>('/sites?active=true')
      .then(({ data }) => {
        setSites(data)
        // This component mounts on every authenticated app load, which makes it
        // the most reliably-warm writer of the cache. Other surfaces (the
        // ticket wizard's return-shop picker) read it instead of falling back
        // to a hardcoded short code.
        cacheActiveSites(data)
        if (data.length === 0) return
        const stored = getActiveSiteId()
        const valid = stored && data.some(s => s.id === stored)
        if (!valid) {
          // No stored choice (or it points at a now-inactive site) — default to
          // the user's configured home site, else the first site alphabetically.
          const home = user?.homeSiteId && data.some(s => s.id === user.homeSiteId)
            ? user.homeSiteId
            : data[0].id
          setActiveSiteId(home)
          setActiveId(home)
        }
      })
      // Offline / server down: keep whatever the cache seeded rather than
      // blanking the switcher, which used to make the site context vanish.
      .catch(() => { /* keep cached list */ })
  }, [user?.homeSiteId])

  if (sites.length === 0) return null

  const active = sites.find(s => s.id === activeId) ?? sites[0]

  function handleChange(id: string) {
    setActiveSiteId(id)
    setActiveId(id)
  }

  if (sites.length === 1) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-700 text-sm text-slate-300">
        <MapPin className="w-4 h-4 text-slate-400 shrink-0" />
        <span className="font-medium truncate">{active.name}</span>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-700">
      <MapPin className="w-4 h-4 text-slate-400 shrink-0" />
      <select
        value={active.id}
        onChange={e => handleChange(e.target.value)}
        className="flex-1 min-w-0 bg-slate-800 text-white text-sm rounded-md border border-slate-700 px-2 py-1.5 focus:ring-2 focus:ring-blue-500 outline-none"
      >
        {sites.map(s => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
      <HelpTip text="Choose your working site. This selection is saved for this session; your account home site supplies the default." />
    </div>
  )
}
