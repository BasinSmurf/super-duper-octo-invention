/**
 * TrainingCalendarPage — ClassPRO wave 3: the scheduling pane of glass.
 *
 * Month / Week / Agenda views over scheduled sessions, with travel bands
 * (dashed, inherited from the location's cached drive time), in-house vs
 * on-site markers, and per-day trainer outages. "What are we doing this
 * week + who's free."
 *
 * Sessions carry either a Tier-A location (reusable, geocoded) or an ad-hoc
 * address (session metadata only — promotable to a reusable location from
 * the dialog).
 *
 * Wave 4: sessions carry a pre-registration roster + booking customer, and
 * "Make class ticket" pushes ONCE into a draft training ticket (registrations
 * become roster records; the QR sign-in link hangs off the ticket). After the
 * push the ticket is the source of truth — the session just links to it.
 */
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { Link } from 'react-router-dom'
import { api } from '@/lib/api'
import { db } from '@/lib/db'
import { useAuth } from '@/contexts/AuthContext'
import { hasPermission } from '@/lib/permissions'
import { cn } from '@/lib/cn'
import {
  CalendarDays, ChevronLeft, ChevronRight, Plus, X, Loader2,
  MapPin, Building2, Navigation, CalendarX, AlertTriangle, Users,
  Ticket, QrCode, UserPlus, Trash2, ExternalLink,
} from 'lucide-react'

// ---- Types (calendar feed) ----

interface CalSession {
  id: string
  courseId: string
  trainerId: string | null
  locationId: string | null
  adHocAddress: string | null
  date: string
  startTime: string
  endTime: string
  deliveryMode: 'in_house' | 'on_site'
  capacity: number | null
  travelBeforeMin: number
  travelAfterMin: number
  status: 'scheduled' | 'cancelled' | 'pushed' | 'completed'
  ticketId: string | null
  companyId: string | null
  notes: string | null
  course: { id: string; code: string; name: string; durationHours: number | null; cardsOnSite: boolean }
  trainer: { id: string; isActive: boolean; user: { id: string; name: string } } | null
  location: { id: string; name: string; city: string | null; type: string; driveTimeFromShopMin: number | null; companyId: string | null } | null
  company: { id: string; name: string } | null
  _count?: { registrations: number }
}

interface Registration {
  id: string
  studentName: string
  employerName: string | null
  employerCompanyId: string | null
  employerCompany: { id: string; name: string } | null
  contactPhone: string | null
  contactEmail: string | null
  notes: string | null
}

interface CalTrainer { id: string; user: { id: string; name: string } }
interface CalOutage { id: string; trainerId: string; date: string; reason: string | null }

interface CourseOpt { id: string; name: string; isActive: boolean; sortOrder: number }
interface LocationOpt { id: string; name: string; type: string; city: string | null; isActive: boolean; driveTimeFromShopMin: number | null }

// ---- Date helpers (YYYY-MM-DD strings, local) ----

function toYmd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function fromYmd(ymd: string): Date {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(y, m - 1, d)
}
function addDays(ymd: string, n: number): string {
  const d = fromYmd(ymd)
  d.setDate(d.getDate() + n)
  return toYmd(d)
}
/** Sunday-start week. */
function startOfWeek(ymd: string): string {
  const d = fromYmd(ymd)
  return addDays(ymd, -d.getDay())
}
function monthLabel(ymd: string): string {
  return fromYmd(ymd).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
}
function dayLabel(ymd: string): string {
  return fromYmd(ymd).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}
function hmToMin(hm: string): number {
  const [h, m] = hm.split(':').map(Number)
  return h * 60 + m
}
function fmtHm(hm: string): string {
  const [h, m] = hm.split(':').map(Number)
  const ampm = h >= 12 ? 'p' : 'a'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return m === 0 ? `${h12}${ampm}` : `${h12}:${String(m).padStart(2, '0')}${ampm}`
}
const TODAY = toYmd(new Date())

// ---- Small bits ----

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

const STATUS_STYLES: Record<CalSession['status'], string> = {
  scheduled: 'bg-blue-50 border-blue-200 text-blue-900',
  pushed: 'bg-emerald-50 border-emerald-200 text-emerald-900',
  completed: 'bg-slate-50 border-slate-200 text-slate-500',
  cancelled: 'bg-slate-50 border-slate-200 text-slate-400 line-through',
}

function ModeIcon({ mode, className }: { mode: CalSession['deliveryMode']; className?: string }) {
  return mode === 'on_site'
    ? <Navigation className={cn('w-3 h-3', className)} />
    : <Building2 className={cn('w-3 h-3', className)} />
}

/** Dashed travel band — reuses the calendar "unavailable" visual language. */
function TravelBand({ minutes, edge }: { minutes: number; edge: 'before' | 'after' }) {
  if (!minutes) return null
  return (
    <div
      className={cn(
        'px-2 py-0.5 text-[10px] text-slate-500 border-x border-dashed border-slate-300 bg-[repeating-linear-gradient(45deg,transparent,transparent_4px,rgba(100,116,139,0.08)_4px,rgba(100,116,139,0.08)_8px)]',
        edge === 'before' ? 'border-t rounded-t-md' : 'border-b rounded-b-md',
      )}
    >
      ⇄ {minutes} min travel
    </div>
  )
}

function sessionPlace(s: CalSession): string {
  if (s.location) return s.location.name
  if (s.adHocAddress) return s.adHocAddress
  return s.deliveryMode === 'in_house' ? 'In-house' : '—'
}

