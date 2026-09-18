import { useState } from 'react'
import { v4 as uuidv4 } from 'uuid'
import { cn } from '@/lib/cn'
import type {
  IhTestDraftRecord,
  IhTestType,
  H2sTestData,
  O2VocTestData,
  SamplingTestData,
  AudiometricTestData,
} from '@/lib/db-types'
import {
  Plus,
  Trash2,
  ChevronDown,
  ChevronUp,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Beaker,
  Wind,
  Thermometer,
  UserPlus,
} from 'lucide-react'

// ============================================================
// Constants & Exports
// ============================================================

// Audiometric is intentionally NOT listed here — it moved under Occ Health
// (FitTestRecord.includesAudiometric). The 'ih_audiometric' type, its factory,
// and AudiometricSection are kept below so historical IH tickets that already
// have audiometric records still render correctly; new IH tickets can't pick it.
export const IH_SUBTYPES = [
  { value: 'ih_h2s' as const, label: 'H₂S Testing', description: 'PPM readings per location point' },
  { value: 'ih_o2_voc' as const, label: 'O₂/VOC Testing', description: 'O₂ saturation & VOC readings per sample point' },
  { value: 'ih_sampling' as const, label: 'Sampling', description: 'Produced water/oil collection for lab' },
]

const SAMPLE_TYPE_PRESETS = ['Produced Water', 'Oil', 'Gas', 'Condensate']
const WEATHER_PRESETS = ['Clear', 'Partly Cloudy', 'Overcast', 'Rain', 'Snow', 'Windy']

// ============================================================
// Factory functions
// ============================================================

function createBlankH2sData(): H2sTestData {
  return {
    readings: [],
    weatherConditions: '',
    windDirection: '',
    temperature: null,
    instrumentModel: '',
  }
}

function createBlankO2VocData(): O2VocTestData {
  return {
    samplePoints: [],
    instrumentSerial: '',
    instrumentModel: '',
  }
}

function createBlankSamplingData(): SamplingTestData {
  return { samples: [] }
}

function createBlankAudiometricData(): AudiometricTestData {
  return { personnel: [] }
}

export function createBlankIhRecord(testType: IhTestType): IhTestDraftRecord {
  const dataByType: Record<IhTestType, () => IhTestDraftRecord['testData']> = {
    ih_h2s: createBlankH2sData,
    ih_o2_voc: createBlankO2VocData,
    ih_sampling: createBlankSamplingData,
    ih_audiometric: createBlankAudiometricData,
  }
  return {
    id: uuidv4(),
    testType,
    locationPoint: '',
    instrumentModel: '',
    instrumentSerial: '',
    testData: dataByType[testType](),
    notes: '',
    testedAt: new Date().toISOString(),
  }
}

// ============================================================
// Props
// ============================================================

interface IhTestingEditorProps {
  records: IhTestDraftRecord[]
  onChange: (records: IhTestDraftRecord[]) => void
  testType: IhTestType
  defaultEmployer?: string
  isCallOut?: boolean
}

// ============================================================
// Main Component
// ============================================================

