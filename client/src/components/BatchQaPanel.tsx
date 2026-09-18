/**
 * BatchQaPanel — WI-06: QA a selection in one action, then the exceptions.
 *
 * THE CHECKLIST COMES FROM THE SERVER. It would be a line of code to render it
 * from the client's mirrored catalog, and it would be wrong: the gate that
 * decides whether these units may be released reads the server's list, and a
 * client that drew its boxes from a stale bundle would let a tech tick four
 * boxes and be told they missed a fifth they were never shown.
 *
 * THE EXCEPTIONS ARE THE SAME FORM. "Pass 4 as a batch, then QA the other 6
 * individually" is not two features here — the per-unit rows are always
 * present, always optional, and a single unit is a batch of one. A separate
 * single-unit dialog is a second code path that eventually disagrees with this
 * one about what a pass means.
 */

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Check, ChevronDown, ChevronRight, Loader2, X } from 'lucide-react'
import { api } from '../lib/api'

interface Checkpoint {
  key: string
  label: string
  required: boolean
}

interface ChecklistResponse {
  category: string | null
  error: string | null
  checklistVersion?: string
  checkpoints: Checkpoint[]
  eligible: { id: string; serialNumber: string }[]
  skipped: { id: string; serialNumber: string; reason: string }[]
}

interface PerUnitState {
  /** Checkpoint keys this unit deviates on: key → the unit's own answer. */
  overrides: Record<string, boolean>
  notes: string
  fail: boolean
}

interface Props {
  workOrderId: string
  itemIds: string[]
  onClose: () => void
  onDone: () => void | Promise<void>
}

const EMPTY_UNIT: PerUnitState = { overrides: {}, notes: '', fail: false }

