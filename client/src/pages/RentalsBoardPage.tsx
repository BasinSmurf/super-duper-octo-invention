import { useEffect, useState } from 'react'
import { useNavigate, useLocation, useParams, useSearchParams } from 'react-router-dom'
import { cn } from '@/lib/cn'
import { api } from '@/lib/api'
import { getKioskToken, captureKioskToken } from '@/lib/kioskAuth'
import { deriveJobTypePills } from '@/components/JobTypePills'
import type { RentalComposition } from '@/lib/db-types'
import { Loader2, Truck, ArrowLeft } from 'lucide-react'

/**
 * dispatch = Basin delivers and services on site. walk_in = the customer signs
 * at the counter and carries the gear out. A dispatcher's wall and the front
 * counter want opposite halves of the same three columns, which is why the
 * kiosk roles split on this and not on anything new.
 */
type PickupType = 'dispatch' | 'walk_in'

const PICKUP_LABEL: Record<PickupType, string> = {
  dispatch: 'Dispatch',
  walk_in: 'Walk-in',
}

/** Kiosk path segment -> pickup type. `/kiosk/rentals/WIL/walk_in`. */
function parsePickupType(raw: string | undefined): PickupType | null {
  return raw === 'dispatch' || raw === 'walk_in' ? raw : null
}

// ---------- Types matching the /api/rentals-board response ----------

interface RentalBoardCard {
  id: string
  agreementNumber: string | null
  companyName: string
  padName: string | null
  wellName: string | null
  status: string
  startDate: string
  endDate: string | null
  itemCount: number
  isManned: boolean
  isRigJob: boolean
  monitorsIncluded: boolean
  composition: RentalComposition | null
  pickupType: PickupType
  siteName: string | null
  siteShortCode: string | null
}

interface RentalsBoardResponse {
  generatedAt: string
  /** Echoed back by the server — a kiosk's own provisioning may override what we asked for. */
  pickupType: PickupType | null
  siteId: string | null
  scheduled: RentalBoardCard[]
  active: RentalBoardCard[]
  recentlyClosed: RentalBoardCard[]
}

interface SiteOption { id: string; name: string; shortCode: string }

interface DisplayColumn {
  key: keyof Pick<RentalsBoardResponse, 'scheduled' | 'active' | 'recentlyClosed'>
  title: string
  owner: string
}

const DISPLAY_COLUMNS: DisplayColumn[] = [
  { key: 'scheduled', title: 'Scheduled', owner: 'Dispatched, not yet deployed' },
  { key: 'active', title: 'Active', owner: 'Deployed on-site' },
  { key: 'recentlyClosed', title: 'Recently Closed', owner: 'Wrapped in the last 14 days' },
]

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
async function fetchBoard(
  site: string | null,
  pickupType: PickupType | null,
  signal?: AbortSignal,
): Promise<RentalsBoardResponse> {
  const headers: Record<string, string> = {}
  const jwt = localStorage.getItem('sundog_token')
  if (jwt) headers['Authorization'] = `Bearer ${jwt}`
  const kioskToken = getKioskToken()
  if (kioskToken) headers['X-Kiosk-Token'] = kioskToken

  // A kiosk's filters come from its provisioning, not the URL — the server
  // ignores these for kiosk callers. Sent anyway so the same code path serves
  // both, and so the in-app board's filters work off one implementation.
  const qs = new URLSearchParams()
  if (site) qs.set('site', site)
  if (pickupType) qs.set('pickupType', pickupType)

  const res = await fetch(`/api/rentals-board${qs.toString() ? `?${qs}` : ''}`, { headers, signal })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error || `Board request failed (${res.status})`)
  }
  return res.json()
}

