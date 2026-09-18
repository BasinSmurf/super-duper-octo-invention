import { v4 as uuidv4 } from 'uuid'
import { cn } from '@/lib/cn'
import type { GasDetectionDraftRecord, GasDetectionSubtype } from '@/lib/db-types'
import { Plus, Trash2, Activity, Gauge, Wrench, Settings } from 'lucide-react'

// ============================================================
// Subtype config
// ============================================================

interface SubtypeConfig {
  value: GasDetectionSubtype
  label: string
  icon: typeof Activity
  /** Render extra fields beneath the subtype picker for this option. */
  needsResult: boolean       // pass/fail
  needsSensor: boolean       // which sensor was swapped
  needsWorkText: boolean     // free-text work description
}

export const GAS_DETECTION_SUBTYPES: SubtypeConfig[] = [
  { value: 'bump',                label: 'Bump',         icon: Activity, needsResult: true,  needsSensor: false, needsWorkText: false },
  { value: 'calibration',         label: 'Calibration',  icon: Gauge,    needsResult: true,  needsSensor: false, needsWorkText: false },
  { value: 'sensor_replacement',  label: 'Sensor Replace', icon: Settings, needsResult: false, needsSensor: true,  needsWorkText: false },
  { value: 'other_repair',        label: 'Other Repair', icon: Wrench,   needsResult: false, needsSensor: false, needsWorkText: true },
]

// Common sensor types — tech can also type freely.
const SENSOR_PRESETS = ['O₂', 'H₂S', 'CO', 'LEL', 'VOC', 'Multi']

// ============================================================
// Factory
// ============================================================

export function createBlankGasDetectionRecord(): GasDetectionDraftRecord {
  return {
    id: uuidv4(),
    monitorMake: '',
    monitorModel: '',
    monitorSerial: '',
    subtype: 'bump',
    testResult: null,
    sensorReplaced: '',
    workPerformed: '',
    notes: '',
  }
}

// ============================================================
// Editor
// ============================================================

interface GasDetectionEditorProps {
  records: GasDetectionDraftRecord[]
  onChange: (records: GasDetectionDraftRecord[]) => void
}

