import { useState } from 'react'
import { cn } from '@/lib/cn'
import { SignaturePad } from '@/components/SignaturePad'
import type { FitTestDraftRecord } from '@/lib/db-types'
import {
  UserPlus,
  Trash2,
  ChevronDown,
  ChevronUp,
  CheckCircle,
  XCircle,
  Copy,
  AlertTriangle,
  FileCheck,
  Ear,
  Paperclip,
  X,
} from 'lucide-react'

interface FitTestEditorProps {
  records: FitTestDraftRecord[]
  onChange: (records: FitTestDraftRecord[]) => void
  defaultEmployer?: string
  /** #10 Occ Health: services this visit covers. Each person can take any
   * subset of these (chips per person when more than one). Defaults to
   * fit-test-only for legacy callers. */
  services?: ('fit_test' | 'audiometric')[]
}

// #14 Half Face or Full Face only. Full Face picks an air-supply class —
// APR (particulate) or SAR (supplied air), as tooltips not button text.
// Half Face is always APR. Legacy rows may still carry scba/sar as the type.
const RESPIRATOR_TYPES = [
  { value: 'half_face', label: 'Half Face' },
  { value: 'full_face', label: 'Full Face' },
]

const AIR_SUPPLY_CLASSES = [
  { value: 'apr' as const, label: 'APR', tooltip: 'Air-Purifying Respirator (particulate)' },
  { value: 'sar' as const, label: 'SAR', tooltip: 'Supplied-Air Respirator' },
]

// #15 PortaCount + TSI 8030 lead; Irritant Smoke + Ambient Aerosol removed.
const TEST_METHODS = [
  { value: 'portacount', label: 'PortaCount' },
  { value: 'tsi_8030', label: 'TSI 8030' },
  { value: 'isoamyl_acetate', label: 'Banana Oil', tooltip: 'Isoamyl acetate' },
  { value: 'bitrex', label: 'Bitrex' },
]

// Removed methods still render (selected) on old records so the data stays visible.
const LEGACY_TEST_METHODS: Record<string, string> = {
  irritant_smoke: 'Irritant Smoke',
  ambient_aerosol: 'Ambient Aerosol',
}

/** Effective type/class for a record, mapping legacy scba/sar types onto Full Face + SAR. */
function effectiveRespirator(rec: Pick<FitTestDraftRecord, 'respiratorType' | 'respiratorClass'>): { type: string; cls: 'apr' | 'sar' | null } {
  const legacy = rec.respiratorType === 'scba' || rec.respiratorType === 'sar'
  const type = legacy ? 'full_face' : rec.respiratorType
  const cls = type === 'half_face' ? 'apr' : (rec.respiratorClass ?? (legacy ? 'sar' : null))
  return { type, cls }
}

/**
 * #14 Respirator requirements: Full Face must pick APR or SAR, and SAR masks
 * must carry a fit factor (fit factor is optional everywhere else).
 * Applies to the second mask too. Exported — the wizard gates Next on it.
 */
export function respiratorRequirementsMet(rec: FitTestDraftRecord): boolean {
  const { type, cls } = effectiveRespirator(rec)
  if (type === 'full_face' && !cls) return false
  if (cls === 'sar' && rec.fitFactor == null) return false
  const m2 = rec.secondMask
  if (m2) {
    const e2 = effectiveRespirator({ respiratorType: m2.respiratorType, respiratorClass: m2.respiratorClass })
    if (e2.type === 'full_face' && !e2.cls) return false
    if (e2.cls === 'sar' && m2.fitFactor == null) return false
  }
  return true
}

/** Treat legacy rows (no flags) as pure fit tests. */
export function recHasFitTest(rec: FitTestDraftRecord): boolean {
  return rec.includesFitTest !== false
}
export function recHasAudiometric(rec: FitTestDraftRecord): boolean {
  return rec.includesAudiometric === true
}

/**
 * #10/#11 Occ Health record completeness — gates the wizard's Next:
 * a name, at least one service, fit-test respirator rules when fit testing,
 * and a Baseline/Retest result when audiometric.
 */
export function occRecordComplete(rec: FitTestDraftRecord): boolean {
  if (!rec.employeeName.trim()) return false
  const ft = recHasFitTest(rec)
  const aud = recHasAudiometric(rec)
  if (!ft && !aud) return false
  if (ft && !respiratorRequirementsMet(rec)) return false
  if (aud && !rec.audiometricResult) return false
  return true
}

// ---- Disclosure: conditions that may cause fit test to be void ----
export const DISCLOSURE_CONDITIONS = [
  { key: 'beard_1_2_day', label: '1-2 Day beard growth prevents seal' },
  { key: 'beard_2_plus_day', label: '2+ Day beard growth prevents seal' },
  { key: 'glasses_prevent_seal', label: 'Glasses prevent seal' },
  { key: 'facial_scar', label: 'Facial scar can prevent seal' },
  { key: 'dentures', label: 'Dentures can prevent seal' },
  { key: 'weight_change', label: 'Extreme Weight Gain / Loss (requires additional fit test)' },
  { key: 'annual_test', label: 'Must be fit tested annually' },
  { key: 'company_policies', label: 'Follow Company Policies' },
  { key: 'idlh_required', label: 'Respirator required in IDLH atmospheres' },
]

