import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { api } from '@/lib/api'
import { cn } from '@/lib/cn'
import { useAuth } from '@/contexts/AuthContext'
import { hasPermission } from '@/lib/permissions'
import { formatCalendarDate } from '@/lib/dates'
import { EditWellModal } from '@/components/EditWellModal'
import { LocationWorkPointEditor } from '@/components/LocationWorkPointEditor'
import { InlineCodeField } from '@/components/InlineCodeField'
import {
  ArrowLeft,
  Droplets,
  Building2,
  Navigation,
  Loader2,
  AlertTriangle,
  Shield,
  CheckCircle,
  Compass,
  Hash,
  Activity,
  History,
  Trash2,
  GitMerge,
  Search,
  Pencil,
  MapPin,
} from 'lucide-react'

// ---- Types ----
interface WorkPointInfo {
  id: string
  name: string
  type: string
  isActive: boolean
  customData: any
}

interface WellDetail {
  id: string
  wellName: string | null
  wellNameBase: string | null
  apiNumber: string | null
  apiShort: string | null
  dmrFileNumber: number | null
  totalDepth: number | null
  spudDate: string | null
  wellType: string | null
  wellStatus: string | null
  county: string | null
  facilityCode: string | null
  costCenter: string | null
  quarterQuarter: string | null
  section: number | null
  township: number | null
  range: number | null
  feetNs: number | null
  nsLine: string | null
  feetEw: number | null
  ewLine: string | null
  latitude: string | null
  longitude: string | null
  hasSuppliedAir: boolean
  hasAreaMonitors: boolean
  isHighRisk: boolean
  tier1: boolean
  riskNotes: string | null
  isActiveForService: boolean
  serviceNotes: string | null
  pendingReview: boolean
  assetCategory: 'site' | 'other_mobile'
    | 'gas_plant' | 'tank_battery' | 'compressor_station' | 'swd_facility' | 'office' | 'shop'
  customData: any
  createdAt: string
  updatedAt: string
  pad: { id: string; name: string } | null
  field: { id: string; name: string; county: string | null; state: string | null } | null
  currentOperator: { id: string; name: string } | null
  workPoints: WorkPointInfo[]
  // True if this well is referenced by any ticket, rental, equipment, fit test,
  // route stop, or operator history — the same check that gates deletion.
  hasHistory: boolean
}

interface WellOption {
  id: string
  wellName: string | null
  apiNumber: string | null
  pad: { id: string; name: string } | null
  currentOperator: { id: string; name: string } | null
}

const STATUS_LABELS: Record<string, string> = {
  A: 'Active', DRY: 'Dry Hole', PA: 'Plugged & Abandoned', PNC: 'Plugged & Completed',
  IA: 'Inactive', SI: 'Shut In', TA: 'Temp Abandoned',
  LOC: 'Location', WC: 'Waiting Completion', DC: 'Drilling Complete',
}

const TYPE_LABELS: Record<string, string> = {
  OG: 'Oil & Gas', SWD: 'Salt Water Disposal', WI: 'Water Injection',
  GI: 'Gas Injection', OB: 'Observation', ST: 'Stratigraphic Test',
}

const ASSET_CATEGORY_LABELS: Record<string, string> = {
  other_mobile: 'Mobile asset',
  gas_plant: 'Gas plant', tank_battery: 'Tank battery', compressor_station: 'Compressor station',
  swd_facility: 'SWD facility', office: 'Office', shop: 'Shop',
}

