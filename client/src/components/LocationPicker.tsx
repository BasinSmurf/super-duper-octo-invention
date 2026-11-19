import { HelpTip } from '@/components/HelpTip'
import { useState, useEffect, useRef, useMemo } from 'react'
import { db } from '@/lib/db'
import { api } from '@/lib/api'
import { useAuth } from '@/contexts/AuthContext'
import { isFieldMobileRole } from '@/lib/roleMobility'
import { cn } from '@/lib/cn'
import { MapPin, ChevronRight, Search, X, Check, Plus, AlertCircle } from 'lucide-react'

interface Field { id: string; name: string }
interface Pad {
  id: string
  name: string
  fieldId: string
  fieldName?: string
  county?: string | null
  pendingReview?: boolean
  isFloatingAsset?: boolean
  currentOperatorId?: string | null
  currentOperatorName?: string | null
}

// Mobile PadAssetCategory values only — must mirror FLOATING_ASSET_CATEGORIES
// in server/src/routes/locations.ts. gas_plant/office/etc. are fixed,
// single-operator places and stay scoped to the selected company normally.
// rig/truck retired — rigs are now the thin standalone MobileAsset model,
// trucks are free text captured directly on Air Fill tickets.
const FLOATING_ASSET_CATEGORIES = new Set(['other_mobile'])
export interface Well {
  id: string
  wellName: string
  padId: string
  apiNumber?: string | null
  pendingReview?: boolean
  isFloatingAsset?: boolean
  currentOperatorId?: string | null
  currentOperatorName?: string | null
}

export interface LocationSelection {
  field: Field | null
  pad: Pad | null
  wells: Well[]
}

interface LocationPickerProps {
  companyId: string | null
  value: LocationSelection
  onChange: (loc: LocationSelection) => void
  /** Allow selecting multiple wells at the SAME site. Default true for field_service, can be set to false */
  multiWell?: boolean
  /**
   * IH testing only: after the first well is picked, show a "+ additional
   * well" link that re-opens well-first search to add another well that may
   * be on a DIFFERENT pad/site (an IH visit can span more than one well on a
   * customer's lease). Distinct from multiWell, which only multi-selects
   * among wells already on the one selected pad.
   */
  multiSite?: boolean
  /** Field-service cleanup mode: select from every active site, then flag mismatches for approval. */
  allActive?: boolean
}