// ---- Disclosure: adverse reactions experienced during test ----
export const ADVERSE_REACTIONS = [
  { key: 'skin_irritation', label: 'Skin Irritation' },
  { key: 'difficulty_breathing', label: 'Difficulty Breathing' },
  { key: 'lack_of_visibility', label: 'Lack of Visibility' },
  { key: 'improper_fit', label: 'Respirator too tight / improper fit' },
  { key: 'claustrophobia', label: 'Claustrophobia' },
]

let nextTempId = 1

function createBlankRecord(defaultEmployer: string, services: ('fit_test' | 'audiometric')[] = ['fit_test']): FitTestDraftRecord {
  return {
    id: `ft_${nextTempId++}`,
    includesFitTest: services.includes('fit_test'),
    includesAudiometric: services.includes('audiometric'),
    audiometricResult: null,
    resultFiles: [],
    employeeName: '',
    employeeId: '',
    employerName: defaultEmployer,
    jobTitle: '',
    respiratorType: 'half_face',
    respiratorClass: null,
    respiratorMake: '',
    respiratorModel: '',
    respiratorSize: '',
    testMethod: 'portacount',
    passFail: 'pass',
    fitFactor: null,
    meqAccepted: false,
    meqDate: null,
    secondMask: null,
    notes: '',
    // Disclosure
    disclosureConditions: [],
    isCleanShaven: null,
    wearsGlassesContacts: null,
    adverseReactions: [],
    criteriaAcknowledged: false,
    participantSignature: null,
  }
}