export function IhTestingEditor({ records, onChange, testType, defaultEmployer, isCallOut }: IhTestingEditorProps) {
  const [expandedId, setExpandedId] = useState<string | null>(records.length === 1 ? records[0]?.id ?? null : null)

  function updateRecord(id: string, patch: Partial<IhTestDraftRecord>) {
    onChange(records.map(r => r.id === id ? { ...r, ...patch } : r))
  }

  function removeRecord(id: string) {
    onChange(records.filter(r => r.id !== id))
    if (expandedId === id) setExpandedId(null)
  }

  function addRecord() {
    const rec = createBlankIhRecord(testType)
    // Pre-fill employer for audiometric
    if (testType === 'ih_audiometric' && defaultEmployer) {
      const data = rec.testData as AudiometricTestData
      data.personnel = [{
        id: uuidv4(), employeeName: '', employeeId: '', employerName: defaultEmployer,
        tested: true, result: 'na', notes: '',
      }]
    }
    onChange([...records, rec])
    setExpandedId(rec.id)
  }

  const subtypeLabel = IH_SUBTYPES.find(s => s.value === testType)?.label ?? 'IH Test'

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-slate-900 flex items-center gap-2">
          <Beaker className="w-4 h-4 text-blue-600" />
          {subtypeLabel} Records
          {isCallOut && (
            <span className="text-xs px-2 py-0.5 bg-amber-100 text-amber-800 rounded-full font-medium">
              CALL-OUT
            </span>
          )}
        </h3>
        <span className="text-sm text-slate-500">{records.length} record{records.length !== 1 ? 's' : ''}</span>
      </div>

      {/* Records */}
      {records.map((rec, idx) => {
        const isExpanded = expandedId === rec.id
        return (
          <div key={rec.id} className="border border-slate-200 rounded-xl overflow-hidden">
            {/* Header */}
            <button
              type="button"
              onClick={() => setExpandedId(isExpanded ? null : rec.id)}
              className="w-full flex items-center gap-3 p-4 bg-slate-50 hover:bg-slate-100 transition-colors text-left"
            >
              <span className="text-sm font-mono text-slate-400 w-6">{idx + 1}.</span>
              <span className="flex-1 font-medium text-slate-900 truncate">
                {getRecordLabel(rec) || 'New Record'}
              </span>
              {isExpanded ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
            </button>

            {/* Body */}
            {isExpanded && (
              <div className="p-4 space-y-4 border-t border-slate-200">
                {testType === 'ih_h2s' && <H2sSection record={rec} onUpdate={patch => updateRecord(rec.id, patch)} />}
                {testType === 'ih_o2_voc' && <O2VocSection record={rec} onUpdate={patch => updateRecord(rec.id, patch)} />}
                {testType === 'ih_sampling' && <SamplingSection record={rec} onUpdate={patch => updateRecord(rec.id, patch)} />}
                {testType === 'ih_audiometric' && (
                  <AudiometricSection record={rec} onUpdate={patch => updateRecord(rec.id, patch)} defaultEmployer={defaultEmployer} />
                )}

                {/* Common: Notes */}
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Notes</label>
                  <textarea
                    value={rec.notes}
                    onChange={e => updateRecord(rec.id, { notes: e.target.value })}
                    placeholder="Additional notes..."
                    rows={2}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none resize-none"
                  />
                </div>

                {/* Delete */}
                <button
                  type="button"
                  onClick={() => removeRecord(rec.id)}
                  className="flex items-center gap-2 text-sm text-red-600 hover:text-red-700 font-medium"
                >
                  <Trash2 className="w-4 h-4" /> Remove Record
                </button>
              </div>
            )}
          </div>
        )
      })}

      {/* Add button */}
      <button
        type="button"
        onClick={addRecord}
        className="w-full py-4 border-2 border-dashed border-slate-300 rounded-xl text-slate-600 hover:border-blue-400 hover:text-blue-600 transition-colors font-medium flex items-center justify-center gap-2"
      >
        <Plus className="w-5 h-5" />
        Add {subtypeLabel} Record
      </button>
    </div>
  )
}

// ============================================================
// Helpers
// ============================================================

function getRecordLabel(rec: IhTestDraftRecord): string {
  switch (rec.testType) {
    case 'ih_h2s': {
      const n = (rec.testData as H2sTestData)?.readings?.length ?? 0
      return n > 0 ? `H₂S — ${n} reading${n !== 1 ? 's' : ''}` : 'H₂S Test'
    }
    case 'ih_o2_voc': {
      const n = (rec.testData as O2VocTestData)?.samplePoints?.length ?? 0
      return n > 0 ? `O₂/VOC — ${n} point${n !== 1 ? 's' : ''}` : 'O₂/VOC Test'
    }
    case 'ih_sampling': {
      const n = (rec.testData as SamplingTestData)?.samples?.length ?? 0
      return n > 0 ? `Sampling — ${n} sample${n !== 1 ? 's' : ''}` : 'Sampling'
    }
    case 'ih_audiometric': {
      const n = (rec.testData as AudiometricTestData)?.personnel?.length ?? 0
      return n > 0 ? `Audiometric — ${n} person${n !== 1 ? 'nel' : ''}` : 'Audiometric'
    }
    default:
      return rec.locationPoint || 'IH Record'
  }
}

