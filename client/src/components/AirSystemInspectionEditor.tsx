import { useState, useEffect } from 'react'
import { cn } from '@/lib/cn'
import type { AirSystemDraftRecord, CylinderRecord } from '@/lib/db-types'
import { api } from '@/lib/api'
import { WorkPointVerification, verificationCurrent } from '@/components/WorkPointVerification'
import { SerialInput } from '@/components/SerialInput'
import { MobileAssetPicker, type MobileAssetOption } from '@/components/MobileAssetPicker'
import {
  Plus,
  Trash2,
  ChevronDown,
  ChevronUp,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Wind,
  Gauge,
  Wrench,
  MapPin,
  Cylinder,
  ArrowRightLeft,
} from 'lucide-react'

interface WorkPointCylinder {
  serialNumber: string
  hydroDate?: string
  expiryDate?: string
}

interface WorkPointInfo {
  id: string
  name: string
  airSystemType: string | null
  reelSerialNumber: string | null
  standSerialNumber: string | null
  cylinders: WorkPointCylinder[]
  verified: boolean
  dateVerified: string | null
}

interface AirSystemInspectionEditorProps {
  records: AirSystemDraftRecord[]
  onChange: (records: AirSystemDraftRecord[]) => void
  wellIds?: string[]
  padId?: string | null
}

// ---- Component check items (cylinder removed — tracked per-bottle now) ----
const COMPONENT_CHECKS = [
  { key: 'reelCondition', label: 'Reel' },
  { key: 'standCondition', label: 'Stand' },
  { key: 'hoseCondition', label: 'Hose' },
  { key: 'maskCondition', label: 'Mask' },
  { key: 'regulatorCondition', label: 'Regulator' },
  { key: 'gaugeCondition', label: 'Gauge' },
  { key: 'alarmCondition', label: 'Alarm' },
] as const

// ---- Service actions (replaced_cylinder removed — now per-bottle) ----
// 'no_service_required' is the explicit "nothing needed" option; pick at
// least one action OR this one before the inspection can be marked complete.
export const SERVICE_ACTIONS = [
  { key: 'no_service_required', label: 'No service required' },
  { key: 'replaced_hose', label: 'Replaced Hose' },
  { key: 'replaced_mask', label: 'Replaced Mask' },
  { key: 'replaced_regulator', label: 'Replaced Regulator' },
  { key: 'replaced_gauge', label: 'Replaced Gauge' },
  { key: 'replaced_alarm', label: 'Replaced Alarm' },
  { key: 'cleaned_system', label: 'Cleaned System' },
  { key: 'tightened_fittings', label: 'Tightened Fittings' },
  { key: 'leak_test', label: 'Performed Leak Test' },
  { key: 'tagged_out', label: 'Tagged Out of Service' },
]

// Non-cylinder replacement serial tracking
const REPLACEMENT_SERIAL_ACTIONS: Record<string, { oldKey: keyof AirSystemDraftRecord; newKey: keyof AirSystemDraftRecord; label: string }> = {
  replaced_regulator: { oldKey: 'replacedRegulatorSerialOld', newKey: 'replacedRegulatorSerialNew', label: 'Regulator' },
  replaced_mask: { oldKey: 'replacedMaskSerialOld', newKey: 'replacedMaskSerialNew', label: 'Mask' },
}

const AIR_SYSTEM_TYPES = [
  { value: 'tank_battery', label: 'Tank Battery' },
  { value: 'oil_tank_battery', label: 'Oil Tank Battery' },
  { value: 'compressor', label: 'Compressor' },
  { value: 'swd_facility', label: 'SWD Facility' },
  { value: 'gas_plant', label: 'Gas Plant' },
  { value: 'other', label: 'Other' },
]

let nextTempId = 1
let nextCylId = 1

function createBlankCylinder(): CylinderRecord {
  return {
    id: `cyl_${Date.now()}_${nextCylId++}`,
    serialNumber: '',
    hydroDate: '',
    expiryDate: '',
    condition: 'pass',
    replaced: false,
    replacedNewSerial: '',
    replacedNewHydroDate: '',
    replacedNewExpiryDate: '',
  }
}

