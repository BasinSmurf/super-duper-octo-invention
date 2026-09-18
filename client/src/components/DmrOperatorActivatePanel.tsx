import { useEffect, useRef, useState } from 'react'
import { api, ApiError } from '@/lib/api'
import {
  Factory, Search, Loader2, Check, ChevronDown, ChevronUp, Zap, Building2, ArrowRight, AlertTriangle,
  Link2, PlusCircle,
} from 'lucide-react'

interface DmrOperator { operatorName: string; unactivatedCount: number }
interface Company { id: string; name: string }
interface ActivateStats {
  fieldsCreated: number; padsCreated: number; wellsCreated: number; wellsLinked: number
  wellsSkipped: number; needsReview: number; errors: number
}
// mirror server/src/services/wellDmrMatch.ts ExistingWellCandidate
interface ExistingWellCandidate {
  id: string; wellName: string | null; apiNumber: string | null
  fieldName: string | null; padName: string | null; operatorName: string | null
  score: number; exact: boolean
}
interface AmbiguousActivation {
  dmrWellId: string; wellName: string | null; apiNumber: string | null; fieldName: string | null
  candidates: ExistingWellCandidate[]
}
type Resolution = { action: 'link'; wellId: string } | { action: 'create' }

/**
 * "Activate everything for <operator>" — bulk-materialize all unactivated DMR
 * wells for one or more operator names into the system under a chosen company.
 * Then run a buyout (Transfer Operator on the acquiring company) to fold it in.
 */
