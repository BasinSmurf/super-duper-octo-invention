import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Activity, Loader2, Play } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { cn } from '@/lib/cn'
import { usePermissions } from '@/contexts/PermissionsContext'

interface Processor {
  name: string
  running: boolean
  everBeat: boolean
  lastBeatAgoMs: number | null
  restarts: number
  givenUp: boolean
}

interface SyncSummary {
  equipmentSeen: number
  created: number
  updated: number
  unchanged: number
  issues: number
  errors: string[]
}

interface NovaraStatus {
  configured: boolean
  enabled: boolean
  intervalMs: number
  lastRunAt: string | null
  lastSummary: SyncSummary | null
  lastError: string | null
  lastJob: { status: string; startedAt: string; errorMessage: string | null } | null
  counts: { linkedUnits: number; openIssues: number; expiredUnits: number }
}

function heartbeatAge(ms: number | null): string {
  if (ms === null) return 'No heartbeat yet'
  if (ms < 60_000) return 'Less than a minute ago'
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`
  return `${Math.floor(ms / 3_600_000)}h ${Math.floor(ms % 3_600_000 / 60_000)}m ago`
}

export function NovaraOpsCard({ refreshedAt, onChanged }: {
  refreshedAt: Date | null
  onChanged: () => Promise<void>
}) {
  const { can } = usePermissions()
  const canSync = can('inventory:novara')
  const [status, setStatus] = useState<NovaraStatus | null>(null)
  const [processor, setProcessor] = useState<Processor | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<{ error: boolean; text: string } | null>(null)
  const runRef = useRef(false)

  // Refresh with the Ops dashboard's existing poll and Refresh button.
  useEffect(() => {
    let active = true
    async function load() {
      try {
        const [processors, novara] = await Promise.all([
          api.get<{ processors: Processor[] }>('/admin/ops/processors'),
          canSync ? api.get<NovaraStatus>('/novara/status') : Promise.resolve(null),
        ])
        if (!active) return
        setProcessor(processors.processors.find(p => p.name === 'novara-sync') ?? null)
        setStatus(novara)
        setLoadError(null)
      } catch (err) {
        if (active) setLoadError(err instanceof Error ? err.message : 'Unable to load Novara health')
      }
    }
    void load()
    return () => { active = false }
  }, [refreshedAt, canSync])

  async function doNow() {
    if (runRef.current) return
    runRef.current = true
    setRunning(true)
    setResult(null)
    try {
      const response = await api.post<{ outcome: string; summary: SyncSummary | null }>('/novara/sync', { dryRun: false })
      const summary = response.summary
      setResult({
        error: response.outcome !== 'success' || !!summary?.errors.length,
        text: response.outcome !== 'success'
          ? 'Sync did not complete. Check Novara Sync for details.'
          : summary
            ? `Synced ${summary.equipmentSeen} units: ${summary.created} created, ${summary.updated} updated, ${summary.unchanged} unchanged; ${summary.issues} need review.` +
              (summary.errors.length ? ` ${summary.errors.length} sync errors: ${summary.errors.join('; ')}` : '')
            : 'Novara sync completed.',
      })
    } catch (err) {
      setResult({ error: true, text: err instanceof ApiError && err.status === 409
        ? 'A Novara sync is already running. Wait for it to finish.'
        : err instanceof Error ? err.message : 'Novara sync failed' })
    } finally {
      await onChanged()
      runRef.current = false
      setRunning(false)
    }
  }

  const health = loadError ? 'Health unavailable'
    : status && !status.configured ? 'Not configured'
    : status && !status.enabled ? 'Schedule disabled'
    : !processor ? 'Processor unavailable'
    : processor.givenUp ? 'Watchdog needs attention'
    : !processor.everBeat ? 'Waiting for first heartbeat'
    : processor.running ? 'Heartbeat healthy' : 'Heartbeat stalled'
  const fault = !!loadError || !!processor?.givenUp || !!(processor?.everBeat && !processor.running)
  const syncError = status?.lastJob?.status === 'error'
    ? status.lastJob.errorMessage || status.lastError || 'Last sync failed'
    : status?.lastSummary?.errors.length ? status.lastSummary.errors.join('; ') : null
  const syncRunning = running || status?.lastJob?.status === 'running'

  return (
    <section className="bg-white rounded-lg border border-slate-200 p-4">
      <div className="flex items-center justify-between gap-3 mb-3">
        <h2 className="font-semibold text-slate-800 flex items-center gap-2">
          <Activity className="w-5 h-5 text-teal-600" /> Novara Sync
        </h2>
        {canSync && (
          <button type="button" onClick={() => void doNow()}
            disabled={!status?.configured || !!loadError || !!syncRunning}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed">
            {syncRunning ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
            {syncRunning ? 'Running…' : 'Do now'}
          </button>
        )}
      </div>
      <p className={cn('text-sm font-medium', fault ? 'text-red-700' : processor?.running && status?.enabled !== false ? 'text-emerald-700' : 'text-slate-600')}>{health}</p>
      <p className="text-xs text-slate-500 mt-1">
        {heartbeatAge(processor?.lastBeatAgoMs ?? null)}
        {processor && ` · ${processor.restarts} watchdog restarts`}
      </p>
      {status && (
        <>
          <p className="text-xs text-slate-500 mt-2">
            Scheduled every {Math.round(status.intervalMs / 60_000)}m · Last sync: {status.lastRunAt ? new Date(status.lastRunAt).toLocaleString() : 'Never'}
          </p>
          <div className="grid grid-cols-3 gap-2 text-center mt-3 pt-3 border-t border-slate-100">
            <Stat label="linked units" value={status.counts.linkedUnits} />
            <Stat label="open issues" value={status.counts.openIssues} warn />
            <Stat label="expired units" value={status.counts.expiredUnits} warn />
          </div>
        </>
      )}
      {loadError && <p role="alert" className="text-xs text-red-700 mt-2">{loadError}</p>}
      {syncError && <p className="text-xs text-red-700 mt-2 break-words">{syncError}</p>}
      {result && <p role="status" className={cn('text-xs mt-2 break-words', result.error ? 'text-red-700' : 'text-emerald-700')}>{result.text}</p>}
      {can('page:novara') && <Link to="/admin/novara" className="inline-block text-xs text-blue-600 hover:underline mt-3">Mappings & review queue →</Link>}
    </section>
  )
}

function Stat({ label, value, warn }: { label: string; value: number; warn?: boolean }) {
  return <div>
    <p className={cn('text-xl font-semibold', warn && value > 0 ? 'text-amber-700' : 'text-slate-800')}>{value}</p>
    <p className="text-[11px] text-slate-500">{label}</p>
  </div>
}
