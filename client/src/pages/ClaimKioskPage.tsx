import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { cn } from '@/lib/cn'
import { getKioskToken, captureKioskToken } from '@/lib/kioskAuth'
import { Loader2, WifiOff, Plus } from 'lucide-react'

interface QueueJob {
  id: string
  equipment: string
  serialNumber: string | null
  pieceCount: number
  itemIds: string[]
  createdAt: string
  workOrder: {
    id: string
    workOrderNumber: string
    priority: number
    company: { name: string }
  }
}

interface Tech {
  id: string
  name: string
}

interface QueueResponse {
  generatedAt: string
  site: { id: string; name: string; shortCode: string }
  jobs: QueueJob[]
  techs: Tech[]
}

const REFRESH_MS = 15_000

/** Kiosk fetch — sends the kiosk token, never redirects on 401. */
async function kioskFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const jwt = localStorage.getItem('sundog_token')
  if (jwt) headers['Authorization'] = `Bearer ${jwt}`
  const token = getKioskToken()
  if (token) headers['X-Kiosk-Token'] = token

  const res = await fetch(`/api${path}`, { ...init, headers })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error || `Request failed (${res.status})`)
  }
  return res.json()
}

function waitingLabel(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000))
  if (mins < 60) return `${mins} min`
  const h = Math.floor(mins / 60)
  return `${h}h ${mins % 60}m`
}

function priorityBucket(p: number): 'critical' | 'rush' | 'normal' {
  if (p <= 2) return 'critical'
  if (p <= 4) return 'rush'
  return 'normal'
}