export function DmrOperatorActivatePanel() {
  const [open, setOpen] = useState(false)

  // Operator selection
  const [opQuery, setOpQuery] = useState('')
  const [opResults, setOpResults] = useState<DmrOperator[]>([])
  const [opLoading, setOpLoading] = useState(false)
  const [selectedOps, setSelectedOps] = useState<Map<string, number>>(new Map()) // name -> count
  const opReq = useRef(0)

  // Target company
  const [coQuery, setCoQuery] = useState('')
  const [coResults, setCoResults] = useState<Company[]>([])
  const [coOpen, setCoOpen] = useState(false)
  const [targetCompany, setTargetCompany] = useState<Company | null>(null)
  const [creatingCo, setCreatingCo] = useState(false)

  // Run state
  const [preview, setPreview] = useState<{ wouldActivate: number; alreadyExist: number; matched: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ stats: ActivateStats; company: string } | null>(null)
  const [error, setError] = useState('')

  // Ambiguous wells needing a per-well "same well or not?" confirm before they
  // can be activated (see server-side findExistingWellCandidates).
  const [ambiguous, setAmbiguous] = useState<AmbiguousActivation[]>([])
  const [resolutions, setResolutions] = useState<Map<string, Resolution>>(new Map())

  const selectedTotal = [...selectedOps.values()].reduce((a, b) => a + b, 0)

  // Operator search
  useEffect(() => {
    if (!open) return
    const id = ++opReq.current
    setOpLoading(true)
    api.get<{ data: DmrOperator[] }>(`/locations/dmr/operators?search=${encodeURIComponent(opQuery.trim())}`)
      .then(r => { if (id === opReq.current) setOpResults(r.data) })
      .catch(() => { if (id === opReq.current) setOpResults([]) })
      .finally(() => { if (id === opReq.current) setOpLoading(false) })
  }, [opQuery, open])

  // Company search
  useEffect(() => {
    if (!coQuery.trim()) { setCoResults([]); return }
    const t = setTimeout(() => {
      api.get<{ data: Company[] }>(`/companies?search=${encodeURIComponent(coQuery.trim())}&limit=10&active=true`)
        .then(r => { setCoResults(r.data || []); setCoOpen(true) })
        .catch(() => setCoResults([]))
    }, 200)
    return () => clearTimeout(t)
  }, [coQuery])

  function toggleOp(o: DmrOperator) {
    setSelectedOps(prev => {
      const next = new Map(prev)
      next.has(o.operatorName) ? next.delete(o.operatorName) : next.set(o.operatorName, o.unactivatedCount)
      return next
    })
    setPreview(null); setResult(null); setAmbiguous([]); setResolutions(new Map())
  }

  function pickCompany(c: Company) {
    setTargetCompany(c); setCoQuery(c.name); setCoOpen(false); setResult(null)
  }

  async function createCompany() {
    const name = coQuery.trim()
    if (!name) return
    setCreatingCo(true); setError('')
    try {
      const c = await api.post<Company>('/companies', { name, companyType: 'operator', isActive: true })
      pickCompany(c)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to create company')
    } finally {
      setCreatingCo(false)
    }
  }

  async function runPreview() {
    if (selectedOps.size === 0) return
    setBusy(true); setError(''); setResult(null)
    try {
      const r = await api.post<{ wouldActivate: number; alreadyExist: number; matched: number }>(
        '/locations/dmr/activate-by-operator',
        { operatorNames: [...selectedOps.keys()], dryRun: true },
      )
      setPreview(r)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Preview failed')
    } finally {
      setBusy(false)
    }
  }

  function mergeStats(a: ActivateStats | undefined, b: ActivateStats): ActivateStats {
    if (!a) return b
    return {
      fieldsCreated: a.fieldsCreated + b.fieldsCreated,
      padsCreated: a.padsCreated + b.padsCreated,
      wellsCreated: a.wellsCreated + b.wellsCreated,
      wellsLinked: a.wellsLinked + b.wellsLinked,
      wellsSkipped: a.wellsSkipped + b.wellsSkipped,
      needsReview: b.needsReview, // reflects what's still outstanding, not cumulative
      errors: a.errors + b.errors,
    }
  }

  // Fully done — no more ambiguous rows outstanding. Reset selection & refresh counts.
  function finishUp() {
    setPreview(null)
    setAmbiguous([]); setResolutions(new Map())
    setSelectedOps(new Map())
    setOpQuery(q => q) // retrigger
    opReq.current++ // force refresh
    api.get<{ data: DmrOperator[] }>(`/locations/dmr/operators?search=${encodeURIComponent(opQuery.trim())}`)
      .then(rr => setOpResults(rr.data)).catch(() => {})
  }

  async function runActivate() {
    if (selectedOps.size === 0 || !targetCompany) return
    setBusy(true); setError(''); setResult(null); setAmbiguous([]); setResolutions(new Map())
    try {
      const r = await api.post<{ stats: ActivateStats; targetCompany: Company; ambiguous: AmbiguousActivation[] }>(
        '/locations/dmr/activate-by-operator',
        { operatorNames: [...selectedOps.keys()], targetCompanyId: targetCompany.id },
      )
      setResult({ stats: r.stats, company: r.targetCompany.name })
      if (r.ambiguous.length > 0) {
        setAmbiguous(r.ambiguous)
      } else {
        finishUp()
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Activation failed')
    } finally {
      setBusy(false)
    }
  }

  function pickResolution(dmrWellId: string, resolution: Resolution) {
    setResolutions(prev => {
      const next = new Map(prev)
      next.set(dmrWellId, resolution)
      return next
    })
  }

  async function submitResolutions() {
    if (!targetCompany || ambiguous.length === 0) return
    setBusy(true); setError('')
    try {
      const r = await api.post<{ stats: ActivateStats; targetCompany: Company; ambiguous: AmbiguousActivation[] }>(
        '/locations/dmr/activate-by-operator',
        {
          operatorNames: [...selectedOps.keys()],
          targetCompanyId: targetCompany.id,
          resolutions: ambiguous.map(a => {
            const res = resolutions.get(a.dmrWellId)
            return res ? { dmrWellId: a.dmrWellId, ...res } : null
          }).filter(Boolean),
        },
      )
      setResult(prev => ({ stats: mergeStats(prev?.stats, r.stats), company: r.targetCompany.name }))
      if (r.ambiguous.length > 0) {
        setAmbiguous(r.ambiguous)
        setResolutions(new Map())
      } else {
        finishUp()
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Activation failed')
    } finally {
      setBusy(false)
    }
  }

  const exactCompanyMatch = coResults.some(c => c.name.toLowerCase() === coQuery.trim().toLowerCase())

  return (
    <div className="bg-white border border-slate-200 rounded-lg mb-4">
      <button onClick={() => setOpen(!open)} className="w-full flex items-center justify-between px-4 py-3 text-left">
        <div className="flex items-center gap-2">
          <Factory className="w-5 h-5 text-blue-600" />
          <div>
            <h3 className="text-sm font-semibold text-slate-900">Activate everything for an operator</h3>
            <p className="text-xs text-slate-500">Bulk-activate a DMR operator's wells, then run a buyout to reassign.</p>
          </div>
        </div>
        {open ? <ChevronUp className="w-5 h-5 text-slate-400" /> : <ChevronDown className="w-5 h-5 text-slate-400" />}
      </button>

      {open && (
        <div className="px-4 pb-4 border-t border-slate-100 pt-3 space-y-4">
          {/* Step 1: operators */}
          <div>
            <p className="text-xs font-medium text-slate-600 mb-1.5">1 · Pick operator(s) <span className="text-slate-400">(name variants are common — select all that apply)</span></p>
            <div className="relative mb-2">
              <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
              {opLoading && <Loader2 className="w-4 h-4 absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 animate-spin" />}
              <input value={opQuery} onChange={e => setOpQuery(e.target.value)} placeholder="Filter DMR operators (e.g. Burlington)…"
                className="w-full pl-8 pr-8 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400" />
            </div>
            <div className="max-h-44 overflow-y-auto border border-slate-100 rounded-lg divide-y divide-slate-50">
              {opResults.length === 0 ? (
                <p className="text-xs text-slate-400 text-center py-4">{opLoading ? 'Searching…' : 'No unactivated operators match.'}</p>
              ) : opResults.map(o => {
                const sel = selectedOps.has(o.operatorName)
                return (
                  <button key={o.operatorName} onClick={() => toggleOp(o)}
                    className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left hover:bg-blue-50 text-xs">
                    <span className={`w-4 h-4 rounded border-2 flex items-center justify-center shrink-0 ${sel ? 'border-blue-500 bg-blue-500' : 'border-slate-300'}`}>
                      {sel && <Check className="w-3 h-3 text-white" />}
                    </span>
                    <span className="flex-1 min-w-0 truncate font-medium text-slate-800">{o.operatorName}</span>
                    <span className="text-slate-400 shrink-0">{o.unactivatedCount.toLocaleString()} wells</span>
                  </button>
                )
              })}
            </div>
            {selectedOps.size > 0 && (
              <p className="text-xs text-blue-700 mt-1.5 font-medium">{selectedOps.size} operator{selectedOps.size === 1 ? '' : 's'} · {selectedTotal.toLocaleString()} unactivated wells selected</p>
            )}
          </div>

          {/* Step 2: target company */}
          <div>
            <p className="text-xs font-medium text-slate-600 mb-1.5">2 · Activate under company</p>
            <div className="relative">
              <Building2 className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
              <input value={coQuery}
                onChange={e => { setCoQuery(e.target.value); setTargetCompany(null); setCoOpen(true) }}
                placeholder="Search or name a company…"
                className="w-full pl-8 pr-8 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400" />
              {targetCompany && <Check className="w-4 h-4 absolute right-2.5 top-1/2 -translate-y-1/2 text-emerald-500" />}
              {coOpen && coQuery.trim() && !targetCompany && (
                <div className="absolute z-10 left-0 right-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
                  {coResults.map(c => (
                    <button key={c.id} onClick={() => pickCompany(c)} className="w-full text-left px-3 py-2 text-sm hover:bg-slate-50 truncate">{c.name}</button>
                  ))}
                  {!exactCompanyMatch && (
                    <button onClick={createCompany} disabled={creatingCo}
                      className="w-full text-left px-3 py-2 text-sm border-t border-slate-100 bg-slate-50 hover:bg-blue-50 text-blue-700 font-medium flex items-center gap-1.5">
                      {creatingCo ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Building2 className="w-3.5 h-3.5" />}
                      Create operator "{coQuery.trim()}"
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>

          {error && <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1.5 flex items-center gap-1.5"><AlertTriangle className="w-3.5 h-3.5" />{error}</div>}

          {preview && (
            <div className="text-xs bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-slate-700">
              Preview: <b>{preview.wouldActivate.toLocaleString()}</b> wells would be activated
              {preview.alreadyExist > 0 && <> · {preview.alreadyExist.toLocaleString()} already exist (skipped)</>}
            </div>
          )}

          {result && (
            <div className="text-xs bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 text-emerald-800">
              <p className="font-medium flex items-center gap-1.5"><Check className="w-3.5 h-3.5" />Activated under {result.company}</p>
              <p className="mt-0.5">
                {result.stats.wellsCreated.toLocaleString()} new · {result.stats.wellsLinked.toLocaleString()} linked to existing unattached wells · {result.stats.padsCreated.toLocaleString()} pads · {result.stats.fieldsCreated} fields created
                {result.stats.wellsSkipped > 0 ? ` · ${result.stats.wellsSkipped} skipped` : ''}
                {result.stats.errors > 0 ? ` · ${result.stats.errors} errors` : ''}
              </p>
              {ambiguous.length === 0 && (
                <p className="mt-1.5 flex items-center gap-1 text-emerald-700">
                  <ArrowRight className="w-3.5 h-3.5" /> Buyout? Open the acquiring company and use <b>Transfer Operator</b> to move it all over.
                </p>
              )}
            </div>
          )}

          {/* Ambiguous — DMR wells whose name matches an existing unattached
              well. Fuzzy hits can be a different wellbore entirely (e.g. an
              original "-1" vs its horizontal re-entry "-1H"), so each one
              needs an explicit human call before anything is created. */}
          {ambiguous.length > 0 && (
            <div className="border border-amber-200 bg-amber-50 rounded-lg p-3 space-y-3">
              <p className="text-xs font-medium text-amber-800 flex items-center gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5" />
                {ambiguous.length} well{ambiguous.length === 1 ? '' : 's'} look like they might already exist, unattached — confirm each one
              </p>
              <div className="space-y-2 max-h-80 overflow-y-auto">
                {ambiguous.map(a => {
                  const chosen = resolutions.get(a.dmrWellId)
                  return (
                    <div key={a.dmrWellId} className="bg-white border border-amber-100 rounded-lg p-2.5">
                      <p className="text-xs font-medium text-slate-800">{a.wellName || '(unnamed)'} <span className="text-slate-400 font-mono">{a.apiNumber}</span></p>
                      <div className="mt-1.5 space-y-1">
                        {a.candidates.map(c => {
                          const isChosen = chosen?.action === 'link' && chosen.wellId === c.id
                          return (
                            <button key={c.id} onClick={() => pickResolution(a.dmrWellId, { action: 'link', wellId: c.id })}
                              className={`w-full flex items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-xs border ${
                                isChosen ? 'border-blue-400 bg-blue-50' : 'border-slate-200 hover:border-slate-300'
                              }`}>
                              <span className="min-w-0 truncate">
                                <span className="font-medium text-slate-800">{c.wellName}</span>
                                {c.exact && <span className="ml-1 text-green-600 font-medium">exact name match</span>}
                                <span className="text-slate-400"> · {c.padName || c.fieldName || 'unattached'} · {c.operatorName || 'no operator'}</span>
                              </span>
                              <span className={`inline-flex items-center gap-1 shrink-0 ${isChosen ? 'text-blue-600' : 'text-slate-400'}`}>
                                <Link2 className="w-3 h-3" /> Same well
                              </span>
                            </button>
                          )
                        })}
                        <button onClick={() => pickResolution(a.dmrWellId, { action: 'create' })}
                          className={`w-full flex items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-xs border ${
                            chosen?.action === 'create' ? 'border-blue-400 bg-blue-50' : 'border-slate-200 hover:border-slate-300'
                          }`}>
                          <span className="text-slate-600">None of these — different well</span>
                          <span className={`inline-flex items-center gap-1 shrink-0 ${chosen?.action === 'create' ? 'text-blue-600' : 'text-slate-400'}`}>
                            <PlusCircle className="w-3 h-3" /> Create new
                          </span>
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
              <button onClick={submitResolutions} disabled={busy || resolutions.size < ambiguous.length}
                className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-amber-600 hover:bg-amber-700 rounded-lg disabled:opacity-50">
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                Confirm {resolutions.size}/{ambiguous.length} and continue
              </button>
            </div>
          )}

          {ambiguous.length === 0 && (
            <div className="flex items-center gap-2">
              <button onClick={runPreview} disabled={busy || selectedOps.size === 0}
                className="px-3 py-1.5 text-sm font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg disabled:opacity-50">
                {busy && !targetCompany ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Preview'}
              </button>
              <button onClick={runActivate} disabled={busy || selectedOps.size === 0 || !targetCompany}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg disabled:opacity-50">
                {busy && targetCompany ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
                Activate {selectedTotal > 0 ? selectedTotal.toLocaleString() : ''} wells
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