export function RentalsBoardPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const params = useParams<{ siteSlug?: string; pickupType?: string }>()
  const [searchParams] = useSearchParams()

  const kiosk = searchParams.get('kiosk') === '1' || location.pathname.startsWith('/kiosk/')
  const refreshMs = kiosk ? 15_000 : 30_000

  // On a kiosk the site + type are in the path (and enforced server-side from
  // the device token regardless). In-app they're filters the user drives.
  const routeSite = params.siteSlug?.toUpperCase() ?? null
  const routePickup = parsePickupType(params.pickupType)

  const [site, setSite] = useState<string | null>(routeSite)
  const [pickupType, setPickupType] = useState<PickupType | null>(routePickup)
  const [sites, setSites] = useState<SiteOption[]>([])

  const [data, setData] = useState<RentalsBoardResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastLoadedAt, setLastLoadedAt] = useState<Date | null>(null)

  useEffect(() => { captureKioskToken() }, [])

  // Site list for the in-app filter. Kiosks skip it: a wall display is pinned
  // to one shop and has no business enumerating the others.
  useEffect(() => {
    if (kiosk) return
    let cancelled = false
    api.get<{ data: SiteOption[] }>('/sites')
      .then(r => { if (!cancelled) setSites(r.data ?? []) })
      .catch(() => { /* filter degrades to "All sites"; not worth an error banner */ })
    return () => { cancelled = true }
  }, [kiosk])

  useEffect(() => {
    // The in-flight guard is per effect-instance, NOT a component-level ref.
    // A shared ref meant a re-run (StrictMode's double mount, or a filter
    // change) returned immediately while the previous run's fetch was still
    // open — and that previous run then bailed on `cancelled` without ever
    // clearing `loading`. The board sat on its spinner until the next interval
    // tick: 15s on a wall display, 30s in-app, on every filter change.
    const ac = new AbortController()
    let inFlight = false
    let cancelled = false

    async function load() {
      if (inFlight) return // don't let slow ticks stack up
      inFlight = true
      try {
        const res = await fetchBoard(site, pickupType, ac.signal)
        if (cancelled) return
        setData(res)
        setError(null)
        setLastLoadedAt(new Date())
      } catch (e) {
        // An abort is us tearing down, not a failure worth showing.
        if (cancelled || ac.signal.aborted) return
        setError(e instanceof Error ? e.message : 'Failed to load rentals board')
      } finally {
        inFlight = false
        if (!cancelled) setLoading(false)
      }
    }
    load()
    const t = setInterval(load, refreshMs)
    return () => { cancelled = true; ac.abort(); clearInterval(t) }
  }, [refreshMs, site, pickupType])

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
        <p className="text-sm text-red-800 font-medium">Unable to load rentals board</p>
        <p className="text-xs text-red-600 mt-1">{error}</p>
      </div>
    )
  }
  if (!data) return null

  // The server is the authority on what this board actually shows: a kiosk's
  // provisioned role and site override whatever the URL asked for.
  const effectivePickup: PickupType | null = data.pickupType ?? pickupType

  // Only label a site when the board is actually scoped to one. Reading a name
  // off the first card would label an all-sites board with whichever shop
  // happened to sort first.
  const scopedToOneSite = data.siteId !== null
  const siteLabel = !scopedToOneSite
    ? null
    // Prefer the name the server joined onto the cards over the short code in
    // the path, so the wall reads "Williston" and not "WIL".
    : [...data.scheduled, ...data.active, ...data.recentlyClosed].find(c => c.siteName)?.siteName
      ?? sites.find(s => s.shortCode === site)?.name
      ?? site

  return (
    <div className={cn(
      'relative bg-[#181310] text-slate-100',
      kiosk ? 'fixed inset-0 overflow-auto p-4 z-50' : 'pb-12 p-4 rounded-2xl min-h-[calc(100vh-2rem)]',
    )}>
      <div className="relative z-10">
        {/* Header */}
        <div className="rounded-2xl bg-gradient-to-r from-blue-900 to-blue-700 text-white p-5 mb-4 shadow-md">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div>
              <h1 className="text-2xl font-bold flex items-center gap-2">
                <Truck className="w-6 h-6" />
                {/* The board says what it is. A wall display with no title is
                    indistinguishable from the other one hanging next to it. */}
                {effectivePickup ? `${PICKUP_LABEL[effectivePickup]} Rentals` : 'Rentals Board'}
                {siteLabel && <span className="text-white/70 font-semibold">· {siteLabel}</span>}
              </h1>
              <p className="text-sm text-white/80 mt-0.5">
                Live rental status — refreshes every {Math.round(refreshMs / 1000)}s
                {lastLoadedAt && <> · last: {fmtTime(lastLoadedAt.toISOString())}</>}
                {kiosk && ' · KIOSK'}
              </p>
            </div>
            {!kiosk && (
              <div className="flex items-center gap-2 flex-wrap">
                <select
                  value={site ?? ''}
                  onChange={e => setSite(e.target.value || null)}
                  className="px-2.5 py-2 text-sm bg-white/10 hover:bg-white/15 rounded-lg border border-white/15 text-white [&>option]:text-slate-900"
                >
                  <option value="">All sites</option>
                  {sites.map(s => (
                    <option key={s.id} value={s.shortCode}>{s.name}</option>
                  ))}
                </select>
                <select
                  value={pickupType ?? ''}
                  onChange={e => setPickupType(parsePickupType(e.target.value))}
                  className="px-2.5 py-2 text-sm bg-white/10 hover:bg-white/15 rounded-lg border border-white/15 text-white [&>option]:text-slate-900"
                >
                  <option value="">Dispatch + Walk-in</option>
                  <option value="dispatch">Dispatch only</option>
                  <option value="walk_in">Walk-in only</option>
                </select>
                <button
                  onClick={() => navigate('/')}
                  className="flex items-center gap-1.5 px-3 py-2 text-sm bg-white/10 hover:bg-white/20 rounded-lg"
                >
                  <ArrowLeft className="w-4 h-4" />
                  Back to App
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="grid gap-3 pb-3" style={{ gridTemplateColumns: `repeat(${DISPLAY_COLUMNS.length}, minmax(0, 1fr))` }}>
          {DISPLAY_COLUMNS.map(col => {
            const cards = data[col.key]
            return (
              <section key={col.key} className="backdrop-blur-md border border-white/10 bg-white/[0.04] rounded-2xl flex flex-col min-h-[320px] shadow-lg shadow-black/30">
                <div className="px-3 py-3 border-b border-white/10 bg-white/[0.05] rounded-t-2xl">
                  <div className="font-semibold text-white text-sm">{col.title}</div>
                  <div className="text-[11px] text-slate-400 mb-1.5">{col.owner}</div>
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full border border-white/15 bg-white/10 text-[11px] font-medium text-slate-200">
                    {cards.length} {cards.length === 1 ? 'job' : 'jobs'}
                  </span>
                </div>
                <div className="flex flex-col gap-2 p-2 flex-1">
                  {cards.length === 0 ? (
                    <div className="text-xs text-slate-500 text-center py-4 border border-dashed border-white/12 bg-white/[0.02] rounded-lg">
                      Nothing here
                    </div>
                  ) : (
                    cards.map(c => (
                      <Card
                        key={c.id}
                        card={c}
                        // Only annotate what the board isn't already filtered to.
                        showSite={!scopedToOneSite}
                        showPickup={effectivePickup === null}
                        onClick={kiosk ? undefined : () => navigate(`/rentals/${c.id}`)}
                      />
                    ))
                  )}
                </div>
              </section>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function Card({ card, onClick, showSite, showPickup }: {
  card: RentalBoardCard
  onClick?: () => void
  showSite: boolean
  showPickup: boolean
}) {
  const pills = deriveJobTypePills(card)
  const location = [card.padName, card.wellName].filter(Boolean).join(' › ')
  return (
    <button
      onClick={onClick}
      disabled={!onClick}
      className={cn(
        'text-left bg-white/[0.06] backdrop-blur-md border border-white/12 rounded-xl p-3 transition-all shadow-md shadow-black/20',
        onClick && 'hover:bg-white/[0.12] hover:border-white/25',
      )}
    >
      <div className="text-sm font-semibold text-white truncate">{card.companyName}</div>
      {location && <div className="text-xs text-slate-400 truncate">{location}</div>}
      {pills.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1.5">
          {pills.map(p => (
            <span key={p.label} className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-white/15 text-white ring-1 ring-white/25">
              {p.label}
            </span>
          ))}
        </div>
      )}
      <div className="flex items-center gap-3 text-[11px] text-slate-400 mt-2 flex-wrap">
        <span className="font-mono text-slate-500">{card.agreementNumber || 'Pending...'}</span>
        <span>{card.startDate}</span>
        {card.itemCount > 0 && <span>{card.itemCount} item{card.itemCount !== 1 ? 's' : ''}</span>}
        {showPickup && (
          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-200 ring-1 ring-blue-400/30">
            {PICKUP_LABEL[card.pickupType]}
          </span>
        )}
        {showSite && (
          // A rental written before rentals carried a site has nothing to show
          // here; say so rather than leaving a silent gap the eye reads as "mine".
          <span className={cn(
            'text-[10px] font-semibold px-1.5 py-0.5 rounded ring-1',
            card.siteShortCode
              ? 'bg-white/10 text-slate-200 ring-white/20'
              : 'bg-amber-500/15 text-amber-200 ring-amber-400/30',
          )}>
            {card.siteShortCode ?? 'No site'}
          </span>
        )}
      </div>
    </button>
  )
}
