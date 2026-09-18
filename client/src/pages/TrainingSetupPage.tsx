/**
 * TrainingSetupPage — ClassPRO wave 2: Tier-A training locations and
 * trainers + per-date availability. The wave-3 calendar reads both.
 *
 * Locations geocode + cache drive-time-from-shop on save when Google Maps
 * is configured server-side; without it everything is manually enterable
 * (the banner says which mode you're in).
 */
import { useState, useEffect, useCallback, useRef } from 'react'
import { api } from '@/lib/api'
import { db } from '@/lib/db'
import { useAuth } from '@/contexts/AuthContext'
import { hasPermission } from '@/lib/permissions'
import { cn } from '@/lib/cn'
import {
  CalendarDays, MapPin, Users, Plus, Pencil, Loader2, X,
  Building2, Navigation, CalendarX, Trash2, RefreshCw,
} from 'lucide-react'

// ---- Types ----

interface CpLocation {
  id: string
  name: string
  type: 'basin' | 'client' | 'other'
  companyId: string | null
  company: { id: string; name: string } | null
  address: string | null
  city: string | null
  state: string | null
  zip: string | null
  lat: number | null
  lng: number | null
  driveTimeFromShopMin: number | null
  notes: string | null
  isActive: boolean
}

interface Unavailability {
  id: string
  date: string
  reason: string | null
}

interface Trainer {
  id: string
  isActive: boolean
  user: { id: string; name: string; email: string; isActive: boolean }
  unavailability: Unavailability[]
  availableToday: boolean
}

const inputCls = 'w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500'

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div>
      <label className="block text-xs font-medium text-slate-600 mb-1">{label}</label>
      {children}
      {hint && <p className="mt-1 text-[11px] text-slate-400">{hint}</p>}
    </div>
  )
}