// ============================================================
// H2S Section
// ============================================================

function H2sSection({ record, onUpdate }: { record: IhTestDraftRecord; onUpdate: (patch: Partial<IhTestDraftRecord>) => void }) {
  const data = record.testData as H2sTestData

  function updateData(patch: Partial<H2sTestData>) {
    onUpdate({ testData: { ...data, ...patch } })
  }

  function addReading() {
    updateData({
      readings: [...data.readings, {
        id: uuidv4(), locationPoint: '', ppmReading: null, backgroundPpm: null,
        instrumentSerial: record.instrumentSerial || '', durationMinutes: null, result: 'na',
      }],
    })
  }

  function updateReading(id: string, patch: Partial<H2sTestData['readings'][0]>) {
    updateData({ readings: data.readings.map(r => r.id === id ? { ...r, ...patch } : r) })
  }

  function removeReading(id: string) {
    updateData({ readings: data.readings.filter(r => r.id !== id) })
  }

  return (
    <div className="space-y-4">
      {/* Instrument info */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">Instrument Model</label>
          <input type="text" value={data.instrumentModel} onChange={e => updateData({ instrumentModel: e.target.value })}
            placeholder="e.g. BW GasAlert Extreme" className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm" />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">Instrument Serial</label>
          <input type="text" value={record.instrumentSerial} onChange={e => onUpdate({ instrumentSerial: e.target.value })}
            placeholder="Serial #" className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono" />
        </div>
      </div>

      {/* Weather */}
      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">Weather</label>
          <select value={data.weatherConditions} onChange={e => updateData({ weatherConditions: e.target.value })}
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm">
            <option value="">Select...</option>
            {WEATHER_PRESETS.map(w => <option key={w} value={w}>{w}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">
            <Wind className="w-3 h-3 inline mr-1" />Wind Direction
          </label>
          <input type="text" value={data.windDirection} onChange={e => updateData({ windDirection: e.target.value })}
            placeholder="NW, SE..." className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm" />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">
            <Thermometer className="w-3 h-3 inline mr-1" />Temp (°F)
          </label>
          <input type="number" value={data.temperature ?? ''} onChange={e => updateData({ temperature: e.target.value ? Number(e.target.value) : null })}
            placeholder="°F" className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm" />
        </div>
      </div>

      {/* Readings */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-sm font-medium text-slate-700">Readings</label>
          <span className="text-xs text-slate-400">{data.readings.length} point{data.readings.length !== 1 ? 's' : ''}</span>
        </div>

        {data.readings.map((reading, i) => (
          <div key={reading.id} className="bg-slate-50 rounded-lg p-3 space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono text-slate-400 w-5">{i + 1}.</span>
              <input type="text" value={reading.locationPoint} onChange={e => updateReading(reading.id, { locationPoint: e.target.value })}
                placeholder="Location (e.g. Treater, Tubing, Casing)"
                className="flex-1 px-3 py-2 border border-slate-300 rounded-lg text-sm" />
              <button type="button" onClick={() => removeReading(reading.id)} className="p-1 text-red-400 hover:text-red-600">
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pl-7">
              <div>
                <label className="block text-xs text-slate-500 mb-0.5">PPM</label>
                <input type="number" value={reading.ppmReading ?? ''} onChange={e => updateReading(reading.id, { ppmReading: e.target.value ? Number(e.target.value) : null })}
                  placeholder="0" className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm font-mono" />
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-0.5">Background</label>
                <input type="number" value={reading.backgroundPpm ?? ''} onChange={e => updateReading(reading.id, { backgroundPpm: e.target.value ? Number(e.target.value) : null })}
                  placeholder="0" className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm font-mono" />
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-0.5">Duration (min)</label>
                <input type="number" value={reading.durationMinutes ?? ''} onChange={e => updateReading(reading.id, { durationMinutes: e.target.value ? Number(e.target.value) : null })}
                  placeholder="15" className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm" />
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-0.5">Result</label>
                <div className="flex gap-1">
                  {(['pass', 'fail', 'na'] as const).map(v => (
                    <button key={v} type="button" onClick={() => updateReading(reading.id, { result: v })}
                      className={cn('flex-1 py-1.5 rounded text-xs font-medium transition-colors',
                        reading.result === v
                          ? v === 'pass' ? 'bg-green-100 text-green-700 border border-green-300'
                            : v === 'fail' ? 'bg-red-100 text-red-700 border border-red-300'
                            : 'bg-slate-200 text-slate-600 border border-slate-300'
                          : 'bg-white text-slate-400 border border-slate-200 hover:border-slate-300',
                      )}>
                      {v === 'na' ? 'N/A' : v.toUpperCase()}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        ))}

        <button type="button" onClick={addReading}
          className="w-full py-2.5 border border-dashed border-slate-300 rounded-lg text-sm text-slate-500 hover:border-blue-400 hover:text-blue-600 transition-colors flex items-center justify-center gap-1">
          <Plus className="w-4 h-4" /> Add Reading
        </button>
      </div>
    </div>
  )
}

// ============================================================
// O2/VOC Section
// ============================================================

function O2VocSection({ record, onUpdate }: { record: IhTestDraftRecord; onUpdate: (patch: Partial<IhTestDraftRecord>) => void }) {
  const data = record.testData as O2VocTestData

  function updateData(patch: Partial<O2VocTestData>) {
    onUpdate({ testData: { ...data, ...patch } })
  }

  function addPoint() {
    updateData({
      samplePoints: [...data.samplePoints, {
        id: uuidv4(), pointName: '', o2Percent: null, vocPpm: null, notes: '',
      }],
    })
  }

  function updatePoint(id: string, patch: Partial<O2VocTestData['samplePoints'][0]>) {
    updateData({ samplePoints: data.samplePoints.map(p => p.id === id ? { ...p, ...patch } : p) })
  }

  function removePoint(id: string) {
    updateData({ samplePoints: data.samplePoints.filter(p => p.id !== id) })
  }

  return (
    <div className="space-y-4">
      {/* Instrument info */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">Instrument Model</label>
          <input type="text" value={data.instrumentModel} onChange={e => updateData({ instrumentModel: e.target.value })}
            placeholder="e.g. RAE MiniRAE 3000" className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm" />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">Instrument Serial</label>
          <input type="text" value={data.instrumentSerial} onChange={e => updateData({ instrumentSerial: e.target.value })}
            placeholder="Serial #" className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono" />
        </div>
      </div>

      {/* Sample points */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-sm font-medium text-slate-700">Sample Points</label>
          <span className="text-xs text-slate-400">{data.samplePoints.length} point{data.samplePoints.length !== 1 ? 's' : ''}</span>
        </div>

        {data.samplePoints.map((point, i) => (
          <div key={point.id} className="bg-slate-50 rounded-lg p-3 space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono text-slate-400 w-5">{i + 1}.</span>
              <input type="text" value={point.pointName} onChange={e => updatePoint(point.id, { pointName: e.target.value })}
                placeholder="Point name (e.g. Upwind, Downwind, Tank Walkway)"
                className="flex-1 px-3 py-2 border border-slate-300 rounded-lg text-sm" />
              <button type="button" onClick={() => removePoint(point.id)} className="p-1 text-red-400 hover:text-red-600">
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
            <div className="grid grid-cols-3 gap-2 pl-7">
              <div>
                <label className="block text-xs text-slate-500 mb-0.5">O₂ %</label>
                <input type="number" step="0.1" value={point.o2Percent ?? ''} onChange={e => updatePoint(point.id, { o2Percent: e.target.value ? Number(e.target.value) : null })}
                  placeholder="20.9" className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm font-mono" />
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-0.5">VOC (ppm)</label>
                <input type="number" step="0.1" value={point.vocPpm ?? ''} onChange={e => updatePoint(point.id, { vocPpm: e.target.value ? Number(e.target.value) : null })}
                  placeholder="0.0" className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm font-mono" />
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-0.5">Notes</label>
                <input type="text" value={point.notes} onChange={e => updatePoint(point.id, { notes: e.target.value })}
                  placeholder="Optional" className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm" />
              </div>
            </div>
          </div>
        ))}

        <button type="button" onClick={addPoint}
          className="w-full py-2.5 border border-dashed border-slate-300 rounded-lg text-sm text-slate-500 hover:border-blue-400 hover:text-blue-600 transition-colors flex items-center justify-center gap-1">
          <Plus className="w-4 h-4" /> Add Sample Point
        </button>
      </div>
    </div>
  )
}

// ============================================================
// Sampling Section
// ============================================================

function SamplingSection({ record, onUpdate }: { record: IhTestDraftRecord; onUpdate: (patch: Partial<IhTestDraftRecord>) => void }) {
  // Normalize: a record may arrive with a different subtype's testData shape
  // (e.g. the subtype was switched after a record existed) — never assume samples exists.
  const samples = (record.testData as SamplingTestData)?.samples ?? []

  function updateData(patch: Partial<SamplingTestData>) {
    onUpdate({ testData: { samples, ...patch } })
  }

  function addSample() {
    updateData({
      samples: [...samples, {
        id: uuidv4(), sampleType: '', collectionPoint: '', labId: '', deliveryDate: '', notes: '',
      }],
    })
  }

  function updateSample(id: string, patch: Partial<SamplingTestData['samples'][0]>) {
    updateData({ samples: samples.map(s => s.id === id ? { ...s, ...patch } : s) })
  }

  function removeSample(id: string) {
    updateData({ samples: samples.filter(s => s.id !== id) })
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="text-sm font-medium text-slate-700">Samples Collected</label>
        <span className="text-xs text-slate-400">{samples.length} sample{samples.length !== 1 ? 's' : ''}</span>
      </div>

      {samples.map((sample, i) => (
        <div key={sample.id} className="bg-slate-50 rounded-lg p-3 space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-mono text-slate-400 w-5">{i + 1}.</span>
            <select value={sample.sampleType} onChange={e => updateSample(sample.id, { sampleType: e.target.value })}
              className="flex-1 px-3 py-2 border border-slate-300 rounded-lg text-sm">
              <option value="">Sample type...</option>
              {SAMPLE_TYPE_PRESETS.map(t => <option key={t} value={t}>{t}</option>)}
              <option value="__custom">Other...</option>
            </select>
            <button type="button" onClick={() => removeSample(sample.id)} className="p-1 text-red-400 hover:text-red-600">
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
          {sample.sampleType === '__custom' && (
            <div className="pl-7">
              <input type="text" value="" onChange={e => updateSample(sample.id, { sampleType: e.target.value })}
                placeholder="Enter sample type..." autoFocus
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm" />
            </div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pl-7">
            <div>
              <label className="block text-xs text-slate-500 mb-0.5">Collection Point</label>
              <input type="text" value={sample.collectionPoint} onChange={e => updateSample(sample.id, { collectionPoint: e.target.value })}
                placeholder="Where collected" className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm" />
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-0.5">Lab / CoC ID</label>
              <input type="text" value={sample.labId} onChange={e => updateSample(sample.id, { labId: e.target.value })}
                placeholder="LAB-2026-001" className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm font-mono" />
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-0.5">Delivery Date</label>
              <input type="date" value={sample.deliveryDate} onChange={e => updateSample(sample.id, { deliveryDate: e.target.value })}
                className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm" />
            </div>
          </div>
          <div className="pl-7">
            <input type="text" value={sample.notes} onChange={e => updateSample(sample.id, { notes: e.target.value })}
              placeholder="Notes (optional)" className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm" />
          </div>
        </div>
      ))}

      <button type="button" onClick={addSample}
        className="w-full py-2.5 border border-dashed border-slate-300 rounded-lg text-sm text-slate-500 hover:border-blue-400 hover:text-blue-600 transition-colors flex items-center justify-center gap-1">
        <Plus className="w-4 h-4" /> Add Sample
      </button>
    </div>
  )
}

// ============================================================
// Audiometric Section
// ============================================================

function AudiometricSection({
  record,
  onUpdate,
  defaultEmployer,
}: { record: IhTestDraftRecord; onUpdate: (patch: Partial<IhTestDraftRecord>) => void; defaultEmployer?: string }) {
  const data = record.testData as AudiometricTestData

  function updateData(patch: Partial<AudiometricTestData>) {
    onUpdate({ testData: { ...data, ...patch } })
  }

  function addPerson() {
    updateData({
      personnel: [...data.personnel, {
        id: uuidv4(), employeeName: '', employeeId: '', employerName: defaultEmployer || '',
        tested: true, result: 'na', notes: '',
      }],
    })
  }

  function updatePerson(id: string, patch: Partial<AudiometricTestData['personnel'][0]>) {
    updateData({ personnel: data.personnel.map(p => p.id === id ? { ...p, ...patch } : p) })
  }

  function removePerson(id: string) {
    updateData({ personnel: data.personnel.filter(p => p.id !== id) })
  }

  const RESULT_OPTIONS = [
    { value: 'pass' as const, label: 'Pass', icon: CheckCircle, color: 'bg-green-100 text-green-700 border-green-300' },
    { value: 'fail' as const, label: 'Fail', icon: XCircle, color: 'bg-red-100 text-red-700 border-red-300' },
    { value: 'referred' as const, label: 'Referred', icon: AlertTriangle, color: 'bg-amber-100 text-amber-700 border-amber-300' },
    { value: 'na' as const, label: 'N/A', icon: null, color: 'bg-slate-200 text-slate-600 border-slate-300' },
  ]

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="text-sm font-medium text-slate-700">Personnel Tested</label>
        <span className="text-xs text-slate-400">{data.personnel.length} person{data.personnel.length !== 1 ? 'nel' : ''}</span>
      </div>

      {data.personnel.map((person, i) => (
        <div key={person.id} className="bg-slate-50 rounded-lg p-3 space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-mono text-slate-400 w-5">{i + 1}.</span>
            <input type="text" value={person.employeeName} onChange={e => updatePerson(person.id, { employeeName: e.target.value })}
              placeholder="Full name" className="flex-1 px-3 py-2 border border-slate-300 rounded-lg text-sm" />
            <button type="button" onClick={() => removePerson(person.id)} className="p-1 text-red-400 hover:text-red-600">
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2 pl-7">
            <div>
              <label className="block text-xs text-slate-500 mb-0.5">Employee ID</label>
              <input type="text" value={person.employeeId} onChange={e => updatePerson(person.id, { employeeId: e.target.value })}
                placeholder="ID #" className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm" />
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-0.5">Employer</label>
              <input type="text" value={person.employerName} onChange={e => updatePerson(person.id, { employerName: e.target.value })}
                placeholder="Employer" className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm" />
            </div>
          </div>
          <div className="pl-7">
            <label className="block text-xs text-slate-500 mb-1">Result</label>
            <div className="flex gap-1">
              {RESULT_OPTIONS.map(opt => (
                <button key={opt.value} type="button" onClick={() => updatePerson(person.id, { result: opt.value })}
                  className={cn('flex-1 py-1.5 rounded text-xs font-medium transition-colors border',
                    person.result === opt.value ? opt.color : 'bg-white text-slate-400 border-slate-200 hover:border-slate-300',
                  )}>
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
          <div className="pl-7">
            <input type="text" value={person.notes} onChange={e => updatePerson(person.id, { notes: e.target.value })}
              placeholder="Notes (optional)" className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm" />
          </div>
        </div>
      ))}

      <button type="button" onClick={addPerson}
        className="w-full py-2.5 border border-dashed border-slate-300 rounded-lg text-sm text-slate-500 hover:border-blue-400 hover:text-blue-600 transition-colors flex items-center justify-center gap-1">
        <UserPlus className="w-4 h-4" /> Add Person
      </button>
    </div>
  )
}