// ---- Page ----

type View = 'month' | 'week' | 'agenda'

export function TrainingCalendarPage() {
  const { user } = useAuth()
  const canSchedule = hasPermission(user?.role, 'training:schedule')

  const [view, setView] = useState<View>('week')
  const [anchor, setAnchor] = useState(TODAY)

  const [sessions, setSessions] = useState<CalSession[]>([])
  const [trainers, setTrainers] = useState<CalTrainer[]>([])
  const [outages, setOutages] = useState<CalOutage[]>([])
  const [courses, setCourses] = useState<CourseOpt[]>([])
  const [locations, setLocations] = useState<LocationOpt[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Visible range per view
  const [rangeFrom, rangeTo] = useMemo((): [string, string] => {
    if (view === 'week') {
      const start = startOfWeek(anchor)
      return [start, addDays(start, 6)]
    }
    if (view === 'agenda') return [anchor, addDays(anchor, 13)]
    // month: grid spills into neighbor months
    const d = fromYmd(anchor)
    const first = toYmd(new Date(d.getFullYear(), d.getMonth(), 1))
    const last = toYmd(new Date(d.getFullYear(), d.getMonth() + 1, 0))
    const gridStart = startOfWeek(first)
    const gridEnd = addDays(startOfWeek(last), 6)
    return [gridStart, gridEnd]
  }, [view, anchor])

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ sessions: CalSession[]; trainers: CalTrainer[]; unavailability: CalOutage[] }>(
        `/classpro/calendar?from=${rangeFrom}&to=${rangeTo}`,
      )
      setSessions(res.sessions.map(s => ({ ...s, date: s.date.slice(0, 10) })))
      setTrainers(res.trainers)
      setOutages(res.unavailability.map(o => ({ ...o, date: o.date.slice(0, 10) })))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load calendar')
    } finally {
      setLoading(false)
    }
  }, [rangeFrom, rangeTo])
  useEffect(() => { load() }, [load])

  // Dialog reference data — once
  useEffect(() => {
    api.get<{ courses: (CourseOpt & { isActive: boolean })[] }>('/classpro/courses')
      .then(r => setCourses(r.courses.filter(c => c.isActive).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))))
      .catch(() => {})
    api.get<{ locations: LocationOpt[] }>('/classpro/locations')
      .then(r => setLocations(r.locations.filter(l => l.isActive)))
      .catch(() => {})
  }, [])

  // Dialog state
  const [dialogSession, setDialogSession] = useState<CalSession | null>(null)
  const [dialogDate, setDialogDate] = useState<string | null>(null) // create mode prefill
  const openCreate = (date?: string) => { setDialogSession(null); setDialogDate(date ?? anchor) }
  const openEdit = (s: CalSession) => { setDialogSession(s); setDialogDate(null) }
  const closeDialog = () => { setDialogSession(null); setDialogDate(null) }

  const byDay = useMemo(() => {
    const m = new Map<string, CalSession[]>()
    for (const s of sessions) {
      if (!m.has(s.date)) m.set(s.date, [])
      m.get(s.date)!.push(s)
    }
    return m
  }, [sessions])

  const outagesByDay = useMemo(() => {
    const m = new Map<string, CalOutage[]>()
    for (const o of outages) {
      if (!m.has(o.date)) m.set(o.date, [])
      m.get(o.date)!.push(o)
    }
    return m
  }, [outages])

  const trainerName = useCallback(
    (trainerId: string) => trainers.find(t => t.id === trainerId)?.user.name ?? 'Unknown',
    [trainers],
  )

  function step(dir: 1 | -1) {
    if (view === 'week') setAnchor(a => addDays(a, 7 * dir))
    else if (view === 'agenda') setAnchor(a => addDays(a, 14 * dir))
    else {
      const d = fromYmd(anchor)
      setAnchor(toYmd(new Date(d.getFullYear(), d.getMonth() + dir, 1)))
    }
  }

  const headerLabel = view === 'month'
    ? monthLabel(anchor)
    : view === 'week'
      ? `${dayLabel(rangeFrom)} – ${dayLabel(rangeTo)}`
      : `${dayLabel(rangeFrom)} – ${dayLabel(rangeTo)}`

  return (
    <div className="max-w-6xl mx-auto pb-12">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
          <CalendarDays className="w-6 h-6 text-blue-600" />
          Training Calendar
        </h1>
        {canSchedule && (
          <button onClick={() => openCreate()} className="flex items-center gap-1.5 px-3 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700">
            <Plus className="w-4 h-4" /> New Session
          </button>
        )}
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-1">
          <button onClick={() => step(-1)} className="p-2 text-slate-500 hover:bg-slate-100 rounded-lg"><ChevronLeft className="w-4 h-4" /></button>
          <button onClick={() => setAnchor(TODAY)} className="px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-lg">Today</button>
          <button onClick={() => step(1)} className="p-2 text-slate-500 hover:bg-slate-100 rounded-lg"><ChevronRight className="w-4 h-4" /></button>
          <span className="ml-2 text-sm font-semibold text-slate-700">{headerLabel}</span>
        </div>
        <div className="flex rounded-lg border border-slate-200 overflow-hidden">
          {(['month', 'week', 'agenda'] as const).map(v => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={cn(
                'px-3 py-1.5 text-sm font-medium capitalize',
                view === v ? 'bg-blue-600 text-white' : 'text-slate-600 hover:bg-slate-50',
              )}
            >
              {v}
            </button>
          ))}
        </div>
      </div>

      {error && <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800">{error}</div>}

      {loading ? (
        <div className="flex justify-center py-20"><Loader2 className="w-6 h-6 text-slate-400 animate-spin" /></div>
      ) : view === 'month' ? (
        <MonthView
          rangeFrom={rangeFrom} rangeTo={rangeTo} anchor={anchor}
          byDay={byDay} onDayClick={canSchedule ? openCreate : undefined} onSessionClick={openEdit}
        />
      ) : view === 'week' ? (
        <WeekView
          rangeFrom={rangeFrom}
          byDay={byDay} outagesByDay={outagesByDay} trainerName={trainerName}
          onDayClick={canSchedule ? openCreate : undefined} onSessionClick={openEdit}
        />
      ) : (
        <AgendaView
          rangeFrom={rangeFrom} rangeTo={rangeTo}
          byDay={byDay} outagesByDay={outagesByDay} trainerName={trainerName}
          onSessionClick={openEdit}
        />
      )}

      {(dialogSession || dialogDate) && (
        <SessionDialog
          session={dialogSession}
          prefillDate={dialogDate ?? undefined}
          courses={courses}
          locations={locations}
          trainers={trainers}
          allSessions={sessions}
          outages={outages}
          canSchedule={canSchedule}
          onClose={closeDialog}
          onSaved={() => { closeDialog(); load() }}
          onRefresh={load}
        />
      )}
    </div>
  )
}

