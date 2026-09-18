import { useState, useEffect } from 'react'
import { api } from '@/lib/api'
import { X, Loader2, Save, Search } from 'lucide-react'

// Admin-only correction form for the core identity/classification/location
// fields that drive DMR matching, dedup, and billing (API #, operator, S/T/R,
// etc). Deliberately separate from the everyday fields on WellDetailPage
// (facility code, asset category, active toggle) — those stay open to anyone
// with locations:manage. The server enforces the same admin-only split
// independent of this form (WELL_ADMIN_ONLY_FIELDS in locations.ts), so this
// is a convenience UI, not the security boundary.

interface OperatorOption {
  id: string
  name: string
}

interface EditableWell {
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
  currentOperator: { id: string; name: string } | null
}

const WELL_TYPE_OPTIONS = [
  { value: '', label: '(none)' },
  { value: 'OG', label: 'Oil & Gas' },
  { value: 'SWD', label: 'Salt Water Disposal' },
  { value: 'WI', label: 'Water Injection' },
  { value: 'GI', label: 'Gas Injection' },
  { value: 'OB', label: 'Observation' },
  { value: 'ST', label: 'Stratigraphic Test' },
]

const WELL_STATUS_OPTIONS = [
  { value: '', label: '(none)' },
  { value: 'A', label: 'Active' },
  { value: 'DRY', label: 'Dry Hole' },
  { value: 'PA', label: 'Plugged & Abandoned' },
  { value: 'PNC', label: 'Plugged & Completed' },
  { value: 'IA', label: 'Inactive' },
  { value: 'SI', label: 'Shut In' },
  { value: 'TA', label: 'Temp Abandoned' },
  { value: 'LOC', label: 'Location' },
  { value: 'WC', label: 'Waiting Completion' },
  { value: 'DC', label: 'Drilling Complete' },
]

function toNumOrNull(s: string): number | null {
  const t = s.trim()
  if (!t) return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}
function toStrOrNull(s: string): string | null {
  const t = s.trim()
  return t || null
}
// <input type="date"> gives "YYYY-MM-DD" — Prisma's DateTime field needs a
// full ISO-8601 timestamp, not a bare date string.
function toDateOrNull(s: string): string | null {
  const t = s.trim()
  return t ? `${t}T00:00:00.000Z` : null
}

