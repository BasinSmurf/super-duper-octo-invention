import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  DndContext, DragOverlay, PointerSensor, useSensor, useSensors,
  useDraggable, useDroppable, type DragEndEvent, type DragStartEvent,
} from '@dnd-kit/core'
import {
  Layers, GitMerge, Search, MapPin, Loader2, AlertTriangle, Check, X,
  ArrowLeft, Pin, Crosshair, RefreshCw,
} from 'lucide-react'
import { api, ApiError } from '@/lib/api'

// ── Shared types (mirror server payloads) ─────────────────────────────────────

interface PadMergeSuggestion {
  winnerPadId: string
  winnerPadName: string
  suggestedName: string
  loserPads: Array<{ padId: string; padName: string; wellCount: number }>
  totalWells: number
  centroid: { lat: number; lon: number }
  section: number | null; township: number | null; range: number | null
  spanFt: number
  confident: boolean
  distinctNameBases: number
  sampleWellNames: string[]
}

interface DmrWell {
  id: string; wellName: string | null; apiNumber: string; operatorName: string | null
  fieldName: string | null; section: number | null; township: number | null; range: number | null
  latitude: number | string | null; longitude: number | string | null; matchedWellId: string | null
}

interface WellRow {
  id: string; wellName: string | null; apiNumber: string | null
  pad?: { id: string; name: string } | null
  field?: { id: string; name: string } | null
  currentOperator?: { id: string; name: string } | null
}

interface PadRow {
  id: string; name: string; isActive: boolean
  field?: { id: string; name: string } | null
  currentOperator?: { id: string; name: string } | null
  _count?: { wells: number }
}

// ── Page shell ────────────────────────────────────────────────────────────────

type Tab = 'consolidate' | 'build'

export function LocationBuilderPage() {
  const [tab, setTab] = useState<Tab>('consolidate')

  return (
    <div className="h-[calc(100vh-1rem)] flex flex-col">
      <div className="flex items-center justify-between gap-3 px-1 pb-3 border-b border-slate-200">
        <div className="flex items-center gap-3 min-w-0">
          <Link to="/locations/dmr" className="text-slate-400 hover:text-slate-600 shrink-0"><ArrowLeft className="w-5 h-5" /></Link>
          <div className="min-w-0">
            <h1 className="text-lg font-semibold text-slate-900 flex items-center gap-2"><Layers className="w-5 h-5 text-blue-600" /> Location Builder</h1>
            <p className="text-xs text-slate-500">Consolidate fragmented pads by location, and build pads by dragging wells.</p>
          </div>
        </div>
        <div className="flex rounded-lg bg-slate-100 p-0.5 shrink-0">
          <TabBtn active={tab === 'consolidate'} onClick={() => setTab('consolidate')}><GitMerge className="w-4 h-4" /> Consolidate</TabBtn>
          <TabBtn active={tab === 'build'} onClick={() => setTab('build')}><Layers className="w-4 h-4" /> Build</TabBtn>
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-hidden pt-3">
        {tab === 'consolidate' ? <ConsolidateTab /> : <BuildTab />}
      </div>
    </div>
  )
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick}
      className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md transition ${active ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
      {children}
    </button>
  )
}

function Banner({ msg, onClose }: { msg: { kind: 'ok' | 'err'; text: string } | null; onClose: () => void }) {
  if (!msg) return null
  return (
    <div className={`flex items-center justify-between gap-3 px-3 py-2 rounded-lg text-sm mb-3 ${msg.kind === 'ok' ? 'bg-green-50 text-green-800 border border-green-200' : 'bg-red-50 text-red-800 border border-red-200'}`}>
      <span className="flex items-center gap-2">{msg.kind === 'ok' ? <Check className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}{msg.text}</span>
      <button onClick={onClose} className="opacity-60 hover:opacity-100"><X className="w-4 h-4" /></button>
    </div>
  )
}

// ── Tab 1: Consolidate (proximity-driven pad merging) ─────────────────────────

