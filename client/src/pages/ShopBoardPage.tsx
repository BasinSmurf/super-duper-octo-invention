import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useLocation, useSearchParams } from 'react-router-dom'
import { cn } from '@/lib/cn'
import { getKioskToken, captureKioskToken } from '@/lib/kioskAuth'
import { resolveColumnColors, stageStyle, type ColumnColors } from '@/lib/boardTheme'
import { Loader2, Activity, DollarSign, Hammer, ArrowLeft, CheckCircle2, PauseCircle } from 'lucide-react'

// ---------- Types matching the board response ----------

type ShopBoardColumn =
  | 'incoming'
  | 'received'
  | 'needs_review'
  | 'waiting_approval'
  | 'waiting_parts'
  | 'on_hold'
  | 'in_service'
  | 'qa_testing'
  | 'ready_pickup'
  | 'departing'

/** WI-02 -- why a card is parked. Null unless the card sits in an On-Hold stage. */
interface HoldReason {
  code: string
  label: string
  /** Optional free-text qualifier. Display-only; never parsed. */
  note: string | null
}

interface BoardCard {
  id: string
  workOrderId: string
  workOrderNumber: string
  column: ShopBoardColumn
  status: string
  customer: string
  equipment: string
  title: string
  serviceType: string
  assigned: string
  priority: 'critical' | 'rush' | 'normal'
  priorityRaw: number
  value: number
  daysOpen: number
  hoursInStatus: number
  due: string | null
  flags: string[]
  pieceCount: number
  itemIds: string[]
  bins?: string[]
  holdReason?: HoldReason | null
}

interface BoardResponse {
  generatedAt: string
  site?: { id: string; name: string; shortCode: string }
  stationFilter?: string
  scope?: BoardScope
  theme?: { columnColors?: ColumnColors }
  cards: BoardCard[]
  summary: {
    openCount: number
    openValue: number
    flaggedCount: number
    waitingPartsValue: number
    closedThisWeek: number
    bottleneck: { column: ShopBoardColumn; count: number } | null
  }
}

/**
 * Which half of the shop this board shows. The two wall boards partition the
 * work: `customer` is everything a paying customer dropped off (the board that
 * has always existed, unchanged in spirit), `internal` is Basin's own gear
 * serviced in house. Station benches ask for `all` — a bench works whatever is
 * in front of it. The value rides in the `?scope=` query param.
 */
type BoardScope = 'customer' | 'internal' | 'all'

// ---------- Column definitions ----------
// The server reports 8 granular workflow stages; the wall board collapses them
// into THREE display columns, because three is what a person walking past a
// wall display can actually read. Everything a unit does between arriving and
// being finished is "In Service"; everything that stopped it is "On Hold";
// everything done is "Ready for Pickup". Station kiosks and detail views still
// see the granular stages — collapsing is display-only.
//
// Two stages folded away rather than being deleted, and both still exist as
// statuses that round-trip through the API:
//   WI-01  Re-Test  — a unit awaiting re-test is simply still in service, so
//                     qa_testing folds into In Service.
//   Received         — intake is not a state anyone stands at the wall waiting
//                     on; it folds into In Service too.
// A station kiosk can still be pointed at either bench.
//
// incoming/departing remain as transit columns that render ONLY when they hold
// cards, so the steady-state board is the three columns above. They are not a
// stage — they say a box is physically on a truck between sites. They fill
// themselves from open transfer events, which both a manual inter-site
// transfer and a field-inspection spawn create, so there is nothing to switch
// on: the column appears when a unit is in transit and vanishes when it lands.
//
// A per-site board frames transit directionally (arriving here vs leaving
// here). The all-sites board has no "here" to measure against, so the server
// funnels every in-transit unit into `incoming` and we retitle that column
// "In Transit" — hence `soloTitle`/`soloOwner` below. Departing never fills on
// an all-sites board and so never renders there.

interface DisplayColumn {
  key: string
  title: string
  owner: string
  sources: ShopBoardColumn[]
  transient?: boolean
  /** Title to use when the board isn't scoped to a single site. */
  soloTitle?: string
  soloOwner?: string
}