export function BatchQaPanel({ workOrderId, itemIds, onClose, onDone }: Props) {
  const [meta, setMeta] = useState<ChecklistResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [results, setResults] = useState<Record<string, boolean>>({})
  const [notes, setNotes] = useState('')
  const [perUnit, setPerUnit] = useState<Record<string, PerUnitState>>({})
  const [expanded, setExpanded] = useState<string | null>(null)

  // The selection is fixed for the life of this panel — the caller remounts it
  // (keyed on the selection) when the checkboxes change, so this fetch runs once
  // and the "loading" reset lives in the initial state rather than in the effect.
  const selectionKey = itemIds.join(',')

  useEffect(() => {
    let cancelled = false
    api
      .get<ChecklistResponse>(`/shop-orders/${workOrderId}/qa-checklist?itemIds=${selectionKey}`)
      .then(res => {
        if (cancelled) return
        setMeta(res)
        if (res.error) setError(res.error)
      })
      .catch(err => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load the checklist')
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [workOrderId, selectionKey])

  const unitOf = useCallback(
    (id: string) => perUnit[id] ?? EMPTY_UNIT,
    [perUnit],
  )

  function setUnit(id: string, patch: Partial<PerUnitState>) {
    setPerUnit(prev => ({ ...prev, [id]: { ...(prev[id] ?? EMPTY_UNIT), ...patch } }))
  }

  // A unit's effective answer: its own override if it has one, else the batch.
  // Mirrors the server's `effectiveChecklist` exactly — the tech should see the
  // same resolution the gate will apply, not a client approximation of it.
  function effectiveFor(id: string, key: string): boolean | undefined {
    const o = unitOf(id).overrides
    return key in o ? o[key] : results[key]
  }

  const required = meta?.checkpoints.filter(c => c.required) ?? []
  const missing = required.filter(c => results[c.key] !== true)

  function unitPasses(id: string): boolean {
    if (unitOf(id).fail) return false
    return required.every(c => effectiveFor(id, c.key) === true)
  }

  const eligible = meta?.eligible ?? []
  const passing = eligible.filter(u => unitPasses(u.id))
  const failing = eligible.filter(u => !unitPasses(u.id))

  async function submit() {
    setBusy(true)
    setError('')
    try {
      await api.post(`/shop-orders/${workOrderId}/batch-qa`, {
        itemIds: eligible.map(u => u.id),
        checklistResults: results,
        notes: notes.trim() || undefined,
        perUnit: Object.fromEntries(
          Object.entries(perUnit)
            .filter(([, v]) => Object.keys(v.overrides).length > 0 || v.notes.trim() || v.fail)
            .map(([k, v]) => [k, { overrides: v.overrides, notes: v.notes.trim() || undefined, fail: v.fail }]),
        ),
      })
      await onDone()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Batch QA failed')
    } finally {
      setBusy(false)
    }
  }

  if (loading) {
    return (
      <div className="px-4 py-6 bg-cyan-50 border-b border-cyan-200 flex items-center gap-2 text-sm text-cyan-800">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading the checklist for this selection…
      </div>
    )
  }

  // A mixed selection has no single checklist to run, so there is nothing to
  // render but the reason why.
  if (!meta?.category) {
    return (
      <div className="px-4 py-3 bg-amber-50 border-b border-amber-200">
        <div className="flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
          <p className="text-xs text-amber-900 flex-1">{error || 'Nothing in this selection can be QA’d.'}</p>
          <button type="button" onClick={onClose} className="text-amber-700 hover:text-amber-900">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="px-4 py-3 bg-cyan-50 border-b border-cyan-200 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-cyan-900">
          Batch QA — {eligible.length} unit{eligible.length === 1 ? '' : 's'}
          <span className="ml-2 font-normal text-cyan-700 capitalize">
            {meta.category.replace(/_/g, ' ')}
          </span>
        </h3>
        <button type="button" onClick={onClose} disabled={busy}
          className="text-cyan-700 hover:text-cyan-900"><X className="w-4 h-4" /></button>
      </div>

      {meta.skipped.length > 0 && (
        <p className="text-[11px] text-cyan-800">
          Not QA’d (already closed): {meta.skipped.map(s => s.serialNumber).join(', ')}
        </p>
      )}

      {/* The shared checklist — ONE set of boxes for the whole batch. */}
      <div className="rounded-lg border border-cyan-200 bg-white divide-y divide-slate-100">
        {meta.checkpoints.map(cp => {
          const val = results[cp.key]
          return (
            <div key={cp.key} className="flex items-center gap-2 px-3 py-2">
              <span className="flex-1 text-xs text-slate-700">
                {cp.label}
                {cp.required && <span className="ml-1 text-red-500" title="Required">*</span>}
              </span>
              <div className="flex gap-1 shrink-0">
                <button type="button" onClick={() => setResults(r => ({ ...r, [cp.key]: true }))}
                  className={`px-2 py-1 rounded text-[11px] font-semibold border ${
                    val === true
                      ? 'bg-emerald-600 text-white border-emerald-600'
                      : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'}`}>Pass</button>
                <button type="button" onClick={() => setResults(r => ({ ...r, [cp.key]: false }))}
                  className={`px-2 py-1 rounded text-[11px] font-semibold border ${
                    val === false
                      ? 'bg-red-600 text-white border-red-600'
                      : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'}`}>Fail</button>
              </div>
            </div>
          )
        })}
        {meta.checkpoints.length === 0 && (
          <p className="px-3 py-3 text-xs text-slate-500">
            This category has no shop checklist. Recording a batch QA here attests to the units
            being checked — it does not assert that a checklist was run.
          </p>
        )}
      </div>

      {missing.length > 0 && (
        <p className="text-[11px] text-amber-800">
          {missing.length} required check{missing.length === 1 ? '' : 's'} not answered yet — units
          will be recorded as failed until every required box is a pass.
        </p>
      )}

      <div>
        <label className="block text-[10px] font-medium text-cyan-700 uppercase tracking-wide mb-1">
          Batch note (stored once, on the QA record)
        </label>
        <input value={notes} onChange={e => setNotes(e.target.value)}
          placeholder="e.g. annual service, all gauges reseated"
          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm" />
      </div>

      {/* Per-unit exceptions. Always here, never required. */}
      <div className="rounded-lg border border-cyan-200 bg-white">
        <div className="px-3 py-2 text-[11px] font-medium text-slate-600 border-b border-slate-100">
          Units — open one to record an exception
        </div>
        <div className="divide-y divide-slate-100 max-h-64 overflow-y-auto">
          {eligible.map(u => {
            const open = expanded === u.id
            const st = unitOf(u.id)
            const passes = unitPasses(u.id)
            const deviations = Object.keys(st.overrides).length
            return (
              <div key={u.id}>
                <button type="button" onClick={() => setExpanded(open ? null : u.id)}
                  className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-slate-50">
                  {open ? <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
                        : <ChevronRight className="w-3.5 h-3.5 text-slate-400" />}
                  <span className="font-mono text-xs text-slate-700 flex-1">{u.serialNumber}</span>
                  {deviations > 0 && (
                    <span className="text-[10px] text-violet-700">{deviations} exception{deviations === 1 ? '' : 's'}</span>
                  )}
                  <span className={`px-2 py-0.5 rounded text-[10px] font-semibold ${
                    passes ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
                    {passes ? 'PASS' : 'FAIL'}
                  </span>
                </button>

                {open && (
                  <div className="px-3 pb-3 space-y-2 bg-slate-50">
                    <div className="rounded border border-slate-200 bg-white divide-y divide-slate-100">
                      {meta.checkpoints.map(cp => {
                        const eff = effectiveFor(u.id, cp.key)
                        const overridden = cp.key in st.overrides
                        return (
                          <div key={cp.key} className="flex items-center gap-2 px-2 py-1.5">
                            <span className="flex-1 text-[11px] text-slate-600">
                              {cp.label}
                              {overridden && <span className="ml-1 text-violet-600">(this unit)</span>}
                            </span>
                            <div className="flex gap-1 shrink-0">
                              <button type="button"
                                onClick={() => setUnit(u.id, { overrides: { ...st.overrides, [cp.key]: true } })}
                                className={`px-1.5 py-0.5 rounded text-[10px] border ${
                                  eff === true ? 'bg-emerald-600 text-white border-emerald-600'
                                               : 'bg-white text-slate-500 border-slate-300'}`}>P</button>
                              <button type="button"
                                onClick={() => setUnit(u.id, { overrides: { ...st.overrides, [cp.key]: false } })}
                                className={`px-1.5 py-0.5 rounded text-[10px] border ${
                                  eff === false ? 'bg-red-600 text-white border-red-600'
                                                : 'bg-white text-slate-500 border-slate-300'}`}>F</button>
                              {overridden && (
                                <button type="button" title="Use the batch answer"
                                  onClick={() => {
                                    const next = { ...st.overrides }
                                    delete next[cp.key]
                                    setUnit(u.id, { overrides: next })
                                  }}
                                  className="px-1.5 py-0.5 rounded text-[10px] border border-slate-300 text-slate-500 bg-white">↺</button>
                              )}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                    <input value={st.notes} onChange={e => setUnit(u.id, { notes: e.target.value })}
                      placeholder="What was wrong with this one?"
                      className="w-full px-2 py-1.5 border border-slate-300 rounded text-xs" />
                    <label className="flex items-center gap-2 text-[11px] text-slate-600">
                      <input type="checkbox" checked={st.fail}
                        onChange={e => setUnit(u.id, { fail: e.target.checked })} />
                      Fail this unit regardless of the checklist
                    </label>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {error && <p className="text-xs text-red-700">{error}</p>}

      <div className="flex items-center gap-2">
        <button type="button" onClick={submit} disabled={busy || eligible.length === 0}
          className="px-4 py-2 rounded-lg text-xs font-semibold bg-cyan-700 text-white hover:bg-cyan-600 disabled:opacity-40 flex items-center gap-1.5">
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
          Record QA — {passing.length} pass, {failing.length} fail
        </button>
        <button type="button" onClick={onClose} disabled={busy}
          className="px-3 py-2 rounded-lg text-xs font-medium border border-slate-300 text-slate-600 bg-white">
          Cancel
        </button>
        {failing.length > 0 && (
          <span className="text-[11px] text-slate-600">
            Failed units go back to In Repair; passing units move to Ready for Pickup.
          </span>
        )}
      </div>
    </div>
  )
}
