import { useState, useEffect, useRef } from 'react'
import { cn } from '@/lib/cn'
import { db } from '@/lib/db'
import type { TrainingRosterDraftRecord } from '@/lib/db-types'
import {
  UserPlus,
  Trash2,
  ChevronDown,
  ChevronUp,
  CheckCircle,
  XCircle,
  Copy,
  Building2,
} from 'lucide-react'

// ---- Course type constants ----

export const COURSE_TYPES = [
  { value: 'h2s_clear', label: 'H2S CLEAR', cardsOnSite: true },
  { value: 'pec_safeland', label: 'PEC SafeLand', cardsOnSite: false },
  { value: 'first_aid_cpr', label: 'First Aid/CPR', cardsOnSite: false },
  { value: 'safety_meeting', label: 'Safety Meeting', cardsOnSite: true },
  { value: 'man_down_rescue', label: 'Man Down Rescue', cardsOnSite: true },
  { value: 'fex_safety_1hr', label: 'FEX Safety (1 hr)', cardsOnSite: true },
  { value: 'h2s_pec_combo', label: 'H2S Awareness + PEC Basic (1hr + 8hr)', cardsOnSite: false },
  { value: 'h2s_awareness_1hr', label: 'H2S Awareness (1 hr)', cardsOnSite: true },
  { value: 'confined_space_4hr', label: 'Confined Space (4 hr)', cardsOnSite: true },
  { value: 'defensive_driving_4hr', label: 'Defensive Driving (4 hr)', cardsOnSite: true },
  { value: 'bloodborne_pathogens_1hr', label: 'Bloodborne Pathogens (1 hr)', cardsOnSite: true },
  { value: 'other', label: 'Other', cardsOnSite: false },
]

// ---- Factory ----

let nextTempId = 1

export function createBlankTrainingRecord(
  defaultEmployer: string,
  courseName: string,
  cardsOnSite?: boolean,
): TrainingRosterDraftRecord {
  // Caller passes cardsOnSite from the ClassPRO catalog; the static
  // COURSE_TYPES lookup is the fallback for legacy callers.
  const courseConfig = COURSE_TYPES.find(c => c.label === courseName)
  return {
    id: `tr_${Date.now()}_${nextTempId++}`,
    employeeName: '',
    employeeId: '',
    employerName: defaultEmployer,
    employerCompanyId: null,
    contactEmail: '',
    contactPhone: '',
    courseName,
    passed: true,
    cardIssuedOnSite: cardsOnSite ?? courseConfig?.cardsOnSite ?? false,
    cardIssuedOfficial: false,
    cardNumber: '',
    cardExpiryDate: '',
    notes: '',
    trainedAt: new Date().toISOString(),
  }
}

// ---- Inline employer search ----

interface CompanyResult {
  id: string
  name: string
  companyType: string
}