export function ClaimKioskPage() {
  const navigate = useNavigate()
  const { siteSlug } = useParams<{ siteSlug: string }>()
  const [data, setData] = useState<QueueResponse | null>(null)
  const [online, setOnline] = useState(true)
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<QueueJob | null>(null)
  const [claiming, setClaiming] = useState(false)
  const [confirmation, setConfirmation] = useState<string | null>(null)
  const [claimError, setClaimError] = useState<string | null>(null)
  const [now, setNow] = useState(new Date())
  const loadingRef = useRef(false)

  useEffect(() => { captureKioskToken() }, [])

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    let cancelled = false
    async function load() {
      if (loadingRef.current) return
      loadingRef.current = true
      try {
        const res = await kioskFetch<QueueResponse>(`/claim/${siteSlug}/queue`)
        if (cancelled) return
        setData(res)
        setOnline(true)
      } catch {
        if (!cancelled) setOnline(false)
      } finally {
        loadingRef.current = false
        if (!cancelled) setLoading(false)
      }
    }
    load()
    const t = setInterval(load, REFRESH_MS)
    return () => { cancelled = true; clearInterval(t) }
  }, [siteSlug])

  async function claim(tech: Tech) {
    if (!selected) return
    setClaiming(true)
    setClaimError(null)
    const claimedId = selected.id
    const pcs = selected.pieceCount
    try {
      await kioskFetch(`/claim/batch`, {
        method: 'POST',
        body: JSON.stringify({ techUserId: tech.id, itemIds: selected.itemIds }),
      })
      setSelected(null)
      setConfirmation(`${pcs} pc${pcs === 1 ? '' : 's'} claimed by ${tech.name} — get to work`)
      setTimeout(() => setConfirmation(null), 2500)
      // Refresh so the claimed tile drops off the board.
      setData(prev => (prev ? { ...prev, jobs: prev.jobs.filter(j => j.id !== claimedId) } : prev))
    } catch (err) {
      setClaimError(err instanceof Error ? err.message : 'Claim failed')
    } finally {
      setClaiming(false)
    }
  }

  // Offline — read-only displays go blank, but the claim kiosk must say so.
  if (!online && !loading) {
    return (
      <div className="fixed inset-0 z-50 bg-slate-900 text-white flex flex-col items-center justify-center gap-4">
        <WifiOff className="w-20 h-20 text-amber-400" />
        <p className="text-4xl font-bold">CLAIM UNAVAILABLE</p>
        <p className="text-2xl text-slate-300">Use your iPad</p>
      </div>
    )
  }

  if (loading && !data) {
    return (
      <div className="fixed inset-0 z-50 bg-slate-50 flex items-center justify-center">
        <Loader2 className="w-10 h-10 text-slate-400 animate-spin" />
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-50 bg-slate-100 flex flex-col">
      {/* Header */}
      <div className="bg-blue-900 text-white px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Claim a Job</h1>
          <p className="text-sm text-white/70">{data?.site.name} · Receiving</p>
        </div>
        <div className="flex items-center gap-4">
          <button
            onClick={() => navigate('/shop/intake')}
            className="flex items-center gap-2 px-4 py-2 bg-white text-blue-900 rounded-lg font-semibold hover:bg-blue-50 active:scale-95 transition-all"
          >
            <Plus className="w-5 h-5" />
            New Intake
          </button>
          <p className="text-lg font-medium">
            {now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
          </p>
        </div>
      </div>

      {/* Tile grid */}
      <div className="flex-1 overflow-auto p-4">
        {!data || data.jobs.length === 0 ? (
          <div className="h-full flex items-center justify-center text-slate-400 text-2xl">
            Nothing waiting to be claimed
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {data.jobs.map(job => {
              const bucket = priorityBucket(job.workOrder.priority)
              return (
                <button
                  key={job.id}
                  onClick={() => { setSelected(job); setClaimError(null) }}
                  className="text-left bg-white rounded-2xl border-2 border-slate-200 p-4 hover:border-blue-400 active:scale-[0.98] transition-all"
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-lg font-bold text-slate-900 leading-tight">
                      {job.workOrder.company.name}
                    </p>
                    {bucket !== 'normal' && (
                      <span className={cn(
                        'shrink-0 text-[10px] font-bold uppercase px-1.5 py-0.5 rounded-full',
                        bucket === 'critical' ? 'bg-rose-100 text-rose-800' : 'bg-amber-100 text-amber-800',
                      )}>
                        {bucket}
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-blue-700 font-semibold mt-1">{job.workOrder.workOrderNumber}</p>
                  <p className="text-sm text-slate-600 truncate">
                    {job.equipment}
                    {job.serialNumber ? ` · S/N ${job.serialNumber}` : ''}
                  </p>
                  <div className="flex items-center justify-between mt-2">
                    <p className="text-xs text-slate-400">Waiting {waitingLabel(job.createdAt)}</p>
                    <span className={cn(
                      'text-sm font-bold px-2 py-0.5 rounded-full',
                      job.pieceCount > 1 ? 'bg-blue-100 text-blue-800' : 'bg-slate-100 text-slate-600',
                    )}>
                      {job.pieceCount} {job.pieceCount === 1 ? 'pc' : 'pcs'}
                    </span>
                  </div>
                </button>
              )
            })}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="bg-white border-t border-slate-200 px-6 py-2 text-center text-sm text-slate-500">
        {data?.site.name} · {data?.jobs.length ?? 0} waiting
      </div>

      {/* Confirmation flash */}
      {confirmation && (
        <div className="fixed inset-0 z-[60] bg-emerald-600/95 flex items-center justify-center">
          <p className="text-4xl font-bold text-white text-center px-8">{confirmation}</p>
        </div>
      )}

      {/* Select-tech modal */}
      {selected && (
        <div className="fixed inset-0 z-[55] bg-black/50 flex items-center justify-center p-6" onClick={() => setSelected(null)}>
          <div className="bg-white rounded-2xl p-6 w-full max-w-2xl" onClick={e => e.stopPropagation()}>
            <p className="text-xl font-bold text-slate-900">
              Claim {selected.workOrder.workOrderNumber} · {selected.pieceCount} {selected.pieceCount === 1 ? 'pc' : 'pcs'}
            </p>
            <p className="text-sm text-slate-500 mb-4">Tap your name</p>
            {claimError && (
              <div className="mb-3 p-2 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">{claimError}</div>
            )}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 max-h-[50vh] overflow-auto">
              {(data?.techs ?? []).map(tech => (
                <button
                  key={tech.id}
                  onClick={() => claim(tech)}
                  disabled={claiming}
                  className="px-3 py-4 rounded-xl bg-blue-50 border-2 border-blue-100 text-blue-900 font-semibold hover:border-blue-400 active:scale-95 transition-all disabled:opacity-50"
                >
                  {tech.name}
                </button>
              ))}
            </div>
            <button
              onClick={() => setSelected(null)}
              className="mt-4 w-full py-2 text-slate-500 hover:text-slate-700"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
