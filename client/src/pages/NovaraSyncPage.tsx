/**
 * NovaraSyncPage — admin surface for the Novara Flex equipment/compliance sync.
 *
 * Three jobs, in the order an admin actually needs them:
 *   1. Is it running, and what did the last run do.
 *   2. Map Novara equipment types to SP products — the gate on auto-create —
 *      and point Novara inspection schedules at SP due-date columns.
 *   3. Work the review queue of units the sync could not land.
 *
 * The queue self-drains: adding the missing mapping and re-running resolves the
 * rows, so nothing here needs a "mark done" ritual for the normal case.
 */

import { useState, useEffect, useCallback } from 'react'
import { api, ApiError } from '@/lib/api'
import { cn } from '@/lib/cn'
import {
  AlertTriangle, CheckCircle2, Link2, Loader2, PlugZap, RefreshCw, Search, ShieldCheck, XCircle,
} from 'lucide-react'

// ---- Types ----

interface SyncSummary {
  typesSeen: number
  typesSynced: number
  typesUnmapped: number
  typesSkipped: number
  equipmentSeen: number
  created: number
  updated: number
  unchanged: number
  issues: number
  issuesResolved: number
  parentsLinked: number
  dryRun: boolean
  errors: string[]
}

interface NovaraStatus {
  configured: boolean
  baseUrl: string
  enabled: boolean
  intervalMs: number
  lastRunAt: string | null
  lastSummary: SyncSummary | null
  lastError: string | null
  lastJob: { status: string; startedAt: string; durationMs: number | null; errorMessage: string | null } | null
  counts: {
    types: number
    typesMapped: number
    typesUnmapped: number
    openIssues: number
    linkedUnits: number
    expiredUnits: number
  }
}

interface ScheduleMap {
  id: string
  novaraTypeId: string
  novaraScheduleId: string
  novaraScheduleName: string | null
  targetField: string | null
}

interface TypeMap {
  id: string
  novaraTypeId: string
  novaraTypeTitle: string
  productId: string | null
  ownership: 'basin_safety' | 'customer_owned'
  autoCreate: boolean
  syncEnabled: boolean
  equipmentCount: number
  lastSeenAt: string | null
  product: { id: string; partNumber: string; name: string; isSerialized: boolean } | null
  schedules: ScheduleMap[]
  openIssues: number
}

interface SyncIssue {
  id: string
  novaraEquipmentId: string
  novaraTypeTitle: string | null
  serialNumber: string | null
  novaraTitle: string | null
  reason: string
  detail: string | null
  firstSeenAt: string
  lastSeenAt: string
  resolvedAt: string | null
}

interface ProductOption {
  id: string
  partNumber: string
  name: string
  isSerialized: boolean
  isActive: boolean
}

const ISSUE_LABELS: Record<string, string> = {
  unmapped_type: 'Type not mapped',
  auto_create_off: 'Auto-create off',
  missing_serial: 'No serial number',
  serial_conflict: 'Serial conflict',
  parent_unresolved: 'Parent not in SP',
  parent_not_assembly: 'Parent not an assembly',
}

const TARGET_LABELS: Record<string, string> = {
  calibrationDueDate: 'Calibration Due',
  bumpTestDueDate: 'Bump Test Due',
}

function fmt(ts: string | null): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleString()
}

