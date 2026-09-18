import { useState, useEffect } from 'react'
import { api } from '@/lib/api'
import { useAuth } from '@/contexts/AuthContext'
import { hasPermission } from '@/lib/permissions'
import { Monitor, Plus, Copy } from 'lucide-react'

interface Site {
  id: string
  name: string
  shortCode: string
}

// BOARD and INHOUSE are the same wall kanban pointed at the two halves of the
// shop: BOARD shows customer work, INHOUSE shows Basin's own. They configure
// identically — only the URL the kiosk is handed differs.
type KioskRole =
  | 'BOARD' | 'INHOUSE' | 'STATION' | 'CLAIM' | 'TRAINING'
  | 'RENTALS_DISPATCH' | 'RENTALS_WALKIN'

interface CpLocation {
  id: string
  name: string
}

interface Kiosk {
  id: string
  slug: string
  displayName: string
  siteId: string
  role: KioskRole
  stationFilter: string | null
  idleLogoutMinutes: number | null
  active: boolean
  apiToken: string
  lastSeenAt: string | null
  site: Site
}

interface KioskForm {
  slug: string
  displayName: string
  siteId: string
  role: KioskRole
  stationFilter: string
  idleLogoutMinutes: string
}

// Granular stages a bench display can be pinned to. These are ShopItemStatus
// slices, not wall-board columns — the wall collapses several of these into
// one column, but a bench still wants exactly its own.
const STATION_OPTIONS = [
  'received',
  'needs_review',
  'waiting_approval',
  'waiting_parts',
  'in_service',
  'qa_testing',
  'ready_pickup',
]

const EMPTY_FORM: KioskForm = { slug: '', displayName: '', siteId: '', role: 'BOARD', stationFilter: 'received', idleLogoutMinutes: '' }

// "INHOUSE" on its own doesn't say which board a device is showing, and the two
// board roles are otherwise indistinguishable in the list.
const ROLE_LABEL: Record<KioskRole, string> = {
  BOARD: 'BOARD · customer',
  INHOUSE: 'BOARD · in-house',
  STATION: 'STATION',
  CLAIM: 'CLAIM',
  TRAINING: 'TRAINING',
  RENTALS_DISPATCH: 'RENTALS · dispatch',
  RENTALS_WALKIN: 'RENTALS · walk-in',
}

/** Rentals kiosk roles -> the pickup-type segment in their board URL. */
const RENTALS_PICKUP_SEGMENT: Partial<Record<KioskRole, string>> = {
  RENTALS_DISPATCH: 'dispatch',
  RENTALS_WALKIN: 'walk_in',
}

function kioskUrl(k: Kiosk): string {
  const origin = window.location.origin
  const code = k.site.shortCode
  if (k.role === 'INHOUSE') return `${origin}/kiosk/inhouse/${code}?token=${k.apiToken}`
  if (k.role === 'STATION') return `${origin}/kiosk/station/${code}/${k.stationFilter}?token=${k.apiToken}`
  if (k.role === 'CLAIM') return `${origin}/kiosk/claim/${code}?token=${k.apiToken}`
  if (k.role === 'TRAINING') return `${origin}/kiosk/training/${code}?token=${k.apiToken}`
  const pickup = RENTALS_PICKUP_SEGMENT[k.role]
  if (pickup) return `${origin}/kiosk/rentals/${code}/${pickup}?token=${k.apiToken}`
  return `${origin}/kiosk/board/${code}?token=${k.apiToken}`
}