function fmtDate(ymd: string): string {
  // date-only string — render without timezone shift
  const [y, m, d] = ymd.slice(0, 10).split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

// ---- Inline company search (Dexie, mirrors TrainingClassEditor's) ----

function CompanyPicker({ value, valueName, onChange }: {
  value: string | null
  valueName: string | null
  onChange: (companyId: string | null, name: string | null) => void
}) {
  const [query, setQuery] = useState(valueName ?? '')
  const [results, setResults] = useState<{ id: string; name: string }[]>([])
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => { setQuery(valueName ?? '') }, [valueName])

  useEffect(() => {
    if (query.length < 2) { setResults([]); return }
    const t = setTimeout(async () => {
      try {
        const q = query.toLowerCase()
        const companies = await db.companies
          .filter(c => c.name.toLowerCase().includes(q) && c.isActive)
          .limit(8)
          .toArray()
        setResults(companies.map(c => ({ id: c.id, name: c.name })))
        setOpen(companies.length > 0)
      } catch {
        setResults([])
      }
    }, 200)
    return () => clearTimeout(t)
  }, [query])

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  return (
    <div ref={boxRef} className="relative">
      <input
        className={inputCls}
        value={query}
        placeholder="Search customers…"
        onChange={e => {
          setQuery(e.target.value)
          if (value) onChange(null, null)
        }}
        onFocus={() => results.length > 0 && setOpen(true)}
      />
      {open && (
        <div className="absolute z-10 mt-1 w-full bg-white border border-slate-200 rounded-lg shadow-lg max-h-56 overflow-y-auto">
          {results.map(c => (
            <button
              key={c.id}
              type="button"
              className="w-full text-left px-3 py-2 text-sm hover:bg-blue-50 flex items-center gap-2"
              onClick={() => { setQuery(c.name); onChange(c.id, c.name); setOpen(false) }}
            >
              <Building2 className="w-3.5 h-3.5 text-slate-400 shrink-0" />
              <span className="truncate">{c.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ---- Locations tab ----

type LocationForm = {
  name: string
  type: 'basin' | 'client' | 'other'
  companyId: string | null
  companyName: string | null
  address: string
  city: string
  state: string
  zip: string
  driveTimeFromShopMin: string
  notes: string
  isActive: boolean
}

const EMPTY_LOCATION: LocationForm = {
  name: '', type: 'client', companyId: null, companyName: null,
  address: '', city: '', state: 'ND', zip: '', driveTimeFromShopMin: '',
  notes: '', isActive: true,
}

function LocationsTab({ canManage }: { canManage: boolean }) {
  const [locations, setLocations] = useState<CpLocation[]>([])
  const [travelAutoCompute, setTravelAutoCompute] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [editing, setEditing] = useState<CpLocation | null>(null)
  const [showDialog, setShowDialog] = useState(false)
  const [form, setForm] = useState<LocationForm>(EMPTY_LOCATION)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [computingId, setComputingId] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ locations: CpLocation[]; travelAutoCompute: boolean }>('/classpro/locations')
      setLocations(res.locations)
      setTravelAutoCompute(res.travelAutoCompute)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load locations')
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => { load() }, [load])

  function openCreate() {
    setEditing(null)
    setForm(EMPTY_LOCATION)
    setSaveError(null)
    setShowDialog(true)
  }

  function openEdit(l: CpLocation) {
    setEditing(l)
    setForm({
      name: l.name,
      type: l.type,
      companyId: l.companyId,
      companyName: l.company?.name ?? null,
      address: l.address ?? '',
      city: l.city ?? '',
      state: l.state ?? '',
      zip: l.zip ?? '',
      driveTimeFromShopMin: l.driveTimeFromShopMin != null ? String(l.driveTimeFromShopMin) : '',
      notes: l.notes ?? '',
      isActive: l.isActive,
    })
    setSaveError(null)
    setShowDialog(true)
  }

  function set<K extends keyof LocationForm>(key: K, value: LocationForm[K]) {
    setForm(f => ({ ...f, [key]: value }))
  }

  async function save() {
    if (!form.name.trim()) { setSaveError('Name is required'); return }
    setSaving(true)
    setSaveError(null)
    const payload = {
      name: form.name.trim(),
      type: form.type,
      companyId: form.type === 'client' ? form.companyId : null,
      address: form.address.trim() || null,
      city: form.city.trim() || null,
      state: form.state.trim() || null,
      zip: form.zip.trim() || null,
      driveTimeFromShopMin: form.driveTimeFromShopMin.trim() ? Number(form.driveTimeFromShopMin) : null,
      notes: form.notes.trim() || null,
      isActive: form.isActive,
    }
    try {
      if (editing) await api.put(`/classpro/locations/${editing.id}`, payload)
      else await api.post('/classpro/locations', payload)
      setShowDialog(false)
      await load()
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Failed to save location')
    } finally {
      setSaving(false)
    }
  }

  async function computeTravel(id: string) {
    setComputingId(id)
    try {
      await api.post(`/classpro/locations/${id}/compute-travel`)
      await load()
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Travel-time recompute failed')
    } finally {
      setComputingId(null)
    }
  }

  if (loading) return <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 text-slate-400 animate-spin" /></div>

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs text-slate-500">
          Reusable training sites. Sessions inherit the cached drive time as their travel buffer.
          {!travelAutoCompute && (
            <span className="text-amber-600"> Google Maps isn't configured — enter drive times manually.</span>
          )}
        </p>
        {canManage && (
          <button onClick={openCreate} className="flex items-center gap-1.5 px-3 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 shrink-0">
            <Plus className="w-4 h-4" /> Add Location
          </button>
        )}
      </div>

      {error && <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800">{error}</div>}

      {locations.length === 0 ? (
        <div className="border-2 border-dashed border-slate-200 rounded-lg p-10 text-center text-sm text-slate-400">
          No training locations yet.
        </div>
      ) : (
        <div className="overflow-x-auto border border-slate-200 rounded-xl">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 text-left text-xs text-slate-500">
                <th className="px-4 py-2.5 font-medium">Location</th>
                <th className="px-4 py-2.5 font-medium">Type</th>
                <th className="px-4 py-2.5 font-medium">Address</th>
                <th className="px-4 py-2.5 font-medium">Drive Time</th>
                <th className="px-4 py-2.5 font-medium">Geocoded</th>
                {canManage && <th className="px-2 py-2.5" />}
              </tr>
            </thead>
            <tbody>
              {locations.map(l => (
                <tr key={l.id} className={cn('border-t border-slate-100 hover:bg-slate-50/50', !l.isActive && 'opacity-50')}>
                  <td className="px-4 py-2.5">
                    <div className="font-medium text-slate-800">{l.name}{!l.isActive && <span className="ml-2 text-xs text-slate-400">(retired)</span>}</div>
                    {l.company && <div className="text-xs text-slate-400">{l.company.name}</div>}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className={cn(
                      'px-1.5 py-0.5 rounded text-xs font-medium',
                      l.type === 'basin' ? 'bg-blue-50 text-blue-700' : l.type === 'client' ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-600',
                    )}>
                      {l.type === 'basin' ? 'Basin Safety' : l.type === 'client' ? 'Client site' : 'Other'}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-slate-600 text-xs">
                    {[l.address, l.city, l.state].filter(Boolean).join(', ') || '—'}
                  </td>
                  <td className="px-4 py-2.5 text-slate-600">
                    {l.driveTimeFromShopMin != null ? `${l.driveTimeFromShopMin} min` : '—'}
                  </td>
                  <td className="px-4 py-2.5">
                    {l.lat != null && l.lng != null ? (
                      <span className="inline-flex items-center gap-1 text-xs text-emerald-600" title={`${l.lat.toFixed(5)}, ${l.lng.toFixed(5)}`}>
                        <Navigation className="w-3.5 h-3.5" /> yes
                      </span>
                    ) : (
                      <span className="text-xs text-slate-400">no</span>
                    )}
                  </td>
                  {canManage && (
                    <td className="px-2 py-2.5 text-right whitespace-nowrap">
                      <button
                        onClick={() => computeTravel(l.id)}
                        disabled={computingId === l.id}
                        className="p-1.5 text-slate-400 hover:text-blue-600 rounded disabled:opacity-50"
                        title="Re-geocode + recompute drive time"
                      >
                        {computingId === l.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                      </button>
                      <button onClick={() => openEdit(l)} className="p-1.5 text-slate-400 hover:text-blue-600 rounded" title="Edit">
                        <Pencil className="w-4 h-4" />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => !saving && setShowDialog(false)}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 sticky top-0 bg-white rounded-t-xl">
              <h2 className="font-semibold text-slate-900">{editing ? `Edit — ${editing.name}` : 'New Training Location'}</h2>
              <button onClick={() => setShowDialog(false)} className="p-1 text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
            </div>

            <div className="p-5 grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="sm:col-span-2">
                <Field label="Name *">
                  <input className={inputCls} value={form.name} onChange={e => set('name', e.target.value)} placeholder="Williston Training Room" />
                </Field>
              </div>

              <Field label="Type">
                <div className="grid grid-cols-3 gap-1">
                  {(['basin', 'client', 'other'] as const).map(t => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => set('type', t)}
                      className={cn(
                        'px-2 py-2 rounded-lg border-2 text-xs font-medium',
                        form.type === t ? 'border-blue-500 bg-blue-50 text-blue-800' : 'border-slate-200 text-slate-600',
                      )}
                    >
                      {t === 'basin' ? 'Basin' : t === 'client' ? 'Client' : 'Other'}
                    </button>
                  ))}
                </div>
              </Field>
              {form.type === 'client' ? (
                <Field label="Customer">
                  <CompanyPicker
                    value={form.companyId}
                    valueName={form.companyName}
                    onChange={(id, name) => setForm(f => ({ ...f, companyId: id, companyName: name }))}
                  />
                </Field>
              ) : <div />}

              <div className="sm:col-span-2">
                <Field label="Street address">
                  <input className={inputCls} value={form.address} onChange={e => set('address', e.target.value)} />
                </Field>
              </div>
              <Field label="City">
                <input className={inputCls} value={form.city} onChange={e => set('city', e.target.value)} />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="State">
                  <input className={inputCls} value={form.state} onChange={e => set('state', e.target.value)} />
                </Field>
                <Field label="ZIP">
                  <input className={inputCls} value={form.zip} onChange={e => set('zip', e.target.value)} />
                </Field>
              </div>

              <Field label="Drive time from shop (min)" hint={travelAutoCompute ? 'Blank = computed automatically from the address.' : 'Google Maps not configured — enter manually.'}>
                <input className={inputCls} type="number" min="0" value={form.driveTimeFromShopMin} onChange={e => set('driveTimeFromShopMin', e.target.value)} />
              </Field>
              <div className="flex items-end pb-1">
                <label className="flex items-center gap-2 text-sm text-slate-700">
                  <input type="checkbox" className="w-4 h-4" checked={form.isActive} onChange={e => set('isActive', e.target.checked)} />
                  Active
                </label>
              </div>

              <div className="sm:col-span-2">
                <Field label="Notes">
                  <textarea className={cn(inputCls, 'min-h-[60px]')} value={form.notes} onChange={e => set('notes', e.target.value)} />
                </Field>
              </div>
            </div>

            {saveError && <div className="mx-5 mb-3 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800">{saveError}</div>}

            <div className="flex justify-end gap-2 px-5 py-4 border-t border-slate-100">
              <button onClick={() => setShowDialog(false)} disabled={saving} className="px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 rounded-lg">Cancel</button>
              <button onClick={save} disabled={saving} className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50">
                {saving && <Loader2 className="w-4 h-4 animate-spin" />}
                {editing ? 'Save' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ---- Trainers tab ----

function TrainersTab({ canManage }: { canManage: boolean }) {
  const [trainers, setTrainers] = useState<Trainer[]>([])
  const [users, setUsers] = useState<{ id: string; name: string }[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [addUserId, setAddUserId] = useState('')
  const [busy, setBusy] = useState(false)

  // Per-trainer "mark unavailable" mini-form
  const [outFor, setOutFor] = useState<string | null>(null)
  const [outDate, setOutDate] = useState('')
  const [outReason, setOutReason] = useState('')

  const load = useCallback(async () => {
    try {
      const [t, u] = await Promise.all([
        api.get<{ trainers: Trainer[] }>('/classpro/trainers'),
        api.get<{ data: { id: string; name: string }[] }>('/users/active'),
      ])
      setTrainers(t.trainers)
      setUsers(u.data)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load trainers')
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => { load() }, [load])

  const trainerUserIds = new Set(trainers.map(t => t.user.id))
  const addableUsers = users.filter(u => !trainerUserIds.has(u.id))

  async function run(fn: () => Promise<unknown>) {
    setBusy(true)
    try {
      await fn()
      await load()
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed')
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 text-slate-400 animate-spin" /></div>

  return (
    <div>
      <div className="flex items-center justify-between mb-3 gap-3">
        <p className="text-xs text-slate-500">
          Who teaches classes, and when they're out. "Available" is computed — active, not marked out
          (and, once sessions land, not mid-class or driving).
        </p>
        {canManage && (
          <div className="flex gap-2 shrink-0">
            <select className={cn(inputCls, 'w-52')} value={addUserId} onChange={e => setAddUserId(e.target.value)}>
              <option value="">Add trainer…</option>
              {addableUsers.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
            <button
              disabled={!addUserId || busy}
              onClick={() => run(async () => { await api.post('/classpro/trainers', { userId: addUserId }); setAddUserId('') })}
              className="flex items-center gap-1.5 px-3 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50"
            >
              <Plus className="w-4 h-4" /> Add
            </button>
          </div>
        )}
      </div>

      {error && <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800">{error}</div>}

      {trainers.length === 0 ? (
        <div className="border-2 border-dashed border-slate-200 rounded-lg p-10 text-center text-sm text-slate-400">
          No trainers yet. Add staff who teach classes.
        </div>
      ) : (
        <div className="space-y-3">
          {trainers.map(t => (
            <div key={t.id} className={cn('border border-slate-200 rounded-xl p-4', !t.isActive && 'opacity-50 bg-slate-50')}>
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-3">
                  <span className={cn('w-2.5 h-2.5 rounded-full shrink-0', t.availableToday ? 'bg-emerald-500' : 'bg-slate-300')} />
                  <div>
                    <div className="font-medium text-slate-800">{t.user.name}</div>
                    <div className="text-xs text-slate-400">
                      {!t.isActive ? 'retired trainer' : t.availableToday ? 'available today' : 'out today'}
                    </div>
                  </div>
                </div>
                {canManage && (
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => { setOutFor(outFor === t.id ? null : t.id); setOutDate(''); setOutReason('') }}
                      className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50"
                    >
                      <CalendarX className="w-3.5 h-3.5" /> Mark out
                    </button>
                    <button
                      disabled={busy}
                      onClick={() => run(() => api.put(`/classpro/trainers/${t.id}`, { isActive: !t.isActive }))}
                      className="px-2.5 py-1.5 text-xs font-medium text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50"
                    >
                      {t.isActive ? 'Retire' : 'Reactivate'}
                    </button>
                  </div>
                )}
              </div>

              {outFor === t.id && canManage && (
                <div className="mt-3 flex flex-wrap items-end gap-2 p-3 bg-slate-50 rounded-lg">
                  <Field label="Date">
                    <input type="date" className={inputCls} value={outDate} onChange={e => setOutDate(e.target.value)} />
                  </Field>
                  <div className="flex-1 min-w-[160px]">
                    <Field label="Reason (optional)">
                      <input className={inputCls} value={outReason} onChange={e => setOutReason(e.target.value)} placeholder="PTO, field job…" />
                    </Field>
                  </div>
                  <button
                    disabled={!outDate || busy}
                    onClick={() => run(async () => {
                      await api.post(`/classpro/trainers/${t.id}/unavailability`, { date: outDate, reason: outReason || undefined })
                      setOutFor(null)
                    })}
                    className="px-3 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50"
                  >
                    Save
                  </button>
                </div>
              )}

              {t.unavailability.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {t.unavailability.map(u => (
                    <span key={u.id} className="inline-flex items-center gap-1.5 px-2 py-1 bg-amber-50 border border-amber-200 text-amber-800 rounded-lg text-xs">
                      <CalendarX className="w-3 h-3" />
                      {fmtDate(u.date)}
                      {u.reason && <span className="text-amber-600">— {u.reason}</span>}
                      {canManage && (
                        <button
                          disabled={busy}
                          onClick={() => run(() => api.delete(`/classpro/trainers/${t.id}/unavailability/${u.id}`))}
                          className="text-amber-400 hover:text-amber-700"
                          title="Remove"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      )}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ---- Employers tab (wave 4) — "kraken = Kraken Oil and Gas" ----
//
// Students type their employer as free text on the QR sign-in; billing splits
// invoices per matched customer. This lists every unmatched employer name
// (roster records + session pre-registrations) with fuzzy suggestions; one
// click backfills the rows and teaches the matcher an alias so the same text
// matches silently forever after.

interface UnmatchedEmployer {
  employerName: string
  variants: string[]
  rosterCount: number
  registrationCount: number
  lastSeen: string
  suggestions: { companyId: string; companyName: string; strength: 1 | 2 | 3 }[]
}

interface EmployerAlias {
  id: string
  alias: string
  company: { id: string; name: string }
}

function EmployersTab({ canManage }: { canManage: boolean }) {
  const [unmatched, setUnmatched] = useState<UnmatchedEmployer[] | null>(null)
  const [aliases, setAliases] = useState<EmployerAlias[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busyName, setBusyName] = useState<string | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  // Manual picks per employer name (when no suggestion fits)
  const [manualPick, setManualPick] = useState<Record<string, { id: string; name: string } | null>>({})

  const load = useCallback(async () => {
    try {
      const [u, a] = await Promise.all([
        api.get<{ unmatched: UnmatchedEmployer[] }>('/training/employers/unmatched'),
        api.get<{ aliases: EmployerAlias[] }>('/training/employers/aliases'),
      ])
      setUnmatched(u.unmatched)
      setAliases(a.aliases)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load employers')
    }
  }, [])
  useEffect(() => { load() }, [load])

  async function confirm(employerName: string, companyId: string, companyName: string) {
    setBusyName(employerName)
    setError(null)
    try {
      const r = await api.post<{ rosterUpdated: number; registrationsUpdated: number }>('/training/employers/match', { employerName, companyId })
      setUnmatched(u => (u ?? []).filter(x => x.employerName !== employerName))
      setFlash(`"${employerName}" → ${companyName} — backfilled ${r.rosterUpdated + r.registrationsUpdated} row(s)`)
      api.get<{ aliases: EmployerAlias[] }>('/training/employers/aliases').then(a => setAliases(a.aliases)).catch(() => {})
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save match')
    } finally {
      setBusyName(null)
    }
  }

  async function removeAlias(id: string) {
    try {
      await api.delete(`/training/employers/aliases/${id}`)
      setAliases(a => a.filter(x => x.id !== id))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to remove alias')
    }
  }

  if (unmatched === null && !error) {
    return <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 text-slate-400 animate-spin" /></div>
  }

  return (
    <div className="space-y-8">
      {error && <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800">{error}</div>}
      {flash && (
        <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-sm text-emerald-800 flex items-center justify-between gap-3">
          <span>{flash}</span>
          <button onClick={() => setFlash(null)} className="text-emerald-500 hover:text-emerald-700 shrink-0"><X className="w-4 h-4" /></button>
        </div>
      )}

      <section>
        <h2 className="text-sm font-semibold text-slate-700 mb-1">Unmatched employers</h2>
        <p className="text-xs text-slate-500 mb-3">
          Free-text employer names from sign-ins and rosters that aren’t tied to a customer yet.
          Matching one backfills every record with that name and remembers it for future sign-ins.
        </p>
        {(unmatched ?? []).length === 0 ? (
          <div className="border-2 border-dashed border-slate-200 rounded-xl p-8 text-center text-sm text-slate-400">
            Everything is matched. 🎉
          </div>
        ) : (
          <div className="space-y-3">
            {(unmatched ?? []).map(u => (
              <div key={u.employerName} className="border border-slate-200 rounded-xl p-4">
                <div className="flex flex-wrap items-center gap-2 mb-2">
                  <span className="px-2 py-0.5 bg-amber-50 text-amber-700 rounded font-medium text-sm">{u.employerName}</span>
                  <span className="text-xs text-slate-500">
                    {u.rosterCount > 0 && `${u.rosterCount} roster record${u.rosterCount === 1 ? '' : 's'}`}
                    {u.rosterCount > 0 && u.registrationCount > 0 && ' · '}
                    {u.registrationCount > 0 && `${u.registrationCount} pre-registration${u.registrationCount === 1 ? '' : 's'}`}
                  </span>
                  {u.variants.length > 1 && (
                    <span className="text-[11px] text-slate-400" title={u.variants.join(', ')}>
                      +{u.variants.length - 1} spelling variant{u.variants.length === 2 ? '' : 's'}
                    </span>
                  )}
                </div>
                {canManage ? (
                  <div className="flex flex-wrap items-center gap-2">
                    {u.suggestions.map(s => (
                      <button
                        key={s.companyId}
                        onClick={() => confirm(u.employerName, s.companyId, s.companyName)}
                        disabled={busyName === u.employerName}
                        className={cn(
                          'flex items-center gap-1.5 px-3 py-1.5 border rounded-lg text-xs font-medium disabled:opacity-50',
                          s.strength >= 2
                            ? 'border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                            : 'border-slate-200 text-slate-600 hover:bg-slate-50',
                        )}
                        title={s.strength >= 2 ? 'Strong match' : 'Possible match'}
                      >
                        <Building2 className="w-3.5 h-3.5" />
                        {s.companyName}
                      </button>
                    ))}
                    <div className="flex items-center gap-2 min-w-[240px]">
                      <div className="flex-1">
                        <CompanyPicker
                          value={manualPick[u.employerName]?.id ?? null}
                          valueName={manualPick[u.employerName]?.name ?? null}
                          onChange={(id, name) => setManualPick(m => ({ ...m, [u.employerName]: id && name ? { id, name } : null }))}
                        />
                      </div>
                      <button
                        onClick={() => {
                          const pick = manualPick[u.employerName]
                          if (pick) confirm(u.employerName, pick.id, pick.name)
                        }}
                        disabled={!manualPick[u.employerName] || busyName === u.employerName}
                        className="shrink-0 px-3 py-2 bg-blue-600 text-white text-xs font-medium rounded-lg hover:bg-blue-700 disabled:opacity-40"
                      >
                        {busyName === u.employerName ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Match'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-slate-400">Ask a training admin to match this employer.</p>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="text-sm font-semibold text-slate-700 mb-1">Learned aliases</h2>
        <p className="text-xs text-slate-500 mb-3">
          Confirmed matches — future sign-ins with these names attach to the customer automatically.
          Removing one stops future auto-matching but doesn’t un-match existing records.
        </p>
        {aliases.length === 0 ? (
          <p className="text-sm text-slate-400">No aliases yet.</p>
        ) : (
          <div className="border border-slate-200 rounded-xl divide-y divide-slate-100">
            {aliases.map(a => (
              <div key={a.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                <span className="font-mono text-xs text-slate-600">{a.alias}</span>
                <span className="text-slate-300">→</span>
                <span className="flex items-center gap-1.5 text-slate-800"><Building2 className="w-3.5 h-3.5 text-slate-400" />{a.company.name}</span>
                {canManage && (
                  <button onClick={() => removeAlias(a.id)} className="ml-auto p-1 text-slate-300 hover:text-red-500" title="Remove alias">
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

// ---- Page shell ----

export function TrainingSetupPage() {
  const { user } = useAuth()
  const canManage = hasPermission(user?.role, 'training:schedule')
  const [tab, setTab] = useState<'locations' | 'trainers' | 'employers'>('locations')

  return (
    <div className="max-w-5xl mx-auto pb-12">
      <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2 mb-1">
        <CalendarDays className="w-6 h-6 text-blue-600" />
        Training Setup
      </h1>
      <p className="text-xs text-slate-500 mb-5">
        Locations and trainers for training scheduling. The class calendar builds on these.
      </p>

      <div className="flex gap-1 mb-5 border-b border-slate-200">
        {([['locations', 'Locations', MapPin], ['trainers', 'Trainers & Availability', Users], ['employers', 'Employer Matching', Building2]] as const).map(([key, label, Icon]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={cn(
              'flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px',
              tab === key ? 'border-blue-600 text-blue-700' : 'border-transparent text-slate-500 hover:text-slate-700',
            )}
          >
            <Icon className="w-4 h-4" /> {label}
          </button>
        ))}
      </div>

      {tab === 'locations' ? <LocationsTab canManage={canManage} /> : tab === 'trainers' ? <TrainersTab canManage={canManage} /> : <EmployersTab canManage={canManage} />}
    </div>
  )
}