function ConsolidateTab() {
  const [all, setAll] = useState<PadMergeSuggestion[]>([])
  const [loading, setLoading] = useState(true)
  const [confidentOnly, setConfidentOnly] = useState(true)
  const [hideMixed, setHideMixed] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [names, setNames] = useState<Record<string, string>>({})
  const [excluded, setExcluded] = useState<Record<string, Set<string>>>({})
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await api.get<PadMergeSuggestion[]>('/locations/proximity/pad-merges')
      setAll(data)
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof ApiError ? e.message : 'Failed to load suggestions' })
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => { void load() }, [load])

  const visible = useMemo(() => all.filter((s) =>
    !dismissed.has(s.winnerPadId) &&
    (!confidentOnly || s.confident) &&
    (!hideMixed || s.distinctNameBases <= 1)
  ), [all, dismissed, confidentOnly, hideMixed])

  const toggleExclude = (winnerId: string, loserId: string) => {
    setExcluded((prev) => {
      const set = new Set(prev[winnerId] ?? [])
      set.has(loserId) ? set.delete(loserId) : set.add(loserId)
      return { ...prev, [winnerId]: set }
    })
  }

  const doMerge = async (s: PadMergeSuggestion) => {
    const ex = excluded[s.winnerPadId] ?? new Set<string>()
    const loserPadIds = s.loserPads.filter((l) => !ex.has(l.padId)).map((l) => l.padId)
    if (loserPadIds.length === 0) { setMsg({ kind: 'err', text: 'No pads left to merge — all excluded.' }); return }
    setBusy(s.winnerPadId)
    try {
      const newName = (names[s.winnerPadId] ?? s.suggestedName).trim()
      const r = await api.post<{ merged: number; wellsMoved: number }>('/locations/proximity/pad-merges/apply', {
        winnerPadId: s.winnerPadId, loserPadIds, newName,
      })
      setDismissed((d) => new Set(d).add(s.winnerPadId))
      setMsg({ kind: 'ok', text: `Merged ${r.merged} pad${r.merged === 1 ? '' : 's'} into "${newName}" (${r.wellsMoved} wells moved).` })
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof ApiError ? e.message : 'Merge failed' })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="h-full flex flex-col">
      <Banner msg={msg} onClose={() => setMsg(null)} />
      <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
        <p className="text-sm text-slate-600">
          {loading ? 'Scanning…' : <><span className="font-semibold text-slate-900">{visible.length}</span> pad-consolidation {visible.length === 1 ? 'suggestion' : 'suggestions'} — physically co-located pads to merge into one.</>}
        </p>
        <div className="flex items-center gap-3 text-sm">
          <label className="inline-flex items-center gap-1.5 text-slate-600 cursor-pointer">
            <input type="checkbox" checked={confidentOnly} onChange={(e) => setConfidentOnly(e.target.checked)} className="rounded" /> High-confidence only
          </label>
          <label className="inline-flex items-center gap-1.5 text-slate-600 cursor-pointer">
            <input type="checkbox" checked={hideMixed} onChange={(e) => setHideMixed(e.target.checked)} className="rounded" /> Hide mixed-name
          </label>
          <button onClick={() => void load()} className="inline-flex items-center gap-1 text-slate-500 hover:text-slate-700"><RefreshCw className="w-4 h-4" /> Refresh</button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto pr-1 space-y-3">
        {loading ? (
          <div className="flex items-center justify-center py-20 text-slate-400"><Loader2 className="w-6 h-6 animate-spin" /></div>
        ) : visible.length === 0 ? (
          <div className="text-center py-20 text-slate-400">
            <Check className="w-10 h-10 mx-auto mb-2 text-green-400" />
            <p>Nothing to consolidate with the current filters.</p>
          </div>
        ) : visible.map((s) => {
          const ex = excluded[s.winnerPadId] ?? new Set<string>()
          const remaining = s.loserPads.filter((l) => !ex.has(l.padId)).length
          return (
            <div key={s.winnerPadId} className="border border-slate-200 rounded-lg p-3 bg-white">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <Pin className="w-4 h-4 text-blue-600 shrink-0" />
                  <input value={names[s.winnerPadId] ?? s.suggestedName}
                    onChange={(e) => setNames((n) => ({ ...n, [s.winnerPadId]: e.target.value }))}
                    className="font-semibold text-slate-900 border-b border-transparent hover:border-slate-300 focus:border-blue-500 focus:outline-none px-0.5 min-w-0 flex-1 max-w-xs" />
                  {s.confident
                    ? <span className="text-[10px] uppercase font-semibold tracking-wide text-green-700 bg-green-100 px-1.5 py-0.5 rounded">confident</span>
                    : <span className="text-[10px] uppercase font-semibold tracking-wide text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded">review</span>}
                  {s.distinctNameBases > 1 &&
                    <span className="text-[10px] font-semibold text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded inline-flex items-center gap-1"><AlertTriangle className="w-3 h-3" />{s.distinctNameBases} names</span>}
                </div>
                <button onClick={() => doMerge(s)} disabled={busy === s.winnerPadId || remaining === 0}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded shrink-0 disabled:opacity-50">
                  {busy === s.winnerPadId ? <Loader2 className="w-4 h-4 animate-spin" /> : <GitMerge className="w-4 h-4" />}
                  Merge {remaining + 1} pads
                </button>
              </div>

              <div className="flex items-center gap-3 text-xs text-slate-500 mt-1.5 flex-wrap">
                <span className="inline-flex items-center gap-1"><MapPin className="w-3 h-3" />S{s.section ?? '?'}-T{s.township ?? '?'}-R{s.range ?? '?'}</span>
                <span>{s.totalWells} wells</span>
                <span>footprint {s.spanFt} ft</span>
                <span className="text-slate-400">{s.centroid.lat.toFixed(4)}, {s.centroid.lon.toFixed(4)}</span>
              </div>

              <div className="mt-2 flex flex-wrap gap-1.5">
                <span className="text-[11px] inline-flex items-center gap-1 bg-blue-50 text-blue-800 border border-blue-200 rounded px-2 py-0.5">
                  <Check className="w-3 h-3" /> keep: {s.winnerPadName || '(unnamed)'}
                </span>
                {s.loserPads.map((l) => {
                  const off = ex.has(l.padId)
                  return (
                    <button key={l.padId} onClick={() => toggleExclude(s.winnerPadId, l.padId)}
                      title={off ? 'Excluded — click to include' : 'Click to exclude from this merge'}
                      className={`text-[11px] inline-flex items-center gap-1 rounded px-2 py-0.5 border transition ${off ? 'bg-slate-50 text-slate-400 border-slate-200 line-through' : 'bg-slate-100 text-slate-700 border-slate-300 hover:bg-slate-200'}`}>
                      {l.padName || '(unnamed)'} · {l.wellCount}w
                    </button>
                  )
                })}
              </div>

              {s.sampleWellNames.length > 0 &&
                <p className="mt-2 text-[11px] text-slate-400 truncate">wells: {s.sampleWellNames.join(', ')}</p>}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Tab 2: Build (drag-and-drop board) ────────────────────────────────────────

type DragData =
  | { kind: 'dmr'; dmr: DmrWell }
  | { kind: 'well'; well: WellRow }

function BuildTab() {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))
  const [active, setActive] = useState<DragData | null>(null)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  // Loaded pad columns (drop targets). Keyed by id.
  const [columns, setColumns] = useState<Array<PadRow & { wells: WellRow[] }>>([])
  const reloadPad = useCallback(async (padId: string) => {
    const pad = await api.get<PadRow & { wells: WellRow[] }>(`/locations/pads/${padId}`)
    setColumns((cols) => cols.map((c) => (c.id === padId ? { ...pad, wells: pad.wells ?? [] } : c)))
  }, [])

  const addColumn = useCallback(async (padId: string) => {
    if (columns.some((c) => c.id === padId)) return
    const pad = await api.get<PadRow & { wells: WellRow[] }>(`/locations/pads/${padId}`)
    setColumns((cols) => [...cols, { ...pad, wells: pad.wells ?? [] }])
  }, [columns])

  // Source rail state (lifted so we can drop-remove from it).
  const [rail, setRail] = useState<'dmr' | 'wells'>('dmr')
  const [dmrResults, setDmrResults] = useState<DmrWell[]>([])
  const [wellResults, setWellResults] = useState<WellRow[]>([])

  const onDragStart = (e: DragStartEvent) => setActive((e.active.data.current as DragData) ?? null)

  const onDragEnd = async (e: DragEndEvent) => {
    setActive(null)
    const data = e.active.data.current as DragData | undefined
    const overId = e.over?.id?.toString()
    if (!data || !overId) return

    try {
      // Drop targets: "pad:<id>" (column) or "well:<id>" (a well chip, for DMR match)
      if (overId.startsWith('well:') && data.kind === 'dmr') {
        const wellId = overId.slice(5)
        await api.post('/locations/dmr/match/apply', { wellId, dmrReferenceId: data.dmr.id })
        setDmrResults((r) => r.filter((d) => d.id !== data.dmr.id))
        // refresh any column containing that well
        const col = columns.find((c) => c.wells.some((w) => w.id === wellId))
        if (col) await reloadPad(col.id)
        setMsg({ kind: 'ok', text: `Matched DMR "${data.dmr.wellName}" → existing well (API ${data.dmr.apiNumber}).` })
        return
      }

      if (overId.startsWith('pad:')) {
        const padId = overId.slice(4)
        const col = columns.find((c) => c.id === padId)
        if (!col) return

        if (data.kind === 'well') {
          if (data.well.pad?.id === padId) return
          await api.put(`/locations/wells/${data.well.id}/reassign`, { padId })
          setWellResults((r) => r.filter((w) => w.id !== data.well.id))
          // remove from any other column it sat in
          for (const c of columns) if (c.wells.some((w) => w.id === data.well.id)) await reloadPad(c.id)
          await reloadPad(padId)
          setMsg({ kind: 'ok', text: `Moved "${data.well.wellName}" → ${col.name}.` })
          return
        }

        if (data.kind === 'dmr') {
          const fieldId = col.field?.id
          if (!fieldId) { setMsg({ kind: 'err', text: `Pad "${col.name}" has no field — can't activate a well onto it.` }); return }
          await api.post('/locations/dmr/activate', { dmrWellIds: [data.dmr.id], fieldId, padId })
          setDmrResults((r) => r.filter((d) => d.id !== data.dmr.id))
          await reloadPad(padId)
          setMsg({ kind: 'ok', text: `Activated DMR "${data.dmr.wellName}" onto ${col.name}.` })
          return
        }
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setMsg({ kind: 'err', text: err.message })
      else setMsg({ kind: 'err', text: err instanceof ApiError ? err.message : 'Action failed' })
    }
  }

  return (
    <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
      <div className="h-full flex flex-col">
        <Banner msg={msg} onClose={() => setMsg(null)} />
        <div className="flex-1 min-h-0 flex gap-3">
          {/* Source rail */}
          <div className="w-72 shrink-0 flex flex-col border border-slate-200 rounded-lg bg-slate-50">
            <div className="flex rounded-t-lg overflow-hidden border-b border-slate-200">
              <RailBtn active={rail === 'dmr'} onClick={() => setRail('dmr')}>DMR wells</RailBtn>
              <RailBtn active={rail === 'wells'} onClick={() => setRail('wells')}>System wells</RailBtn>
            </div>
            {rail === 'dmr'
              ? <DmrSource results={dmrResults} setResults={setDmrResults} />
              : <WellSource results={wellResults} setResults={setWellResults} />}
          </div>

          {/* Pad workspace */}
          <div className="flex-1 min-w-0 flex flex-col">
            <PadPicker onPick={addColumn} />
            <div className="flex-1 min-h-0 overflow-x-auto overflow-y-hidden mt-2">
              <div className="flex gap-3 h-full pb-2">
                {columns.length === 0 ? (
                  <div className="flex items-center justify-center w-full text-slate-400 text-sm border-2 border-dashed border-slate-200 rounded-lg">
                    Search a pad above to add it as a drop target, then drag wells onto it.
                  </div>
                ) : columns.map((c) => (
                  <PadColumn key={c.id} pad={c} onRemove={() => setColumns((cols) => cols.filter((x) => x.id !== c.id))} />
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      <DragOverlay>
        {active && (
          <div className="px-2.5 py-1.5 rounded bg-white border border-blue-400 shadow-lg text-xs font-medium text-slate-800">
            {active.kind === 'dmr' ? active.dmr.wellName : active.well.wellName}
          </div>
        )}
      </DragOverlay>
    </DndContext>
  )
}

function RailBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick}
      className={`flex-1 py-2 text-xs font-medium transition ${active ? 'bg-white text-slate-900' : 'bg-slate-50 text-slate-500 hover:text-slate-700'}`}>
      {children}
    </button>
  )
}

// Debounced search hook.
function useDebounced(value: string, ms = 300) {
  const [v, setV] = useState(value)
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t) }, [value, ms])
  return v
}