export function EditWellModal({ well, onSaved, onClose }: {
  well: EditableWell
  onSaved: (patch: Record<string, any>) => void
  onClose: () => void
}) {
  const [wellName, setWellName] = useState(well.wellName || '')
  const [wellNameBase, setWellNameBase] = useState(well.wellNameBase || '')
  const [apiNumber, setApiNumber] = useState(well.apiNumber || '')
  const [apiShort, setApiShort] = useState(well.apiShort || '')
  const [dmrFileNumber, setDmrFileNumber] = useState(well.dmrFileNumber?.toString() || '')
  const [totalDepth, setTotalDepth] = useState(well.totalDepth?.toString() || '')
  const [spudDate, setSpudDate] = useState(well.spudDate ? well.spudDate.slice(0, 10) : '')
  const [wellType, setWellType] = useState(well.wellType || '')
  const [wellStatus, setWellStatus] = useState(well.wellStatus || '')
  const [county, setCounty] = useState(well.county || '')
  const [quarterQuarter, setQuarterQuarter] = useState(well.quarterQuarter || '')
  const [section, setSection] = useState(well.section?.toString() || '')
  const [township, setTownship] = useState(well.township?.toString() || '')
  const [range, setRange] = useState(well.range?.toString() || '')
  const [feetNs, setFeetNs] = useState(well.feetNs?.toString() || '')
  const [nsLine, setNsLine] = useState(well.nsLine || '')
  const [feetEw, setFeetEw] = useState(well.feetEw?.toString() || '')
  const [ewLine, setEwLine] = useState(well.ewLine || '')
  const [latitude, setLatitude] = useState(well.latitude || '')
  const [longitude, setLongitude] = useState(well.longitude || '')

  const [operatorId, setOperatorId] = useState(well.currentOperator?.id || '')
  const [operatorName, setOperatorName] = useState(well.currentOperator?.name || '')
  const [operatorSearch, setOperatorSearch] = useState('')
  const [operators, setOperators] = useState<OperatorOption[]>([])

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!operatorSearch || operatorSearch.length < 2) { setOperators([]); return }
    const timer = setTimeout(async () => {
      try {
        const res = await api.get<{ data: OperatorOption[] }>(`/companies?search=${encodeURIComponent(operatorSearch)}&limit=10&active=true`)
        setOperators(res.data || [])
      } catch { setOperators([]) }
    }, 300)
    return () => clearTimeout(timer)
  }, [operatorSearch])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    const payload: Record<string, any> = {
      wellName: toStrOrNull(wellName),
      wellNameBase: toStrOrNull(wellNameBase),
      apiNumber: toStrOrNull(apiNumber),
      apiShort: toStrOrNull(apiShort),
      dmrFileNumber: toNumOrNull(dmrFileNumber),
      totalDepth: toNumOrNull(totalDepth),
      spudDate: toDateOrNull(spudDate),
      wellType: wellType || null,
      wellStatus: wellStatus || null,
      county: toStrOrNull(county),
      quarterQuarter: toStrOrNull(quarterQuarter),
      section: toNumOrNull(section),
      township: toNumOrNull(township),
      range: toNumOrNull(range),
      feetNs: toNumOrNull(feetNs),
      nsLine: toStrOrNull(nsLine),
      feetEw: toNumOrNull(feetEw),
      ewLine: toStrOrNull(ewLine),
      latitude: toStrOrNull(latitude),
      longitude: toStrOrNull(longitude),
      currentOperatorId: operatorId || null,
    }
    try {
      const updated = await api.put(`/locations/wells/${well.id}`, payload)
      onSaved(updated as Record<string, any>)
    } catch (e: any) {
      setError(e.message || 'Failed to update well')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b sticky top-0 bg-white">
          <h2 className="text-lg font-semibold text-gray-900">Edit Well (Admin)</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-5 py-4 space-y-5">
          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded text-sm">{error}</div>
          )}
          <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
            These fields drive DMR matching, dedup, and billing. Changing them can silently break automatic linking — double-check before saving.
          </p>

          {/* Identity */}
          <div>
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Identity</h3>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Well Name"><input value={wellName} onChange={e => setWellName(e.target.value)} className={inputCls} /></Field>
              <Field label="Base Name"><input value={wellNameBase} onChange={e => setWellNameBase(e.target.value)} className={inputCls} /></Field>
              <Field label="API #"><input value={apiNumber} onChange={e => setApiNumber(e.target.value)} className={inputCls} /></Field>
              <Field label="API Short"><input value={apiShort} onChange={e => setApiShort(e.target.value)} className={inputCls} /></Field>
              <Field label="DMR File #"><input value={dmrFileNumber} onChange={e => setDmrFileNumber(e.target.value)} inputMode="numeric" className={inputCls} /></Field>
            </div>
          </div>

          {/* Operator */}
          <div>
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Operator</h3>
            {operatorId ? (
              <div className="flex items-center gap-2 text-sm">
                <span className="bg-blue-50 text-blue-700 px-2 py-1 rounded">{operatorName}</span>
                <button type="button" onClick={() => { setOperatorId(''); setOperatorName(''); setOperatorSearch('') }} className="text-gray-400 hover:text-red-600">
                  <X className="w-4 h-4" />
                </button>
              </div>
            ) : (
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
                <input
                  type="text"
                  value={operatorSearch}
                  onChange={e => setOperatorSearch(e.target.value)}
                  placeholder="Search by company name..."
                  className="w-full pl-8 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
                {operators.length > 0 && (
                  <div className="absolute z-10 top-full left-0 right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-56 overflow-auto">
                    {operators.map(op => (
                      <button
                        key={op.id}
                        type="button"
                        onClick={() => { setOperatorId(op.id); setOperatorName(op.name); setOperatorSearch('') }}
                        className="w-full text-left px-3 py-2 text-sm hover:bg-blue-50 transition-colors border-b border-gray-100 last:border-b-0"
                      >
                        {op.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Classification */}
          <div>
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Classification</h3>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Well Type">
                <select value={wellType} onChange={e => setWellType(e.target.value)} className={inputCls}>
                  {WELL_TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </Field>
              <Field label="Well Status (DMR)">
                <select value={wellStatus} onChange={e => setWellStatus(e.target.value)} className={inputCls}>
                  {WELL_STATUS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </Field>
              <Field label="County"><input value={county} onChange={e => setCounty(e.target.value)} className={inputCls} /></Field>
              <Field label="Total Depth (ft)"><input value={totalDepth} onChange={e => setTotalDepth(e.target.value)} inputMode="numeric" className={inputCls} /></Field>
              <Field label="Spud Date"><input type="date" value={spudDate} onChange={e => setSpudDate(e.target.value)} className={inputCls} /></Field>
            </div>
          </div>

          {/* Legal location */}
          <div>
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Legal Location</h3>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Quarter-Quarter"><input value={quarterQuarter} onChange={e => setQuarterQuarter(e.target.value)} className={inputCls} /></Field>
              <div className="grid grid-cols-3 gap-2">
                <Field label="Sec"><input value={section} onChange={e => setSection(e.target.value)} inputMode="numeric" className={inputCls} /></Field>
                <Field label="Twp"><input value={township} onChange={e => setTownship(e.target.value)} inputMode="numeric" className={inputCls} /></Field>
                <Field label="Rng"><input value={range} onChange={e => setRange(e.target.value)} inputMode="numeric" className={inputCls} /></Field>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Feet N/S"><input value={feetNs} onChange={e => setFeetNs(e.target.value)} inputMode="numeric" className={inputCls} /></Field>
                <Field label="N/S Line"><input value={nsLine} onChange={e => setNsLine(e.target.value)} placeholder="N or S" className={inputCls} /></Field>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Feet E/W"><input value={feetEw} onChange={e => setFeetEw(e.target.value)} inputMode="numeric" className={inputCls} /></Field>
                <Field label="E/W Line"><input value={ewLine} onChange={e => setEwLine(e.target.value)} placeholder="E or W" className={inputCls} /></Field>
              </div>
              <Field label="Latitude"><input value={latitude} onChange={e => setLatitude(e.target.value)} className={inputCls} /></Field>
              <Field label="Longitude"><input value={longitude} onChange={e => setLongitude(e.target.value)} className={inputCls} /></Field>
            </div>
          </div>

          <div className="flex items-center gap-3 pt-2 border-t border-gray-100">
            <button
              type="submit"
              disabled={saving}
              className="flex-1 flex items-center justify-center gap-2 py-2.5 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors text-sm"
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              Save Changes
            </button>
            <button type="button" onClick={onClose} className="px-4 py-2.5 text-gray-500 hover:text-gray-700 text-sm">
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

const inputCls = 'w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500'

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs text-gray-500 block mb-1">{label}</span>
      {children}
    </label>
  )
}