export function KiosksPage() {
  const [kiosks, setKiosks] = useState<Kiosk[]>([])
  const [sites, setSites] = useState<Site[]>([])
  const [locations, setLocations] = useState<CpLocation[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState<KioskForm>(EMPTY_FORM)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const { user } = useAuth()
  const canManage = hasPermission(user?.role, 'system:config')

  useEffect(() => {
    loadAll()
  }, [])

  async function loadAll() {
    setLoading(true)
    try {
      const [kioskRes, siteRes, locRes] = await Promise.all([
        api.get<{ data: Kiosk[] }>('/kiosks'),
        api.get<{ data: Site[] }>('/sites?active=true'),
        api.get<{ locations: CpLocation[] }>('/classpro/locations').catch(() => ({ locations: [] })),
      ])
      setKiosks(kioskRes.data)
      setSites(siteRes.data)
      setLocations(locRes.locations ?? [])
    } catch {
      setKiosks([])
    } finally {
      setLoading(false)
    }
  }

  async function handleCreate() {
    if (!form.slug.trim() || !form.displayName.trim() || !form.siteId) {
      setError('Slug, display name, and site are required')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await api.post('/kiosks', {
        slug: form.slug,
        displayName: form.displayName,
        siteId: form.siteId,
        role: form.role,
        stationFilter:
          form.role === 'STATION' ? form.stationFilter
          : form.role === 'TRAINING' ? (form.stationFilter || undefined)
          : undefined,
        idleLogoutMinutes: form.role === 'CLAIM' ? (form.idleLogoutMinutes.trim() || 0) : undefined,
      })
      setCreating(false)
      setForm(EMPTY_FORM)
      loadAll()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Create failed')
    } finally {
      setBusy(false)
    }
  }

  async function toggleActive(k: Kiosk) {
    setBusy(true)
    setError(null)
    try {
      await api.put(`/kiosks/${k.id}`, { active: !k.active })
      loadAll()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Update failed')
    } finally {
      setBusy(false)
    }
  }

  async function saveIdleLogout(k: Kiosk, raw: string) {
    const next = raw.trim() === '' ? 0 : Number(raw)
    if ((k.idleLogoutMinutes ?? 0) === next) return
    setBusy(true)
    setError(null)
    try {
      await api.put(`/kiosks/${k.id}`, { idleLogoutMinutes: next })
      loadAll()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Update failed')
    } finally {
      setBusy(false)
    }
  }

  async function copyUrl(k: Kiosk) {
    try {
      await navigator.clipboard.writeText(kioskUrl(k))
      setCopied(k.id)
      setTimeout(() => setCopied(null), 2000)
    } catch {
      setError('Could not copy to clipboard')
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Kiosks</h1>
          {!loading && <p className="text-sm text-slate-500">{kiosks.length} provisioned displays</p>}
        </div>
        {canManage && !creating && (
          <button
            onClick={() => { setCreating(true); setForm({ ...EMPTY_FORM, siteId: sites[0]?.id || '' }); setError(null) }}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium"
          >
            <Plus className="w-4 h-4" />
            Provision Kiosk
          </button>
        )}
      </div>

      {error && (
        <div className="mb-4 p-3 rounded-lg border border-red-200 bg-red-50 text-sm text-red-700 flex items-start gap-2">
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)} className="text-red-400 hover:text-red-600 leading-none">&times;</button>
        </div>
      )}

      {creating && (
        <div className="mb-4 bg-white rounded-lg border border-blue-200 p-4">
          <p className="font-medium text-slate-900 mb-3">New Kiosk</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] font-medium text-slate-500 block mb-1">Slug</label>
              <input
                type="text"
                value={form.slug}
                onChange={e => setForm({ ...form, slug: e.target.value.toLowerCase() })}
                placeholder="wil-receiving"
                className="w-full px-2 py-1.5 text-sm font-mono border border-slate-300 rounded"
              />
            </div>
            <div>
              <label className="text-[10px] font-medium text-slate-500 block mb-1">Display Name</label>
              <input
                type="text"
                value={form.displayName}
                onChange={e => setForm({ ...form, displayName: e.target.value })}
                placeholder="Williston Receiving"
                className="w-full px-2 py-1.5 text-sm border border-slate-300 rounded"
              />
            </div>
            <div>
              <label className="text-[10px] font-medium text-slate-500 block mb-1">Site</label>
              <select
                value={form.siteId}
                onChange={e => setForm({ ...form, siteId: e.target.value })}
                className="w-full px-2 py-1.5 text-sm border border-slate-300 rounded"
              >
                <option value="">Select site…</option>
                {sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div>
              <label className="text-[10px] font-medium text-slate-500 block mb-1">Role</label>
              <select
                value={form.role}
                onChange={e => {
                  const role = e.target.value as KioskRole
                  // STATION needs a column; TRAINING's filter is an optional
                  // location (blank = all classes); others don't use it.
                  setForm({ ...form, role, stationFilter: role === 'STATION' ? 'received' : '' })
                }}
                className="w-full px-2 py-1.5 text-sm border border-slate-300 rounded"
              >
                <option value="BOARD">Board — full kanban (customer work)</option>
                <option value="INHOUSE">In-House Board — full kanban (Basin's own work)</option>
                <option value="STATION">Station — single column</option>
                <option value="CLAIM">Claim — touch (Phase 4)</option>
                <option value="TRAINING">Training — classroom sign-in</option>
                <option value="RENTALS_DISPATCH">Rentals — dispatch (Basin delivers)</option>
                <option value="RENTALS_WALKIN">Rentals — walk-in (counter pickup)</option>
              </select>
            </div>
            {form.role === 'STATION' && (
              <div>
                <label className="text-[10px] font-medium text-slate-500 block mb-1">Station Column</label>
                <select
                  value={form.stationFilter}
                  onChange={e => setForm({ ...form, stationFilter: e.target.value })}
                  className="w-full px-2 py-1.5 text-sm border border-slate-300 rounded"
                >
                  {STATION_OPTIONS.map(s => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
                </select>
              </div>
            )}
            {form.role === 'TRAINING' && (
              <div>
                <label className="text-[10px] font-medium text-slate-500 block mb-1">Classroom (optional)</label>
                <select
                  value={form.stationFilter}
                  onChange={e => setForm({ ...form, stationFilter: e.target.value })}
                  className="w-full px-2 py-1.5 text-sm border border-slate-300 rounded"
                >
                  <option value="">All of today's classes</option>
                  {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
                <p className="text-[10px] text-slate-400 mt-0.5">
                  Pin to a training location to show only that room's classes, or leave blank to show every class today.
                </p>
              </div>
            )}
            {form.role === 'CLAIM' && (
              <div>
                <label className="text-[10px] font-medium text-slate-500 block mb-1">Auto-logout (min)</label>
                <input
                  type="number"
                  min={0}
                  max={240}
                  value={form.idleLogoutMinutes}
                  onChange={e => setForm({ ...form, idleLogoutMinutes: e.target.value })}
                  placeholder="0 = no auto-logout"
                  className="w-full px-2 py-1.5 text-sm border border-slate-300 rounded"
                />
                <p className="text-[10px] text-slate-400 mt-0.5">
                  Board stays open; a signed-in intake session auto-logs-out after this many idle minutes so the next intake logs in fresh.
                </p>
              </div>
            )}
          </div>
          <div className="flex justify-end gap-2 mt-3">
            <button onClick={() => { setCreating(false); setError(null) }} className="px-3 py-1.5 text-sm text-slate-600 hover:text-slate-900">
              Cancel
            </button>
            <button onClick={handleCreate} disabled={busy} className="px-4 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50">
              {busy ? 'Saving...' : 'Provision'}
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-center py-12 text-slate-400">Loading...</div>
      ) : kiosks.length === 0 ? (
        <div className="text-center py-12 text-slate-400">No kiosks provisioned</div>
      ) : (
        <div className="space-y-2">
          {kiosks.map(k => (
            <div key={k.id} className={`bg-white rounded-lg border p-4 ${k.active ? 'border-slate-200' : 'border-slate-200 opacity-60'}`}>
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-blue-50 flex items-center justify-center shrink-0">
                  <Monitor className="w-5 h-5 text-blue-600" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="font-medium text-slate-900">{k.displayName}</p>
                    <span className="font-mono text-xs bg-slate-100 px-1.5 py-0.5 rounded">{k.slug}</span>
                    <span className="text-xs bg-blue-50 text-blue-600 px-1.5 py-0.5 rounded">
                      {ROLE_LABEL[k.role] ?? k.role}
                      {k.role === 'STATION' && k.stationFilter ? ` · ${k.stationFilter.replace(/_/g, ' ')}` : ''}
                      {k.role === 'TRAINING'
                        ? ` · ${k.stationFilter ? (locations.find(l => l.id === k.stationFilter)?.name ?? 'room') : 'all classes'}`
                        : ''}
                    </span>
                    {k.role === 'CLAIM' && (
                      <span className={`text-xs px-1.5 py-0.5 rounded ${k.idleLogoutMinutes ? 'bg-amber-50 text-amber-700' : 'bg-slate-100 text-slate-500'}`}>
                        {k.idleLogoutMinutes ? `intake logout · ${k.idleLogoutMinutes}m idle` : 'no auto-logout'}
                      </span>
                    )}
                    {!k.active && <span className="text-xs bg-slate-200 text-slate-600 px-1.5 py-0.5 rounded">Inactive</span>}
                  </div>
                  <div className="flex items-center gap-2 text-sm text-slate-500 flex-wrap">
                    <span>{k.site.name}</span>
                    <span className="text-xs text-slate-400">
                      {k.lastSeenAt ? `last seen ${new Date(k.lastSeenAt).toLocaleString()}` : 'never seen'}
                    </span>
                  </div>
                </div>
                {canManage && (
                  <div className="flex items-center gap-1 shrink-0">
                    {k.role === 'CLAIM' && (
                      <label className="flex items-center gap-1 text-xs text-slate-500 mr-1">
                        <span className="hidden sm:inline">logout</span>
                        <input
                          type="number"
                          min={0}
                          max={240}
                          defaultValue={k.idleLogoutMinutes ?? 0}
                          disabled={busy}
                          onBlur={e => saveIdleLogout(k, e.target.value)}
                          className="w-14 px-1.5 py-1 text-xs border border-slate-300 rounded disabled:opacity-50"
                          title="Idle minutes before an intake session auto-logs-out (0 = off)"
                        />
                        <span>min</span>
                      </label>
                    )}
                    <button
                      onClick={() => copyUrl(k)}
                      className="flex items-center gap-1 text-xs px-2 py-1 rounded border border-slate-300 text-slate-600 hover:bg-slate-50"
                    >
                      <Copy className="w-3 h-3" /> {copied === k.id ? 'Copied!' : 'Kiosk URL'}
                    </button>
                    <button
                      onClick={() => toggleActive(k)}
                      disabled={busy}
                      className="text-xs px-2 py-1 rounded border border-slate-300 text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                    >
                      {k.active ? 'Disable' : 'Enable'}
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