function DmrSource({ results, setResults }: { results: DmrWell[]; setResults: (r: DmrWell[]) => void }) {
  const [q, setQ] = useState('')
  const dq = useDebounced(q)
  const [loading, setLoading] = useState(false)
  const reqId = useRef(0)

  useEffect(() => {
    if (dq.trim().length < 2) { setResults([]); return }
    const id = ++reqId.current
    setLoading(true)
    api.get<{ data: DmrWell[] }>(`/locations/dmr?search=${encodeURIComponent(dq.trim())}&limit=40`)
      .then((res) => { if (id === reqId.current) setResults(res.data.filter((d) => !d.matchedWellId)) })
      .catch(() => { if (id === reqId.current) setResults([]) })
      .finally(() => { if (id === reqId.current) setLoading(false) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dq])

  return (
    <div className="flex flex-col min-h-0 flex-1">
      <SearchBox value={q} onChange={setQ} placeholder="Search DMR by name/API…" loading={loading} />
      <p className="px-2 text-[10px] text-slate-400">Drag onto a pad to activate, or onto a well to match.</p>
      <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-1">
        {dq.trim().length < 2 ? <Hint text="Type to search the DMR reference (43k wells)." />
          : results.length === 0 && !loading ? <Hint text="No unmatched DMR wells found." />
          : results.map((d) => (
            <DraggableChip key={d.id} id={`dmr-${d.id}`} data={{ kind: 'dmr', dmr: d }}>
              <div className="min-w-0">
                <div className="font-medium text-slate-800 truncate">{d.wellName || '(no name)'}</div>
                <div className="text-[10px] text-slate-400 truncate">API {d.apiNumber} · S{d.section ?? '?'}-T{d.township ?? '?'}-R{d.range ?? '?'} · {d.operatorName || '—'}</div>
              </div>
            </DraggableChip>
          ))}
      </div>
    </div>
  )
}

function WellSource({ results, setResults }: { results: WellRow[]; setResults: (r: WellRow[]) => void }) {
  const [q, setQ] = useState('')
  const dq = useDebounced(q)
  const [loading, setLoading] = useState(false)
  const reqId = useRef(0)

  useEffect(() => {
    if (dq.trim().length < 2) { setResults([]); return }
    const id = ++reqId.current
    setLoading(true)
    api.get<{ data: WellRow[] }>(`/locations/wells?search=${encodeURIComponent(dq.trim())}&limit=40`)
      .then((res) => { if (id === reqId.current) setResults(res.data) })
      .catch(() => { if (id === reqId.current) setResults([]) })
      .finally(() => { if (id === reqId.current) setLoading(false) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dq])

  return (
    <div className="flex flex-col min-h-0 flex-1">
      <SearchBox value={q} onChange={setQ} placeholder="Search system wells…" loading={loading} />
      <p className="px-2 text-[10px] text-slate-400">Drag onto a pad to reassign.</p>
      <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-1">
        {dq.trim().length < 2 ? <Hint text="Type to search system wells." />
          : results.length === 0 && !loading ? <Hint text="No wells found." />
          : results.map((w) => (
            <DraggableChip key={w.id} id={`well-${w.id}`} data={{ kind: 'well', well: w }}>
              <div className="min-w-0">
                <div className="font-medium text-slate-800 truncate">{w.wellName || '(no name)'}</div>
                <div className="text-[10px] text-slate-400 truncate">{w.apiNumber ? `API ${w.apiNumber}` : 'no API'} · {w.pad ? `on ${w.pad.name}` : 'unassigned'}</div>
              </div>
            </DraggableChip>
          ))}
      </div>
    </div>
  )
}

function SearchBox({ value, onChange, placeholder, loading }: { value: string; onChange: (v: string) => void; placeholder: string; loading?: boolean }) {
  return (
    <div className="relative p-2">
      {loading ? <Loader2 className="w-4 h-4 absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 animate-spin" />
        : <Search className="w-4 h-4 absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" />}
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
        className="w-full pl-8 pr-2 py-1.5 text-sm border border-slate-200 rounded bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400" />
    </div>
  )
}

function Hint({ text }: { text: string }) {
  return <p className="text-center text-[11px] text-slate-400 py-8 px-3">{text}</p>
}

function DraggableChip({ id, data, children }: { id: string; data: DragData; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id, data })
  return (
    <div ref={setNodeRef} {...listeners} {...attributes}
      className={`flex items-center gap-2 bg-white border border-slate-200 rounded px-2 py-1.5 cursor-grab active:cursor-grabbing text-xs hover:border-blue-300 ${isDragging ? 'opacity-30' : ''}`}>
      <Crosshair className="w-3 h-3 text-slate-300 shrink-0" />
      {children}
    </div>
  )
}

function PadPicker({ onPick }: { onPick: (padId: string) => void }) {
  const [q, setQ] = useState('')
  const dq = useDebounced(q)
  const [results, setResults] = useState<PadRow[]>([])
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (dq.trim().length < 2) { setResults([]); return }
    api.get<{ data: PadRow[] }>(`/locations/pads?search=${encodeURIComponent(dq.trim())}&active=true&limit=20`)
      .then((res) => { setResults(res.data); setOpen(true) })
      .catch(() => setResults([]))
  }, [dq])

  return (
    <div className="relative">
      <div className="relative">
        <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
        <input value={q} onChange={(e) => { setQ(e.target.value); setOpen(true) }} onFocus={() => setOpen(true)}
          placeholder="Add a pad to the board (search by name)…"
          className="w-full pl-8 pr-2 py-2 text-sm border border-slate-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400" />
      </div>
      {open && results.length > 0 && (
        <div className="absolute z-10 left-0 right-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-lg max-h-64 overflow-y-auto">
          {results.map((p) => (
            <button key={p.id} onClick={() => { onPick(p.id); setOpen(false); setQ('') }}
              className="w-full text-left px-3 py-2 text-sm hover:bg-slate-50 flex items-center justify-between gap-2">
              <span className="font-medium text-slate-800 truncate flex items-center gap-1.5"><Pin className="w-3 h-3 text-blue-500" />{p.name}</span>
              <span className="text-xs text-slate-400 shrink-0">{p.field?.name} · {p._count?.wells ?? 0}w</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function PadColumn({ pad, onRemove }: { pad: PadRow & { wells: WellRow[] }; onRemove: () => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: `pad:${pad.id}`, data: { padId: pad.id } })
  return (
    <div ref={setNodeRef}
      className={`w-64 shrink-0 flex flex-col rounded-lg border ${isOver ? 'border-blue-400 bg-blue-50' : 'border-slate-200 bg-white'} transition`}>
      <div className="flex items-center justify-between gap-2 px-2.5 py-2 border-b border-slate-100">
        <div className="min-w-0">
          <div className="font-semibold text-sm text-slate-900 truncate flex items-center gap-1.5"><Pin className="w-3.5 h-3.5 text-blue-600" />{pad.name}</div>
          <div className="text-[10px] text-slate-400 truncate">{pad.field?.name || '—'} · {pad.wells.length} wells</div>
        </div>
        <button onClick={onRemove} className="text-slate-300 hover:text-slate-500 shrink-0"><X className="w-4 h-4" /></button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-1">
        {pad.wells.length === 0 ? <p className="text-[11px] text-slate-300 text-center py-6">Drop wells here</p>
          : pad.wells.map((w) => <WellDropChip key={w.id} well={w} />)}
      </div>
    </div>
  )
}

// A well chip on a pad: also a drop target so a DMR well can be matched onto it.
function WellDropChip({ well }: { well: WellRow }) {
  const { setNodeRef, isOver } = useDroppable({ id: `well:${well.id}`, data: { wellId: well.id } })
  return (
    <div ref={setNodeRef}
      className={`rounded px-2 py-1.5 border text-xs ${isOver ? 'border-green-400 bg-green-50' : 'border-slate-100 bg-slate-50'}`}>
      <div className="font-medium text-slate-700 truncate">{well.wellName || '(no name)'}</div>
      <div className="text-[10px] text-slate-400 truncate">{well.apiNumber ? `API ${well.apiNumber}` : 'no API — drop a DMR well to match'}</div>
    </div>
  )
}