export function FitTestEditor({ records, onChange, defaultEmployer = '', services = ['fit_test'] }: FitTestEditorProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const multiService = services.length > 1

  function addRecord() {
    const rec = createBlankRecord(defaultEmployer, services)
    onChange([...records, rec])
    setExpandedId(rec.id)
  }

  function duplicateLast() {
    if (records.length === 0) return
    const last = records[records.length - 1]
    const rec: FitTestDraftRecord = {
      ...last,
      id: `ft_${nextTempId++}`,
      employeeName: '',
      employeeId: '',
      jobTitle: '',
      meqAccepted: false,
      meqDate: null,
      audiometricResult: null,
      resultFiles: [],
      notes: '',
      // Reset disclosure per person
      disclosureConditions: [],
      isCleanShaven: null,
      wearsGlassesContacts: null,
      adverseReactions: [],
      criteriaAcknowledged: false,
      participantSignature: null,
    }
    onChange([...records, rec])
    setExpandedId(rec.id)
  }

  function updateRecord(id: string, updates: Partial<FitTestDraftRecord>) {
    onChange(records.map(r => r.id === id ? { ...r, ...updates } : r))
  }

  function removeRecord(id: string) {
    onChange(records.filter(r => r.id !== id))
    if (expandedId === id) setExpandedId(null)
  }

  function toggleCondition(recId: string, key: string) {
    const rec = records.find(r => r.id === recId)
    if (!rec) return
    const has = rec.disclosureConditions.includes(key)
    const updated = has
      ? rec.disclosureConditions.filter(k => k !== key)
      : [...rec.disclosureConditions, key]
    updateRecord(recId, { disclosureConditions: updated })
  }

  function toggleReaction(recId: string, key: string) {
    const rec = records.find(r => r.id === recId)
    if (!rec) return
    const has = rec.adverseReactions.includes(key)
    const updated = has
      ? rec.adverseReactions.filter(k => k !== key)
      : [...rec.adverseReactions, key]
    updateRecord(recId, { adverseReactions: updated })
  }

  const passCount = records.filter(r => recHasFitTest(r) && r.passFail === 'pass').length
  const failCount = records.filter(r => recHasFitTest(r) && r.passFail === 'fail').length

  // Compute disclosure completeness per record
  function disclosureComplete(rec: FitTestDraftRecord): boolean {
    return (
      rec.disclosureConditions.length === DISCLOSURE_CONDITIONS.length &&
      rec.isCleanShaven !== null &&
      rec.wearsGlassesContacts !== null &&
      rec.criteriaAcknowledged &&
      rec.participantSignature !== null
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <label className="block text-sm font-medium text-slate-700">
          Occ Health Roster
          {records.length > 0 && (
            <span className="ml-2 text-slate-400 font-normal">
              {records.length} tested
              {passCount > 0 && <span className="text-green-600 ml-1">{passCount} pass</span>}
              {failCount > 0 && <span className="text-red-600 ml-1">{failCount} fail</span>}
            </span>
          )}
        </label>
      </div>

      {/* Add buttons */}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={addRecord}
          className="flex-1 flex items-center justify-center gap-2 py-3 bg-blue-50 text-blue-700 border-2 border-blue-200 rounded-lg font-medium text-sm hover:bg-blue-100 active:scale-[0.98] transition-all"
        >
          <UserPlus className="w-5 h-5" />
          Add Person
        </button>
        {records.length > 0 && (
          <button
            type="button"
            onClick={duplicateLast}
            className="flex items-center gap-2 px-4 py-3 bg-slate-50 text-slate-600 border-2 border-slate-200 rounded-lg font-medium text-sm hover:bg-slate-100 active:scale-[0.98] transition-all"
            title="Copy respirator setup from last entry"
          >
            <Copy className="w-4 h-4" />
            Duplicate
          </button>
        )}
      </div>

      {/* Record list */}
      {records.length > 0 && (
        <div className="space-y-2">
          {records.map((rec, index) => {
            const isExpanded = expandedId === rec.id
            const effHdr = effectiveRespirator(rec)
            const respLabel = [
              RESPIRATOR_TYPES.find(t => t.value === effHdr.type)?.label || rec.respiratorType,
              effHdr.type === 'full_face' && effHdr.cls ? effHdr.cls.toUpperCase() : null,
              rec.secondMask ? '+ 2nd mask' : null,
            ].filter(Boolean).join(' ')
            const hasDisclosure = disclosureComplete(rec)

            return (
              <div key={rec.id} className="bg-white rounded-lg border border-slate-200 overflow-hidden">
                {/* Header row */}
                <button
                  type="button"
                  onClick={() => setExpandedId(isExpanded ? null : rec.id)}
                  className="w-full flex items-center gap-3 p-3 hover:bg-slate-50 transition-colors"
                >
                  <span className="text-xs font-mono text-slate-400 w-5">{index + 1}</span>
                  {recHasFitTest(rec) ? (
                    rec.passFail === 'pass' ? (
                      <CheckCircle className="w-5 h-5 text-green-500 shrink-0" />
                    ) : (
                      <XCircle className="w-5 h-5 text-red-500 shrink-0" />
                    )
                  ) : (
                    <Ear className="w-5 h-5 text-purple-500 shrink-0" />
                  )}
                  <div className="flex-1 min-w-0 text-left">
                    <p className="font-medium text-slate-900 text-sm truncate">
                      {rec.employeeName || <span className="text-slate-400 italic">Name required</span>}
                    </p>
                    <p className="text-xs text-slate-500 truncate">
                      {[
                        rec.employerName,
                        recHasFitTest(rec) ? respLabel : null,
                        recHasAudiometric(rec) ? 'Audiometric' : null,
                      ].filter(Boolean).join(' \u00b7 ')}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {recHasFitTest(rec) && !hasDisclosure && rec.employeeName && (
                      <AlertTriangle className="w-4 h-4 text-amber-500" />
                    )}
                    {recHasAudiometric(rec) && (
                      <span className={cn(
                        'text-xs font-medium px-2 py-0.5 rounded-full',
                        rec.audiometricResult ? 'bg-purple-100 text-purple-700' : 'bg-amber-100 text-amber-700',
                      )}>
                        {rec.audiometricResult ? rec.audiometricResult.toUpperCase() : 'AUDIO \u2014 PICK RESULT'}
                      </span>
                    )}
                    {recHasFitTest(rec) && (
                      <span className={cn(
                        'text-xs font-medium px-2 py-0.5 rounded-full',
                        rec.passFail === 'pass'
                          ? 'bg-green-100 text-green-700'
                          : 'bg-red-100 text-red-700',
                      )}>
                        {rec.passFail === 'pass' ? 'PASS' : 'FAIL'}
                      </span>
                    )}
                  </div>
                  {isExpanded ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
                </button>

                {/* Expanded detail */}
                {isExpanded && (
                  <div className="px-3 pb-3 pt-1 border-t border-slate-100 space-y-4">

                    {/* ===== SECTION 1: Employee Info ===== */}
                    <div className="grid grid-cols-2 gap-3">
                      <div className="col-span-2">
                        <label className="block text-xs font-medium text-slate-500 mb-1">Employee Name *</label>
                        <input
                          type="text"
                          value={rec.employeeName}
                          onChange={e => updateRecord(rec.id, { employeeName: e.target.value })}
                          placeholder="Full name"
                          autoFocus={!rec.employeeName}
                          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-500 mb-1">Employee ID</label>
                        <input
                          type="text"
                          value={rec.employeeId}
                          onChange={e => updateRecord(rec.id, { employeeId: e.target.value })}
                          placeholder="Optional"
                          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-500 mb-1">Job Title / Position</label>
                        <input
                          type="text"
                          value={rec.jobTitle}
                          onChange={e => updateRecord(rec.id, { jobTitle: e.target.value })}
                          placeholder="Optional"
                          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-500 mb-1">Employer</label>
                        <input
                          type="text"
                          value={rec.employerName}
                          onChange={e => updateRecord(rec.id, { employerName: e.target.value })}
                          placeholder="Company name"
                          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                        />
                      </div>
                    </div>

                    {/* ===== #10 Services this person is taking (when the visit covers both) ===== */}
                    {multiService && (
                      <div>
                        <label className="block text-xs font-medium text-slate-500 mb-1">Services</label>
                        <div className="flex gap-2">
                          {services.map(svc => {
                            const on = svc === 'fit_test' ? recHasFitTest(rec) : recHasAudiometric(rec)
                            return (
                              <button
                                key={svc}
                                type="button"
                                onClick={() => {
                                  const next = svc === 'fit_test'
                                    ? { includesFitTest: !recHasFitTest(rec) }
                                    : { includesAudiometric: !recHasAudiometric(rec) }
                                  // never allow zero services on a person
                                  const ft = next.includesFitTest ?? recHasFitTest(rec)
                                  const aud = next.includesAudiometric ?? recHasAudiometric(rec)
                                  if (!ft && !aud) return
                                  updateRecord(rec.id, next)
                                }}
                                className={cn(
                                  'px-4 py-2 rounded-lg text-sm font-medium border-2 transition-colors',
                                  on
                                    ? 'border-blue-500 bg-blue-50 text-blue-800'
                                    : 'border-slate-200 text-slate-500 hover:border-slate-300',
                                )}
                              >
                                {svc === 'fit_test' ? 'Fit Test' : 'Audiometric'}
                              </button>
                            )
                          })}
                        </div>
                      </div>
                    )}

                    {/* ===== #11 Audiometric: Baseline / Retest ===== */}
                    {recHasAudiometric(rec) && (
                      <div>
                        <label className="block text-xs font-medium text-slate-500 mb-1">Audiometric Result</label>
                        <div className="grid grid-cols-2 gap-2">
                          {(['baseline', 'retest'] as const).map(v => (
                            <button
                              key={v}
                              type="button"
                              onClick={() => updateRecord(rec.id, { audiometricResult: v })}
                              className={cn(
                                'py-3 rounded-lg font-bold text-sm border-2 transition-colors capitalize',
                                rec.audiometricResult === v
                                  ? 'bg-purple-100 border-purple-400 text-purple-800'
                                  : 'border-slate-200 text-slate-400',
                              )}
                            >
                              {v}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* ===== #11 Individual results attachments (per person) ===== */}
                    <div>
                      <label className="block text-xs font-medium text-slate-500 mb-1">
                        Individual Results <span className="font-normal text-slate-400">— printouts / reports for this person</span>
                      </label>
                      {(rec.resultFiles || []).map(f => (
                        <div key={f.id} className="flex items-center gap-2 text-sm text-slate-700 py-1">
                          <Paperclip className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                          <span className="flex-1 truncate">{f.fileName}</span>
                          <button
                            type="button"
                            onClick={() => updateRecord(rec.id, { resultFiles: (rec.resultFiles || []).filter(x => x.id !== f.id) })}
                            className="text-slate-400 hover:text-red-500"
                          >
                            <X className="w-4 h-4" />
                          </button>
                        </div>
                      ))}
                      <label className="inline-flex items-center gap-1.5 px-3 py-1.5 mt-1 rounded-lg border border-dashed border-slate-300 text-sm text-slate-600 hover:border-blue-400 hover:text-blue-600 cursor-pointer">
                        <Paperclip className="w-4 h-4" />
                        Attach file
                        <input
                          type="file"
                          accept="image/*,application/pdf"
                          multiple
                          className="hidden"
                          onChange={e => {
                            const files = Array.from(e.target.files || [])
                            e.target.value = ''
                            files.forEach(file => {
                              const reader = new FileReader()
                              reader.onload = () => {
                                updateRecord(rec.id, {
                                  resultFiles: [
                                    ...(records.find(r => r.id === rec.id)?.resultFiles || []),
                                    { id: `rf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, fileName: file.name, mimeType: file.type || 'application/octet-stream', dataUrl: String(reader.result) },
                                  ],
                                })
                              }
                              reader.readAsDataURL(file)
                            })
                          }}
                        />
                      </label>
                    </div>

                    {recHasFitTest(rec) && (<>
                    {/* ===== SECTION 2: MEQ Current (#16 — above respirator type) ===== */}
                    <div className="flex items-center gap-4 p-3 bg-slate-50 rounded-lg">
                      <label className="flex items-center gap-2 cursor-pointer shrink-0">
                        <input
                          type="checkbox"
                          checked={rec.meqAccepted}
                          onChange={e => updateRecord(rec.id, { meqAccepted: e.target.checked, ...(e.target.checked ? {} : { meqDate: null }) })}
                          className="w-5 h-5 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                        />
                        <span className="text-sm font-medium text-slate-700">MEQ Current</span>
                      </label>
                      {rec.meqAccepted && (
                        <div className="flex items-center gap-2">
                          <label className="text-xs text-slate-500">as of</label>
                          <input
                            type="date"
                            value={rec.meqDate || ''}
                            onChange={e => updateRecord(rec.id, { meqDate: e.target.value || null })}
                            className="px-2 py-1.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                          />
                        </div>
                      )}
                    </div>

                    {/* ===== SECTION 3: Respirator (#14) + masks (#17) ===== */}
                    {(() => {
                      const eff = effectiveRespirator(rec)
                      return (
                        <div>
                          <label className="block text-xs font-medium text-slate-500 mb-1">Respirator Type</label>
                          <div className="grid grid-cols-2 gap-1.5">
                            {RESPIRATOR_TYPES.map(rt => (
                              <button
                                key={rt.value}
                                type="button"
                                onClick={() => updateRecord(rec.id, {
                                  respiratorType: rt.value,
                                  // Half Face is always APR (stored null); Full Face keeps a prior class pick.
                                  respiratorClass: rt.value === 'half_face' ? null : (eff.type === 'full_face' ? eff.cls : null),
                                })}
                                className={cn(
                                  'py-2 rounded-lg text-xs font-medium border-2 transition-colors',
                                  eff.type === rt.value
                                    ? 'border-blue-500 bg-blue-50 text-blue-800'
                                    : 'border-slate-200 text-slate-500 hover:border-slate-300',
                                )}
                              >
                                {rt.label}
                              </button>
                            ))}
                          </div>
                          {eff.type === 'full_face' && (
                            <div className="grid grid-cols-2 gap-1.5 mt-1.5">
                              {AIR_SUPPLY_CLASSES.map(ac => (
                                <button
                                  key={ac.value}
                                  type="button"
                                  title={ac.tooltip}
                                  onClick={() => updateRecord(rec.id, { respiratorType: 'full_face', respiratorClass: ac.value })}
                                  className={cn(
                                    'py-2 rounded-lg text-xs font-medium border-2 transition-colors',
                                    eff.cls === ac.value
                                      ? 'border-indigo-500 bg-indigo-50 text-indigo-800'
                                      : 'border-slate-200 text-slate-500 hover:border-slate-300',
                                  )}
                                >
                                  {ac.label}
                                </button>
                              ))}
                            </div>
                          )}
                          {eff.type === 'full_face' && !eff.cls && (
                            <p className="text-xs text-amber-600 mt-1">Pick APR or SAR for a Full Face respirator.</p>
                          )}
                          {eff.type === 'half_face' && (
                            <p className="text-xs text-slate-400 mt-1">Half Face is always APR.</p>
                          )}

                          {/* Mask 1 details + fit factor (required on SAR only) */}
                          <div className="grid grid-cols-4 gap-3 mt-3">
                            <div>
                              <label className="block text-xs font-medium text-slate-500 mb-1">Make</label>
                              <input
                                type="text"
                                value={rec.respiratorMake}
                                onChange={e => updateRecord(rec.id, { respiratorMake: e.target.value })}
                                placeholder="e.g. 3M"
                                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                              />
                            </div>
                            <div>
                              <label className="block text-xs font-medium text-slate-500 mb-1">Model</label>
                              <input
                                type="text"
                                value={rec.respiratorModel}
                                onChange={e => updateRecord(rec.id, { respiratorModel: e.target.value })}
                                placeholder="Model #"
                                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                              />
                            </div>
                            <div>
                              <label className="block text-xs font-medium text-slate-500 mb-1">Size</label>
                              <input
                                type="text"
                                value={rec.respiratorSize}
                                onChange={e => updateRecord(rec.id, { respiratorSize: e.target.value })}
                                placeholder="S/M/L"
                                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                              />
                            </div>
                            <div>
                              <label className="block text-xs font-medium text-slate-500 mb-1">
                                Fit Factor{eff.cls === 'sar' && <span className="text-red-500"> *</span>}
                              </label>
                              <input
                                type="number"
                                value={rec.fitFactor ?? ''}
                                onChange={e => updateRecord(rec.id, { fitFactor: e.target.value ? Number(e.target.value) : null })}
                                placeholder={eff.cls === 'sar' ? 'Required' : 'Optional'}
                                className={cn(
                                  'w-full px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none',
                                  eff.cls === 'sar' && rec.fitFactor == null ? 'border-red-300 bg-red-50' : 'border-slate-300',
                                )}
                              />
                            </div>
                          </div>

                          {/* #17 Second mask */}
                          {rec.secondMask ? (
                            (() => {
                              const m2 = rec.secondMask!
                              const e2 = effectiveRespirator({ respiratorType: m2.respiratorType, respiratorClass: m2.respiratorClass })
                              const patch2 = (p: Partial<NonNullable<FitTestDraftRecord['secondMask']>>) =>
                                updateRecord(rec.id, { secondMask: { ...m2, ...p } })
                              return (
                                <div className="mt-3 border border-slate-200 rounded-lg p-3 bg-slate-50/60">
                                  <div className="flex items-center justify-between mb-2">
                                    <span className="text-xs font-semibold text-slate-600 uppercase tracking-wide">2nd Mask</span>
                                    <button
                                      type="button"
                                      onClick={() => updateRecord(rec.id, { secondMask: null })}
                                      className="text-xs text-red-500 hover:text-red-700 font-medium"
                                    >
                                      Remove
                                    </button>
                                  </div>
                                  <div className="grid grid-cols-2 gap-1.5">
                                    {RESPIRATOR_TYPES.map(rt => (
                                      <button
                                        key={rt.value}
                                        type="button"
                                        onClick={() => patch2({
                                          respiratorType: rt.value,
                                          respiratorClass: rt.value === 'half_face' ? null : (e2.type === 'full_face' ? e2.cls : null),
                                        })}
                                        className={cn(
                                          'py-2 rounded-lg text-xs font-medium border-2 transition-colors',
                                          e2.type === rt.value
                                            ? 'border-blue-500 bg-blue-50 text-blue-800'
                                            : 'border-slate-200 text-slate-500 hover:border-slate-300',
                                        )}
                                      >
                                        {rt.label}
                                      </button>
                                    ))}
                                  </div>
                                  {e2.type === 'full_face' && (
                                    <div className="grid grid-cols-2 gap-1.5 mt-1.5">
                                      {AIR_SUPPLY_CLASSES.map(ac => (
                                        <button
                                          key={ac.value}
                                          type="button"
                                          title={ac.tooltip}
                                          onClick={() => patch2({ respiratorType: 'full_face', respiratorClass: ac.value })}
                                          className={cn(
                                            'py-2 rounded-lg text-xs font-medium border-2 transition-colors',
                                            e2.cls === ac.value
                                              ? 'border-indigo-500 bg-indigo-50 text-indigo-800'
                                              : 'border-slate-200 text-slate-500 hover:border-slate-300',
                                          )}
                                        >
                                          {ac.label}
                                        </button>
                                      ))}
                                    </div>
                                  )}
                                  <div className="grid grid-cols-4 gap-3 mt-2">
                                    <input
                                      type="text"
                                      value={m2.make}
                                      onChange={e => patch2({ make: e.target.value })}
                                      placeholder="Make"
                                      className="px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                                    />
                                    <input
                                      type="text"
                                      value={m2.model}
                                      onChange={e => patch2({ model: e.target.value })}
                                      placeholder="Model"
                                      className="px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                                    />
                                    <input
                                      type="text"
                                      value={m2.size}
                                      onChange={e => patch2({ size: e.target.value })}
                                      placeholder="Size"
                                      className="px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                                    />
                                    <input
                                      type="number"
                                      value={m2.fitFactor ?? ''}
                                      onChange={e => patch2({ fitFactor: e.target.value ? Number(e.target.value) : null })}
                                      placeholder={e2.cls === 'sar' ? 'Fit factor *' : 'Fit factor'}
                                      className={cn(
                                        'px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none',
                                        e2.cls === 'sar' && m2.fitFactor == null ? 'border-red-300 bg-red-50' : 'border-slate-300',
                                      )}
                                    />
                                  </div>
                                </div>
                              )
                            })()
                          ) : (
                            <button
                              type="button"
                              onClick={() => updateRecord(rec.id, {
                                secondMask: { respiratorType: 'half_face', respiratorClass: null, make: '', model: '', size: '', fitFactor: null },
                              })}
                              className="mt-2 text-sm font-medium text-blue-600 hover:text-blue-700"
                            >
                              + Add 2nd mask
                            </button>
                          )}
                        </div>
                      )
                    })()}

                    {/* ===== SECTION 4: Test Method (#15) ===== */}
                    <div>
                      <label className="block text-xs font-medium text-slate-500 mb-1">Test Method</label>
                      <div className="grid grid-cols-2 gap-1.5">
                        {[
                          ...TEST_METHODS,
                          // A removed method already on this record stays visible/selected.
                          ...(LEGACY_TEST_METHODS[rec.testMethod]
                            ? [{ value: rec.testMethod, label: `${LEGACY_TEST_METHODS[rec.testMethod]} (legacy)`, tooltip: 'No longer offered — kept from the original record' }]
                            : []),
                        ].map(tm => (
                          <button
                            key={tm.value}
                            type="button"
                            title={'tooltip' in tm ? tm.tooltip : undefined}
                            onClick={() => updateRecord(rec.id, { testMethod: tm.value })}
                            className={cn(
                              'py-2 rounded-lg text-xs font-medium border-2 transition-colors',
                              rec.testMethod === tm.value
                                ? 'border-indigo-500 bg-indigo-50 text-indigo-800'
                                : 'border-slate-200 text-slate-500 hover:border-slate-300',
                            )}
                          >
                            {tm.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* ===== SECTION 4: Pass / Fail ===== */}
                    <div>
                      <label className="block text-xs font-medium text-slate-500 mb-1">Result</label>
                      <div className="grid grid-cols-2 gap-2">
                        <button
                          type="button"
                          onClick={() => updateRecord(rec.id, { passFail: 'pass' })}
                          className={cn(
                            'py-3 rounded-lg font-bold text-sm border-2 transition-colors',
                            rec.passFail === 'pass'
                              ? 'bg-green-100 border-green-400 text-green-800'
                              : 'border-slate-200 text-slate-400',
                          )}
                        >
                          PASS
                        </button>
                        <button
                          type="button"
                          onClick={() => updateRecord(rec.id, { passFail: 'fail' })}
                          className={cn(
                            'py-3 rounded-lg font-bold text-sm border-2 transition-colors',
                            rec.passFail === 'fail'
                              ? 'bg-red-100 border-red-400 text-red-800'
                              : 'border-slate-200 text-slate-400',
                          )}
                        >
                          FAIL
                        </button>
                      </div>
                    </div>

                    {/* ===== SECTION 5: DISCLOSURE — Participant Acceptance ===== */}
                    <div className="border-t border-slate-200 pt-3">
                      <div className="flex items-center gap-2 mb-2">
                        <FileCheck className="w-4 h-4 text-amber-600" />
                        <h4 className="text-sm font-semibold text-slate-800">Participant Acceptance</h4>
                      </div>
                      <p className="text-xs text-slate-500 mb-3">
                        Acknowledge the following conditions required for respirator safety:
                      </p>
                      <div className="space-y-2">
                        {DISCLOSURE_CONDITIONS.map(cond => {
                          const checked = rec.disclosureConditions.includes(cond.key)
                          return (
                            <label key={cond.key} className="flex items-start gap-2.5 cursor-pointer group">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggleCondition(rec.id, cond.key)}
                                className="w-5 h-5 mt-0.5 rounded border-slate-300 text-amber-600 focus:ring-amber-500 shrink-0"
                              />
                              <span className={cn(
                                'text-sm leading-snug',
                                checked ? 'text-slate-800' : 'text-slate-600',
                              )}>
                                {cond.label}
                              </span>
                            </label>
                          )
                        })}
                      </div>
                      {rec.disclosureConditions.length === DISCLOSURE_CONDITIONS.length && (
                        <p className="text-xs text-amber-600 font-medium mt-2">
                          All {DISCLOSURE_CONDITIONS.length} conditions acknowledged
                        </p>
                      )}
                    </div>

                    {/* ===== SECTION 6: Clean shaven + glasses questions ===== */}
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="block text-xs font-medium text-slate-500 mb-1.5">Clean shaven?</label>
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => updateRecord(rec.id, { isCleanShaven: true })}
                            className={cn(
                              'flex-1 py-2 rounded-lg text-sm font-medium border-2 transition-colors',
                              rec.isCleanShaven === true
                                ? 'border-green-400 bg-green-50 text-green-800'
                                : 'border-slate-200 text-slate-400',
                            )}
                          >
                            Yes
                          </button>
                          <button
                            type="button"
                            onClick={() => updateRecord(rec.id, { isCleanShaven: false })}
                            className={cn(
                              'flex-1 py-2 rounded-lg text-sm font-medium border-2 transition-colors',
                              rec.isCleanShaven === false
                                ? 'border-red-400 bg-red-50 text-red-800'
                                : 'border-slate-200 text-slate-400',
                            )}
                          >
                            No
                          </button>
                        </div>
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-500 mb-1.5">Glasses / contacts?</label>
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => updateRecord(rec.id, { wearsGlassesContacts: true })}
                            className={cn(
                              'flex-1 py-2 rounded-lg text-sm font-medium border-2 transition-colors',
                              rec.wearsGlassesContacts === true
                                ? 'border-blue-400 bg-blue-50 text-blue-800'
                                : 'border-slate-200 text-slate-400',
                            )}
                          >
                            Yes
                          </button>
                          <button
                            type="button"
                            onClick={() => updateRecord(rec.id, { wearsGlassesContacts: false })}
                            className={cn(
                              'flex-1 py-2 rounded-lg text-sm font-medium border-2 transition-colors',
                              rec.wearsGlassesContacts === false
                                ? 'border-slate-400 bg-slate-50 text-slate-700'
                                : 'border-slate-200 text-slate-400',
                            )}
                          >
                            No
                          </button>
                        </div>
                      </div>
                    </div>

                    {/* ===== SECTION 7: Adverse Reactions ===== */}
                    <div>
                      <div className="flex items-center gap-2 mb-2">
                        <AlertTriangle className="w-4 h-4 text-orange-500" />
                        <h4 className="text-sm font-semibold text-slate-800">Adverse Reactions</h4>
                      </div>
                      <p className="text-xs text-slate-500 mb-2">
                        Check any issues experienced during the fit test:
                      </p>
                      <div className="grid grid-cols-2 gap-2">
                        {ADVERSE_REACTIONS.map(ar => {
                          const checked = rec.adverseReactions.includes(ar.key)
                          return (
                            <label key={ar.key} className="flex items-center gap-2 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggleReaction(rec.id, ar.key)}
                                className="w-4 h-4 rounded border-slate-300 text-orange-500 focus:ring-orange-500 shrink-0"
                              />
                              <span className={cn(
                                'text-sm',
                                checked ? 'text-orange-700 font-medium' : 'text-slate-600',
                              )}>
                                {ar.label}
                              </span>
                            </label>
                          )
                        })}
                      </div>
                      {rec.adverseReactions.length === 0 && (
                        <p className="text-xs text-slate-400 mt-1.5 italic">None reported</p>
                      )}
                    </div>

                    {/* ===== SECTION 8: Criteria Acknowledgment + Signature ===== */}
                    <div className="border-t border-slate-200 pt-3">
                      <h4 className="text-sm font-semibold text-slate-800 mb-2">Fit Test Criteria & Understanding</h4>
                      <div className="bg-slate-50 rounded-lg p-3 mb-3">
                        <p className="text-xs text-slate-600 leading-relaxed">
                          I have read the material issued to me on how to clean, store, and inspect the respirator,
                          and I am familiar with the conditions under which it should be used. I am familiar with
                          the applicable OSHA standards, such as 29 CFR 1910.134 and others as required.
                        </p>
                        <p className="text-xs text-slate-600 leading-relaxed mt-2">
                          Since conditions vary greatly situation to situation, I take full responsibility for
                          becoming informed about the contaminants that may be encountered which will require the
                          use of my respirator, or a change in the means of protecting myself.
                        </p>
                      </div>
                      <label className="flex items-start gap-2.5 cursor-pointer mb-3">
                        <input
                          type="checkbox"
                          checked={rec.criteriaAcknowledged}
                          onChange={e => updateRecord(rec.id, { criteriaAcknowledged: e.target.checked })}
                          className="w-5 h-5 mt-0.5 rounded border-slate-300 text-blue-600 focus:ring-blue-500 shrink-0"
                        />
                        <span className={cn(
                          'text-sm font-medium leading-snug',
                          rec.criteriaAcknowledged ? 'text-blue-800' : 'text-slate-700',
                        )}>
                          I understand and accept the above criteria
                        </span>
                      </label>

                      {/* Per-person signature */}
                      <SignaturePad
                        value={rec.participantSignature}
                        onChange={(sig) => updateRecord(rec.id, { participantSignature: sig })}
                        label={`Signature — ${rec.employeeName || 'Participant'}`}
                      />
                    </div>
                    </>)}

                    {/* Notes */}
                    <div>
                      <label className="block text-xs font-medium text-slate-500 mb-1">Notes</label>
                      <input
                        type="text"
                        value={rec.notes}
                        onChange={e => updateRecord(rec.id, { notes: e.target.value })}
                        placeholder="Optional notes"
                        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                      />
                    </div>

                    {/* Disclosure completeness indicator (fit tests only) */}
                    {rec.employeeName && recHasFitTest(rec) && (
                      <div className={cn(
                        'flex items-center gap-2 p-2 rounded-lg text-xs font-medium',
                        hasDisclosure
                          ? 'bg-green-50 text-green-700'
                          : 'bg-amber-50 text-amber-700',
                      )}>
                        {hasDisclosure ? (
                          <><CheckCircle className="w-4 h-4" /> Disclosure complete</>
                        ) : (
                          <>
                            <AlertTriangle className="w-4 h-4" />
                            <span>
                              Disclosure incomplete:
                              {rec.disclosureConditions.length < DISCLOSURE_CONDITIONS.length && ' conditions'}
                              {rec.isCleanShaven === null && ' shaven'}
                              {rec.wearsGlassesContacts === null && ' glasses'}
                              {!rec.criteriaAcknowledged && ' acknowledgment'}
                              {!rec.participantSignature && ' signature'}
                            </span>
                          </>
                        )}
                      </div>
                    )}

                    {/* Delete */}
                    <button
                      type="button"
                      onClick={() => removeRecord(rec.id)}
                      className="flex items-center gap-1 text-sm text-red-500 hover:text-red-700 font-medium"
                    >
                      <Trash2 className="w-4 h-4" />
                      Remove
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {records.length === 0 && (
        <div className="text-center py-6 text-sm text-slate-400 border border-dashed border-slate-300 rounded-lg">
          Tap "Add Person" to start recording fit tests
        </div>
      )}
    </div>
  )
}