export function GasDetectionEditor({ records, onChange }: GasDetectionEditorProps) {
  function update(id: string, patch: Partial<GasDetectionDraftRecord>) {
    onChange(records.map(r => (r.id === id ? { ...r, ...patch } : r)))
  }

  function remove(id: string) {
    onChange(records.filter(r => r.id !== id))
  }

  function add() {
    onChange([...records, createBlankGasDetectionRecord()])
  }

  return (
    <div className="space-y-3">
      {records.length === 0 && (
        <div className="text-center py-8 text-slate-400 text-sm border-2 border-dashed border-slate-200 rounded-lg">
          No monitors added yet. Tap below to add one.
        </div>
      )}

      {records.map((rec, idx) => {
        const cfg = GAS_DETECTION_SUBTYPES.find(s => s.value === rec.subtype)!
        return (
          <div key={rec.id} className="bg-white border border-slate-200 rounded-lg p-3 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-slate-700">Monitor {idx + 1}</span>
              <button
                type="button"
                onClick={() => remove(rec.id)}
                className="text-slate-400 hover:text-red-600 p-1"
                aria-label="Remove monitor"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>

            {/* Make / Model / Serial */}
            <div className="grid grid-cols-2 gap-2">
              <input
                type="text"
                value={rec.monitorMake}
                onChange={e => update(rec.id, { monitorMake: e.target.value })}
                placeholder="Make"
                className="px-3 py-2 border border-slate-300 rounded-md text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
              />
              <input
                type="text"
                value={rec.monitorModel}
                onChange={e => update(rec.id, { monitorModel: e.target.value })}
                placeholder="Model"
                className="px-3 py-2 border border-slate-300 rounded-md text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
              />
            </div>
            <input
              type="text"
              value={rec.monitorSerial}
              onChange={e => update(rec.id, { monitorSerial: e.target.value })}
              placeholder="Serial number *"
              className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
            />

            {/* Subtype picker (card-style buttons) */}
            <div className="grid grid-cols-4 gap-1.5">
              {GAS_DETECTION_SUBTYPES.map(s => {
                const Icon = s.icon
                const active = rec.subtype === s.value
                return (
                  <button
                    key={s.value}
                    type="button"
                    onClick={() => update(rec.id, { subtype: s.value })}
                    className={cn(
                      'flex flex-col items-center gap-1 p-2 rounded-md border-2 text-xs font-medium transition-colors',
                      active
                        ? 'border-blue-500 bg-blue-50 text-blue-800'
                        : 'border-slate-200 text-slate-600 hover:border-slate-300',
                    )}
                  >
                    <Icon className="w-4 h-4" />
                    {s.label}
                  </button>
                )
              })}
            </div>

            {/* Conditional fields per subtype */}
            {cfg.needsResult && (
              <div className="grid grid-cols-2 gap-2">
                {(['pass', 'fail'] as const).map(r => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => update(rec.id, { testResult: r })}
                    className={cn(
                      'p-2 rounded-md border-2 text-sm font-medium transition-colors',
                      rec.testResult === r
                        ? r === 'pass'
                          ? 'border-green-500 bg-green-50 text-green-800'
                          : 'border-red-500 bg-red-50 text-red-800'
                        : 'border-slate-200 text-slate-600 hover:border-slate-300',
                    )}
                  >
                    {r.toUpperCase()}
                  </button>
                ))}
              </div>
            )}

            {cfg.needsSensor && (
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">Sensor replaced</label>
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {SENSOR_PRESETS.map(s => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => update(rec.id, { sensorReplaced: s })}
                      className={cn(
                        'px-2 py-1 rounded text-xs border transition-colors',
                        rec.sensorReplaced === s
                          ? 'border-blue-500 bg-blue-50 text-blue-800'
                          : 'border-slate-200 text-slate-600 hover:border-slate-300',
                      )}
                    >
                      {s}
                    </button>
                  ))}
                </div>
                <input
                  type="text"
                  value={rec.sensorReplaced}
                  onChange={e => update(rec.id, { sensorReplaced: e.target.value })}
                  placeholder="Or type custom sensor"
                  className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                />
              </div>
            )}

            {cfg.needsWorkText && (
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">Work performed *</label>
                <textarea
                  value={rec.workPerformed}
                  onChange={e => update(rec.id, { workPerformed: e.target.value })}
                  placeholder="Describe the repair / work done"
                  rows={2}
                  className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none resize-none"
                />
              </div>
            )}

            {/* Always-available notes */}
            <input
              type="text"
              value={rec.notes}
              onChange={e => update(rec.id, { notes: e.target.value })}
              placeholder="Notes (optional)"
              className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
            />
          </div>
        )
      })}

      <button
        type="button"
        onClick={add}
        className="w-full flex items-center justify-center gap-2 py-3 border-2 border-dashed border-slate-300 rounded-lg text-slate-600 hover:border-blue-400 hover:text-blue-700 transition-colors"
      >
        <Plus className="w-4 h-4" />
        Add Monitor
      </button>
    </div>
  )
}

// ============================================================
// Validation helper
// ============================================================

/** Returns true when the record is complete enough to bill (serial + valid subtype-specific data). */
export function isGasDetectionRecordComplete(rec: GasDetectionDraftRecord): boolean {
  if (!rec.monitorSerial.trim()) return false
  const cfg = GAS_DETECTION_SUBTYPES.find(s => s.value === rec.subtype)
  if (!cfg) return false
  if (cfg.needsResult && !rec.testResult) return false
  if (cfg.needsWorkText && !rec.workPerformed.trim()) return false
  return true
}
