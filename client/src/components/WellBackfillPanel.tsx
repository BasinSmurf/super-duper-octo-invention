import { useState, useEffect, useCallback } from 'react'
import { api } from '@/lib/api'
import { cn } from '@/lib/cn'
import {
  Wand2, Loader2, ChevronDown, ChevronUp, CheckCircle2, AlertCircle,
  GitMerge, MapPin, SkipForward, Link2, Search, Trash2,
} from 'lucide-react'

// ── Types (mirror server/src/services/wellDmrMatch.ts) ──
interface MatchStats {
  unmatched: number
  autoApplicable: number
  duplicates: number
  duplicatesClean: number
  duplicatesWithRelations: number
  needsReview: number
  skipped: number
  orphaned: number
}
interface ReviewCandidate {
  id: string; apiNumber: string | null; wellName: string | null
  fieldName: string | null; operatorName: string | null; county: string | null
  section: number | null; township: number | null; range: number | null
  latitude: number | null; longitude: number | null
  score: number; exact: boolean
  // Set when this API is already on a DIFFERENT well — that well's data is
  // likely wrong, not this candidate. Applying would 409; flagged so a human
  // can go fix the real problem instead of hitting a dead end.
  apiTakenBy?: { wellId: string; wellName: string | null; operatorName: string | null } | null
}
interface ReviewItem {
  wellId: string; wellName: string | null
  field: string | null; operator: string | null
  kind: 'duplicate' | 'dmr_match'
  duplicateOf?: { wellId: string; wellName: string | null; apiNumber: string | null; hasRelations: boolean }
  candidates: ReviewCandidate[]
  hasHistory?: boolean
}
interface ReviewResponse { total: number; limit: number; offset: number; items: ReviewItem[] }

const PAGE_SIZES = [25, 50, 100, 200]
const DEFAULT_PAGE = 25

// Persist page size + position across reloads/collapses — reopening the panel
// or hitting F5 mid-review used to always snap back to page 1, which was
// miserable for a queue that can run into the hundreds.
const LS_PAGE_SIZE = 'wellBackfillPanel.pageSize'
const LS_OFFSET = 'wellBackfillPanel.offset'

function readStoredPageSize(): number {
  const raw = Number(localStorage.getItem(LS_PAGE_SIZE))
  return PAGE_SIZES.includes(raw) ? raw : DEFAULT_PAGE
}
function readStoredOffset(): number {
  const raw = Number(localStorage.getItem(LS_OFFSET))
  return Number.isFinite(raw) && raw >= 0 ? raw : 0
}