const DISPLAY_COLUMNS: DisplayColumn[] = [
  { key: 'incoming',     title: 'Incoming',         owner: 'In transit — arriving',        sources: ['incoming'], transient: true,
    soloTitle: 'In Transit', soloOwner: 'Between sites — not yet received' },
  { key: 'in_service',   title: 'In Service',       owner: 'Intake, repair & re-test',     sources: ['received', 'needs_review', 'in_service', 'qa_testing'] },
  { key: 'on_hold',      title: 'On Hold',          owner: 'Approval · parts · vendor',    sources: ['waiting_approval', 'waiting_parts', 'on_hold'] },
  { key: 'ready_pickup', title: 'Ready for Pickup', owner: 'Service admin',                sources: ['ready_pickup'] },
  { key: 'departing',    title: 'Departing',        owner: 'In transit — leaving',         sources: ['departing'], transient: true },
]


// Reverse lookup: granular server column → display column key.
const DISPLAY_FOR_SOURCE: Record<string, string> = {}
for (const col of DISPLAY_COLUMNS) for (const s of col.sources) DISPLAY_FOR_SOURCE[s] = col.key

// A station kiosk points at ONE granular stage, so its heading can no longer be
// looked up from the collapsed display column -- several stages now share one,
// and a re-test bench titled "In Service" would be wrong on the wall.
const STATION_TITLE: Record<string, string> = {
  received: 'Received',
  needs_review: 'Inspecting',
  waiting_approval: 'Waiting Approval',
  waiting_parts: 'Waiting on Parts',
  on_hold: 'On Hold',
  in_service: 'In Service',
  qa_testing: 'Re-Test',
  ready_pickup: 'Ready for Pickup',
}

// WI-02: 'aging' is deliberately absent. The server still emits the flag (other
// surfaces and summary.flaggedCount rely on it) but the service board no longer
// renders age as a pill -- BOARD_HIDDEN_FLAGS below drops it at render time.
// Age now lives in the aging widgets (WI-03), where it is filterable.
//
// 'qa' is relabelled Re-Test: with WI-01 folding the Re-Test column into In
// Service, this pill is now the only thing on the board that says a unit is at
// final inspection rather than in repair. "QA Hold" also read as a blocked
// unit, which it never was.
const FLAG_LABEL: Record<string, string> = {
  parts: 'Waiting on Parts',
  approval: 'Approval Needed',
  qa: 'Re-Test',
  pickup: 'Ready for Pickup',
  outside: 'Outside Vendor',
}

// Flags something else on the card now says better.
//   aging / parts / outside / approval — the On-Hold reason pill is the single
//     "why", and 'parts'/'outside'/'approval' are each just a restatement of
//     the status that reason is derived from ("External vendor" and "Outside
//     Vendor" on the same card).
//   pickup — with the three-column board, this pill only ever appears on cards
//     already sitting under a column headed "Ready for Pickup".
// Everything here is dropped at render; the server still emits the flags.
const BOARD_HIDDEN_FLAGS = new Set(['aging', 'parts', 'outside', 'approval', 'pickup'])

const FLAG_COLOR: Record<string, string> = {
  parts:    'bg-violet-100 text-violet-800',
  approval: 'bg-rose-100 text-rose-800',
  qa:       'bg-emerald-100 text-emerald-800',
  pickup:   'bg-cyan-100 text-cyan-800',
  outside:  'bg-slate-200 text-slate-700',
}

// ---------- Helpers ----------

const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' })
  } catch { return iso }
}

/**
 * Board fetch. Sends the user JWT and/or kiosk token; deliberately does NOT
 * use the shared api client so a transient 401 on a wall display can't bounce
 * the kiosk to the login page.
 */
async function fetchBoard(endpoint: string): Promise<BoardResponse> {
  const headers: Record<string, string> = {}
  const jwt = localStorage.getItem('sundog_token')
  if (jwt) headers['Authorization'] = `Bearer ${jwt}`
  const kioskToken = getKioskToken()
  if (kioskToken) headers['X-Kiosk-Token'] = kioskToken

  const res = await fetch(`/api${endpoint}`, { headers })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error || `Board request failed (${res.status})`)
  }
  return res.json()
}

// ---------- Component ----------