function createBlankRecord(): AirSystemDraftRecord {
  return {
    id: `as_${Date.now()}_${nextTempId++}`,
    workPointId: null,
    workPointName: '',
    airSystemType: 'tank_battery',
    reelSerialNumber: '',
    standSerialNumber: '',
    overallResult: 'pass',
    reelCondition: 'pass',
    standCondition: 'pass',
    hoseCondition: 'pass',
    maskCondition: 'pass',
    regulatorCondition: 'pass',
    gaugeCondition: 'pass',
    alarmCondition: 'pass',
    cylinderCondition: 'pass',
    cascadeArrivalPsi: null,
    cascadeDeparturePsi: null,
    cylinders: [],
    serviceActions: [],
    partsReplaced: '',
    replacedRegulatorSerialOld: '',
    replacedRegulatorSerialNew: '',
    replacedMaskSerialOld: '',
    replacedMaskSerialNew: '',
    notes: '',
    inspectedAt: new Date().toISOString(),
  }
}

function createFromWorkPoint(wp: WorkPointInfo): AirSystemDraftRecord {
  const base = createBlankRecord()
  // Pre-populate cylinders from the WorkPoint's known bottles
  const cylinders: CylinderRecord[] = wp.cylinders.map((c) => ({
    id: `cyl_${Date.now()}_${nextCylId++}`,
    serialNumber: c.serialNumber || '',
    hydroDate: c.hydroDate || '',
    expiryDate: c.expiryDate || '',
    condition: 'pass',
    replaced: false,
    replacedNewSerial: '',
    replacedNewHydroDate: '',
    replacedNewExpiryDate: '',
  }))
  return {
    ...base,
    workPointId: wp.id,
    workPointName: wp.name,
    airSystemType: wp.airSystemType || 'tank_battery',
    reelSerialNumber: wp.reelSerialNumber || '',
    standSerialNumber: wp.standSerialNumber || '',
    cylinders,
    verified: wp.verified,
    dateVerified: wp.dateVerified,
  }
}

function getResultIcon(result: string) {
  switch (result) {
    case 'pass': return <CheckCircle className="w-4 h-4 text-green-600" />
    case 'fail': return <XCircle className="w-4 h-4 text-red-600" />
    case 'needs_service': return <AlertTriangle className="w-4 h-4 text-amber-600" />
    default: return null
  }
}

function isComplete(rec: AirSystemDraftRecord): boolean {
  // Per Phase B spec: reel/stand serials no longer required. Inspection is
  // complete when:
  //   - system identity has at least a name
  //   - at least one service action selected (or "no service required")
  //   - if overall result is fail, a reason was provided in notes
  if (!rec.workPointName) return false
  if (!rec.serviceActions || rec.serviceActions.length === 0) return false
  if (rec.overallResult === 'fail' && !rec.notes?.trim()) return false
  return true
}

function hasAnyFail(rec: AirSystemDraftRecord): boolean {
  const componentFail = COMPONENT_CHECKS.some(c => rec[c.key] === 'fail')
  const cylinderFail = rec.cylinders.some(c => c.condition === 'fail')
  return componentFail || cylinderFail
}

// ---- Scannable serial input (uses unified SerialInput with barcode + OCR) ----
function AirSerialField({ label, value, onChange, placeholder = 'Scan or type', required = false }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; required?: boolean
}) {
  return (
    <SerialInput
      label={`${label}${required ? ' *' : ''}`}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
    />
  )
}