export function NovaraSyncPage() {
  const [status, setStatus] = useState<NovaraStatus | null>(null)
  const [types, setTypes] = useState<TypeMap[]>([])
  const [issues, setIssues] = useState<SyncIssue[]>([])
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState<'live' | 'dry' | null>(null)
  const [probing, setProbing] = useState(false)
  const [banner, setBanner] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)

  const load = useCallback(async () => {
    try {
      const [s, t, i] = await Promise.all([
        api.get<NovaraStatus>('/novara/status'),
        api.get<TypeMap[]>('/novara/types'),
        api.get<SyncIssue[]>('/novara/issues?state=open'),
      ])
      setStatus(s)
      setTypes(t)
      setIssues(i)
    } catch (err) {
      setBanner({ tone: 'err', text: err instanceof ApiError ? err.message : 'Failed to load Novara status' })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  async function runSync(dryRun: boolean) {
    setRunning(dryRun ? 'dry' : 'live')
    setBanner(null)
    try {
      const res = await api.post<{ outcome: string; summary: SyncSummary | null }>('/novara/sync', { dryRun })
      const sum = res.summary
      setBanner({
        tone: 'ok',
        text: sum
          ? `${dryRun ? 'Dry run' : 'Sync'}: ${sum.equipmentSeen} units across ${sum.typesSeen} types — ` +
            `${sum.created} created, ${sum.updated} updated, ${sum.unchanged} unchanged` +
            `${sum.parentsLinked ? `, ${sum.parentsLinked} re-parented` : ''}, ${sum.issues} need review`
          : 'Sync finished',
      })
      await load()
    } catch (err) {
      setBanner({ tone: 'err', text: err instanceof ApiError ? err.message : 'Sync failed' })
    } finally {
      setRunning(null)
    }
  }

  async function probe() {
    setProbing(true)
    setBanner(null)
    try {
      const res = await api.get<{ ok: boolean; equipmentTypes: number }>('/novara/test-connection')
      setBanner({ tone: 'ok', text: `Connected — token is valid and can see ${res.equipmentTypes} equipment types.` })
    } catch (err) {
      setBanner({ tone: 'err', text: err instanceof ApiError ? err.message : 'Connection failed' })
    } finally {
      setProbing(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-slate-400">
        <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading Novara status…
      </div>
    )
  }

  return (
    <div className="p-4 md:p-6 max-w-6xl mx-auto space-y-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold text-slate-800 flex items-center gap-2">
            <ShieldCheck className="w-5 h-5" /> Novara Sync
          </h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Equipment existence and inspection compliance, pulled from Novara Flex. One-way — nothing is sent back.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={probe}
            disabled={probing || !status?.configured}
            className="px-3 py-2 text-sm border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50 flex items-center gap-1.5"
          >
            {probing ? <Loader2 className="w-4 h-4 animate-spin" /> : <PlugZap className="w-4 h-4" />}
            Test connection
          </button>
          <button
            onClick={() => runSync(true)}
            disabled={!!running || !status?.configured}
            className="px-3 py-2 text-sm border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50 flex items-center gap-1.5"
            title="Walk everything and report what would happen, without writing"
          >
            {running === 'dry' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
            Dry run
          </button>
          <button
            onClick={() => runSync(false)}
            disabled={!!running || !status?.configured}
            className="px-3 py-2 text-sm text-white bg-blue-600 hover:bg-blue-700 rounded-lg disabled:opacity-50 flex items-center gap-1.5"
          >
            {running === 'live' ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            Sync now
          </button>
        </div>
      </div>

      {banner && (
        <div className={cn(
          'px-4 py-3 rounded-lg border text-sm flex items-start gap-2',
          banner.tone === 'ok' ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
            : 'bg-red-50 border-red-200 text-red-800',
        )}>
          {banner.tone === 'ok' ? <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" /> : <XCircle className="w-4 h-4 mt-0.5 shrink-0" />}
          <span>{banner.text}</span>
        </div>
      )}

      {status && !status.configured && (
        <div className="px-4 py-3 rounded-lg border bg-amber-50 border-amber-200 text-amber-800 text-sm flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>
            Novara is not configured — set <code className="font-mono">NOVARA_API_TOKEN</code> on the server.
            The scheduled sync self-skips until it is set.
          </span>
        </div>
      )}

      {/* ── Status ─────────────────────────────────────────────────────── */}
      {status && (
        <div className="bg-white rounded-lg border border-slate-200 shadow-sm p-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Stat label="Units linked" value={status.counts.linkedUnits} />
            <Stat label="Expired in Novara" value={status.counts.expiredUnits} tone={status.counts.expiredUnits ? 'red' : undefined} />
            <Stat label="Types unmapped" value={status.counts.typesUnmapped} tone={status.counts.typesUnmapped ? 'amber' : undefined} />
            <Stat label="Needs review" value={status.counts.openIssues} tone={status.counts.openIssues ? 'amber' : undefined} />
          </div>
          <div className="mt-4 pt-3 border-t border-slate-100 text-xs text-slate-500 flex flex-wrap gap-x-6 gap-y-1">
            <span>Last run: {fmt(status.lastRunAt)}</span>
            <span>Every {Math.round(status.intervalMs / 60000)} min{status.enabled ? '' : ' (disabled)'}</span>
            <span className="font-mono">{status.baseUrl}</span>
          </div>
          {status.lastError && (
            <p className="mt-2 text-xs text-red-600">Last error: {status.lastError}</p>
          )}
        </div>
      )}

      {/* ── Type mapping ───────────────────────────────────────────────── */}
      <div className="bg-white rounded-lg border border-slate-200 shadow-sm">
        <div className="px-4 py-3 border-b border-slate-100">
          <h2 className="font-semibold text-slate-800 flex items-center gap-2">
            <Link2 className="w-4 h-4" /> Equipment types
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            A type needs an SP product before the sync can create its units — SP equipment rows can't
            exist without one. Types with no product still update units you already have.
          </p>
        </div>
        {types.length === 0 ? (
          <p className="p-4 text-sm text-slate-500">
            No types discovered yet. Run a sync to pull Novara's catalog.
          </p>
        ) : (
          <div className="divide-y divide-slate-100">
            {types.map(t => (
              <TypeRow key={t.id} type={t} onChanged={load} />
            ))}
          </div>
        )}
      </div>

      {/* ── Review queue ───────────────────────────────────────────────── */}
      <div className="bg-white rounded-lg border border-slate-200 shadow-sm">
        <div className="px-4 py-3 border-b border-slate-100">
          <h2 className="font-semibold text-slate-800 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4" /> Needs review ({issues.length})
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Novara units the sync couldn't land. Fix the cause (usually a missing type mapping) and
            re-run — these clear themselves.
          </p>
        </div>
        {issues.length === 0 ? (
          <p className="p-4 text-sm text-slate-500">Nothing waiting. Every Novara unit landed.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500 uppercase">
                <tr>
                  <th className="text-left px-4 py-2 font-medium">Serial</th>
                  <th className="text-left px-4 py-2 font-medium">Type</th>
                  <th className="text-left px-4 py-2 font-medium">Reason</th>
                  <th className="text-left px-4 py-2 font-medium">Detail</th>
                  <th className="text-right px-4 py-2 font-medium">Last seen</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {issues.map(i => (
                  <IssueRow key={i.id} issue={i} onChanged={load} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

// ============================================================
// Pieces
// ============================================================

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'red' | 'amber' }) {
  return (
    <div>
      <p className="text-xs text-slate-400">{label}</p>
      <p className={cn(
        'text-2xl font-semibold',
        tone === 'red' ? 'text-red-600' : tone === 'amber' ? 'text-amber-600' : 'text-slate-800',
      )}>{value}</p>
    </div>
  )
}

function TypeRow({ type, onChanged }: { type: TypeMap; onChanged: () => Promise<void> }) {
  const [expanded, setExpanded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function patch(body: Record<string, unknown>) {
    setSaving(true)
    setError(null)
    try {
      await api.patch(`/novara/types/${type.novaraTypeId}`, body)
      await onChanged()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Update failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={() => setExpanded(e => !e)}
          className="text-left min-w-0 flex-1"
        >
          <p className="text-sm font-medium text-slate-800 truncate">{type.novaraTypeTitle}</p>
          <p className="text-xs text-slate-400">
            {type.equipmentCount} unit{type.equipmentCount === 1 ? '' : 's'} in Novara
            {type.openIssues > 0 && <span className="text-amber-600"> · {type.openIssues} needing review</span>}
            {type.schedules.length > 0 && ` · ${type.schedules.length} schedule${type.schedules.length === 1 ? '' : 's'}`}
          </p>
        </button>

        {type.product ? (
          <span className="px-2 py-1 text-xs rounded-lg bg-emerald-50 text-emerald-700 border border-emerald-200">
            {type.product.partNumber} — {type.product.name}
          </span>
        ) : (
          <span className="px-2 py-1 text-xs rounded-lg bg-amber-50 text-amber-700 border border-amber-200">
            Not mapped
          </span>
        )}

        <label className="flex items-center gap-1.5 text-xs text-slate-600">
          <input
            type="checkbox"
            checked={type.syncEnabled}
            disabled={saving}
            onChange={e => patch({ syncEnabled: e.target.checked })}
            className="rounded border-slate-300"
          />
          Sync
        </label>
        <label className="flex items-center gap-1.5 text-xs text-slate-600">
          <input
            type="checkbox"
            checked={type.autoCreate}
            disabled={saving || !type.productId}
            onChange={e => patch({ autoCreate: e.target.checked })}
            className="rounded border-slate-300"
          />
          Auto-create
        </label>
        <button
          onClick={() => setExpanded(e => !e)}
          className="px-2 py-1 text-xs border border-slate-300 rounded-lg hover:bg-slate-50"
        >
          {expanded ? 'Close' : 'Configure'}
        </button>
      </div>

      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}

      {expanded && (
        <div className="mt-3 pl-1 space-y-4 border-l-2 border-slate-100">
          <div className="pl-3">
            <p className="text-xs font-medium text-slate-500 mb-1.5">SP product</p>
            <ProductPicker
              current={type.product}
              disabled={saving}
              onPick={id => patch({ productId: id })}
            />
            <div className="mt-2">
              <label className="text-xs text-slate-500 mr-2">Ownership for units this creates</label>
              <select
                value={type.ownership}
                disabled={saving}
                onChange={e => patch({ ownership: e.target.value })}
                className="px-2 py-1 text-xs border border-slate-300 rounded-lg"
              >
                <option value="basin_safety">Basin Safety</option>
                <option value="customer_owned">Customer owned</option>
              </select>
            </div>
          </div>

          <div className="pl-3">
            <p className="text-xs font-medium text-slate-500 mb-1.5">Inspection schedules</p>
            {type.schedules.length === 0 ? (
              <p className="text-xs text-slate-400">No schedules discovered for this type.</p>
            ) : (
              <>
                <p className="text-xs text-slate-400 mb-2">
                  Point a schedule at an SP date column and the sync writes its next-due date there.
                  Left unmapped, it still shows on the equipment page under Novara Compliance.
                </p>
                <div className="space-y-1.5">
                  {type.schedules.map(s => (
                    <ScheduleRow key={s.id} schedule={s} onChanged={onChanged} />
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function ScheduleRow({ schedule, onChanged }: { schedule: ScheduleMap; onChanged: () => Promise<void> }) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function setTarget(value: string) {
    setSaving(true)
    setError(null)
    try {
      await api.patch(`/novara/schedules/${schedule.novaraScheduleId}`, { targetField: value || null })
      await onChanged()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Update failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-sm text-slate-700 min-w-[10rem]">{schedule.novaraScheduleName || 'Unnamed schedule'}</span>
      <span className="text-xs text-slate-400">writes to</span>
      <select
        value={schedule.targetField ?? ''}
        disabled={saving}
        onChange={e => setTarget(e.target.value)}
        className="px-2 py-1 text-xs border border-slate-300 rounded-lg"
      >
        <option value="">— nothing (mirror only) —</option>
        {Object.entries(TARGET_LABELS).map(([k, v]) => (
          <option key={k} value={k}>{v}</option>
        ))}
      </select>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  )
}

/**
 * Serialized products only. A non-serialized product would collapse every
 * individually-tracked Novara unit onto one bulk catalog row, so the server
 * rejects it too — filtering here just stops the admin picking a dead end.
 *
 * Inactive products are offered but flagged: `isActive` is a catalog/pricing
 * flag, and a product retired from sale can still have units in the field that
 * Novara is tracking. Hiding them would make those types unmappable.
 */
function ProductPicker({
  current, disabled, onPick,
}: {
  current: { id: string; partNumber: string; name: string } | null
  disabled: boolean
  onPick: (id: string | null) => void
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ProductOption[]>([])
  const [searching, setSearching] = useState(false)

  useEffect(() => {
    if (query.trim().length < 2) { setResults([]); return }
    let cancelled = false
    setSearching(true)
    const t = setTimeout(async () => {
      try {
        const res = await api.get<{ data: ProductOption[] }>(
          `/products?search=${encodeURIComponent(query.trim())}&limit=20`,
        )
        if (!cancelled) setResults(res.data.filter(p => p.isSerialized))
      } catch {
        if (!cancelled) setResults([])
      } finally {
        if (!cancelled) setSearching(false)
      }
    }, 250)
    return () => { cancelled = true; clearTimeout(t) }
  }, [query])

  return (
    <div className="space-y-2">
      {current && (
        <div className="flex items-center gap-2">
          <span className="text-sm text-slate-700">{current.partNumber} — {current.name}</span>
          <button
            onClick={() => onPick(null)}
            disabled={disabled}
            className="text-xs text-red-600 hover:underline disabled:opacity-50"
          >
            unmap
          </button>
        </div>
      )}
      <div className="relative max-w-md">
        <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-slate-400" />
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search serialized products…"
          disabled={disabled}
          className="w-full pl-8 pr-3 py-1.5 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
        />
      </div>
      {searching && <p className="text-xs text-slate-400">Searching…</p>}
      {results.length > 0 && (
        <div className="border border-slate-200 rounded-lg divide-y divide-slate-100 max-w-md max-h-52 overflow-y-auto">
          {results.map(p => (
            <button
              key={p.id}
              onClick={() => { onPick(p.id); setQuery(''); setResults([]) }}
              disabled={disabled}
              className="w-full text-left px-3 py-2 text-sm hover:bg-blue-50 disabled:opacity-50"
            >
              <span className="font-mono text-xs text-slate-500 mr-2">{p.partNumber}</span>
              {p.name}
              {!p.isActive && <span className="ml-2 text-xs text-amber-600">(inactive)</span>}
            </button>
          ))}
        </div>
      )}
      {!searching && query.trim().length >= 2 && results.length === 0 && (
        <p className="text-xs text-slate-400">No serialized products match.</p>
      )}
    </div>
  )
}

function IssueRow({ issue, onChanged }: { issue: SyncIssue; onChanged: () => Promise<void> }) {
  const [dismissing, setDismissing] = useState(false)

  async function dismiss() {
    setDismissing(true)
    try {
      await api.post(`/novara/issues/${issue.id}/dismiss`)
      await onChanged()
    } finally {
      setDismissing(false)
    }
  }

  return (
    <tr>
      <td className="px-4 py-2 font-mono text-xs text-slate-700">{issue.serialNumber || '—'}</td>
      <td className="px-4 py-2 text-slate-600">{issue.novaraTypeTitle || '—'}</td>
      <td className="px-4 py-2">
        <span className="px-2 py-0.5 text-xs rounded-full bg-amber-50 text-amber-700 border border-amber-200">
          {ISSUE_LABELS[issue.reason] ?? issue.reason}
        </span>
      </td>
      <td className="px-4 py-2 text-xs text-slate-500 max-w-md">{issue.detail || '—'}</td>
      <td className="px-4 py-2 text-right text-xs text-slate-400 whitespace-nowrap">{fmt(issue.lastSeenAt)}</td>
      <td className="px-4 py-2 text-right">
        <button
          onClick={dismiss}
          disabled={dismissing}
          className="text-xs text-slate-500 hover:text-slate-700 hover:underline disabled:opacity-50"
          title="Hide until the next run re-reports it"
        >
          {dismissing ? '…' : 'dismiss'}
        </button>
      </td>
    </tr>
  )
}