// ---- Session card (week/agenda) ----

function SessionCard({ s, onClick, compact }: { s: CalSession; onClick: () => void; compact?: boolean }) {
  return (
    <div className="cursor-pointer" onClick={onClick}>
      {!compact && s.deliveryMode === 'on_site' && <TravelBand minutes={s.travelBeforeMin} edge="before" />}
      <div className={cn('border rounded-md px-2 py-1.5 text-xs', STATUS_STYLES[s.status],
        !compact && s.deliveryMode === 'on_site' && (s.travelBeforeMin || s.travelAfterMin) ? 'rounded-none border-x' : '')}>
        <div className="font-semibold flex items-center gap-1">
          <ModeIcon mode={s.deliveryMode} className="shrink-0 opacity-60" />
          <span className="truncate">{s.course.name}</span>
        </div>
        <div className="opacity-80">{fmtHm(s.startTime)}–{fmtHm(s.endTime)}</div>
        <div className="opacity-70 truncate">
          {s.trainer ? s.trainer.user.name : <span className="text-amber-700 font-medium">unassigned</span>}
          {' · '}{sessionPlace(s)}
        </div>
        {((s._count?.registrations ?? 0) > 0 || s.capacity != null) && (
          <div className="opacity-60 flex items-center gap-0.5">
            <Users className="w-2.5 h-2.5" />
            {s._count?.registrations ?? 0}{s.capacity != null ? `/${s.capacity}` : ' registered'}
          </div>
        )}
      </div>
      {!compact && s.deliveryMode === 'on_site' && <TravelBand minutes={s.travelAfterMin} edge="after" />}
    </div>
  )
}

// ---- Month view ----