export function ShopBoardPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const params = useParams<{ siteSlug?: string; stationFilter?: string }>()
  const [searchParams] = useSearchParams()

  const siteSlug = params.siteSlug
  const stationFilter = params.stationFilter
  const isStation = !!stationFilter
  const kiosk = searchParams.get('kiosk') === '1' || location.pathname.startsWith('/kiosk/')

  // The board split lives in the route, not in a toggle: an /inhouse path is
  // Basin's own work, anything else is customer work, and the two together are
  // the whole shop. A wall display must never be one stray click away from
  // showing the wrong half, which is what a toggle would make it.
  // Station benches are the exception — they show whatever is on the bench.
  const scope: BoardScope = isStation
    ? 'all'
    : /(^|\/)inhouse(\/|$)/.test(location.pathname) ? 'internal' : 'customer'
  const isInHouse = scope === 'internal'
  const refreshMs = kiosk ? 15_000 : 30_000
  // Opt-in slow auto-scroll for kiosks where a stage (usually On Hold) stacks
  // taller than the screen. Only scrolls when content actually overflows.
  const autoscroll = kiosk && searchParams.get('autoscroll') === '1'

  const endpoint = (stationFilter
    ? `/boards/${siteSlug}/station/${stationFilter}`
    : siteSlug
      ? `/boards/${siteSlug}`
      : '/shop-board') + `?scope=${scope}`

  const [data, setData] = useState<BoardResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastLoadedAt, setLastLoadedAt] = useState<Date | null>(null)
  const loadingRef = useRef(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  const [search, setSearch] = useState('')
  const [priorityFilter, setPriorityFilter] = useState<'all' | 'normal' | 'rush' | 'critical'>('all')

  // Pull a kiosk ?token= out of the URL into localStorage on first paint.
  useEffect(() => { captureKioskToken() }, [])

  useEffect(() => {
    let cancelled = false
    async function load() {
      if (loadingRef.current) return
      loadingRef.current = true
      try {
        const res = await fetchBoard(endpoint)
        if (cancelled) return
        setData(res)
        setError(null)
        setLastLoadedAt(new Date())
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load shop board')
      } finally {
        loadingRef.current = false
        if (!cancelled) setLoading(false)
      }
    }
    load()
    const t = setInterval(load, refreshMs)
    return () => {
      cancelled = true
      clearInterval(t)
      // Release the in-flight guard on teardown. Without this, StrictMode's
      // mount/unmount/remount left the ref stuck true from the first mount's
      // fetch, so the remount's load() bailed out and the abandoned fetch
      // skipped setLoading(false) as cancelled -- the board sat on its spinner
      // until the next interval tick 30s later. Harmless in production (no
      // double-mount), but it is 30s of blank wall in dev.
      loadingRef.current = false
    }
  }, [endpoint, refreshMs])

  // Auto-scroll loop (kiosk + ?autoscroll=1 only). Each tick reads the live
  // overflow: if the board fits on screen it parks at the top and does nothing;
  // if it overflows it eases to the bottom, dwells, then eases back up. Keyed
  // on `ready` (not `data`) so a 15s refresh doesn't reset the cycle.
  const ready = !!data
  useEffect(() => {
    if (!autoscroll || !ready) return
    const PAUSE = 8_000     // dwell at each end, ms
    const SLACK = 8         // px of overflow to ignore (rounding)
    let atTop = true
    let timer = setTimeout(function tick() {
      const el = scrollRef.current
      if (el) {
        const overflow = el.scrollHeight - el.clientHeight
        if (overflow <= SLACK) {
          if (el.scrollTop > 0) el.scrollTo({ top: 0, behavior: 'smooth' })
          atTop = true
        } else {
          atTop = !atTop
          el.scrollTo({ top: atTop ? 0 : overflow, behavior: 'smooth' })
        }
      }
      timer = setTimeout(tick, PAUSE)
    }, PAUSE)
    return () => clearTimeout(timer)
  }, [autoscroll, ready])

  const filtered = useMemo(() => {
    if (!data) return [] as BoardCard[]
    const q = search.trim().toLowerCase()
    return data.cards.filter(c => {
      if (priorityFilter !== 'all' && c.priority !== priorityFilter) return false
      if (q) {
        const blob = `${c.workOrderNumber} ${c.customer} ${c.equipment} ${c.title} ${c.assigned}`.toLowerCase()
        if (!blob.includes(q)) return false
      }
      return true
    })
  }, [data, search, priorityFilter])

  // Admin overrides (from the board response) merged over the built-in defaults.
  const columnColors = useMemo(() => resolveColumnColors(data?.theme?.columnColors), [data?.theme?.columnColors])

  // Parked pieces across every hold stage — the in-house board's headline stat,
  // standing in for the dollar figure that internal work never has.
  const onHoldPieces = useMemo(
    () => filtered
      .filter(c => DISPLAY_FOR_SOURCE[c.column] === 'on_hold')
      .reduce((sum, c) => sum + c.pieceCount, 0),
    [filtered],
  )

  const cardsByColumn = useMemo(() => {
    const map = new Map<string, BoardCard[]>()
    for (const col of DISPLAY_COLUMNS) map.set(col.key, [])
    for (const c of filtered) {
      const key = DISPLAY_FOR_SOURCE[c.column]
      if (key) map.get(key)?.push(c)
    }
    return map
  }, [filtered])

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 text-slate-400 animate-spin" />
      </div>
    )
  }
  if (error && !data) {
    return (
      <div className="max-w-2xl mx-auto p-4 bg-red-50 border border-red-200 rounded-lg">
        <p className="text-sm text-red-800 font-medium">Unable to load shop board</p>
        <p className="text-xs text-red-600 mt-1">{error}</p>
      </div>
    )
  }
  if (!data) return null

  const stationTitle = stationFilter
    ? STATION_TITLE[stationFilter] || stationFilter.replace(/_/g, ' ')
    : null
  const boardName = isInHouse ? 'In-House Board' : 'Service Center Board'
  const boardTitle = stationTitle
    ? stationTitle
    : data.site
      ? `${boardName} — ${data.site.name}`
      : boardName

  return (
    <div
      ref={scrollRef}
      className={cn(
        'relative bg-[#181310] text-slate-100',
        kiosk ? 'fixed inset-0 overflow-auto p-4 z-50' : 'pb-12 p-4 rounded-2xl min-h-[calc(100vh-2rem)]',
      )}
    >
      <div className="relative z-10">
        {/* Header */}
        <div className="rounded-2xl bg-gradient-to-r from-blue-900 to-blue-700 text-white p-5 mb-4 shadow-md">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div>
              <h1 className="text-2xl font-bold flex items-center gap-2">
                <Hammer className="w-6 h-6" /> {boardTitle}
              </h1>
              <p className="text-sm text-white/80 mt-0.5">
                {isStation ? 'Live shop status' : isInHouse ? "Basin's own equipment" : 'Customer equipment'}
                {' — refreshes every '}{Math.round(refreshMs / 1000)}s
                {lastLoadedAt && <> · last: {fmtTime(lastLoadedAt.toISOString())}</>}
                {kiosk && ' · KIOSK'}
                {autoscroll && ' · auto-scroll'}
              </p>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {/* Scorecards live in the header now — frees the full row below for
                  the columns. Hidden on single-column station displays. */}
              {!isStation && (
                <div className="flex items-stretch gap-2">
                  <HeaderStat icon={<Activity className="w-4 h-4" />} label="Open Jobs" value={String(data.summary.openCount)} />
                  {/* Internal work is never invoiced, so a dollar figure on the
                      in-house board would always read $0. Count the parked
                      pieces instead — that is the number it can act on. */}
                  {isInHouse ? (
                    <HeaderStat icon={<PauseCircle className="w-4 h-4" />} label="On Hold" value={`${onHoldPieces} pcs`} />
                  ) : (
                    <HeaderStat icon={<DollarSign className="w-4 h-4" />} label="Waiting on Parts" value={currency.format(data.summary.waitingPartsValue)} />
                  )}
                  <HeaderStat icon={<CheckCircle2 className="w-4 h-4" />} label="Closed This Week" value={String(data.summary.closedThisWeek)} />
                </div>
              )}
              {!kiosk && (
                <button
                  onClick={() => navigate('/')}
                  className="flex items-center gap-1.5 px-3 py-2 text-sm bg-white/10 hover:bg-white/20 rounded-lg"
                >
                  <ArrowLeft className="w-4 h-4" />
                  Back to App
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Filters (full board only, non-kiosk) */}
        {!kiosk && !isStation && (
          <div className="bg-white/[0.04] backdrop-blur-md border border-white/10 rounded-lg p-3 mb-4 flex flex-wrap items-center gap-2 shadow-lg shadow-black/30">
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search WO #, customer, equipment, tech…"
              className="flex-1 min-w-[200px] px-3 py-1.5 bg-white/10 border border-white/15 rounded-lg text-sm text-slate-100 placeholder:text-slate-400 focus:ring-2 focus:ring-blue-400 focus:border-blue-400 outline-none"
            />
            <select
              value={priorityFilter}
              onChange={e => setPriorityFilter(e.target.value as typeof priorityFilter)}
              className="px-2 py-1.5 text-sm border border-white/15 rounded-lg bg-slate-800 text-slate-100"
            >
              <option value="all">All priorities</option>
              <option value="critical">Critical</option>
              <option value="rush">Rush</option>
              <option value="normal">Normal</option>
            </select>
            {(search || priorityFilter !== 'all') && (
              <button
                onClick={() => { setSearch(''); setPriorityFilter('all') }}
                className="text-xs text-slate-400 hover:text-slate-200"
              >
                clear
              </button>
            )}
          </div>
        )}

        {isStation ? (
          /* Single-station display — one wide column of larger cards. */
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 pb-3">
            {filtered.length === 0 ? (
              <div className="col-span-full text-center text-slate-400 py-12 border border-dashed border-white/15 bg-white/[0.03] rounded-lg">
                Nothing queued at this station
              </div>
            ) : (
              filtered.map(c => <Card key={c.id} card={c} scope={scope} onClick={kiosk ? undefined : () => navigate(`/shop/${c.workOrderId}`)} />)
            )}
          </div>
        ) : (
          /* Full board — 5 collapsed display columns on a single row so it fits
             a 1080p wall display. Transit columns appear only when they hold
             cards; the grid width tracks the visible count so it never wraps. */
          <div
            className="grid gap-3 pb-3"
            style={{ gridTemplateColumns: `repeat(${DISPLAY_COLUMNS.filter(col => !col.transient || (cardsByColumn.get(col.key)?.length ?? 0) > 0).length}, minmax(0, 1fr))` }}
          >
            {DISPLAY_COLUMNS.filter(col => !col.transient || (cardsByColumn.get(col.key)?.length ?? 0) > 0).map(col => {
              const cards = cardsByColumn.get(col.key) || []
              const value = cards.reduce((s, c) => s + c.value, 0)
              const pieces = cards.reduce((s, c) => s + c.pieceCount, 0)
              const theme = stageStyle(col.key, columnColors)
              return (
                <section
                  key={col.key}
                  className={cn(
                    'backdrop-blur-md border rounded-2xl flex flex-col min-h-[320px] shadow-lg shadow-black/30',
                    !theme && 'bg-white/[0.04] border-white/10',
                  )}
                  style={theme?.column}
                >
                  <div
                    className={cn(
                      'px-3 py-3 border-b border-white/10 backdrop-blur-md rounded-t-2xl',
                      !theme && 'bg-white/[0.05]',
                    )}
                    style={theme?.header}
                  >
                    <div className="font-semibold text-white text-sm">
                      {(data.site ? col.title : col.soloTitle ?? col.title)}
                    </div>
                    <div className={cn('text-[11px] mb-1.5', theme ? 'text-white/70' : 'text-slate-400')}>
                      {(data.site ? col.owner : col.soloOwner ?? col.owner)}
                    </div>
                    <div className="flex flex-wrap gap-1">
                      <Pill>{cards.length} {cards.length === 1 ? 'job' : 'jobs'}</Pill>
                      {pieces !== cards.length && <Pill>{pieces} pcs</Pill>}
                      {!isInHouse && <Pill>{currency.format(value)}</Pill>}
                    </div>
                  </div>
                  <div className="flex flex-col gap-2 p-2 flex-1">
                    {cards.length === 0 ? (
                      <div className="text-xs text-slate-500 text-center py-4 border border-dashed border-white/12 bg-white/[0.02] rounded-lg">
                        No jobs in this stage
                      </div>
                    ) : (
                      cards.map(c => <Card key={c.id} card={c} scope={scope} onClick={kiosk ? undefined : () => navigate(`/shop/${c.workOrderId}`)} />)
                    )}
                  </div>
                </section>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

// ---------- Sub-components ----------

function HeaderStat({ icon, label, value }: {
  icon: React.ReactNode
  label: string
  value: string
}) {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/10 border border-white/15">
      <span className="text-white/70">{icon}</span>
      <div className="leading-tight">
        <div className="text-[10px] uppercase tracking-wide text-white/60 font-semibold">{label}</div>
        <div className="text-lg font-bold text-white">{value}</div>
      </div>
    </div>
  )
}

function Pill({ children, tone }: { children: React.ReactNode; tone?: 'warn' }) {
  return (
    <span className={cn(
      'inline-flex items-center px-2 py-0.5 rounded-full border text-[11px] font-medium',
      tone === 'warn' ? 'bg-amber-400/15 border-amber-400/40 text-amber-300' : 'bg-white/10 border-white/15 text-slate-200',
    )}>
      {children}
    </span>
  )
}

/**
 * A board card.
 *
 * Carries exactly one elapsed-time readout: days open. "In stage: 46h" was the
 * board's aging display, and on a wall panel a per-stage number that only ever
 * counts up reads as an alarm nobody can act on — that lives in the aging
 * widgets now, where it is filterable. Days open is different: it is how long
 * the customer has been waiting, which does not reset when a unit moves stage,
 * so it stays. What the wall needs alongside it is WHY a unit stopped, which is
 * the hold-reason pill below.
 *
 * The piece count stays too: it is the one number that changes what you do next.
 */
function Card({ card, onClick, scope }: { card: BoardCard; onClick?: () => void; scope: BoardScope }) {
  const visibleFlags = card.flags.filter(f => !BOARD_HIDDEN_FLAGS.has(f))
  const holdReason = card.holdReason
  // On the in-house board every card belongs to Basin, so the customer name is
  // the same word on every card — the kind of work is the useful headline.
  const internal = scope === 'internal'
  return (
    <button
      onClick={onClick}
      disabled={!onClick}
      className={cn(
        'text-left bg-white/[0.06] backdrop-blur-md border border-white/12 rounded-xl p-3 transition-all shadow-md shadow-black/20',
        onClick && 'hover:bg-white/[0.12] hover:border-white/25',
      )}
    >
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <div className="min-w-0">
          <div className="text-[11px] font-bold text-blue-300 truncate">{card.workOrderNumber}</div>
          <div className="text-sm font-semibold text-white truncate">
            {internal ? card.serviceType : card.customer}
          </div>
          <div className="text-xs text-slate-400 truncate">{card.equipment}</div>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1 max-w-[52%]">
          {card.pieceCount > 1 && (
            <span className="text-[11px] font-bold px-1.5 py-0.5 rounded-full bg-white/15 text-white ring-1 ring-white/25">
              {card.pieceCount} pcs
            </span>
          )}
          {holdReason && (
            <span
              title={holdReason.note ?? undefined}
              className={cn(
                'text-[10px] font-bold px-1.5 py-0.5 rounded bg-orange-400/20 text-orange-200 ring-1 ring-orange-400/40',
                holdReason.note && 'underline decoration-dotted underline-offset-2',
              )}
            >
              {holdReason.label}
            </span>
          )}
        </div>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-slate-300">
        <div><span className="text-slate-500">Tech:</span> {card.assigned}</div>
        <div><span className="text-slate-500">Days open:</span> {card.daysOpen}</div>
        {/* Internal work is not billable, so a dollar value on it is noise. */}
        {!internal && <div><span className="text-slate-500">Value:</span> {currency.format(card.value)}</div>}
      </div>
      {card.bins && card.bins.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">
          {card.bins.map(b => (
            <span key={b} className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-teal-500/20 text-teal-200 ring-1 ring-teal-400/30">
              {b}
            </span>
          ))}
        </div>
      )}
      {visibleFlags.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">
          {visibleFlags.map(f => (
            <span key={f} className={cn('text-[10px] font-bold px-1.5 py-0.5 rounded', FLAG_COLOR[f] || 'bg-slate-100 text-slate-600')}>
              {FLAG_LABEL[f] || f}
            </span>
          ))}
        </div>
      )}
    </button>
  )
}
