import { useState, useEffect, useCallback } from 'react'
import { api } from '@/lib/api'
import {
  Wand2, Loader2, ChevronDown, ChevronUp, CheckCircle2, AlertCircle,
  GitMerge, SkipForward, Building2, Search, X, ArrowRight,
} from 'lucide-react'

// ── Types (mirror server/src/services/companyMerge.ts) ──
interface MergeStats {
  activeCompanies: number
  exactGroups: number
  exactAutoMergeable: number
  exactQbConflicts: number
  fuzzyCandidates: number
}
interface ReviewCandidate {
  id: string; name: string; companyType: string
  qbCustomerListId: string | null; relationCount: number
  score: number; reason: 'exact' | 'field_office' | 'fuzzy'
}
interface ReviewItem {
  companyId: string; name: string; companyType: string
  qbCustomerListId: string | null; relationCount: number
  kind: 'exact_conflict' | 'fuzzy'
  candidates: ReviewCandidate[]
}
interface ReviewResponse { total: number; limit: number; offset: number; items: ReviewItem[] }
interface CompanyLite { id: string; name: string; companyType?: string; qbCustomerListId?: string | null }

const PAGE = 25

export function CompanyMergePanel({ onMerged }: { onMerged?: () => void }) {
  const [open, setOpen] = useState(false)
  const [stats, setStats] = useState<MergeStats | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [banner, setBanner] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  const [items, setItems] = useState<ReviewItem[]>([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [search, setSearch] = useState('')
  const [loadingQueue, setLoadingQueue] = useState(false)
  const [rowBusy, setRowBusy] = useState<string | null>(null)

  // Manual merge — pick any two companies explicitly. The matcher only
  // surfaces auto-detected dups; this is the escape hatch for pairs it
  // doesn't cluster (e.g. "Chord Energy" vs "Chord Energy LLC").
  const [mLoser, setMLoser] = useState<CompanyLite | null>(null)
  const [mWinner, setMWinner] = useState<CompanyLite | null>(null)
  const [manualBusy, setManualBusy] = useState(false)

  const loadStats = useCallback(async () => {
    try { setStats(await api.get<MergeStats>('/companies/merge/stats')) } catch { /* ok */ }
  }, [])

  const loadQueue = useCallback(async (off: number, q: string) => {
    setLoadingQueue(true)
    try {
      const params = new URLSearchParams({ limit: String(PAGE), offset: String(off) })
      if (q.trim()) params.set('search', q.trim())
      const r = await api.get<ReviewResponse>(`/companies/merge/review?${params}`)
      setItems(r.items); setTotal(r.total); setOffset(off)
    } catch (e) { setBanner({ kind: 'err', text: (e as Error).message }) }
    finally { setLoadingQueue(false) }
  }, [])

  useEffect(() => { if (open) { loadStats(); loadQueue(0, search) } }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  async function runAutoMerge() {
    setBusy('auto'); setBanner(null)
    try {
      const r = await api.post<{ merged: number; skippedConflicts: number; errors: number }>('/companies/merge/auto-merge-exact', {})
      setBanner({ kind: 'ok', text: `Merged ${r.merged} exact duplicate(s); ${r.skippedConflicts} left for review (QB conflict); ${r.errors} error(s).` })
      await loadStats(); await loadQueue(0, search); onMerged?.()
    } catch (e) { setBanner({ kind: 'err', text: (e as Error).message }) }
    finally { setBusy(null) }
  }

  async function mergeRow(loserId: string, winnerId: string, force = false) {
    setRowBusy(loserId)
    try {
      await api.post('/companies/merge/merge', { loserId, winnerId, force })
      setItems(prev => prev.filter(i => i.companyId !== loserId))
      setTotal(t => Math.max(0, t - 1))
      loadStats(); onMerged?.()
    } catch (e) {
      const msg = (e as Error).message
      if (/QB_CONFLICT|QuickBooks id/.test(msg) && !force) {
        if (confirm(`${msg}\n\nProceed and keep the survivor's QuickBooks id? (the other id is recorded on the survivor)`)) {
          return mergeRow(loserId, winnerId, true)
        }
      } else {
        setBanner({ kind: 'err', text: msg })
      }
    } finally { setRowBusy(null) }
  }

  async function runManualMerge(force = false) {
    if (!mLoser || !mWinner) return
    if (mLoser.id === mWinner.id) { setBanner({ kind: 'err', text: 'Pick two different companies.' }); return }
    if (!force && !confirm(
      `Merge "${mLoser.name}" INTO "${mWinner.name}"?\n\n` +
      `"${mWinner.name}" survives and inherits every ticket, invoice, rental, contact, ` +
      `pad and well from "${mLoser.name}", which is then deactivated. This can be undone via the ` +
      `merge breadcrumb but is disruptive — double-check the survivor.`
    )) return
    setManualBusy(true); setBanner(null)
    try {
      await api.post('/companies/merge/merge', { loserId: mLoser.id, winnerId: mWinner.id, force })
      setBanner({ kind: 'ok', text: `Merged "${mLoser.name}" into "${mWinner.name}".` })
      setMLoser(null); setMWinner(null)
      await loadStats(); await loadQueue(0, search); onMerged?.()
    } catch (e) {
      const msg = (e as Error).message
      if (/QB_CONFLICT|QuickBooks id/.test(msg) && !force) {
        if (confirm(`${msg}\n\nProceed and keep the survivor's QuickBooks id? (the other id is recorded on the survivor)`)) {
          setManualBusy(false)
          return runManualMerge(true)
        }
      } else {
        setBanner({ kind: 'err', text: msg })
      }
    } finally { setManualBusy(false) }
  }

  async function skipRow(companyId: string) {
    setRowBusy(companyId)
    try {
      await api.post('/companies/merge/skip', { companyId })
      setItems(prev => prev.filter(i => i.companyId !== companyId))
      setTotal(t => Math.max(0, t - 1))
      loadStats()
    } catch (e) { setBanner({ kind: 'err', text: (e as Error).message }) }
    finally { setRowBusy(null) }
  }

  const tiles: Array<{ label: string; value: number; cls: string }> = stats ? [
    { label: 'Active', value: stats.activeCompanies, cls: 'bg-slate-50 text-slate-800' },
    { label: 'Exact (auto)', value: stats.exactAutoMergeable, cls: 'bg-green-50 text-green-700' },
    { label: 'QB conflicts', value: stats.exactQbConflicts, cls: 'bg-red-50 text-red-700' },
    { label: 'Fuzzy review', value: stats.fuzzyCandidates, cls: 'bg-blue-50 text-blue-700' },
  ] : []

  return (
    <div className="bg-white border border-slate-200 rounded-lg mb-4">
      <button onClick={() => setOpen(!open)} className="w-full flex items-center justify-between px-4 py-3 text-left">
        <div className="flex items-center gap-2">
          <Wand2 className="w-4 h-4 text-slate-400" />
          <span className="text-sm font-medium text-slate-700">Dedupe &amp; Merge Customers</span>
          {stats && (stats.exactAutoMergeable + stats.exactQbConflicts + stats.fuzzyCandidates) > 0 && (
            <span className="text-xs text-amber-500 ml-2">
              {stats.exactAutoMergeable + stats.exactQbConflicts + stats.fuzzyCandidates} possible duplicate(s)
            </span>
          )}
        </div>
        {open ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
      </button>

      {open && (
        <div className="border-t px-4 py-4 space-y-4">
          <p className="text-xs text-slate-500">
            Collapse duplicate customers (operator + QB imports of the same company, field offices entered
            separately) into one record — every ticket, invoice, rental, contact and asset is reassigned.
            Exact-name matches merge automatically; the rest are reviewed below. The survivor keeps a
            single QuickBooks id; when both sides have one it's flagged for you to resolve.
          </p>

          {stats && (
            <div className="grid grid-cols-4 gap-2 text-center text-xs">
              {tiles.map(t => (
                <div key={t.label} className={`rounded-lg p-2 ${t.cls}`}>
                  <p className="text-lg font-bold">{t.value.toLocaleString()}</p>
                  <p className="opacity-80">{t.label}</p>
                </div>
              ))}
            </div>
          )}

          {/* Manual merge — pick any two companies the matcher didn't cluster. */}
          <div className="border border-slate-200 rounded-lg p-3 bg-slate-50/60">
            <h4 className="text-sm font-semibold text-slate-700 mb-1">Merge two specific companies</h4>
            <p className="text-xs text-slate-500 mb-3">
              For pairs the auto-matcher misses (e.g. <span className="font-medium">Chord Energy</span> vs{' '}
              <span className="font-medium">Chord Energy LLC</span>). Pick the duplicate to fold in and the record that should survive.
            </p>
            <div className="flex flex-col sm:flex-row sm:items-end gap-2">
              <div className="flex-1">
                <label className="text-[11px] font-medium text-slate-500 block mb-1">Merge this (duplicate)</label>
                <CompanyPicker value={mLoser} onChange={setMLoser} excludeId={mWinner?.id} placeholder="Search company to fold in…" />
              </div>
              <ArrowRight className="w-4 h-4 text-slate-400 shrink-0 self-center sm:mb-2.5" />
              <div className="flex-1">
                <label className="text-[11px] font-medium text-slate-500 block mb-1">Into this (survivor)</label>
                <CompanyPicker value={mWinner} onChange={setMWinner} excludeId={mLoser?.id} placeholder="Search surviving company…" />
              </div>
              <button
                onClick={() => runManualMerge(false)}
                disabled={!mLoser || !mWinner || manualBusy}
                className="inline-flex items-center justify-center gap-1.5 px-3 py-2 text-sm font-medium text-white bg-amber-600 hover:bg-amber-700 rounded-lg disabled:opacity-50 shrink-0"
              >
                {manualBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <GitMerge className="w-4 h-4" />}
                Merge
              </button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={runAutoMerge}
              disabled={!!busy || !stats?.exactAutoMergeable}
              className="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg disabled:opacity-50"
            >
              {busy === 'auto' ? <Loader2 className="w-4 h-4 animate-spin" /> : <GitMerge className="w-4 h-4" />}
              Auto-merge {stats?.exactAutoMergeable ?? 0} exact match{stats?.exactAutoMergeable === 1 ? '' : 'es'}
            </button>
            {stats && stats.exactQbConflicts > 0 && (
              <span className="text-xs text-red-600">
                {stats.exactQbConflicts} exact dup(s) have conflicting QB ids — review below.
              </span>
            )}
          </div>

          {banner && (
            <div className={`px-3 py-2 rounded text-sm flex items-start gap-2 ${banner.kind === 'ok' ? 'bg-green-50 border border-green-200 text-green-700' : 'bg-red-50 border border-red-200 text-red-700'}`}>
              {banner.kind === 'ok' ? <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" /> : <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />}
              {banner.text}
            </div>
          )}

          <div className="border-t pt-3">
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-sm font-semibold text-slate-700">Review queue <span className="text-slate-400 font-normal">({total.toLocaleString()})</span></h4>
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') loadQueue(0, search) }}
                placeholder="Filter by name…"
                className="text-sm border border-slate-200 rounded px-2 py-1 w-56"
              />
            </div>

            {loadingQueue ? (
              <div className="flex items-center gap-2 text-sm text-slate-500 py-6 justify-center">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading…
              </div>
            ) : items.length === 0 ? (
              <p className="text-sm text-slate-400 py-6 text-center">Nothing to review. 🎉</p>
            ) : (
              <div className="space-y-2">
                {items.map(item => (
                  <ReviewRow key={item.companyId} item={item} busy={rowBusy === item.companyId} onMerge={mergeRow} onSkip={skipRow} />
                ))}
              </div>
            )}

            {total > PAGE && (
              <div className="flex items-center justify-between mt-3 text-sm">
                <button disabled={offset === 0 || loadingQueue} onClick={() => loadQueue(Math.max(0, offset - PAGE), search)}
                  className="px-3 py-1 border rounded disabled:opacity-40">Prev</button>
                <span className="text-slate-500">{offset + 1}–{Math.min(offset + PAGE, total)} of {total.toLocaleString()}</span>
                <button disabled={offset + PAGE >= total || loadingQueue} onClick={() => loadQueue(offset + PAGE, search)}
                  className="px-3 py-1 border rounded disabled:opacity-40">Next</button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/** Debounced company search → select. Used by the manual-merge pickers. */
function CompanyPicker({ value, onChange, excludeId, placeholder }: {
  value: CompanyLite | null
  onChange: (c: CompanyLite | null) => void
  excludeId?: string
  placeholder?: string
}) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<CompanyLite[]>([])
  const [searching, setSearching] = useState(false)

  useEffect(() => {
    if (value || !q.trim()) { setResults([]); return }
    setSearching(true)
    const t = setTimeout(async () => {
      try {
        const r = await api.get<{ data: CompanyLite[] }>(
          `/companies?search=${encodeURIComponent(q.trim())}&limit=10&active=true`
        )
        setResults((r.data || []).filter(c => c.id !== excludeId))
      } catch { setResults([]) }
      finally { setSearching(false) }
    }, 200)
    return () => clearTimeout(t)
  }, [q, value, excludeId])

  if (value) {
    return (
      <div className="flex items-center gap-2 p-2 bg-white border border-slate-300 rounded text-sm">
        <Building2 className="w-4 h-4 text-slate-400 shrink-0" />
        <span className="flex-1 font-medium truncate">{value.name}</span>
        <QbBadge id={value.qbCustomerListId ?? null} />
        <button onClick={() => onChange(null)} className="text-slate-400 hover:text-slate-600 shrink-0" title="Change">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    )
  }

  return (
    <div className="relative">
      <div className="relative">
        <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
        <input
          type="text"
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder={placeholder}
          className="w-full pl-8 pr-2 py-2 border border-slate-300 rounded text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
        />
        {searching && <Loader2 className="w-3.5 h-3.5 animate-spin text-slate-400 absolute right-2.5 top-1/2 -translate-y-1/2" />}
      </div>
      {results.length > 0 && (
        <div className="absolute z-20 left-0 right-0 mt-1 bg-white border border-slate-200 rounded shadow-lg max-h-56 overflow-y-auto">
          {results.map(c => (
            <button
              key={c.id}
              type="button"
              onClick={() => { onChange(c); setQ(''); setResults([]) }}
              className="w-full text-left px-3 py-2 hover:bg-slate-50 text-sm transition-colors flex items-center gap-2"
            >
              <span className="flex-1 truncate">{c.name}</span>
              {c.companyType && <span className="text-[10px] text-slate-400">{c.companyType.replace('_', ' ')}</span>}
              <QbBadge id={c.qbCustomerListId ?? null} />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function QbBadge({ id }: { id: string | null }) {
  return id
    ? <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700">QB</span>
    : <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-slate-100 text-slate-400">no QB</span>
}

function ReviewRow({ item, busy, onMerge, onSkip }: {
  item: ReviewItem
  busy: boolean
  onMerge: (loserId: string, winnerId: string) => void
  onSkip: (companyId: string) => void
}) {
  return (
    <div className="border border-slate-200 rounded-lg p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-slate-800 truncate flex items-center gap-1.5">
            <Building2 className="w-3.5 h-3.5 text-slate-400 shrink-0" />
            {item.name} <QbBadge id={item.qbCustomerListId} />
          </p>
          <p className="text-xs text-slate-400">
            {item.companyType.replace('_', ' ')} · {item.relationCount} linked record{item.relationCount === 1 ? '' : 's'}
            {item.kind === 'exact_conflict' && <span className="ml-1 text-red-500 font-medium">· exact-name QB conflict</span>}
          </p>
        </div>
        <button onClick={() => onSkip(item.companyId)} disabled={busy}
          className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-slate-600 shrink-0">
          {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <SkipForward className="w-3 h-3" />} Skip
        </button>
      </div>

      <div className="mt-2 space-y-1">
        {item.candidates.map(c => (
          <div key={c.id} className={`flex items-center justify-between gap-3 rounded p-2 ${item.kind === 'exact_conflict' ? 'bg-red-50' : 'bg-slate-50'}`}>
            <div className="text-xs text-slate-600 min-w-0">
              <span className="font-medium text-slate-800">{c.name}</span> <QbBadge id={c.qbCustomerListId} />
              {c.reason === 'field_office' && <span className="ml-1 text-blue-600 font-medium">field office</span>}
              {c.reason === 'exact' && <span className="ml-1 text-red-600 font-medium">exact name</span>}
              <span className="text-slate-400"> · {c.companyType.replace('_', ' ')} · {c.relationCount} linked</span>
            </div>
            <button onClick={() => onMerge(item.companyId, c.id)} disabled={busy}
              title={`Merge "${item.name}" into "${c.name}" — ${c.name} survives`}
              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-white bg-amber-600 hover:bg-amber-700 rounded shrink-0 disabled:opacity-50">
              {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <GitMerge className="w-3 h-3" />} Merge into this
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