export function LocationPicker({ companyId, value, onChange, multiWell = true, multiSite = false, allActive = false }: LocationPickerProps) {
  // Every lookup below reads Dexie, and Dexie is only hydrated for field-mobile
  // roles (ADR-0005). An office-only role therefore searches an empty index and
  // gets "no results" for everything — which reads as missing data rather than
  // as a role limit, and sends people off editing wells that were never wrong.
  // Say so instead.
  const { user } = useAuth()
  const offlineHydrated = isFieldMobileRole(user?.role)
  // --- Pad search state ---
  const [padSearch, setPadSearch] = useState('')
  const [allPads, setAllPads] = useState<(Pad & { _fieldName: string })[]>([])
  const [loadingPads, setLoadingPads] = useState(false)
  const [padDropdownOpen, setPadDropdownOpen] = useState(false)
  const padInputRef = useRef<HTMLInputElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)

  // --- Well state ---
  const [availableWells, setAvailableWells] = useState<Well[]>([])
  const [loadingWells, setLoadingWells] = useState(false)

  // --- All wells on this customer's pads (for searching by WELL name) ---
  // Field techs are often handed only a well name, not a pad. We let the same
  // search box resolve a well name back to its location.
  const [allWells, setAllWells] = useState<Well[]>([])

  // --- Field cache ---
  // Field is hidden from the UI, but pads/wells may still carry a legacy
  // fieldId — kept as an internal lookup only (e.g. for display-less bookkeeping),
  // never surfaced or required from the tech.
  const [fieldMap, setFieldMap] = useState<Map<string, string>>(new Map())

  // --- Request-new-location modal ---
  const [showRequestModal, setShowRequestModal] = useState(false)
  const [reqName, setReqName] = useState('')
  const [reqWellNames, setReqWellNames] = useState('')
  const [reqSection, setReqSection] = useState('')
  const [reqTownship, setReqTownship] = useState('')
  const [reqRange, setReqRange] = useState('')
  const [reqNotes, setReqNotes] = useState('')
  const [reqSubmitting, setReqSubmitting] = useState(false)
  const [reqError, setReqError] = useState('')
  // Soft notice when a pad request matched an existing pad rather than
  // creating a new one. Auto-clears on next pad-state change.
  const [dedupNotice, setDedupNotice] = useState<string | null>(null)

  // Load the field id->name lookup (internal bookkeeping only — see above).
  useEffect(() => {
    db.fields.toArray().then(fields => {
      const map = new Map<string, string>()
      for (const f of fields) map.set(f.id, f.name)
      setFieldMap(map)
    }).catch(() => {})
  }, [])

  // Load pads for the selected company, PLUS every floating asset (rig,
  // truck, other mobile equipment) regardless of operator — those get
  // billed to whoever contracted them, not the operator of today's job
  // site, so they're never scoped to one company the way a real pad is.
  useEffect(() => {
    if (!companyId) {
      setAllPads([])
      return
    }
    setLoadingPads(true)

    Promise.all(allActive
      ? [db.pads.filter(p => p.isActive).toArray(), Promise.resolve([])]
      : [
        db.pads.where('currentOperatorId').equals(companyId).filter(p => p.isActive).toArray(),
        db.pads.filter(p => p.isActive && !!p.assetCategory && FLOATING_ASSET_CATEGORIES.has(p.assetCategory)).toArray(),
      ])
      .then(([operatorPads, floatingAssets]) => {
        const byId = new Map<string, typeof operatorPads[0]>()
        for (const p of operatorPads) byId.set(p.id, p)
        for (const p of floatingAssets) byId.set(p.id, p)
        const enriched = Array.from(byId.values()).map(p => ({
          id: p.id,
          name: p.name,
          fieldId: p.fieldId,
          county: p.county ?? null,
          isFloatingAsset: !!p.assetCategory && FLOATING_ASSET_CATEGORIES.has(p.assetCategory),
          currentOperatorId: p.currentOperatorId ?? null,
          currentOperatorName: (p as any).currentOperatorName ?? null,
          _fieldName: fieldMap.get(p.fieldId) || '',
        })).sort((a, b) => a.name.localeCompare(b.name))
        setAllPads(enriched)
      })
      .catch(() => setAllPads([]))
      .finally(() => setLoadingPads(false))
  }, [companyId, fieldMap, allActive])

  // Filter pads by search term
  const filteredPads = useMemo(() => {
    if (!padSearch.trim()) return allPads.slice(0, 100) // show first 100 when empty
    const q = padSearch.toLowerCase().trim()
    return allPads.filter(p =>
      p.name.toLowerCase().includes(q) ||
      p._fieldName.toLowerCase().includes(q) ||
      (p.county && p.county.toLowerCase().includes(q))
    ).slice(0, 100)
  }, [allPads, padSearch])

  // Pad lookup so a well result can resolve back to its location.
  const padById = useMemo(
    () => new Map(allPads.map(p => [p.id, p])),
    [allPads],
  )

  // Load every active well for this customer (by operator) once, so well-name
  // search is instant and works offline. Queried directly — NOT derived from
  // allPads — since most wells now have no pad at all (Pad is an optional
  // grouping, only created when D3 needs to work multiple wells at one site).
  useEffect(() => {
    if (!companyId) { setAllWells([]); return }
    Promise.all(allActive
      ? [db.wells.filter(w => w.isActiveForService).toArray(), Promise.resolve([])]
      : [
        db.wells.where('currentOperatorId').equals(companyId).filter(w => w.isActiveForService).toArray(),
        // Floating assets (rigs, trucks) get re-created once per operator if
        // this search stays scoped to just this one — pull them in regardless
        // of which operator they're currently stamped with.
        db.wells.filter(w => w.isActiveForService && !!w.assetCategory && FLOATING_ASSET_CATEGORIES.has(w.assetCategory)).toArray(),
      ])
      .then(([operatorWells, floatingAssets]) => {
        const byId = new Map<string, typeof operatorWells[0]>()
        for (const w of operatorWells) byId.set(w.id, w)
        for (const w of floatingAssets) byId.set(w.id, w)
        setAllWells(Array.from(byId.values()).map(w => ({
          id: w.id,
          wellName: w.wellName || 'Unnamed',
          padId: w.padId || '',
          apiNumber: w.apiNumber ?? null,
          pendingReview: w.pendingReview ?? false,
          isFloatingAsset: !!w.assetCategory && FLOATING_ASSET_CATEGORIES.has(w.assetCategory),
          currentOperatorId: w.currentOperatorId ?? null,
          currentOperatorName: (w as any).currentOperatorName ?? null,
        })))
      })
      .catch(() => setAllWells([]))
  }, [companyId, allActive])

  // Wells matching the search term. A well with no pad (the common case now)
  // is still a valid, directly-selectable result.
  const filteredWells = useMemo(() => {
    const q = padSearch.toLowerCase().trim()
    if (!q) return []
    return allWells
      .filter(w => w.wellName.toLowerCase().includes(q))
      .slice(0, 50)
  }, [allWells, padSearch])

  // Load wells when pad is selected
  useEffect(() => {
    if (!value.pad) {
      setAvailableWells([])
      return
    }
    setLoadingWells(true)
    db.wells
      .where('padId')
      .equals(value.pad.id)
      .filter(w => w.isActiveForService)
      .toArray()
      .then(wells => {
        setAvailableWells(
          wells
            .map(w => ({
              id: w.id,
              wellName: w.wellName || 'Unnamed',
              padId: w.padId || '',
              apiNumber: w.apiNumber ?? null,
              pendingReview: w.pendingReview ?? false,
              currentOperatorId: w.currentOperatorId ?? null,
              currentOperatorName: (w as any).currentOperatorName ?? null,
            }))
            .sort((a, b) => a.wellName.localeCompare(b.wellName))
        )
      })
      .catch(() => setAvailableWells([]))
      .finally(() => setLoadingWells(false))
  }, [value.pad?.id])

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setPadDropdownOpen(false)
      }
    }
    if (padDropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [padDropdownOpen])

  function selectPad(p: typeof allPads[0]) {
    const field: Field = { id: p.fieldId, name: p._fieldName || 'Unknown Field' }
    const pad: Pad = {
      id: p.id,
      name: p.name,
      fieldId: p.fieldId,
      county: p.county,
      isFloatingAsset: p.isFloatingAsset,
      currentOperatorId: p.currentOperatorId ?? null,
      currentOperatorName: p.currentOperatorName ?? null,
    }
    onChange({ field, pad, wells: [] })
    setPadDropdownOpen(false)
    setPadSearch('')
  }

  // Pick a well directly: resolve its pad if it has one, select the location,
  // and pre-check the well so a tech who only knows the well name lands
  // ready-to-go. Most wells have no pad at all now — that's fine, a well never
  // needs a pad to be selected.
  function selectWell(w: Well) {
    const p = padById.get(w.padId)
    const field: Field | null = p ? { id: p.fieldId, name: p._fieldName || 'Unknown Field' } : null
    const pad: Pad | null = p ? {
      id: p.id,
      name: p.name,
      fieldId: p.fieldId,
      county: p.county,
      currentOperatorId: p.currentOperatorId ?? null,
      currentOperatorName: p.currentOperatorName ?? null,
    } : null
    onChange({ field, pad, wells: [w] })
    setPadDropdownOpen(false)
    setPadSearch('')
  }

  // multiSite: append another well (possibly on a different/no pad) without
  // disturbing the primary pad/field already selected.
  function addAdditionalWell(w: Well) {
    if (value.wells.some(s => s.id === w.id)) return
    onChange({ ...value, wells: [...value.wells, w] })
  }

  function clearPad() {
    onChange({ field: null, pad: null, wells: [] })
    setPadSearch('')
    setDedupNotice(null)
    setTimeout(() => padInputRef.current?.focus(), 50)
  }

  function toggleWell(w: Well) {
    const selected = value.wells
    const exists = selected.some(s => s.id === w.id)
    if (exists) {
      onChange({ ...value, wells: selected.filter(s => s.id !== w.id) })
    } else if (multiWell) {
      onChange({ ...value, wells: [...selected, w] })
    } else {
      onChange({ ...value, wells: [w] })
    }
  }

  function selectAllWells() {
    onChange({ ...value, wells: [...availableWells] })
  }

  function clearWells() {
    onChange({ ...value, wells: [] })
  }

  const selectedWellIds = new Set(value.wells.map(w => w.id))

  // A well picked with no pad behind it. Pad became an optional grouping when
  // wells went first-class, so most wells resolve to no pad at all — and every
  // "you picked something" affordance below used to be gated on value.pad,
  // which meant picking one of those wells rendered nothing and read as "the
  // picker won't let me choose a site". multiSite draws its own chip list for
  // every selected well, so only the single-select flows need this card.
  const padlessWell = !value.pad && !multiSite && value.wells.length > 0 ? value.wells[0] : null

  function openRequestModal() {
    setReqName(padSearch.trim())
    setReqWellNames('')
    setReqSection('')
    setReqTownship('')
    setReqRange('')
    setReqNotes('')
    setReqError('')
    setShowRequestModal(true)
    setPadDropdownOpen(false)
  }

  async function submitLocationRequest() {
    if (!reqName.trim()) { setReqError('Pad name is required'); return }
    setReqSubmitting(true)
    setReqError('')
    try {
      const wellNames = reqWellNames.split(',').map(s => s.trim()).filter(Boolean)
      const body: any = {
        type: 'pad',
        name: reqName.trim(),
        // Carry the customer the wizard is working under — server stores it
        // in customData.requestedForCompanyId so the approver can filter
        // existing-pad candidates by operator and pre-select the operator
        // on resolve.
        companyId: companyId || undefined,
        notes: reqNotes.trim() || undefined,
        wellNames: wellNames.length ? wellNames : undefined,
      }
      if (reqSection) body.section = parseInt(reqSection, 10)
      if (reqTownship) body.township = parseInt(reqTownship, 10)
      if (reqRange) body.range = parseInt(reqRange, 10)

      const res = await api.post<{
        location: { id: string; name: string; fieldId: string | null; county?: string | null; pendingReview?: boolean }
        dedupMatched?: boolean
      }>('/locations/request', body)
      const created = res.location
      onChange({
        field: created.fieldId ? { id: created.fieldId, name: fieldMap.get(created.fieldId) || 'Unknown Field' } : null,
        pad: {
          id: created.id,
          name: created.name,
          fieldId: created.fieldId ?? '',
          county: created.county ?? null,
          // Server tells us whether the matched/created pad is pending review.
          // Default true for fresh requests where the field is omitted.
          pendingReview: created.pendingReview ?? !res.dedupMatched,
        },
        wells: [],
      })
      if (res.dedupMatched) {
        setDedupNotice(`Matched existing pad "${created.name}". Clear and search again if this isn't the one you meant.`)
      } else {
        setDedupNotice(null)
      }
      setShowRequestModal(false)
      setPadSearch('')
    } catch (err: any) {
      setReqError(err?.message || 'Failed to submit location request')
    } finally {
      setReqSubmitting(false)
    }
  }

  if (!companyId) {
    return (
      <div className="text-sm text-slate-400 p-3 border border-dashed border-slate-300 rounded-lg text-center">
        Select a customer first
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <label className="block text-sm font-medium text-slate-700">Location <HelpTip text="Search by pad, site, or well name, then select the location where the work is performed." /></label>

      {/* Pad search / selected pad */}
      <div>
        <p className="text-xs font-medium text-slate-500 mb-1">
          Pad / Site
          {!loadingPads && allPads.length > 0 && !value.pad && value.wells.length === 0 && (
            <span className="text-slate-400 font-normal"> — {allPads.length} locations</span>
          )}
        </p>

        {value.pad ? (
          <div className={cn(
            'flex items-center gap-2 p-3 border rounded-lg',
            value.pad.pendingReview ? 'bg-amber-50 border-amber-300' : 'bg-emerald-50 border-emerald-200',
          )}>
            <MapPin className={cn('w-4 h-4 shrink-0', value.pad.pendingReview ? 'text-amber-600' : 'text-emerald-600')} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium text-slate-900 truncate">{value.pad.name}</span>
                {value.pad.pendingReview && (
                  <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded bg-amber-200 text-amber-800">
                    <AlertCircle className="w-3 h-3" /> Pending review
                  </span>
                )}
                {value.pad.isFloatingAsset && (
                  <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded bg-purple-100 text-purple-700">
                    Rig/truck — any operator
                  </span>
                )}
              </div>
              {value.pad.county && (
                <span className="text-xs text-slate-500">{value.pad.county}</span>
              )}
            </div>
            <button type="button" onClick={clearPad} className={cn(
              'text-sm font-medium shrink-0',
              value.pad.pendingReview ? 'text-amber-700 hover:text-amber-900' : 'text-emerald-600 hover:text-emerald-800',
            )}>
              Change
            </button>
          </div>
        ) : padlessWell ? (
          <div className="flex items-center gap-2 p-3 border rounded-lg bg-emerald-50 border-emerald-200">
            <MapPin className="w-4 h-4 shrink-0 text-emerald-600" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium text-slate-900 truncate">{padlessWell.wellName}</span>
                <span className="text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded bg-slate-200 text-slate-700 shrink-0">
                  Well
                </span>
                {padlessWell.isFloatingAsset && (
                  <span className="text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 shrink-0">
                    Rig/truck &mdash; any operator
                  </span>
                )}
              </div>
              <span className="text-xs text-slate-500">Standalone well &mdash; no pad/site grouping</span>
            </div>
            <button
              type="button"
              onClick={clearPad}
              className="text-sm font-medium shrink-0 text-emerald-600 hover:text-emerald-800"
            >
              Change
            </button>
          </div>
        ) : null}
        {dedupNotice && value.pad && (
          <div className="mt-2 text-xs text-blue-800 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2">
            {dedupNotice}
          </div>
        )}
        {!offlineHydrated && (
          <div className="flex items-start gap-2 p-3 mb-2 rounded-lg bg-amber-50 border border-amber-200">
            <AlertCircle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
            <div className="text-xs text-amber-800">
              <p className="font-semibold">Location search is empty for your role.</p>
              <p className="mt-0.5">
                Wells and pads are searched from offline data, which only field
                roles load. Nothing found here means "not downloaded", not
                "does not exist" &mdash; sign in as a field role to pick a location.
              </p>
            </div>
          </div>
        )}
        {!value.pad && loadingPads ? (
          <div className="text-sm text-slate-400 p-3 animate-pulse">Loading locations...</div>
        ) : (
          <div ref={dropdownRef} className="relative">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input
                ref={padInputRef}
                type="text"
                value={padSearch}
                onChange={e => { setPadSearch(e.target.value); setPadDropdownOpen(true) }}
                onFocus={() => setPadDropdownOpen(true)}
                placeholder="Search by well name, pad/site, field, or county..."
                className="w-full pl-10 pr-10 py-3 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 outline-none"
              />
              {padSearch && (
                <button
                  type="button"
                  onClick={() => { setPadSearch(''); padInputRef.current?.focus() }}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>

            {padDropdownOpen && (
              <div className="absolute z-20 top-full left-0 right-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-lg max-h-72 overflow-y-auto">
                {filteredPads.length === 0 && filteredWells.length === 0 ? (
                  <div className="p-3 text-sm text-slate-400 text-center">
                    {!offlineHydrated
                      ? 'Location data is not available for your role'
                      : allPads.length === 0 ? (allActive ? 'No active locations' : 'No locations for this customer') : 'No matches'}
                  </div>
                ) : (
                  <>
                    {/* Wells matching the term — shown first so a well-name lookup lands at the top */}
                    {filteredWells.length > 0 && (
                      <>
                        <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wide font-semibold text-slate-400 bg-slate-50">
                          Wells
                        </div>
                        {filteredWells.map(w => (
                          <button
                            key={w.id}
                            type="button"
                            onClick={() => selectWell(w)}
                            className="w-full text-left px-3 py-2.5 hover:bg-emerald-50 transition-colors border-b border-slate-50 flex items-center gap-2"
                          >
                            <MapPin className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                            <span className="min-w-0">
                              <p className="text-sm font-medium text-slate-900 truncate flex items-center gap-1.5">
                                {w.wellName}
                                {w.isFloatingAsset && (
                                  <span className="text-[10px] uppercase tracking-wide font-semibold px-1 py-0.5 rounded bg-purple-100 text-purple-700 shrink-0">rig/truck</span>
                                )}
                              </p>
                              {padById.get(w.padId) && (
                                <p className="text-xs text-slate-500 truncate">on {padById.get(w.padId)!.name}</p>
                              )}
                            </span>
                          </button>
                        ))}
                      </>
                    )}

                    {filteredPads.length > 0 && (
                      <>
                        {filteredWells.length > 0 && (
                          <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wide font-semibold text-slate-400 bg-slate-50">
                            Pads / Sites
                          </div>
                        )}
                        {filteredPads.map(p => (
                          <button
                            key={p.id}
                            type="button"
                            onClick={() => selectPad(p)}
                            className="w-full text-left px-3 py-2.5 hover:bg-emerald-50 transition-colors border-b border-slate-50 last:border-b-0"
                          >
                            <p className="text-sm font-medium text-slate-900 truncate flex items-center gap-1.5">
                              {p.name}
                              {p.isFloatingAsset && (
                                <span className="text-[10px] uppercase tracking-wide font-semibold px-1 py-0.5 rounded bg-purple-100 text-purple-700 shrink-0">rig/truck</span>
                              )}
                            </p>
                            {p.county && <p className="text-xs text-slate-500 truncate">{p.county}</p>}
                          </button>
                        ))}
                        {filteredPads.length === 100 && (
                          <div className="p-2 text-xs text-slate-400 text-center bg-slate-50">
                            Showing first 100 — type to narrow results
                          </div>
                        )}
                      </>
                    )}
                  </>
                )}
                {/* Request new location — always available from dropdown */}
                <button
                  type="button"
                  onClick={openRequestModal}
                  className="w-full text-left px-3 py-2.5 border-t border-slate-200 bg-slate-50 hover:bg-amber-50 flex items-center gap-2 text-sm text-amber-700 font-medium"
                >
                  <Plus className="w-4 h-4" />
                  Can't find it? Request new location
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Well selector */}
      {value.pad && !loadingWells && availableWells.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-1">
            <p className="text-xs font-medium text-slate-500">
              Well{multiWell ? 's' : ''} <span className="text-slate-400">({availableWells.length} at this site{multiWell ? ', pick one or more' : ''})</span>
            </p>
            {multiWell && availableWells.length > 1 && (
              <div className="flex gap-2">
                {value.wells.length < availableWells.length ? (
                  <button type="button" onClick={selectAllWells} className="text-[11px] text-blue-600 hover:text-blue-800 font-medium">
                    Select All
                  </button>
                ) : (
                  <button type="button" onClick={clearWells} className="text-[11px] text-slate-500 hover:text-slate-700 font-medium">
                    Clear All
                  </button>
                )}
              </div>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2 max-h-48 overflow-y-auto">
            {availableWells.map(w => {
              const isSelected = selectedWellIds.has(w.id)
              return (
                <button
                  key={w.id}
                  type="button"
                  onClick={() => toggleWell(w)}
                  className={cn(
                    'text-left p-3 rounded-lg border-2 transition-colors text-sm font-medium',
                    isSelected
                      ? 'border-emerald-400 bg-emerald-50 text-emerald-800'
                      : 'border-slate-200 text-slate-700 hover:border-emerald-300 hover:bg-emerald-50',
                  )}
                >
                  <div className="flex items-center gap-2">
                    <div className={cn(
                      'w-4 h-4 rounded border-2 flex items-center justify-center shrink-0',
                      isSelected ? 'border-emerald-500 bg-emerald-500' : 'border-slate-300',
                    )}>
                      {isSelected && <Check className="w-3 h-3 text-white" />}
                    </div>
                    <span className="truncate">{w.wellName}</span>
                  </div>
                </button>
              )
            })}
          </div>
          {value.wells.length > 0 && (
            <p className="text-xs text-emerald-600 font-medium mt-1.5">
              {value.wells.length} of {availableWells.length} well{availableWells.length !== 1 ? 's' : ''} selected
            </p>
          )}
        </div>
      )}

      {value.pad && !loadingWells && availableWells.length === 0 && (
        <div className="text-xs text-slate-400 p-2">No wells at this site</div>
      )}

      {value.pad && loadingWells && (
        <div className="text-xs text-slate-400 p-2 animate-pulse">Loading wells...</div>
      )}

      {/* multiSite: additional wells, possibly on a different pad/site — IH testing only */}
      {multiSite && value.wells.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex flex-wrap gap-1.5">
            {value.wells.map(w => (
              <span key={w.id} className="inline-flex items-center gap-1 text-xs bg-emerald-50 text-emerald-800 border border-emerald-200 rounded-full pl-2.5 pr-1 py-1">
                {w.wellName}
                <button
                  type="button"
                  onClick={() => onChange({ ...value, wells: value.wells.filter(s => s.id !== w.id) })}
                  className="text-emerald-500 hover:text-emerald-800"
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            ))}
          </div>
          <AdditionalWellSearch
            allWells={allWells}
            excludeIds={selectedWellIds}
            onAdd={addAdditionalWell}
          />
        </div>
      )}

      {/* Summary breadcrumb — a pad-less well is a complete location on its own */}
      {(value.pad || value.wells.length > 0) && (
        <div className="flex items-center gap-1 text-xs text-slate-500 pt-1 flex-wrap">
          {value.pad && <span>{value.pad.name}</span>}
          {value.pad && value.wells.length > 0 && <ChevronRight className="w-3 h-3" />}
          {value.wells.length === 1 && <span>{value.wells[0].wellName}</span>}
          {value.wells.length > 1 && <span>{value.wells.length} wells</span>}
        </div>
      )}

      {/* ---- Request-new-location modal ---- */}
      {showRequestModal && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-2xl max-w-md w-full">
            <div className="p-5 border-b border-slate-200">
              <h3 className="text-base font-semibold text-slate-900">Request new location</h3>
              <p className="text-xs text-slate-500 mt-1">
                The ticket will proceed with this pad attached. An admin will verify it against DMR records.
              </p>
            </div>
            <div className="p-5 space-y-3">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Pad / site name <span className="text-rose-500">*</span></label>
                <input
                  type="text"
                  value={reqName}
                  onChange={e => setReqName(e.target.value)}
                  placeholder="e.g. Johnson 14-7H"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-amber-500 focus:border-amber-500 outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Well names <span className="text-slate-400">(comma-separated, optional)</span></label>
                <input
                  type="text"
                  value={reqWellNames}
                  onChange={e => setReqWellNames(e.target.value)}
                  placeholder="Johnson 14-7H, Johnson 14-8H"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-amber-500 focus:border-amber-500 outline-none"
                />
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Section</label>
                  <input type="number" value={reqSection} onChange={e => setReqSection(e.target.value)}
                    className="w-full px-2 py-2 text-sm border border-slate-300 rounded-lg outline-none focus:ring-2 focus:ring-amber-500" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Township</label>
                  <input type="number" value={reqTownship} onChange={e => setReqTownship(e.target.value)}
                    className="w-full px-2 py-2 text-sm border border-slate-300 rounded-lg outline-none focus:ring-2 focus:ring-amber-500" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Range</label>
                  <input type="number" value={reqRange} onChange={e => setReqRange(e.target.value)}
                    className="w-full px-2 py-2 text-sm border border-slate-300 rounded-lg outline-none focus:ring-2 focus:ring-amber-500" />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Notes <span className="text-slate-400">(optional)</span></label>
                <textarea
                  value={reqNotes}
                  onChange={e => setReqNotes(e.target.value)}
                  rows={2}
                  placeholder="Anything helpful for the admin matching this..."
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-amber-500 focus:border-amber-500 outline-none"
                />
              </div>
              {reqError && (
                <div className="text-xs text-rose-600 bg-rose-50 border border-rose-200 rounded px-2 py-1.5">{reqError}</div>
              )}
            </div>
            <div className="p-4 bg-slate-50 border-t border-slate-200 flex gap-2 justify-end">
              <button
                type="button"
                onClick={() => setShowRequestModal(false)}
                disabled={reqSubmitting}
                className="px-3 py-1.5 text-sm text-slate-600 hover:text-slate-800"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submitLocationRequest}
                disabled={reqSubmitting}
                className="px-4 py-1.5 text-sm font-medium rounded-lg bg-amber-600 hover:bg-amber-500 text-white disabled:opacity-50"
              >
                {reqSubmitting ? 'Submitting...' : 'Submit request'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// multiSite "+ additional well" affordance: search box that stays open across
// adds so a tech can quickly chain-add several wells for one IH visit.
function AdditionalWellSearch({ allWells, excludeIds, onAdd }: {
  allWells: Well[]
  excludeIds: Set<string>
  onAdd: (w: Well) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [term, setTerm] = useState('')

  const matches = useMemo(() => {
    const q = term.toLowerCase().trim()
    if (!q) return []
    return allWells.filter(w => !excludeIds.has(w.id) && w.wellName.toLowerCase().includes(q)).slice(0, 20)
  }, [allWells, excludeIds, term])

  if (!expanded) {
    return (
      <button type="button" onClick={() => setExpanded(true)} className="text-xs text-blue-600 hover:text-blue-800 font-medium">
        + additional well
      </button>
    )
  }

  return (
    <div className="space-y-1">
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
        <input
          type="text"
          value={term}
          onChange={e => setTerm(e.target.value)}
          placeholder="Search by well name..."
          autoFocus
          className="w-full pl-8 pr-3 py-1.5 border border-slate-200 rounded-lg text-xs focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500 outline-none"
        />
      </div>
      {matches.length > 0 && (
        <div className="border border-slate-200 rounded-lg max-h-40 overflow-y-auto">
          {matches.map(w => (
            <button
              key={w.id}
              type="button"
              onClick={() => { onAdd(w); setTerm('') }}
              className="w-full text-left px-3 py-1.5 text-xs hover:bg-emerald-50 border-b border-slate-50 last:border-b-0"
            >
              {w.wellName}
            </button>
          ))}
        </div>
      )}
      {term.trim().length > 0 && matches.length === 0 && (
        <p className="text-xs text-slate-400 px-1">No matching wells.</p>
      )}
    </div>
  )
}