function MonthView({ rangeFrom, rangeTo, anchor, byDay, onDayClick, onSessionClick }: {
  rangeFrom: string; rangeTo: string; anchor: string
  byDay: Map<string, CalSession[]>
  onDayClick?: (date: string) => void
  onSessionClick: (s: CalSession) => void
}) {
  const days: string[] = []
  for (let d = rangeFrom; d <= rangeTo; d = addDays(d, 1)) days.push(d)
  const anchorMonth = anchor.slice(0, 7)
  return (
    <div className="border border-slate-200 rounded-xl overflow-hidden">
      <div className="grid grid-cols-7 bg-slate-50 text-xs font-medium text-slate-500 border-b border-slate-200">
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => <div key={d} className="px-2 py-1.5 text-center">{d}</div>)}
      </div>
      <div className="grid grid-cols-7">
        {days.map(day => {
          const inMonth = day.slice(0, 7) === anchorMonth
          const daySessions = byDay.get(day) ?? []
          return (
            <div
              key={day}
              className={cn(
                'min-h-[92px] border-b border-r border-slate-100 p-1',
                !inMonth && 'bg-slate-50/60',
                day === TODAY && 'bg-blue-50/40',
                onDayClick && 'cursor-pointer hover:bg-blue-50/60',
              )}
              onClick={() => onDayClick?.(day)}
            >
              <div className={cn('text-xs mb-1', day === TODAY ? 'font-bold text-blue-700' : inMonth ? 'text-slate-600' : 'text-slate-300')}>
                {Number(day.slice(8))}
              </div>
              <div className="space-y-1">
                {daySessions.slice(0, 3).map(s => (
                  <div
                    key={s.id}
                    onClick={e => { e.stopPropagation(); onSessionClick(s) }}
                    className={cn('border rounded px-1 py-0.5 text-[10px] leading-tight truncate cursor-pointer', STATUS_STYLES[s.status])}
                    title={`${s.course.name} ${fmtHm(s.startTime)}–${fmtHm(s.endTime)}`}
                  >
                    <ModeIcon mode={s.deliveryMode} className="inline w-2.5 h-2.5 mr-0.5 opacity-60" />
                    {fmtHm(s.startTime)} {s.course.name}
                  </div>
                ))}
                {daySessions.length > 3 && <div className="text-[10px] text-slate-400 px-1">+{daySessions.length - 3} more</div>}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ---- Week view ----

function WeekView({ rangeFrom, byDay, outagesByDay, trainerName, onDayClick, onSessionClick }: {
  rangeFrom: string
  byDay: Map<string, CalSession[]>
  outagesByDay: Map<string, CalOutage[]>
  trainerName: (id: string) => string
  onDayClick?: (date: string) => void
  onSessionClick: (s: CalSession) => void
}) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(rangeFrom, i))
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-7 gap-2">
      {days.map(day => {
        const daySessions = byDay.get(day) ?? []
        const dayOutages = outagesByDay.get(day) ?? []
        return (
          <div key={day} className={cn('border border-slate-200 rounded-xl p-2 min-h-[160px]', day === TODAY && 'ring-2 ring-blue-200')}>
            <div
              className={cn('text-xs font-semibold mb-2', day === TODAY ? 'text-blue-700' : 'text-slate-600', onDayClick && 'cursor-pointer hover:text-blue-600')}
              onClick={() => onDayClick?.(day)}
              title={onDayClick ? 'New session on this day' : undefined}
            >
              {dayLabel(day)}
            </div>
            <div className="space-y-2">
              {daySessions.map(s => <SessionCard key={s.id} s={s} onClick={() => onSessionClick(s)} />)}
              {daySessions.length === 0 && <div className="text-[11px] text-slate-300">—</div>}
            </div>
            {dayOutages.length > 0 && (
              <div className="mt-2 space-y-1">
                {dayOutages.map(o => (
                  <div key={o.id} className="flex items-center gap-1 text-[10px] text-amber-700 bg-amber-50 border border-dashed border-amber-300 rounded px-1.5 py-0.5">
                    <CalendarX className="w-2.5 h-2.5 shrink-0" />
                    <span className="truncate">{trainerName(o.trainerId)} out{o.reason ? ` — ${o.reason}` : ''}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ---- Agenda view ----

function AgendaView({ rangeFrom, rangeTo, byDay, outagesByDay, trainerName, onSessionClick }: {
  rangeFrom: string; rangeTo: string
  byDay: Map<string, CalSession[]>
  outagesByDay: Map<string, CalOutage[]>
  trainerName: (id: string) => string
  onSessionClick: (s: CalSession) => void
}) {
  const days: string[] = []
  for (let d = rangeFrom; d <= rangeTo; d = addDays(d, 1)) days.push(d)
  const nonEmpty = days.filter(d => (byDay.get(d)?.length ?? 0) > 0 || (outagesByDay.get(d)?.length ?? 0) > 0)
  if (nonEmpty.length === 0) {
    return <div className="border-2 border-dashed border-slate-200 rounded-xl p-10 text-center text-sm text-slate-400">Nothing scheduled in this window.</div>
  }
  return (
    <div className="space-y-4">
      {nonEmpty.map(day => (
        <div key={day}>
          <div className={cn('text-sm font-semibold mb-1.5', day === TODAY ? 'text-blue-700' : 'text-slate-700')}>{dayLabel(day)}</div>
          <div className="space-y-1.5">
            {(byDay.get(day) ?? []).map(s => (
              <div key={s.id} onClick={() => onSessionClick(s)} className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 border rounded-lg px-3 py-2 text-sm cursor-pointer', STATUS_STYLES[s.status])}>
                <span className="font-mono text-xs">{fmtHm(s.startTime)}–{fmtHm(s.endTime)}</span>
                <span className="font-medium">{s.course.name}</span>
                <span className="flex items-center gap-1 text-xs opacity-80"><Users className="w-3 h-3" />{s.trainer ? s.trainer.user.name : 'unassigned'}</span>
                <span className="flex items-center gap-1 text-xs opacity-80"><MapPin className="w-3 h-3" />{sessionPlace(s)}</span>
                {s.deliveryMode === 'on_site' && (s.travelBeforeMin > 0 || s.travelAfterMin > 0) && (
                  <span className="text-xs opacity-70 border border-dashed border-current rounded px-1">⇄ {s.travelBeforeMin}/{s.travelAfterMin}m travel</span>
                )}
                {s.status !== 'scheduled' && <span className="text-[10px] uppercase font-semibold opacity-70">{s.status}</span>}
              </div>
            ))}
            {(outagesByDay.get(day) ?? []).map(o => (
              <div key={o.id} className="flex items-center gap-1.5 text-xs text-amber-700 bg-amber-50 border border-dashed border-amber-300 rounded-lg px-3 py-1.5">
                <CalendarX className="w-3 h-3" />
                {trainerName(o.trainerId)} unavailable{o.reason ? ` — ${o.reason}` : ''}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

// ---- Inline company search (Dexie-backed, mirrors Training Setup's) ----
// Free text is allowed (employer names aren't always customers yet); picking
// from the dropdown attaches the company id, plain typing clears it.

function CompanySearch({ value, companyId, placeholder, onChange }: {
  value: string
  companyId: string | null
  placeholder?: string
  onChange: (name: string, companyId: string | null) => void
}) {
  const [query, setQuery] = useState(value)
  const [results, setResults] = useState<{ id: string; name: string }[]>([])
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => { setQuery(value) }, [value])

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
      <div className="relative">
        <input
          className={cn(inputCls, 'pr-8')}
          value={query}
          placeholder={placeholder ?? 'Search customers…'}
          onChange={e => { setQuery(e.target.value); onChange(e.target.value, null) }}
          onFocus={() => results.length > 0 && setOpen(true)}
        />
        {companyId && <Building2 className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-emerald-600" />}
      </div>
      {open && (
        <div className="absolute z-20 mt-1 w-full bg-white border border-slate-200 rounded-lg shadow-lg max-h-56 overflow-y-auto">
          {results.map(c => (
            <button
              key={c.id}
              type="button"
              className="w-full text-left px-3 py-2 text-sm hover:bg-blue-50 flex items-center gap-2"
              onClick={() => { setQuery(c.name); onChange(c.name, c.id); setOpen(false) }}
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

// ---- Pre-registration roster (wave 4) ----

function RegistrationsSection({ sessionId, capacity, canSchedule }: {
  sessionId: string
  capacity: number | null
  canSchedule: boolean
}) {
  const [regs, setRegs] = useState<Registration[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [draft, setDraft] = useState({
    studentName: '', employerName: '', employerCompanyId: null as string | null,
    contactPhone: '', contactEmail: '',
  })

  useEffect(() => {
    api.get<{ registrations: Registration[] }>(`/classpro/sessions/${sessionId}/registrations`)
      .then(r => setRegs(r.registrations))
      .catch(e => setError(e instanceof Error ? e.message : 'Failed to load roster'))
  }, [sessionId])

  async function add() {
    if (!draft.studentName.trim()) return
    setSaving(true)
    setError(null)
    try {
      const reg = await api.post<Registration>(`/classpro/sessions/${sessionId}/registrations`, {
        studentName: draft.studentName.trim(),
        employerName: draft.employerName.trim() || null,
        // Only send an explicit pick — free text goes through the server matcher.
        ...(draft.employerCompanyId ? { employerCompanyId: draft.employerCompanyId } : {}),
        contactPhone: draft.contactPhone.trim() || null,
        contactEmail: draft.contactEmail.trim() || null,
      })
      setRegs(r => [...(r ?? []), reg])
      // Keep the employer — crews register together; clear the person fields.
      setDraft(d => ({ ...d, studentName: '', contactPhone: '', contactEmail: '' }))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add student')
    } finally {
      setSaving(false)
    }
  }

  async function remove(id: string) {
    try {
      await api.delete(`/classpro/registrations/${id}`)
      setRegs(r => (r ?? []).filter(x => x.id !== id))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to remove student')
    }
  }

  const count = regs?.length ?? 0
  const overCap = capacity != null && count > capacity

  return (
    <div className="border border-slate-200 rounded-lg p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold text-slate-600 flex items-center gap-1.5">
          <Users className="w-3.5 h-3.5" /> Pre-registered students
        </span>
        <span className={cn('text-xs font-medium', overCap ? 'text-amber-600' : 'text-slate-400')}>
          {count}{capacity != null ? ` / ${capacity}` : ''}{overCap ? ' — over capacity' : ''}
        </span>
      </div>

      {regs === null ? (
        <div className="py-3 flex justify-center"><Loader2 className="w-4 h-4 text-slate-300 animate-spin" /></div>
      ) : regs.length === 0 ? (
        <p className="text-xs text-slate-400 mb-2">Nobody pre-registered yet — students can also sign in by QR once the class ticket exists.</p>
      ) : (
        <div className="space-y-1 mb-2">
          {regs.map(r => (
            <div key={r.id} className="flex items-center gap-2 text-xs bg-slate-50 rounded px-2 py-1.5">
              <span className="font-medium text-slate-800">{r.studentName}</span>
              {r.employerName && (
                <span className={cn(
                  'px-1.5 py-0.5 rounded truncate',
                  r.employerCompanyId ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700',
                )} title={r.employerCompany ? `Matched: ${r.employerCompany.name}` : 'No customer match yet'}>
                  {r.employerName}
                </span>
              )}
              <span className="text-slate-400 truncate">{[r.contactPhone, r.contactEmail].filter(Boolean).join(' · ')}</span>
              {canSchedule && (
                <button onClick={() => remove(r.id)} className="ml-auto p-1 text-slate-300 hover:text-red-500 shrink-0">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {canSchedule && (
        <div className="grid grid-cols-2 gap-2">
          <input
            className={inputCls}
            placeholder="Student name"
            value={draft.studentName}
            onChange={e => setDraft(d => ({ ...d, studentName: e.target.value }))}
            onKeyDown={e => { if (e.key === 'Enter') add() }}
          />
          <CompanySearch
            value={draft.employerName}
            companyId={draft.employerCompanyId}
            placeholder="Employer (free text ok)"
            onChange={(name, companyId) => setDraft(d => ({ ...d, employerName: name, employerCompanyId: companyId }))}
          />
          <input
            className={inputCls}
            placeholder="Phone (optional)"
            value={draft.contactPhone}
            onChange={e => setDraft(d => ({ ...d, contactPhone: e.target.value }))}
          />
          <div className="flex gap-2">
            <input
              className={inputCls}
              placeholder="Email (optional)"
              value={draft.contactEmail}
              onChange={e => setDraft(d => ({ ...d, contactEmail: e.target.value }))}
            />
            <button
              onClick={add}
              disabled={saving || !draft.studentName.trim()}
              className="shrink-0 flex items-center gap-1 px-3 py-2 bg-slate-700 text-white text-xs font-medium rounded-lg hover:bg-slate-600 disabled:opacity-40"
            >
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UserPlus className="w-3.5 h-3.5" />} Add
            </button>
          </div>
        </div>
      )}

      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </div>
  )
}

// ---- Create / edit dialog ----

interface SessionForm {
  courseId: string
  trainerId: string
  placeMode: 'in_house' | 'location' | 'adhoc'
  locationId: string
  adHocAddress: string
  saveAdHocAsLocation: boolean
  date: string
  startTime: string
  endTime: string
  capacity: string
  travelBeforeMin: string
  travelAfterMin: string
  notes: string
  companyId: string | null
  companyName: string
}

function SessionDialog({ session, prefillDate, courses, locations, trainers, allSessions, outages, canSchedule, onClose, onSaved, onRefresh }: {
  session: CalSession | null
  prefillDate?: string
  courses: CourseOpt[]
  locations: LocationOpt[]
  trainers: CalTrainer[]
  allSessions: CalSession[]
  outages: CalOutage[]
  canSchedule: boolean
  onClose: () => void
  onSaved: () => void
  onRefresh: () => void
}) {
  const [form, setForm] = useState<SessionForm>(() => session ? {
    courseId: session.courseId,
    trainerId: session.trainerId ?? '',
    placeMode: session.locationId ? 'location' : session.adHocAddress ? 'adhoc' : 'in_house',
    locationId: session.locationId ?? '',
    adHocAddress: session.adHocAddress ?? '',
    saveAdHocAsLocation: false,
    date: session.date,
    startTime: session.startTime,
    endTime: session.endTime,
    capacity: session.capacity != null ? String(session.capacity) : '',
    travelBeforeMin: String(session.travelBeforeMin),
    travelAfterMin: String(session.travelAfterMin),
    notes: session.notes ?? '',
    companyId: session.companyId,
    companyName: session.company?.name ?? '',
  } : {
    courseId: courses[0]?.id ?? '',
    trainerId: '',
    placeMode: 'in_house',
    locationId: '',
    adHocAddress: '',
    saveAdHocAsLocation: false,
    date: prefillDate ?? TODAY,
    startTime: '09:00',
    endTime: '13:00',
    capacity: '',
    travelBeforeMin: '',
    travelAfterMin: '',
    notes: '',
    companyId: null,
    companyName: '',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Wave 4 — "make the class" push + sign-in QR
  const [pushResult, setPushResult] = useState<{ ticketId: string; ticketNumber: string } | null>(null)
  const [pushing, setPushing] = useState(false)
  const [qr, setQr] = useState<{ url: string; qrDataUrl: string } | null>(null)
  const [qrLoading, setQrLoading] = useState(false)
  const ticketId = pushResult?.ticketId ?? session?.ticketId ?? null
  const isPushed = Boolean(pushResult) || session?.status === 'pushed'

  async function makeTicket() {
    if (!session) return
    // Typed but never picked from the dropdown → no companyId; pushing now
    // would silently fall back to Basin Safety. Make the intent explicit.
    if (form.companyName.trim() && !form.companyId) {
      setError('Pick the booking customer from the dropdown — or clear the field to bill the class to Basin Safety.')
      return
    }
    setPushing(true)
    try {
      // Persist the form first so an unsaved customer pick (or any other
      // edit) makes it onto the ticket — the push reads the saved session.
      if (!(await persist())) return
      const r = await api.post<{ ticketId: string; ticketNumber: string }>(`/classpro/sessions/${session.id}/push`, {})
      setPushResult(r)
      onRefresh() // repaint the calendar behind the dialog (session is now 'pushed')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to make the class ticket')
    } finally {
      setPushing(false)
    }
  }

  async function loadQr() {
    if (!ticketId) return
    setQrLoading(true)
    try {
      const r = await api.post<{ url: string; qrDataUrl: string }>(`/train/link/${ticketId}`, {})
      setQr(r)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to generate sign-in link')
    } finally {
      setQrLoading(false)
    }
  }

  function set<K extends keyof SessionForm>(key: K, value: SessionForm[K]) {
    setForm(f => ({ ...f, [key]: value }))
  }

  // Soft conflict warnings (loaded range only): trainer out that day, or
  // overlapping session (incl. travel bands) for the same trainer.
  const conflicts = useMemo(() => {
    if (!form.trainerId || !form.date) return []
    const msgs: string[] = []
    const outage = outages.find(o => o.trainerId === form.trainerId && o.date === form.date)
    if (outage) msgs.push(`Marked unavailable this day${outage.reason ? ` (${outage.reason})` : ''}.`)
    const start = hmToMin(form.startTime || '00:00') - (Number(form.travelBeforeMin) || 0)
    const end = hmToMin(form.endTime || '23:59') + (Number(form.travelAfterMin) || 0)
    for (const s of allSessions) {
      if (s.id === session?.id || s.trainerId !== form.trainerId || s.date !== form.date) continue
      if (s.status === 'cancelled') continue
      const sStart = hmToMin(s.startTime) - s.travelBeforeMin
      const sEnd = hmToMin(s.endTime) + s.travelAfterMin
      if (start < sEnd && end > sStart) msgs.push(`Overlaps ${s.course.name} ${fmtHm(s.startTime)}–${fmtHm(s.endTime)} (incl. travel).`)
    }
    return msgs
  }, [form.trainerId, form.date, form.startTime, form.endTime, form.travelBeforeMin, form.travelAfterMin, allSessions, outages, session])

  const isOnSite = form.placeMode !== 'in_house'

  // Validates + persists the form. Returns true on success; does NOT close
  // the dialog — save() and makeTicket() both build on it.
  async function persist(): Promise<boolean> {
    if (!form.courseId) { setError('Pick a course'); return false }
    if (form.startTime >= form.endTime) { setError('End time must be after start time'); return false }
    if (form.placeMode === 'location' && !form.locationId) { setError('Pick a location (or switch to ad-hoc address)'); return false }
    setError(null)
    try {
      let locationId: string | null = form.placeMode === 'location' ? form.locationId : null
      let adHocAddress: string | null = form.placeMode === 'adhoc' ? form.adHocAddress.trim() || null : null

      // Promote the ad-hoc address to a reusable Tier-A location on request.
      if (form.placeMode === 'adhoc' && form.saveAdHocAsLocation && adHocAddress) {
        const loc = await api.post<{ id: string }>('/classpro/locations', { name: adHocAddress, type: 'other', address: adHocAddress })
        locationId = loc.id
        adHocAddress = null
      }

      const payload: Record<string, unknown> = {
        courseId: form.courseId,
        trainerId: form.trainerId || null,
        locationId,
        adHocAddress,
        date: form.date,
        startTime: form.startTime,
        endTime: form.endTime,
        deliveryMode: isOnSite ? 'on_site' : 'in_house',
        capacity: form.capacity.trim() ? Number(form.capacity) : null,
        notes: form.notes.trim() || null,
        companyId: form.companyId,
      }
      // Only send travel overrides the user actually typed — blank = inherit.
      if (form.travelBeforeMin.trim() !== '') payload.travelBeforeMin = Number(form.travelBeforeMin)
      if (form.travelAfterMin.trim() !== '') payload.travelAfterMin = Number(form.travelAfterMin)

      if (session) await api.put(`/classpro/sessions/${session.id}`, payload)
      else await api.post('/classpro/sessions', payload)
      return true
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save session')
      return false
    }
  }

  async function save() {
    setSaving(true)
    const ok = await persist()
    setSaving(false)
    if (ok) onSaved()
  }

  async function setStatus(status: 'cancelled' | 'scheduled' | 'completed') {
    if (!session) return
    setSaving(true)
    try {
      await api.put(`/classpro/sessions/${session.id}`, { status })
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update status')
    } finally {
      setSaving(false)
    }
  }

  const readOnly = !canSchedule

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => !saving && onClose()}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 sticky top-0 bg-white rounded-t-xl z-10">
          <h2 className="font-semibold text-slate-900">
            {session ? `${session.course.name} — ${dayLabel(session.date)}` : 'New Session'}
            {session && session.status !== 'scheduled' && (
              <span className="ml-2 text-xs uppercase font-bold text-slate-400">{session.status}</span>
            )}
          </h2>
          <button onClick={onClose} className="p-1 text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
        </div>

        <div className="p-5 grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Course *">
            <select className={inputCls} value={form.courseId} onChange={e => set('courseId', e.target.value)} disabled={readOnly}>
              {courses.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          <Field label="Trainer" hint="Blank = hold the slot, assign later.">
            <select className={inputCls} value={form.trainerId} onChange={e => set('trainerId', e.target.value)} disabled={readOnly}>
              <option value="">— unassigned —</option>
              {trainers.map(t => <option key={t.id} value={t.id}>{t.user.name}</option>)}
            </select>
          </Field>

          <Field label="Date *">
            <input type="date" className={inputCls} value={form.date} onChange={e => set('date', e.target.value)} disabled={readOnly} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Start *">
              <input type="time" className={inputCls} value={form.startTime} onChange={e => set('startTime', e.target.value)} disabled={readOnly} />
            </Field>
            <Field label="End *">
              <input type="time" className={inputCls} value={form.endTime} onChange={e => set('endTime', e.target.value)} disabled={readOnly} />
            </Field>
          </div>

          <div className="sm:col-span-2">
            <Field label="Where">
              <div className="grid grid-cols-3 gap-1 mb-2">
                {([['in_house', 'In-house'], ['location', 'Saved site'], ['adhoc', 'Ad-hoc address']] as const).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    disabled={readOnly}
                    onClick={() => set('placeMode', key)}
                    className={cn(
                      'px-2 py-2 rounded-lg border-2 text-xs font-medium',
                      form.placeMode === key ? 'border-blue-500 bg-blue-50 text-blue-800' : 'border-slate-200 text-slate-600',
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {form.placeMode === 'location' && (
                <select className={inputCls} value={form.locationId} onChange={e => set('locationId', e.target.value)} disabled={readOnly}>
                  <option value="">Pick a training site…</option>
                  {locations.map(l => (
                    <option key={l.id} value={l.id}>
                      {l.name}{l.city ? ` — ${l.city}` : ''}{l.driveTimeFromShopMin != null ? ` (${l.driveTimeFromShopMin} min)` : ''}
                    </option>
                  ))}
                </select>
              )}
              {form.placeMode === 'adhoc' && (
                <div className="space-y-2">
                  <input
                    className={inputCls}
                    value={form.adHocAddress}
                    onChange={e => set('adHocAddress', e.target.value)}
                    placeholder="Street address, city, state"
                    disabled={readOnly}
                  />
                  <label className="flex items-center gap-2 text-xs text-slate-600">
                    <input type="checkbox" className="w-3.5 h-3.5" checked={form.saveAdHocAsLocation} onChange={e => set('saveAdHocAsLocation', e.target.checked)} disabled={readOnly} />
                    Save as a reusable training site (name/type editable later in Training Setup)
                  </label>
                </div>
              )}
            </Field>
          </div>

          <div className="sm:col-span-2">
            <Field
              label="Booking customer"
              hint={form.companyId
                ? 'The class ticket bills to this customer; roster employers still split at invoicing.'
                : 'Blank = Basin Safety (client-site sessions use the site’s customer). Roster employers still split at invoicing.'}
            >
              {readOnly ? (
                <input className={inputCls} value={form.companyName} disabled />
              ) : (
                <CompanySearch
                  value={form.companyName}
                  companyId={form.companyId}
                  onChange={(name, companyId) => setForm(f => ({ ...f, companyName: name, companyId }))}
                />
              )}
            </Field>
          </div>

          <Field label="Capacity">
            <input type="number" min="1" className={inputCls} value={form.capacity} onChange={e => set('capacity', e.target.value)} disabled={readOnly} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Travel before (min)" hint={isOnSite ? 'Blank = from the site’s drive time.' : 'In-house: no travel.'}>
              <input type="number" min="0" className={inputCls} value={form.travelBeforeMin} onChange={e => set('travelBeforeMin', e.target.value)} disabled={readOnly || !isOnSite} />
            </Field>
            <Field label="Travel after (min)">
              <input type="number" min="0" className={inputCls} value={form.travelAfterMin} onChange={e => set('travelAfterMin', e.target.value)} disabled={readOnly || !isOnSite} />
            </Field>
          </div>

          <div className="sm:col-span-2">
            <Field label="Notes">
              <textarea className={cn(inputCls, 'min-h-[60px]')} value={form.notes} onChange={e => set('notes', e.target.value)} disabled={readOnly} />
            </Field>
          </div>

          {/* Wave 4 — pre-registration roster (until the push; then the ticket owns it) */}
          {session && !isPushed && session.status !== 'cancelled' && (
            <div className="sm:col-span-2">
              <RegistrationsSection sessionId={session.id} capacity={form.capacity.trim() ? Number(form.capacity) : null} canSchedule={canSchedule} />
            </div>
          )}

          {/* Wave 4 — the class ticket, once made */}
          {ticketId && (
            <div className="sm:col-span-2 border border-emerald-200 bg-emerald-50 rounded-lg p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="flex items-center gap-1.5 text-sm font-medium text-emerald-800">
                  <Ticket className="w-4 h-4" />
                  {pushResult ? `Class ticket ${pushResult.ticketNumber} created` : 'Class ticket exists'}
                </span>
                <Link
                  to={`/tickets/${ticketId}`}
                  className="flex items-center gap-1 px-2.5 py-1 bg-white border border-emerald-300 text-emerald-700 text-xs font-medium rounded-lg hover:bg-emerald-100"
                >
                  <ExternalLink className="w-3 h-3" /> Open ticket
                </Link>
                <button
                  onClick={loadQr}
                  disabled={qrLoading}
                  className="flex items-center gap-1 px-2.5 py-1 bg-white border border-emerald-300 text-emerald-700 text-xs font-medium rounded-lg hover:bg-emerald-100 disabled:opacity-50"
                >
                  {qrLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <QrCode className="w-3 h-3" />} Sign-in QR
                </button>
              </div>
              <p className="mt-1 text-[11px] text-emerald-700/80">
                Roster, sign-ins and close-out happen on the ticket now. Need to undo? Delete or void the ticket — this class returns to ready-to-create with its pre-registrations intact.
              </p>
              {qr && (
                <div className="mt-3 flex flex-col items-center gap-1.5 bg-white border border-emerald-200 rounded-lg p-3">
                  <img src={qr.qrDataUrl} alt="Sign-in QR code" className="w-44 h-44" />
                  <p className="text-[11px] text-slate-500 break-all text-center">{qr.url}</p>
                  <p className="text-[11px] text-slate-400">Students scan to sign in on their phone.</p>
                </div>
              )}
            </div>
          )}
        </div>

        {conflicts.length > 0 && (
          <div className="mx-5 mb-3 p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-800">
            <div className="flex items-center gap-1.5 font-medium mb-1"><AlertTriangle className="w-4 h-4" /> Trainer conflict</div>
            <ul className="list-disc ml-5 space-y-0.5 text-xs">{conflicts.map((c, i) => <li key={i}>{c}</li>)}</ul>
            <p className="text-xs mt-1 opacity-80">You can still save — this is a heads-up, not a block.</p>
          </div>
        )}

        {error && <div className="mx-5 mb-3 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800">{error}</div>}

        {canSchedule && (
          <div className="flex items-center justify-between gap-2 px-5 py-4 border-t border-slate-100">
            <div>
              {session && session.status === 'scheduled' && (
                <button onClick={() => setStatus('cancelled')} disabled={saving} className="px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50 rounded-lg">
                  Cancel session
                </button>
              )}
              {session && session.status === 'cancelled' && (
                <button onClick={() => setStatus('scheduled')} disabled={saving} className="px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 rounded-lg">
                  Restore session
                </button>
              )}
            </div>
            <div className="flex gap-2">
              <button onClick={onClose} disabled={saving} className="px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 rounded-lg">Close</button>
              {session && session.status === 'scheduled' && !pushResult && (
                <button
                  onClick={makeTicket}
                  disabled={pushing || saving}
                  title="Create the draft training ticket — pre-registered students become the roster"
                  className="flex items-center gap-1.5 px-4 py-2 bg-emerald-600 text-white text-sm font-medium rounded-lg hover:bg-emerald-700 disabled:opacity-50"
                >
                  {pushing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Ticket className="w-4 h-4" />}
                  Make class ticket
                </button>
              )}
              {!isPushed && (
                <button onClick={save} disabled={saving} className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50">
                  {saving && <Loader2 className="w-4 h-4 animate-spin" />}
                  {session ? 'Save' : 'Create'}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