function EmployerSearch({
  value,
  onChange,
}: {
  value: string
  onChange: (name: string, companyId: string | null) => void
}) {
  const [query, setQuery] = useState(value)
  const [results, setResults] = useState<CompanyResult[]>([])
  const [showDropdown, setShowDropdown] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // Sync external value changes
  useEffect(() => { setQuery(value) }, [value])

  useEffect(() => {
    if (query.length < 2) { setResults([]); return }
    const t = setTimeout(async () => {
      try {
        const q = query.toLowerCase()
        const companies = await db.companies
          .filter(c => c.name.toLowerCase().includes(q) && c.isActive)
          .limit(8)
          .toArray()
        setResults(companies.map(c => ({ id: c.id, name: c.name, companyType: c.companyType })))
        setShowDropdown(companies.length > 0)
      } catch {
        setResults([])
      }
    }, 200)
    return () => clearTimeout(t)
  }, [query])

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowDropdown(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  return (
    <div ref={containerRef} className="relative">
      <label className="block text-xs font-medium text-slate-500 mb-1">Employer Company</label>
      <div className="relative">
        <Building2 className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={e => {
            setQuery(e.target.value)
            // Free-text mode — clear company ID, set name
            onChange(e.target.value, null)
          }}
          onFocus={() => { if (results.length > 0) setShowDropdown(true) }}
          placeholder="Search or type company name..."
          className="w-full pl-8 pr-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
        />
      </div>

      {/* Dropdown */}
      {showDropdown && results.length > 0 && (
        <div className="absolute z-50 mt-1 w-full bg-white border border-slate-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
          {results.map(c => (
            <button
              key={c.id}
              type="button"
              className="w-full text-left px-3 py-2 text-sm hover:bg-blue-50 flex items-center gap-2"
              onClick={() => {
                setQuery(c.name)
                onChange(c.name, c.id)
                setShowDropdown(false)
              }}
            >
              <Building2 className="w-3.5 h-3.5 text-slate-400 shrink-0" />
              <span className="truncate">{c.name}</span>
              <span className="ml-auto text-xs text-slate-400">{c.companyType}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ---- Main editor ----

interface TrainingClassEditorProps {
  records: TrainingRosterDraftRecord[]
  onChange: (records: TrainingRosterDraftRecord[]) => void
  defaultEmployer?: string
  courseName: string
  /** From the ClassPRO catalog; undefined falls back to the static COURSE_TYPES lookup. */
  cardsOnSite?: boolean
}

export function TrainingClassEditor({
  records,
  onChange,
  defaultEmployer = '',
  courseName,
  cardsOnSite,
}: TrainingClassEditorProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null)

  function addRecord() {
    const rec = createBlankTrainingRecord(defaultEmployer, courseName, cardsOnSite)
    onChange([...records, rec])
    setExpandedId(rec.id)
  }

  function duplicateLast() {
    if (records.length === 0) return
    const last = records[records.length - 1]
    const rec: TrainingRosterDraftRecord = {
      ...last,
      id: `tr_${Date.now()}_${nextTempId++}`,
      employeeName: '',
      employeeId: '',
      contactEmail: '',
      contactPhone: '',
      notes: '',
      cardNumber: '',
      cardExpiryDate: '',
      // Keep employer from last entry
    }
    onChange([...records, rec])
    setExpandedId(rec.id)
  }

  function updateRecord(id: string, updates: Partial<TrainingRosterDraftRecord>) {
    onChange(records.map(r => r.id === id ? { ...r, ...updates } : r))
  }

  function removeRecord(id: string) {
    onChange(records.filter(r => r.id !== id))
    if (expandedId === id) setExpandedId(null)
  }

  const passCount = records.filter(r => r.passed).length
  const failCount = records.filter(r => !r.passed).length

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <label className="block text-sm font-medium text-slate-700">
          Training Roster
          {records.length > 0 && (
            <span className="ml-2 text-slate-400 font-normal">
              {records.length} {records.length === 1 ? 'person' : 'people'}
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
            title="Copy employer from last entry"
          >
            <Copy className="w-4 h-4" />
            Duplicate
          </button>
        )}
      </div>

      {/* Empty state */}
      {records.length === 0 && (
        <div className="border-2 border-dashed border-slate-200 rounded-lg p-8 text-center text-sm text-slate-400">
          Tap <strong>Add Person</strong> to start building the roster
        </div>
      )}

      {/* Record list */}
      {records.length > 0 && (
        <div className="space-y-2">
          {records.map((rec, index) => {
            const isExpanded = expandedId === rec.id

            return (
              <div key={rec.id} className="bg-white rounded-lg border border-slate-200 overflow-hidden">
                {/* Header row */}
                <button
                  type="button"
                  onClick={() => setExpandedId(isExpanded ? null : rec.id)}
                  className="w-full flex items-center gap-3 p-3 hover:bg-slate-50 transition-colors"
                >
                  <span className="text-xs font-mono text-slate-400 w-5">{index + 1}</span>
                  {rec.passed ? (
                    <CheckCircle className="w-4 h-4 text-green-500 shrink-0" />
                  ) : (
                    <XCircle className="w-4 h-4 text-red-500 shrink-0" />
                  )}
                  <div className="flex-1 text-left min-w-0">
                    <p className="text-sm font-medium text-slate-900 truncate">
                      {rec.employeeName || <span className="italic text-slate-400">Name required</span>}
                    </p>
                    {rec.employerName && (
                      <p className="text-xs text-slate-500 truncate">{rec.employerName}</p>
                    )}
                  </div>
                  <span className={cn(
                    'text-xs font-medium px-2 py-0.5 rounded-full shrink-0',
                    rec.passed
                      ? 'bg-green-100 text-green-700'
                      : 'bg-red-100 text-red-700',
                  )}>
                    {rec.passed ? 'PASS' : 'FAIL'}
                  </span>
                  {!rec.cardIssuedOnSite && !rec.cardIssuedOfficial && (
                    <span className="text-xs text-amber-600 shrink-0">Card Pending</span>
                  )}
                  {isExpanded ? (
                    <ChevronUp className="w-4 h-4 text-slate-400 shrink-0" />
                  ) : (
                    <ChevronDown className="w-4 h-4 text-slate-400 shrink-0" />
                  )}
                </button>

                {/* Expanded form */}
                {isExpanded && (
                  <div className="border-t border-slate-200 p-4 space-y-4 bg-slate-50">
                    {/* Employee Name */}
                    <div>
                      <label className="block text-xs font-medium text-slate-500 mb-1">Employee Name *</label>
                      <input
                        type="text"
                        autoFocus
                        value={rec.employeeName}
                        onChange={e => updateRecord(rec.id, { employeeName: e.target.value })}
                        placeholder="Full name"
                        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                      />
                    </div>

                    {/* Employee ID */}
                    <div>
                      <label className="block text-xs font-medium text-slate-500 mb-1">Employee ID</label>
                      <input
                        type="text"
                        value={rec.employeeId}
                        onChange={e => updateRecord(rec.id, { employeeId: e.target.value })}
                        placeholder="Badge or ID number"
                        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                      />
                    </div>

                    {/* Employer Company (searchable) */}
                    <EmployerSearch
                      value={rec.employerName}
                      onChange={(name, companyId) => {
                        updateRecord(rec.id, {
                          employerName: name,
                          employerCompanyId: companyId,
                        })
                      }}
                    />

                    {/* Contact info row */}
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs font-medium text-slate-500 mb-1">Email</label>
                        <input
                          type="email"
                          value={rec.contactEmail}
                          onChange={e => updateRecord(rec.id, { contactEmail: e.target.value })}
                          placeholder="trainee@email.com"
                          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-500 mb-1">Phone</label>
                        <input
                          type="tel"
                          value={rec.contactPhone}
                          onChange={e => updateRecord(rec.id, { contactPhone: e.target.value })}
                          placeholder="(701) 555-1234"
                          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                        />
                      </div>
                    </div>

                    {/* Result + Card row */}
                    <div className="flex items-center gap-6">
                      {/* Passed */}
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={rec.passed}
                          onChange={e => updateRecord(rec.id, { passed: e.target.checked })}
                          className="w-4 h-4 rounded border-slate-300 text-green-600 focus:ring-green-500"
                        />
                        <span className="text-sm text-slate-700">Passed</span>
                      </label>

                      {/* Card Issued On-Site */}
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={rec.cardIssuedOnSite}
                          onChange={e => updateRecord(rec.id, { cardIssuedOnSite: e.target.checked })}
                          className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                        />
                        <span className="text-sm text-slate-700">Card Issued On-Site</span>
                      </label>
                    </div>

                    {/* Card Number (visible if card issued on-site) */}
                    {rec.cardIssuedOnSite && (
                      <div>
                        <label className="block text-xs font-medium text-slate-500 mb-1">Card Number</label>
                        <input
                          type="text"
                          value={rec.cardNumber}
                          onChange={e => updateRecord(rec.id, { cardNumber: e.target.value })}
                          placeholder="Certificate card number"
                          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                        />
                      </div>
                    )}

                    {/* Notes */}
                    <div>
                      <label className="block text-xs font-medium text-slate-500 mb-1">Notes</label>
                      <input
                        type="text"
                        value={rec.notes}
                        onChange={e => updateRecord(rec.id, { notes: e.target.value })}
                        placeholder="Any additional notes..."
                        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                      />
                    </div>

                    {/* Remove button */}
                    <button
                      type="button"
                      onClick={() => removeRecord(rec.id)}
                      className="flex items-center gap-2 text-red-600 text-sm font-medium hover:text-red-700 transition-colors"
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
    </div>
  )
}