export function AirSystemInspectionEditor({ records, onChange, wellIds = [], padId }: AirSystemInspectionEditorProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [availableWorkPoints, setAvailableWorkPoints] = useState<WorkPointInfo[]>([])
  const [expiryDays, setExpiryDays] = useState(0)
  const [policyLoaded, setPolicyLoaded] = useState(false)
  useEffect(() => {
    api.get<{ expiryDays: number }>('/locations/work-point-verification-settings')
      .then(data => { setExpiryDays(data.expiryDays); setPolicyLoaded(true); localStorage.setItem('workPointVerificationExpiryDays', String(data.expiryDays)) })
      .catch(() => {
        const cached = localStorage.getItem('workPointVerificationExpiryDays')
        if (cached !== null) { setExpiryDays(Number(cached)); setPolicyLoaded(true) }
      })
  }, [])
  // A customer's numbered air trailer isn't tied to the ticket's wellsite —
  // its cylinder/hydro-test history lives on a standalone MobileAsset (see
  // MobileAsset in schema.prisma), picked here rather than threaded through
  // the parent wizard's location state.
  const [selectedTrailer, setSelectedTrailer] = useState<MobileAssetOption | null>(null)
  // scanTarget removed — SerialInput handles scanning internally now

  const wellIdsKey = wellIds.sort().join(',')

  useEffect(() => {
    if (!wellIdsKey && !padId && !selectedTrailer) { setAvailableWorkPoints([]); return }
    let cancelled = false
    async function load() {
      try {
        // Query by wellIds, padId, AND/OR mobileAssetId — server uses OR logic
        const params = new URLSearchParams()
        if (wellIdsKey) params.set('wellIds', wellIdsKey)
        if (padId) params.set('padIds', padId)
        if (selectedTrailer) params.set('mobileAssetId', selectedTrailer.id)
        params.set('active', 'true')
        const data = await api.get<{ data: any[] }>(`/locations/work-points?${params.toString()}`)
        if (!cancelled) {
          setAvailableWorkPoints((data.data || []).map((wp: any) => {
            const cd = wp.customData as any
            const rawCyls: WorkPointCylinder[] = Array.isArray(cd?.cylinders) ? cd.cylinders : []
            return {
              id: wp.id, name: wp.name, airSystemType: wp.airSystemType || null,
              reelSerialNumber: wp.reelSerialNumber || null, standSerialNumber: wp.standSerialNumber || null,
              cylinders: rawCyls,
              verified: wp.verified, dateVerified: wp.dateVerified,
            }
          }))
        }
      } catch { if (!cancelled) setAvailableWorkPoints([]) }
    }
    load()
    return () => { cancelled = true }
  }, [wellIdsKey, padId, selectedTrailer])

  function addRecord() { const rec = createBlankRecord(); onChange([...records, rec]); setExpandedId(rec.id) }
  function addFromWorkPoint(wp: WorkPointInfo) {
    if (records.some(r => r.workPointId === wp.id)) return
    const rec = createFromWorkPoint(wp); onChange([...records, rec]); setExpandedId(rec.id)
  }
  function updateRecord(id: string, updates: Partial<AirSystemDraftRecord>) {
    const record = records.find(r => r.id === id)
    const cylinderIdentity = (items: CylinderRecord[]) => items.map(c => [c.serialNumber, c.hydroDate, c.expiryDate, c.replaced, c.replacedNewSerial, c.replacedNewHydroDate, c.replacedNewExpiryDate])
    const identityChanged = ['workPointName', 'reelSerialNumber', 'standSerialNumber'].some(key => key in updates && updates[key as keyof AirSystemDraftRecord] !== record?.[key as keyof AirSystemDraftRecord])
      || (!!updates.cylinders && JSON.stringify(cylinderIdentity(updates.cylinders)) !== JSON.stringify(cylinderIdentity(record?.cylinders || [])))
    onChange(records.map(r => r.id === id ? { ...r, ...updates, ...(identityChanged ? { verified: false, dateVerified: null, ...(r.workPointId ? { verificationUpdate: { verified: false, changedAt: new Date().toISOString() } } : {}) } : {}) } : r))
  }
  function removeRecord(id: string) { onChange(records.filter(r => r.id !== id)); if (expandedId === id) setExpandedId(null) }

  function toggleAction(recordId: string, actionKey: string) {
    const rec = records.find(r => r.id === recordId); if (!rec) return
    const actions = rec.serviceActions.includes(actionKey) ? rec.serviceActions.filter(a => a !== actionKey) : [...rec.serviceActions, actionKey]
    updateRecord(recordId, { serviceActions: actions })
  }

  // ---- Cylinder helpers ----
  function addCylinder(recordId: string) {
    const rec = records.find(r => r.id === recordId); if (!rec) return
    updateRecord(recordId, { cylinders: [...rec.cylinders, createBlankCylinder()] })
  }
  function updateCylinder(recordId: string, cylId: string, updates: Partial<CylinderRecord>) {
    const rec = records.find(r => r.id === recordId); if (!rec) return
    const cyls = rec.cylinders.map(c => c.id === cylId ? { ...c, ...updates } : c)
    // Auto-update overall cylinderCondition based on worst bottle
    const anyCylFail = cyls.some(c => c.condition === 'fail')
    const recUpdates: Partial<AirSystemDraftRecord> = { cylinders: cyls, cylinderCondition: anyCylFail ? 'fail' : 'pass' }
    const anyFail = COMPONENT_CHECKS.some(c => rec[c.key] === 'fail') || anyCylFail
    if (anyFail && rec.overallResult === 'pass') recUpdates.overallResult = 'fail'
    updateRecord(recordId, recUpdates)
  }
  function removeCylinder(recordId: string, cylId: string) {
    const rec = records.find(r => r.id === recordId); if (!rec) return
    updateRecord(recordId, { cylinders: rec.cylinders.filter(c => c.id !== cylId) })
  }

  // Scanner logic removed — SerialInput handles barcode + OCR inline

  const usedWorkPointIds = new Set(records.map(r => r.workPointId).filter(Boolean))
  const unusedWorkPoints = availableWorkPoints.filter(wp => !usedWorkPointIds.has(wp.id))

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
        <Wind className="w-4 h-4" /> Air System Inspections ({records.length})
      </h3>

      {/* Servicing a customer's air trailer instead of a wellsite system? */}
      <div>
        <p className="text-xs font-medium text-gray-500 mb-1">Servicing an air trailer?</p>
        <MobileAssetPicker
          kind="air_trailer"
          value={selectedTrailer}
          onChange={setSelectedTrailer}
          placeholder="Search air trailers..."
        />
      </div>

      {/* Known work points picker */}
      {unusedWorkPoints.length > 0 && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
          <p className="text-xs font-semibold text-blue-700 mb-3 flex items-center gap-1.5">
            <MapPin className="w-4 h-4" /> Known systems at this location — tap to add:
          </p>
          <div className="grid grid-cols-1 gap-2">
            {unusedWorkPoints.map(wp => (
              <button key={wp.id} type="button" onClick={() => addFromWorkPoint(wp)}
                className="flex items-center gap-3 px-4 py-3 text-sm font-medium bg-white border border-blue-300 text-blue-800 rounded-lg hover:bg-blue-100 transition-colors active:scale-[0.98] text-left">
                <Plus className="w-5 h-5 text-blue-500 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className={cn('font-semibold inline-block', policyLoaded && verificationCurrent(wp.verified, wp.dateVerified, expiryDays) && 'border-2 border-green-500 rounded px-2')}>{wp.name}</div>
                  <div className="text-xs text-blue-500 mt-0.5">
                    {AIR_SYSTEM_TYPES.find(t => t.value === wp.airSystemType)?.label || ''}
                    {wp.reelSerialNumber && ` · Reel: ${wp.reelSerialNumber}`}
                    {wp.cylinders.length > 0 && ` · ${wp.cylinders.length} bottle${wp.cylinders.length !== 1 ? 's' : ''}`}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      <button type="button" onClick={addRecord}
        className="w-full flex items-center justify-center gap-2 px-4 py-4 text-sm font-semibold text-blue-700 bg-blue-50 border-2 border-dashed border-blue-300 rounded-xl hover:bg-blue-100 transition-colors active:scale-[0.98]">
        <Plus className="w-5 h-5" /> Add System Manually
      </button>

      {records.length === 0 && unusedWorkPoints.length === 0 && (
        <div className="text-center py-6 text-gray-400 text-sm">
          <Wind className="w-8 h-8 mx-auto mb-2 opacity-50" /> No air systems added yet.
        </div>
      )}

      {records.map((rec) => {
        const isExpanded = expandedId === rec.id
        const complete = isComplete(rec)
        const hasFails = hasAnyFail(rec)
        const activeReplacements = Object.entries(REPLACEMENT_SERIAL_ACTIONS).filter(([k]) => rec.serviceActions.includes(k))
        const point = availableWorkPoints.find(wp => wp.id === rec.workPointId)
        const verified = rec.verificationUpdate ? rec.verified : point?.verified ?? rec.verified
        const dateVerified = rec.verificationUpdate ? rec.dateVerified : point?.dateVerified ?? rec.dateVerified

        return (
          <div key={rec.id} className="border rounded-lg overflow-hidden bg-white shadow-sm">
            {/* Header */}
            <button type="button" onClick={() => setExpandedId(isExpanded ? null : rec.id)}
              className="w-full flex items-center justify-between px-4 py-3 bg-gray-50 hover:bg-gray-100 transition-colors">
              <div className="flex items-center gap-3">
                {getResultIcon(rec.overallResult)}
                <div className="text-left">
                  <div className={cn('text-sm font-medium text-gray-900 inline-block', policyLoaded && verificationCurrent(verified, dateVerified, expiryDays) && 'border-2 border-green-500 rounded px-2')}>{rec.workPointName || 'Unnamed System'}</div>
                  <div className="text-xs text-gray-500">
                    {AIR_SYSTEM_TYPES.find(t => t.value === rec.airSystemType)?.label || ''}
                    {rec.reelSerialNumber && ` · Reel: ${rec.reelSerialNumber}`}
                    {rec.cylinders.length > 0 && ` · ${rec.cylinders.length} bottle${rec.cylinders.length !== 1 ? 's' : ''}`}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {!complete && <span className="text-xs px-2 py-0.5 bg-amber-100 text-amber-700 rounded-full">Incomplete</span>}
                {hasFails && <span className="text-xs px-2 py-0.5 bg-red-100 text-red-700 rounded-full">Has Fails</span>}
                {isExpanded ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
              </div>
            </button>

            {isExpanded && (
              <div className="p-4 space-y-5 border-t">
                <WorkPointVerification verified={policyLoaded && verified} dateVerified={dateVerified} expiryDays={expiryDays} disabled={!policyLoaded || !rec.workPointId}
                  onChange={checked => updateRecord(rec.id, { verified: checked, dateVerified: checked ? new Date().toISOString() : null, verificationUpdate: { verified: checked, changedAt: new Date().toISOString() } })} />
                {!rec.workPointId && <p className="text-xs text-slate-500">Select a known Work Point to record verification.</p>}
                {/* Section 1: System Identity */}
                <div>
                  <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2 flex items-center gap-1">
                    <Wind className="w-3.5 h-3.5" /> System Identity
                  </h4>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">System Name *</label>
                      <input type="text" value={rec.workPointName} onChange={(e) => updateRecord(rec.id, { workPointName: e.target.value })}
                        placeholder="e.g. Tank Battery #1" className="w-full px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">System Type</label>
                      <select value={rec.airSystemType} onChange={(e) => updateRecord(rec.id, { airSystemType: e.target.value })}
                        className="w-full px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500">
                        {AIR_SYSTEM_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                      </select>
                    </div>
                    <AirSerialField label="Reel Serial #" value={rec.reelSerialNumber}
                      onChange={(v) => updateRecord(rec.id, { reelSerialNumber: v })} />
                    <AirSerialField label="Stand Serial #" value={rec.standSerialNumber}
                      onChange={(v) => updateRecord(rec.id, { standSerialNumber: v })} />
                  </div>
                </div>

                {/* Section 2: Component Checks (Pass / Fail / N/A radio matrix) */}
                <div>
                  <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2 flex items-center gap-1">
                    <CheckCircle className="w-3.5 h-3.5" /> Component Checks
                  </h4>
                  <div className="border rounded-lg overflow-hidden">
                    <div className="grid grid-cols-[1fr_repeat(3,minmax(0,72px))] bg-gray-50 text-[11px] font-semibold text-gray-500 uppercase tracking-wider">
                      <div className="px-3 py-2">Component</div>
                      <div className="px-2 py-2 text-center">Pass</div>
                      <div className="px-2 py-2 text-center">Fail</div>
                      <div className="px-2 py-2 text-center">N/A</div>
                    </div>
                    {COMPONENT_CHECKS.map((check, i) => {
                      const val = rec[check.key]
                      return (
                        <div
                          key={check.key}
                          className={cn(
                            'grid grid-cols-[1fr_repeat(3,minmax(0,72px))] items-center text-sm',
                            i % 2 === 0 ? 'bg-white' : 'bg-gray-50/40',
                          )}
                        >
                          <div className="px-3 py-2.5 text-gray-700 font-medium">{check.label}</div>
                          {(['pass', 'fail', 'na'] as const).map(opt => (
                            <button
                              key={opt}
                              type="button"
                              onClick={() => {
                                const updated = { ...rec, [check.key]: opt }
                                const anyFail = COMPONENT_CHECKS.some(c => updated[c.key] === 'fail') || rec.cylinders.some(c => c.condition === 'fail')
                                const updates: Partial<AirSystemDraftRecord> = { [check.key]: opt }
                                if (anyFail && rec.overallResult === 'pass') updates.overallResult = 'fail'
                                updateRecord(rec.id, updates)
                              }}
                              aria-pressed={val === opt}
                              className="flex items-center justify-center py-2.5"
                            >
                              <span
                                className={cn(
                                  'w-5 h-5 rounded-full border-2 flex items-center justify-center',
                                  val === opt
                                    ? opt === 'pass' ? 'border-green-600 bg-green-600'
                                      : opt === 'fail' ? 'border-red-600 bg-red-600'
                                      : 'border-gray-500 bg-gray-500'
                                    : 'border-gray-300 bg-white',
                                )}
                              >
                                {val === opt && <span className="w-2 h-2 rounded-full bg-white" />}
                              </span>
                            </button>
                          ))}
                        </div>
                      )
                    })}
                  </div>
                </div>

                {/* Section 3: Cascade Readings */}
                <div>
                  <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2 flex items-center gap-1">
                    <Gauge className="w-3.5 h-3.5" /> Cascade Readings
                  </h4>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Arrival PSI</label>
                      <input type="number" inputMode="numeric" value={rec.cascadeArrivalPsi ?? ''}
                        onChange={(e) => updateRecord(rec.id, { cascadeArrivalPsi: e.target.value ? Number(e.target.value) : null })}
                        placeholder="PSI on arrival"
                        className="w-full px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Departure PSI</label>
                      <input type="number" inputMode="numeric" value={rec.cascadeDeparturePsi ?? ''}
                        onChange={(e) => updateRecord(rec.id, { cascadeDeparturePsi: e.target.value ? Number(e.target.value) : null })}
                        placeholder="PSI on departure"
                        className="w-full px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
                    </div>
                  </div>
                </div>

                {/* Section 4: Cylinders */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider flex items-center gap-1">
                      <Cylinder className="w-3.5 h-3.5" /> Cylinders ({rec.cylinders.length})
                    </h4>
                    <button type="button" onClick={() => addCylinder(rec.id)}
                      className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-blue-700 bg-blue-50 rounded-lg hover:bg-blue-100 transition-colors">
                      <Plus className="w-3 h-3" /> Add Bottle
                    </button>
                  </div>

                  {rec.cylinders.length === 0 && (
                    <p className="text-xs text-gray-400 text-center py-3 border border-dashed border-gray-200 rounded-lg">
                      No cylinders added. Tap "Add Bottle" to track individual cylinders.
                    </p>
                  )}

                  <div className="space-y-2">
                    {rec.cylinders.map((cyl, idx) => (
                      <div key={cyl.id} className={cn(
                        'border rounded-lg p-3 space-y-2',
                        cyl.condition === 'fail' ? 'border-red-200 bg-red-50/50' : 'border-gray-200',
                      )}>
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-semibold text-gray-600">Bottle #{idx + 1}</span>
                          <div className="flex items-center gap-2">
                            {/* Condition cycle button */}
                            <button type="button" onClick={() => {
                              const next = cyl.condition === 'pass' ? 'fail' : cyl.condition === 'fail' ? 'na' : 'pass'
                              updateCylinder(rec.id, cyl.id, { condition: next })
                            }} className={cn('px-2 py-0.5 rounded text-xs font-medium border transition-all',
                              cyl.condition === 'pass' && 'border-green-300 bg-green-50 text-green-700',
                              cyl.condition === 'fail' && 'border-red-300 bg-red-50 text-red-700',
                              cyl.condition === 'na' && 'border-gray-200 bg-gray-50 text-gray-400')}>
                              {cyl.condition === 'pass' ? 'PASS' : cyl.condition === 'fail' ? 'FAIL' : 'N/A'}
                            </button>
                            <button type="button" onClick={() => removeCylinder(rec.id, cyl.id)}
                              className="text-red-400 hover:text-red-600"><Trash2 className="w-3.5 h-3.5" /></button>
                          </div>
                        </div>

                        <div className="grid grid-cols-1 gap-2">
                          <AirSerialField label="Serial #" value={cyl.serialNumber}
                            onChange={(v) => updateCylinder(rec.id, cyl.id, { serialNumber: v })} />
                          <div className="grid grid-cols-2 gap-2">
                            <div>
                              <label className="block text-xs text-gray-500 mb-1">Hydro Date</label>
                              <input type="date" value={cyl.hydroDate}
                                onChange={(e) => updateCylinder(rec.id, cyl.id, { hydroDate: e.target.value })}
                                className="w-full px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
                            </div>
                            <div>
                              <label className="block text-xs text-gray-500 mb-1">Expiry Date</label>
                              <input type="date" value={cyl.expiryDate}
                                onChange={(e) => updateCylinder(rec.id, cyl.id, { expiryDate: e.target.value })}
                                className="w-full px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
                            </div>
                          </div>
                        </div>

                        {/* Replaced toggle */}
                        <div>
                          <button type="button" onClick={() => updateCylinder(rec.id, cyl.id, { replaced: !cyl.replaced })}
                            className={cn('flex items-center gap-2 px-3 py-2 rounded-lg border text-xs font-medium w-full transition-all',
                              cyl.replaced ? 'border-amber-300 bg-amber-50 text-amber-700' : 'border-gray-200 text-gray-500 hover:bg-gray-50')}>
                            <ArrowRightLeft className="w-3.5 h-3.5" />
                            {cyl.replaced ? 'Cylinder Replaced' : 'Mark as Replaced'}
                          </button>
                          {cyl.replaced && (
                            <div className="mt-2 bg-amber-50 border border-amber-200 rounded-lg p-3 space-y-2">
                              <p className="text-[10px] font-semibold text-amber-600 uppercase tracking-wider">
                                Replacing {cyl.serialNumber || `Bottle #${idx + 1}`} — New Bottle Info:
                              </p>
                              <AirSerialField label="New Serial #" value={cyl.replacedNewSerial}
                                onChange={(v) => updateCylinder(rec.id, cyl.id, { replacedNewSerial: v })}
                                placeholder="Scan or type new serial" />
                              <div>
                                <label className="block text-xs text-gray-500 mb-1">New Bottle Hydro Date</label>
                                <input type="date" value={cyl.replacedNewHydroDate}
                                  onChange={(e) => updateCylinder(rec.id, cyl.id, { replacedNewHydroDate: e.target.value })}
                                  className="w-full px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
                              </div>
                              <div>
                                <label className="block text-xs text-gray-500 mb-1">New Bottle Expiry</label>
                                <div className="flex gap-2 items-end">
                                  <input type="date" value={cyl.replacedNewExpiryDate}
                                    onChange={(e) => updateCylinder(rec.id, cyl.id, { replacedNewExpiryDate: e.target.value })}
                                    className="flex-1 px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
                                  {cyl.replacedNewHydroDate && (
                                    <div className="flex gap-1 flex-shrink-0">
                                      {[5, 10].map(years => {
                                        const hydro = new Date(cyl.replacedNewHydroDate)
                                        if (isNaN(hydro.getTime())) return null
                                        // Hydro/expiry are calendar dates parsed at UTC midnight, so add
                                        // the years in UTC too — the local setter drifts a day when the
                                        // two dates straddle a DST boundary (e.g. a March hydro date).
                                        const exp = new Date(hydro)
                                        exp.setUTCFullYear(exp.getUTCFullYear() + years)
                                        const expStr = exp.toISOString().split('T')[0]
                                        const isActive = cyl.replacedNewExpiryDate === expStr
                                        return (
                                          <button key={years} type="button"
                                            onClick={() => updateCylinder(rec.id, cyl.id, { replacedNewExpiryDate: expStr })}
                                            className={cn('px-2.5 py-2 rounded-lg text-xs font-medium border transition-all whitespace-nowrap',
                                              isActive ? 'border-amber-500 bg-amber-100 text-amber-700' : 'border-gray-300 text-gray-500 hover:bg-gray-50')}>
                                            +{years}yr
                                          </button>
                                        )
                                      })}
                                    </div>
                                  )}
                                </div>
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Section 5: Overall Result */}
                <div>
                  <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Overall Result</h4>
                  <div className="flex gap-2">
                    {([
                      { value: 'pass', label: 'Pass', color: 'green' },
                      { value: 'fail', label: 'Fail', color: 'red' },
                      { value: 'needs_service', label: 'Needs Service', color: 'amber' },
                    ] as const).map((opt) => (
                      <button key={opt.value} type="button"
                        onClick={() => updateRecord(rec.id, { overallResult: opt.value })}
                        className={cn('flex-1 py-2 rounded-lg text-sm font-medium border-2 transition-all',
                          rec.overallResult === opt.value
                            ? opt.color === 'green' ? 'border-green-500 bg-green-50 text-green-700'
                            : opt.color === 'red' ? 'border-red-500 bg-red-50 text-red-700'
                            : 'border-amber-500 bg-amber-50 text-amber-700'
                            : 'border-gray-200 text-gray-500 hover:bg-gray-50')}>
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Section 6: Service Actions */}
                <div>
                  <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2 flex items-center gap-1">
                    <Wrench className="w-3.5 h-3.5" /> Service Actions Taken
                  </h4>
                  <div className="grid grid-cols-2 gap-2">
                    {SERVICE_ACTIONS.map((action) => {
                      const isChecked = rec.serviceActions.includes(action.key)
                      return (
                        <button key={action.key} type="button" onClick={() => toggleAction(rec.id, action.key)}
                          className={cn('flex items-center gap-2 px-3 py-2 rounded-lg border text-xs text-left transition-all',
                            isChecked ? 'border-blue-300 bg-blue-50 text-blue-700' : 'border-gray-200 text-gray-600 hover:bg-gray-50')}>
                          <div className={cn('w-4 h-4 rounded border flex items-center justify-center flex-shrink-0',
                            isChecked ? 'bg-blue-500 border-blue-500' : 'border-gray-300')}>
                            {isChecked && <CheckCircle className="w-3 h-3 text-white" />}
                          </div>
                          {action.label}
                        </button>
                      )
                    })}
                  </div>

                  {/* Non-cylinder replacement serial tracking */}
                  {activeReplacements.length > 0 && (
                    <div className="mt-3 space-y-3 bg-amber-50 border border-amber-200 rounded-lg p-3">
                      <p className="text-xs font-semibold text-amber-700 uppercase tracking-wider">Replacement Serials</p>
                      {activeReplacements.map(([actionKey, config]) => (
                        <div key={actionKey} className="grid grid-cols-2 gap-2">
                          <AirSerialField label={`${config.label} Removed`} value={(rec[config.oldKey] as string) || ''}
                            onChange={(v) => updateRecord(rec.id, { [config.oldKey]: v } as any)}
                            placeholder="Old serial" />
                          <AirSerialField label={`${config.label} Installed`} value={(rec[config.newKey] as string) || ''}
                            onChange={(v) => updateRecord(rec.id, { [config.newKey]: v } as any)}
                            placeholder="New serial" />
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="mt-2">
                    <label className="block text-xs text-gray-500 mb-1">Parts Replaced (details)</label>
                    <input type="text" value={rec.partsReplaced} onChange={(e) => updateRecord(rec.id, { partsReplaced: e.target.value })}
                      placeholder="e.g. 50ft hose, 3M mask size M"
                      className="w-full px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
                  </div>
                </div>

                {/* Section 7: Notes (required when overall result is FAIL) */}
                <div>
                  <label className={cn(
                    'block text-xs mb-1',
                    rec.overallResult === 'fail' ? 'text-red-600 font-semibold' : 'text-gray-500',
                  )}>
                    {rec.overallResult === 'fail' ? 'Failure reason *' : 'Notes'}
                  </label>
                  <textarea
                    value={rec.notes}
                    onChange={(e) => updateRecord(rec.id, { notes: e.target.value })}
                    rows={2}
                    placeholder={rec.overallResult === 'fail' ? 'Describe what failed and why...' : 'Additional inspection notes...'}
                    className={cn(
                      'w-full px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500',
                      rec.overallResult === 'fail' && !rec.notes?.trim() && 'border-red-300 bg-red-50/30',
                    )}
                  />
                </div>

                {/* Delete */}
                <div className="pt-2 border-t">
                  <button type="button" onClick={() => removeRecord(rec.id)}
                    className="flex items-center gap-1.5 text-xs text-red-600 hover:text-red-800 transition-colors">
                    <Trash2 className="w-3.5 h-3.5" /> Remove this system
                  </button>
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