export function WellBackfillPanel() {
  const [open, setOpen] = useState(false)
  const [stats, setStats] = useState<MatchStats | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [banner, setBanner] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  // review queue
  const [items, setItems] = useState<ReviewItem[]>([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(readStoredOffset)
  const [pageSize, setPageSize] = useState(readStoredPageSize)
  const [search, setSearch] = useState('')
  const [loadingQueue, setLoadingQueue] = useState(false)
  const [rowBusy, setRowBusy] = useState<string | null>(null)
  const [pageInput, setPageInput] = useState('')

  const loadStats = useCallback(async () => {
    try { setStats(await api.get<MatchStats>('/locations/dmr/match/stats')) } catch { /* ok */ }
  }, [])

  const loadQueue = useCallback(async (off: number, q: string, size: number) => {
    setLoadingQueue(true)
    try {
      const params = new URLSearchParams({ limit: String(size), offset: String(off) })
      if (q.trim()) params.set('search', q.trim())
      const r = await api.get<ReviewResponse>(`/locations/dmr/match/review?${params}`)
      // Clamp: a stored offset can outlive the queue shrinking (rows resolved
      // elsewhere) and land past the last page — fall back to the last valid page.
      const maxOffset = Math.max(0, Math.ceil(r.total / size) - 1) * size
      const clamped = Math.min(off, maxOffset)
      if (clamped !== off) {
        const r2 = await api.get<ReviewResponse>(`/locations/dmr/match/review?${new URLSearchParams({ limit: String(size), offset: String(clamped), ...(q.trim() ? { search: q.trim() } : {}) })}`)
        setItems(r2.items); setTotal(r2.total); setOffset(clamped)
        localStorage.setItem(LS_OFFSET, String(clamped))
      } else {
        setItems(r.items); setTotal(r.total); setOffset(off)
        localStorage.setItem(LS_OFFSET, String(off))
      }
    } catch (e) { setBanner({ kind: 'err', text: (e as Error).message }) }
    finally { setLoadingQueue(false) }
  }, [])

  useEffect(() => { if (open) { loadStats(); loadQueue(offset, search, pageSize) } }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  function changePageSize(size: number) {
    setPageSize(size)
    localStorage.setItem(LS_PAGE_SIZE, String(size))
    loadQueue(0, search, size)
  }

  async function runBulk(path: string, label: string) {
    setBusy(label); setBanner(null)
    try {
      const r = await api.post<Record<string, number>>(`/locations/dmr/match/${path}`, {})
      const parts = Object.entries(r).map(([k, v]) => `${v} ${k}`).join(', ')
      setBanner({ kind: 'ok', text: `${label}: ${parts}` })
      await loadStats(); await loadQueue(0, search, pageSize)
    } catch (e) { setBanner({ kind: 'err', text: (e as Error).message }) }
    finally { setBusy(null) }
  }

  async function applyMatch(wellId: string, dmrReferenceId: string) {
    setRowBusy(wellId)
    try {
      await api.post('/locations/dmr/match/apply', { wellId, dmrReferenceId })
      removeRow(wellId)
    } catch (e) { setBanner({ kind: 'err', text: (e as Error).message }) }
    finally { setRowBusy(null) }
  }
  async function mergeRow(loserWellId: string, winnerWellId: string) {
    setRowBusy(loserWellId)
    try {
      await api.post('/locations/dmr/match/merge', { loserWellId, winnerWellId })
      removeRow(loserWellId)
    } catch (e) { setBanner({ kind: 'err', text: (e as Error).message }) }
    finally { setRowBusy(null) }
  }
  async function skipRow(wellId: string) {
    setRowBusy(wellId)
    try { await api.post('/locations/dmr/match/skip', { wellId }); removeRow(wellId) }
    catch (e) { setBanner({ kind: 'err', text: (e as Error).message }) }
    finally { setRowBusy(null) }
  }
  async function deleteOrphan(wellId: string) {
    setRowBusy(wellId)
    try {
      const r = await api.post<{ deleted: number }>('/locations/dmr/match/cleanup-orphans', { wellIds: [wellId] })
      if (r.deleted > 0) removeRow(wellId)
      else setBanner({ kind: 'err', text: 'Well no longer qualifies for deletion (history or a DMR match appeared) — refresh and check again.' })
    } catch (e) { setBanner({ kind: 'err', text: (e as Error).message }) }
    finally { setRowBusy(null) }
  }
  function removeRow(wellId: string) {
    setItems(prev => prev.filter(i => i.wellId !== wellId))
    setTotal(t => Math.max(0, t - 1))
    loadStats()
  }

  const tiles: Array<{ label: string; value: number; cls: string }> = stats ? [
    { label: 'Unmatched', value: stats.unmatched, cls: 'bg-slate-50 text-slate-800' },
    { label: 'Exact (auto)', value: stats.autoApplicable, cls: 'bg-green-50 text-green-700' },
    { label: 'Duplicates', value: stats.duplicates, cls: 'bg-amber-50 text-amber-700' },
    { label: 'Needs review', value: stats.needsReview, cls: 'bg-blue-50 text-blue-700' },
    { label: 'Skipped', value: stats.skipped, cls: 'bg-slate-50 text-slate-500' },
    { label: 'Orphaned', value: stats.orphaned, cls: 'bg-red-50 text-red-700' },
  ] : []

  return (
    <div className="bg-white border border-slate-200 rounded-lg mb-4">
      <button onClick={() => setOpen(!open)} className="w-full flex items-center justify-between px-4 py-3 text-left">
        <div className="flex items-center gap-2">
          <Wand2 className="w-4 h-4 text-slate-400" />
          <span className="text-sm font-medium text-slate-700">Backfill &amp; Dedupe Active Wells</span>
          {stats && (
            <span className="text-xs text-slate-400 ml-2">
              {stats.unmatched.toLocaleString()} wells without an API #
            </span>
          )}
        </div>
        {open ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
      </button>

      {open && (
        <div className="border-t px-4 py-4 space-y-4">
          <p className="text-xs text-slate-500">
            Match active wells that lack an API # / location to the DMR reference data and backfill
            identity + classification. Exact name matches apply automatically; duplicates merge into the
            canonical well; the rest are reviewed below.
          </p>

          {stats && (
            <div className="grid grid-cols-6 gap-2 text-center text-xs">
              {tiles.map(t => (
                <div key={t.label} className={`rounded-lg p-2 ${t.cls}`}>
                  <p className="text-lg font-bold">{t.value.toLocaleString()}</p>
                  <p className="opacity-80">{t.label}</p>
                </div>
              ))}
            </div>
          )}

          {/* Bulk actions */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => runBulk('auto-apply-exact', 'Auto-backfill')}
              disabled={!!busy || !stats?.autoApplicable}
              className="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg disabled:opacity-50"
            >
              {busy === 'Auto-backfill' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Link2 className="w-4 h-4" />}
              Auto-backfill {stats?.autoApplicable ?? 0} exact
            </button>
            <button
              onClick={() => runBulk('auto-merge-clean', 'Auto-merge')}
              disabled={!!busy || !stats?.duplicatesClean}
              className="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium text-white bg-amber-600 hover:bg-amber-700 rounded-lg disabled:opacity-50"
            >
              {busy === 'Auto-merge' ? <Loader2 className="w-4 h-4 animate-spin" /> : <GitMerge className="w-4 h-4" />}
              Auto-merge {stats?.duplicatesClean ?? 0} clean duplicates
            </button>
            <button
              onClick={() => runBulk('cleanup-orphans', 'Clean up orphans')}
              disabled={!!busy || !stats?.orphaned}
              className="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg disabled:opacity-50"
            >
              {busy === 'Clean up orphans' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
              Clean up {stats?.orphaned ?? 0} orphaned wells
            </button>
            {stats && stats.duplicatesWithRelations > 0 && (
              <span className="text-xs text-amber-600">
                {stats.duplicatesWithRelations} duplicate(s) carry tickets/rentals — review below.
              </span>
            )}
          </div>
          {stats && stats.orphaned > 0 && (
            <p className="text-xs text-slate-400">
              Orphaned = no DMR match and no ticket/rental/equipment history anywhere — safe to delete outright.
            </p>
          )}

          {banner && (
            <div className={`px-3 py-2 rounded text-sm flex items-start gap-2 ${banner.kind === 'ok' ? 'bg-green-50 border border-green-200 text-green-700' : 'bg-red-50 border border-red-200 text-red-700'}`}>
              {banner.kind === 'ok' ? <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" /> : <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />}
              {banner.text}
            </div>
          )}

          {/* Review queue */}
          <div className="border-t pt-3">
            <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
              <h4 className="text-sm font-semibold text-slate-700">Review queue <span className="text-slate-400 font-normal">({total.toLocaleString()})</span></h4>
              <div className="flex items-center gap-2">
                <label className="text-xs text-slate-500 flex items-center gap-1">
                  Per page
                  <select
                    value={pageSize}
                    onChange={e => changePageSize(Number(e.target.value))}
                    className="text-sm border border-slate-200 rounded px-1.5 py-1"
                  >
                    {PAGE_SIZES.map(size => <option key={size} value={size}>{size}</option>)}
                  </select>
                </label>
                <input
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') loadQueue(0, search, pageSize) }}
                  placeholder="Filter by well name…"
                  className="text-sm border border-slate-200 rounded px-2 py-1 w-56"
                />
              </div>
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
                  <ReviewRow
                    key={item.wellId}
                    item={item}
                    busy={rowBusy === item.wellId}
                    onApply={applyMatch}
                    onMerge={mergeRow}
                    onSkip={skipRow}
                    onDelete={deleteOrphan}
                  />
                ))}
              </div>
            )}

            {/* pagination */}
            {total > pageSize && (() => {
              const totalPages = Math.max(1, Math.ceil(total / pageSize))
              const currentPage = Math.floor(offset / pageSize) + 1
              const goToPage = (raw: string) => {
                const p = Math.min(totalPages, Math.max(1, parseInt(raw, 10) || currentPage))
                setPageInput('')
                if (p !== currentPage) loadQueue((p - 1) * pageSize, search, pageSize)
              }
              return (
                <div className="flex items-center justify-between mt-3 text-sm gap-2 flex-wrap">
                  <button disabled={offset === 0 || loadingQueue} onClick={() => loadQueue(Math.max(0, offset - pageSize), search, pageSize)}
                    className="px-3 py-1 border rounded disabled:opacity-40">Prev</button>
                  <div className="flex items-center gap-1.5 text-slate-500">
                    <span>{offset + 1}–{Math.min(offset + pageSize, total)} of {total.toLocaleString()} · page</span>
                    <input
                      type="number"
                      min={1}
                      max={totalPages}
                      value={pageInput || currentPage}
                      onChange={e => setPageInput(e.target.value)}
                      onBlur={e => goToPage(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') goToPage((e.target as HTMLInputElement).value) }}
                      className="w-14 text-center border border-slate-200 rounded px-1 py-0.5"
                    />
                    <span>of {totalPages}</span>
                  </div>
                  <button disabled={offset + pageSize >= total || loadingQueue} onClick={() => loadQueue(offset + pageSize, search, pageSize)}
                    className="px-3 py-1 border rounded disabled:opacity-40">Next</button>
                </div>
              )
            })()}
          </div>
        </div>
      )}
    </div>
  )
}

function ReviewRow({ item, busy, onApply, onMerge, onSkip, onDelete }: {
  item: ReviewItem
  busy: boolean
  onApply: (wellId: string, dmrId: string) => void
  onMerge: (loserId: string, winnerId: string) => void
  onSkip: (wellId: string) => void
  onDelete: (wellId: string) => void
}) {
  return (
    <div className="border border-slate-200 rounded-lg p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-slate-800 truncate">{item.wellName || '(unnamed)'}</p>
          <p className="text-xs text-slate-400">
            {item.operator || 'no operator'}{item.field && item.field !== 'UNASSIGNED' ? ` · ${item.field}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {item.kind === 'dmr_match' && item.hasHistory === false && (
            <button onClick={() => onDelete(item.wellId)} disabled={busy}
              className="inline-flex items-center gap-1 text-xs text-red-500 hover:text-red-700">
              {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />} Delete (no history)
            </button>
          )}
          <button onClick={() => onSkip(item.wellId)} disabled={busy}
            className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-slate-600">
            {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <SkipForward className="w-3 h-3" />} Skip
          </button>
        </div>
      </div>

      {item.kind === 'dmr_match' && <ManualDmrSearch wellId={item.wellId} busy={busy} onApply={onApply} />}

      {item.kind === 'duplicate' && item.duplicateOf ? (
        <div className="mt-2 flex items-center justify-between gap-3 bg-amber-50 rounded p-2">
          <div className="text-xs text-amber-800 min-w-0">
            <span className="font-medium">Duplicate of</span> {item.duplicateOf.wellName} · API {item.duplicateOf.apiNumber}
            {item.duplicateOf.hasRelations && <span className="ml-1 text-amber-600">(carries tickets/rentals — will be reassigned)</span>}
          </div>
          <button onClick={() => onMerge(item.wellId, item.duplicateOf!.wellId)} disabled={busy}
            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-white bg-amber-600 hover:bg-amber-700 rounded shrink-0 disabled:opacity-50">
            {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <GitMerge className="w-3 h-3" />} Merge
          </button>
        </div>
      ) : (
        <div className="mt-2 space-y-1">
          {item.candidates.length === 0 ? (
            <p className="text-xs text-slate-400">No DMR candidates found — skip or import data.</p>
          ) : item.candidates.map(c => (
            <div key={c.id} className={cn('rounded p-2', c.apiTakenBy ? 'bg-amber-50 border border-amber-200' : 'bg-slate-50')}>
              <div className="flex items-center justify-between gap-3">
                <div className="text-xs text-slate-600 min-w-0">
                  <span className="font-medium text-slate-800">{c.wellName}</span>
                  {c.exact && <span className="ml-1 text-green-600 font-medium">exact</span>}
                  <span className="text-slate-400"> · API {c.apiNumber} · {c.county}</span>
                  {c.section != null && <span className="text-slate-400 inline-flex items-center gap-0.5 ml-1"><MapPin className="w-3 h-3" />{c.section}-{c.township}-{c.range}</span>}
                  {c.latitude != null && c.longitude != null && <span className="text-slate-400"> · {Number(c.latitude).toFixed(5)}, {Number(c.longitude).toFixed(5)}</span>}
                  <span className="text-slate-300"> · {c.operatorName}</span>
                </div>
                {c.apiTakenBy ? (
                  <a href={`/locations/wells/${c.apiTakenBy.wellId}`} target="_blank" rel="noreferrer"
                    className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-amber-800 bg-amber-100 hover:bg-amber-200 rounded shrink-0">
                    <AlertCircle className="w-3 h-3" /> API taken
                  </a>
                ) : (
                  <button onClick={() => onApply(item.wellId, c.id)} disabled={busy}
                    className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded shrink-0 disabled:opacity-50">
                    {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Link2 className="w-3 h-3" />} Apply
                  </button>
                )}
              </div>
              {c.apiTakenBy && (
                <p className="text-[11px] text-amber-700 mt-1">
                  This API is already on <b>{c.apiTakenBy.wellName || 'another well'}</b>
                  {c.apiTakenBy.operatorName ? ` (${c.apiTakenBy.operatorName})` : ''} — that record likely has the wrong API. Fix it there, or skip this candidate.
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// Auto-suggested candidates miss real renames/typos (e.g. active well "Albin
// 13x" is actually DMR's "Alberto 13x") since the name is too far apart for the
// Fuse threshold. This lets a human search the FULL DMR table by hand and apply
// a match the automatic suggestions never surfaced.
function ManualDmrSearch({ wellId, busy, onApply }: {
  wellId: string
  busy: boolean
  onApply: (wellId: string, dmrId: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ReviewCandidate[]>([])
  const [searching, setSearching] = useState(false)

  async function runSearch() {
    if (!query.trim()) { setResults([]); return }
    setSearching(true)
    try {
      const r = await api.get<ReviewCandidate[]>(`/locations/dmr/match/search?q=${encodeURIComponent(query.trim())}`)
      setResults(r)
    } catch { /* leave results as-is */ }
    finally { setSearching(false) }
  }

  return (
    <div className="mt-2">
      <button onClick={() => setExpanded(!expanded)} className="text-xs text-blue-600 hover:text-blue-800 font-medium">
        {expanded ? 'Hide manual search' : "Not it? Search DMR manually"}
      </button>
      {expanded && (
        <div className="mt-1.5 space-y-1.5">
          <div className="flex items-center gap-1.5">
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') runSearch() }}
              placeholder="Search DMR by well name or API #…"
              className="flex-1 text-xs border border-slate-200 rounded px-2 py-1"
            />
            <button onClick={runSearch} disabled={searching}
              className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-slate-600 border border-slate-200 rounded hover:bg-slate-50 disabled:opacity-50">
              {searching ? <Loader2 className="w-3 h-3 animate-spin" /> : <Search className="w-3 h-3" />} Search
            </button>
          </div>
          {results.length > 0 && (
            <div className="space-y-1">
              {results.map(c => (
                <div key={c.id} className={cn('rounded p-2', c.apiTakenBy ? 'bg-amber-50 border border-amber-200' : 'bg-slate-50')}>
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-xs text-slate-600 min-w-0">
                      <span className="font-medium text-slate-800">{c.wellName}</span>
                      <span className="text-slate-400"> · API {c.apiNumber} · {c.county}</span>
                      {c.section != null && <span className="text-slate-400 inline-flex items-center gap-0.5 ml-1"><MapPin className="w-3 h-3" />{c.section}-{c.township}-{c.range}</span>}
                      <span className="text-slate-300"> · {c.operatorName}</span>
                    </div>
                    {c.apiTakenBy ? (
                      <a href={`/locations/wells/${c.apiTakenBy.wellId}`} target="_blank" rel="noreferrer"
                        className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-amber-800 bg-amber-100 hover:bg-amber-200 rounded shrink-0">
                        <AlertCircle className="w-3 h-3" /> API taken
                      </a>
                    ) : (
                      <button onClick={() => onApply(wellId, c.id)} disabled={busy}
                        className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded shrink-0 disabled:opacity-50">
                        {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Link2 className="w-3 h-3" />} Apply
                      </button>
                    )}
                  </div>
                  {c.apiTakenBy && (
                    <p className="text-[11px] text-amber-700 mt-1">
                      This API is already on <b>{c.apiTakenBy.wellName || 'another well'}</b>
                      {c.apiTakenBy.operatorName ? ` (${c.apiTakenBy.operatorName})` : ''} — that record likely has the wrong API.
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