function formatDate(d: string | null): string {
  if (!d) return '---'
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export function WellDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { user } = useAuth()
  const canManage = hasPermission(user?.role, 'locations:manage')
  const isAdmin = user?.role === 'platform_admin'
  const [well, setWell] = useState<WellDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Facility code inline edit
  const [editingFacility, setEditingFacility] = useState(false)
  const [facilityDraft, setFacilityDraft] = useState('')
  const [savingFacility, setSavingFacility] = useState(false)
  // Admin-only core-field edit (API #, operator, legal location, etc.)
  const [showEditWell, setShowEditWell] = useState(false)

  // Delete / merge (danger zone)
  const [deleting, setDeleting] = useState(false)
  const [merging, setMerging] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [showMergePicker, setShowMergePicker] = useState(false)
  const [mergeSearch, setMergeSearch] = useState('')
  const [mergeResults, setMergeResults] = useState<WellOption[]>([])
  const [mergeSearching, setMergeSearching] = useState(false)
  const [mergeTarget, setMergeTarget] = useState<WellOption | null>(null)

  const handleSaveFacility = async () => {
    if (!well) return
    const value = facilityDraft.trim() || null
    setSavingFacility(true)
    try {
      await api.put(`/locations/wells/${well.id}`, { facilityCode: value })
      setWell({ ...well, facilityCode: value })
      setEditingFacility(false)
    } catch (e: any) {
      alert(e.message || 'Failed to update facility code')
    } finally {
      setSavingFacility(false)
    }
  }

  const handleAssetCategoryChange = async (next: WellDetail['assetCategory']) => {
    if (!well) return
    const prev = well.assetCategory
    setWell({ ...well, assetCategory: next })  // optimistic
    try {
      await api.put(`/locations/wells/${well.id}`, { assetCategory: next })
    } catch (e: any) {
      setWell({ ...well, assetCategory: prev })  // revert
      alert(e.message || 'Failed to update asset type')
    }
  }

  const handleToggleTier1 = async () => {
    if (!well) return
    const next = !well.tier1
    setWell({ ...well, tier1: next })  // optimistic
    try {
      await api.put(`/locations/wells/${well.id}`, { tier1: next })
    } catch (e: any) {
      setWell({ ...well, tier1: !next })  // revert
      alert(e.message || 'Failed to update Tier 1')
    }
  }

  // Deliberately NOT gated on hasHistory — a P&A'd well almost always HAS
  // history (that's the whole reason it needs flipping), so it can't go
  // through the delete path. This is the "it's done producing" switch,
  // independent of whether it's safe to delete outright.
  const handleToggleActive = async () => {
    if (!well) return
    const next = !well.isActiveForService
    setWell({ ...well, isActiveForService: next })  // optimistic
    try {
      await api.put(`/locations/wells/${well.id}`, { isActiveForService: next })
    } catch (e: any) {
      setWell({ ...well, isActiveForService: !next })  // revert
      alert(e.message || 'Failed to update active status')
    }
  }

  const handleDelete = async () => {
    if (!well) return
    if (!window.confirm(`Delete "${well.wellName || 'this well'}" outright? This cannot be undone.`)) return
    setDeleting(true)
    setActionError(null)
    try {
      await api.delete(`/locations/wells/${well.id}`)
      navigate(well.pad ? `/locations/pads/${well.pad.id}` : '/locations')
    } catch (e: any) {
      setActionError(e.message || 'Failed to delete well')
    } finally {
      setDeleting(false)
    }
  }

  const handleMerge = async () => {
    if (!well || !mergeTarget) return
    if (!window.confirm(
      `Merge "${well.wellName || 'this well'}" into "${mergeTarget.wellName || 'the selected well'}"? ` +
      `Every ticket, rental, equipment assignment, and other history on this well will move to the ` +
      `target, then this well will be deactivated.`
    )) return
    setMerging(true)
    setActionError(null)
    try {
      await api.post(`/locations/wells/${well.id}/merge`, { winnerWellId: mergeTarget.id })
      navigate(`/locations/wells/${mergeTarget.id}`)
    } catch (e: any) {
      setActionError(e.message || 'Failed to merge well')
      setMerging(false)
    }
  }

  // Debounced search for the merge-target picker, once opened.
  useEffect(() => {
    if (!showMergePicker) return
    const term = mergeSearch.trim()
    if (!term) { setMergeResults([]); return }
    setMergeSearching(true)
    const handle = setTimeout(() => {
      api.get<{ data: WellOption[] }>(`/locations/wells?search=${encodeURIComponent(term)}&limit=8`)
        .then(r => setMergeResults(r.data.filter(w => w.id !== well?.id)))
        .catch(() => setMergeResults([]))
        .finally(() => setMergeSearching(false))
    }, 300)
    return () => clearTimeout(handle)
  }, [mergeSearch, showMergePicker, well?.id])

  const loadWell = useCallback(() => {
    if (!id) return
    setLoading(true)
    setError(null)
    api.get<WellDetail>(`/locations/wells/${id}`)
      .then(data => setWell(data))
      .catch(e => setError(e.message || 'Failed to load well'))
      .finally(() => setLoading(false))
  }, [id])

  useEffect(() => {
    loadWell()
  }, [loadWell])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 animate-spin text-blue-500" />
        <span className="ml-2 text-gray-500">Loading well...</span>
      </div>
    )
  }

  if (error || !well) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-6">
        <button onClick={() => navigate(-1)} className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-4">
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
          {error || 'Well not found'}
        </div>
      </div>
    )
  }

  const str = [well.section, well.township, well.range].filter(v => v != null)
  const strLabel = str.length === 3 ? `S${str[0]} T${str[1]}N R${str[2]}W` : null
  const hasGps = well.latitude && well.longitude
  const surfaceLocation = [
    well.feetNs ? `${well.feetNs}' ${well.nsLine || 'NS'}` : null,
    well.feetEw ? `${well.feetEw}' ${well.ewLine || 'EW'}` : null,
  ].filter(Boolean).join(', ')

  return (
    <div className="max-w-3xl mx-auto px-4 py-6 space-y-6">
      {/* Header */}
      <div>
        {/* Breadcrumb */}
        <div className="flex items-center gap-1 text-sm text-gray-500 mb-3 flex-wrap">
          <button onClick={() => navigate('/locations')} className="hover:text-gray-700">Locations</button>
          {well.pad && (
            <>
              <span>/</span>
              <button onClick={() => navigate(`/locations/pads/${well.pad!.id}`)} className="hover:text-gray-700">{well.pad.name}</button>
            </>
          )}
          <span>/</span>
          <span className="text-gray-700 font-medium">{well.wellName || 'Well'}</span>
        </div>

        <div className="flex items-start gap-3">
          <div className="w-12 h-12 rounded-xl bg-blue-50 flex items-center justify-center flex-shrink-0">
            <Droplets className="w-6 h-6 text-blue-600" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-2">
              <h1 className="text-xl font-bold text-gray-900">{well.wellName || 'Unnamed Well'}</h1>
              {isAdmin && (
                <button
                  onClick={() => setShowEditWell(true)}
                  title="Edit core well fields (API #, operator, legal location, classification) — admin only"
                  className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 shrink-0"
                >
                  <Pencil className="w-3.5 h-3.5" /> Edit
                </button>
              )}
            </div>
            <div className="flex items-center flex-wrap gap-2 mt-1">
              {well.wellStatus && (
                <span
                  title="Status as reported by NDIC/DMR — not editable here"
                  className={cn(
                    'text-xs px-2 py-0.5 rounded-full font-medium flex items-center gap-1',
                    well.wellStatus === 'A' ? 'bg-green-100 text-green-700' :
                    well.wellStatus === 'PA' ? 'bg-red-100 text-red-600' :
                    well.wellStatus === 'SI' ? 'bg-amber-100 text-amber-700' :
                    'bg-gray-100 text-gray-600'
                  )}>
                  <span className="text-[10px] font-semibold uppercase tracking-wide opacity-60">DMR</span>
                  {STATUS_LABELS[well.wellStatus] || well.wellStatus}
                </span>
              )}
              {well.wellType && (
                <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">
                  {TYPE_LABELS[well.wellType] || well.wellType}
                </span>
              )}
              {well.isHighRisk && (
                <span className="text-xs bg-red-100 text-red-600 px-2 py-0.5 rounded-full flex items-center gap-1">
                  <Shield className="w-3 h-3" /> High Risk
                </span>
              )}
              {well.pendingReview && (
                <span className="text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full flex items-center gap-1">
                  <AlertTriangle className="w-3 h-3" /> Pending Review
                </span>
              )}
              {canManage ? (
                <button
                  onClick={handleToggleTier1}
                  className={cn(
                    'text-xs px-2 py-0.5 rounded-full flex items-center gap-1 transition-colors',
                    well.tier1
                      ? 'bg-purple-100 text-purple-700 hover:bg-purple-200'
                      : 'bg-gray-100 text-gray-500 hover:bg-gray-200',
                  )}
                  title={well.tier1 ? 'On a reservation — 5% Tier 1 fee applies. Click to clear.' : 'Mark this well as on a reservation (adds the 5% Tier 1 fee at invoicing)'}
                >
                  <MapPin className="w-3 h-3" />
                  {well.tier1 ? 'Tier 1' : 'Not Tier 1'}
                </button>
              ) : well.tier1 ? (
                <span className="text-xs bg-purple-100 text-purple-700 px-2 py-0.5 rounded-full flex items-center gap-1">
                  <MapPin className="w-3 h-3" /> Tier 1
                </span>
              ) : null}
              {canManage ? (
                <select
                  value={well.assetCategory}
                  onChange={e => handleAssetCategoryChange(e.target.value as WellDetail['assetCategory'])}
                  title="Rigs/trucks bypass operator-scoped dedup so the same record is reused for every operator they work for"
                  className={cn(
                    'text-xs px-2 py-0.5 rounded-full border-0 cursor-pointer',
                    well.assetCategory !== 'site' ? 'bg-purple-100 text-purple-700' : 'bg-gray-100 text-gray-500',
                  )}
                >
                  <option value="site">Normal well</option>
                  <option value="other_mobile">Other mobile asset (any operator)</option>
                  <option value="gas_plant">Gas plant</option>
                  <option value="tank_battery">Tank battery</option>
                  <option value="compressor_station">Compressor station</option>
                  <option value="swd_facility">SWD facility</option>
                  <option value="office">Office</option>
                  <option value="shop">Shop</option>
                </select>
              ) : well.assetCategory !== 'site' ? (
                <span className="text-xs bg-purple-100 text-purple-700 px-2 py-0.5 rounded-full">
                  {ASSET_CATEGORY_LABELS[well.assetCategory] || well.assetCategory}
                </span>
              ) : null}
              {canManage ? (
                <button
                  onClick={handleToggleActive}
                  className={cn(
                    'text-xs px-2 py-0.5 rounded-full font-medium transition-colors flex items-center gap-1',
                    well.isActiveForService
                      ? 'bg-green-100 text-green-700 hover:bg-green-200'
                      : 'bg-red-100 text-red-600 hover:bg-red-200',
                  )}
                  title={well.isActiveForService ? 'ServicePRO status — click to mark inactive (e.g. P&A’d)' : 'ServicePRO status — click to reactivate'}
                >
                  <span className="text-[10px] font-semibold uppercase tracking-wide opacity-60">Service</span>
                  {well.isActiveForService ? 'Active' : 'Inactive'}
                </button>
              ) : (
                <span
                  title="ServicePRO status — whether this well is in active rotation for work"
                  className={cn(
                    'text-xs px-2 py-0.5 rounded-full font-medium flex items-center gap-1',
                    well.isActiveForService ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-600',
                  )}
                >
                  <span className="text-[10px] font-semibold uppercase tracking-wide opacity-60">Service</span>
                  {well.isActiveForService ? 'Active' : 'Inactive'}
                </span>
              )}
              <span className={cn(
                'text-xs px-2 py-0.5 rounded-full font-medium flex items-center gap-1',
                well.hasHistory ? 'bg-slate-100 text-slate-600' : 'bg-amber-100 text-amber-700'
              )}>
                <History className="w-3 h-3" />
                {well.hasHistory ? 'Has history' : 'No history'}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Well Info Card */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
        <div className="px-4 py-3 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
            <Hash className="w-4 h-4" /> Well Info
          </h2>
        </div>
        <div className="px-4 py-3">
          <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
            {well.apiNumber && <InfoRow label="API #" value={well.apiNumber} />}
            {well.apiShort && <InfoRow label="API Short" value={well.apiShort} />}
            {well.dmrFileNumber && <InfoRow label="DMR File #" value={well.dmrFileNumber.toString()} />}
            {well.totalDepth && <InfoRow label="Total Depth" value={`${well.totalDepth.toLocaleString()} ft`} />}
            {well.spudDate && <InfoRow label="Spud Date" value={formatCalendarDate(well.spudDate)} />}
            {well.wellNameBase && well.wellNameBase !== well.wellName && (
              <InfoRow label="Base Name" value={well.wellNameBase} />
            )}
          </div>
          {well.currentOperator && (
            <div className="mt-2 pt-2 border-t border-gray-100">
              <button
                onClick={() => navigate(`/companies/${well.currentOperator!.id}`)}
                className="text-sm text-blue-600 hover:underline flex items-center gap-1"
              >
                <Building2 className="w-3.5 h-3.5" /> {well.currentOperator.name}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Location Card */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
        <div className="px-4 py-3 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
            <Compass className="w-4 h-4" /> Location
          </h2>
        </div>
        <div className="px-4 py-3 space-y-2 text-sm">
          <div className="grid grid-cols-2 gap-x-6 gap-y-2">
            {well.quarterQuarter && <InfoRow label="QQ" value={well.quarterQuarter} />}
            {strLabel && <InfoRow label="S/T/R" value={strLabel} />}
            {well.county && <InfoRow label="County" value={well.county} />}
            {surfaceLocation && <InfoRow label="Surface" value={surfaceLocation} />}
          </div>
          {hasGps && (
            <div className="flex items-center gap-2 pt-1">
              <Navigation className="w-4 h-4 text-gray-400 flex-shrink-0" />
              <a
                href={`https://maps.google.com/?q=${well.latitude},${well.longitude}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 hover:underline text-sm"
              >
                {parseFloat(well.latitude!).toFixed(5)}, {parseFloat(well.longitude!).toFixed(5)}
              </a>
            </div>
          )}
          {/* Facility Code (Enverus charge-to) */}
          <div className="flex items-center gap-2 pt-1">
            <Hash className="w-4 h-4 text-gray-400 flex-shrink-0" />
            {editingFacility ? (
              <>
                <input
                  type="text"
                  value={facilityDraft}
                  onChange={e => setFacilityDraft(e.target.value)}
                  placeholder="Facility code (e.g. FC17708)"
                  autoFocus
                  className="flex-1 border border-gray-300 rounded px-2 py-1 text-sm focus:ring-1 focus:ring-blue-500"
                  onKeyDown={e => { if (e.key === 'Enter') handleSaveFacility(); if (e.key === 'Escape') setEditingFacility(false) }}
                />
                <button onClick={handleSaveFacility} disabled={savingFacility} className="text-xs text-blue-600 hover:underline disabled:opacity-50">Save</button>
                <button onClick={() => setEditingFacility(false)} className="text-xs text-gray-400 hover:text-gray-600">Cancel</button>
              </>
            ) : (
              <>
                <span className="text-gray-500">Facility Code:</span>
                <span className="text-gray-700">{well.facilityCode || <span className="text-gray-400 italic">none</span>}</span>
                {canManage && (
                  <button
                    onClick={() => { setFacilityDraft(well.facilityCode || ''); setEditingFacility(true) }}
                    className="text-xs text-blue-600 hover:underline ml-1"
                  >
                    {well.facilityCode ? 'Edit' : 'Add'}
                  </button>
                )}
              </>
            )}
          </div>
          {/* Cost code (Enverus Cost Object) — stamped onto new invoices for work here */}
          <InlineCodeField
            label="Cost Code"
            value={well.costCenter}
            placeholder="Cost code (e.g. US00098792)"
            canEdit={canManage}
            onSave={async value => {
              await api.put(`/locations/wells/${well.id}`, { costCenter: value })
              setWell({ ...well, costCenter: value })
            }}
          />
        </div>
      </div>

      {/* Operational Card */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
        <div className="px-4 py-3 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
            <Activity className="w-4 h-4" /> Operational
          </h2>
        </div>
        <div className="px-4 py-3 space-y-2">
          <div className="flex flex-wrap gap-3 text-sm">
            <FlagBadge on={well.hasSuppliedAir} label="Supplied Air" />
            <FlagBadge on={well.hasAreaMonitors} label="Area Monitors" />
            <FlagBadge on={well.isHighRisk} label="High Risk" danger />
          </div>
          {well.riskNotes && (
            <div className="p-2 bg-red-50 rounded text-xs text-red-700 mt-2">
              <span className="font-medium">Risk Notes:</span> {well.riskNotes}
            </div>
          )}
          {well.serviceNotes && (
            <div className="p-2 bg-blue-50 rounded text-xs text-blue-700 mt-2">
              <span className="font-medium">Service Notes:</span> {well.serviceNotes}
            </div>
          )}
        </div>
      </div>

      <LocationWorkPointEditor
        workPoints={well.workPoints}
        canManage={canManage}
        wellId={well.id}
        onChanged={loadWell}
      />

      {/* Danger Zone */}
      {canManage && (
        <div className="bg-white rounded-lg border border-red-200 shadow-sm">
          <div className="px-4 py-3 border-b border-red-100">
            <h2 className="text-sm font-semibold text-red-700 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4" /> Danger Zone
            </h2>
          </div>
          <div className="px-4 py-3 space-y-3">
            {actionError && (
              <div className="p-2 bg-red-50 rounded text-xs text-red-700">{actionError}</div>
            )}

            <div className="flex items-start justify-between gap-3">
              <div className="text-sm">
                <p className="font-medium text-gray-800">Merge into another well</p>
                <p className="text-xs text-gray-500">Moves every ticket, rental, equipment assignment, and other history here onto the target well, then deactivates this one.</p>
              </div>
              <button
                onClick={() => setShowMergePicker(s => !s)}
                className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 shrink-0"
              >
                <GitMerge className="w-3.5 h-3.5" /> Merge…
              </button>
            </div>

            {showMergePicker && (
              <div className="bg-gray-50 border border-gray-200 rounded-lg p-3 space-y-2">
                {mergeTarget ? (
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-sm min-w-0">
                      <p className="font-medium text-gray-800 truncate">{mergeTarget.wellName || '(unnamed)'}</p>
                      <p className="text-xs text-gray-400 truncate">
                        {mergeTarget.apiNumber ? `API ${mergeTarget.apiNumber} · ` : ''}
                        {mergeTarget.pad?.name || 'no pad'}
                        {mergeTarget.currentOperator ? ` · ${mergeTarget.currentOperator.name}` : ''}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button onClick={() => setMergeTarget(null)} className="text-xs text-gray-400 hover:text-gray-600">Change</button>
                      <button
                        onClick={handleMerge}
                        disabled={merging}
                        className="inline-flex items-center gap-1 text-xs font-medium px-2.5 py-1 rounded bg-amber-600 hover:bg-amber-700 text-white disabled:opacity-50"
                      >
                        {merging ? <Loader2 className="w-3 h-3 animate-spin" /> : <GitMerge className="w-3 h-3" />} Confirm merge
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="relative">
                      <Search className="w-3.5 h-3.5 text-gray-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                      <input
                        autoFocus
                        value={mergeSearch}
                        onChange={e => setMergeSearch(e.target.value)}
                        placeholder="Search wells by name or API #…"
                        className="w-full pl-8 pr-3 py-1.5 text-sm border border-gray-300 rounded-lg"
                      />
                    </div>
                    {mergeSearching ? (
                      <p className="text-xs text-gray-400 py-1">Searching…</p>
                    ) : mergeResults.length > 0 ? (
                      <div className="space-y-1 max-h-48 overflow-y-auto">
                        {mergeResults.map(w => (
                          <button
                            key={w.id}
                            onClick={() => setMergeTarget(w)}
                            className="w-full text-left px-2 py-1.5 rounded hover:bg-white border border-transparent hover:border-gray-200 text-sm"
                          >
                            <span className="font-medium text-gray-800">{w.wellName || '(unnamed)'}</span>
                            <span className="text-xs text-gray-400 ml-1.5">
                              {w.apiNumber ? `API ${w.apiNumber} · ` : ''}{w.pad?.name || 'no pad'}
                            </span>
                          </button>
                        ))}
                      </div>
                    ) : mergeSearch.trim() ? (
                      <p className="text-xs text-gray-400 py-1">No matching wells.</p>
                    ) : null}
                  </>
                )}
              </div>
            )}

            <div className="flex items-start justify-between gap-3 pt-2 border-t border-gray-100">
              <div className="text-sm">
                <p className="font-medium text-gray-800">Delete well</p>
                <p className="text-xs text-gray-500">
                  {well.hasHistory
                    ? 'Blocked — this well has history. Merge it into another well instead.'
                    : 'Permanently removes this well. No history is attached, so nothing else is affected.'}
                </p>
              </div>
              <button
                onClick={handleDelete}
                disabled={deleting || well.hasHistory}
                title={well.hasHistory ? 'Has history — merge instead of deleting' : undefined}
                className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-700 text-white disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
              >
                {deleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />} Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="text-xs text-gray-400 text-center pb-4">
        Created {formatDate(well.createdAt)} &middot; Last updated {formatDate(well.updatedAt)}
      </div>

      {/* Edit Well Modal (admin only) */}
      {showEditWell && (
        <EditWellModal
          well={well}
          onSaved={(patch) => { setWell({ ...well, ...patch }); setShowEditWell(false) }}
          onClose={() => setShowEditWell(false)}
        />
      )}
    </div>
  )
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-gray-500 flex-shrink-0">{label}:</span>
      <span className="text-gray-800 font-medium truncate">{value}</span>
    </div>
  )
}

function FlagBadge({ on, label, danger }: { on: boolean; label: string; danger?: boolean }) {
  return (
    <span className={cn(
      'inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full font-medium',
      on
        ? danger ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'
        : 'bg-gray-100 text-gray-400'
    )}>
      {on ? <CheckCircle className="w-3 h-3" /> : <span className="w-3 h-3 rounded-full border border-current inline-block" />}
      {label}
    </span>
  )
}
