import { useState } from 'react'
import { PhotoCapture, type CapturedPhoto } from './PhotoCapture'
import { CheckCircle2, AlertTriangle, XCircle, X } from 'lucide-react'

export interface InspectionData {
  overallCondition: 'good' | 'minor_damage' | 'major_damage' | 'needs_repair'
  physicalDamage: boolean
  physicalDamageNotes: string
  cleanlinessOk: boolean
  calibrationCurrent: boolean
  accessoriesReturned: boolean
  accessoriesNotes: string
  notes: string
  damagePhotos: CapturedPhoto[]
}

interface RentalInspectionEditorProps {
  equipmentName: string
  serialNumber: string
  submitLabel?: string
  headerNote?: string
  saving?: boolean
  error?: string
  onComplete: (data: InspectionData) => void
  onCancel: () => void
}

const CONDITION_OPTIONS: Array<{
  value: InspectionData['overallCondition']
  label: string
  icon: typeof CheckCircle2
  color: string
}> = [
  { value: 'good', label: 'Good', icon: CheckCircle2, color: 'text-green-500' },
  { value: 'minor_damage', label: 'Minor Damage', icon: AlertTriangle, color: 'text-amber-500' },
  { value: 'major_damage', label: 'Major Damage', icon: XCircle, color: 'text-red-500' },
  { value: 'needs_repair', label: 'Needs Repair', icon: XCircle, color: 'text-red-600' },
]

export function RentalInspectionEditor({ equipmentName, serialNumber, headerNote, submitLabel = 'Complete Return', saving, error, onComplete, onCancel }: RentalInspectionEditorProps) {
  const [data, setData] = useState<InspectionData>({
    overallCondition: 'good',
    physicalDamage: false,
    physicalDamageNotes: '',
    cleanlinessOk: true,
    calibrationCurrent: true,
    accessoriesReturned: true,
    accessoriesNotes: '',
    notes: '',
    damagePhotos: [],
  })
  const [showPhotos, setShowPhotos] = useState(false)

  function update(patch: Partial<InspectionData>) {
    setData(prev => ({ ...prev, ...patch }))
  }

  function handleSubmit() {
    onComplete(data)
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center">
      <div className="bg-white w-full sm:max-w-lg sm:rounded-xl rounded-t-xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-slate-200 shrink-0">
          <div>
            <h3 className="font-semibold text-slate-900">
              Return Inspection
              {headerNote && <span className="ml-2 text-xs font-normal text-slate-400">({headerNote})</span>}
            </h3>
            <p className="text-xs text-slate-500">{equipmentName} — {serialNumber}</p>
          </div>
          <button disabled={saving} onClick={onCancel} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100">
            <X className="w-5 h-5 text-slate-400" />
          </button>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto p-4 space-y-5">
          {error && <p role="alert" className="rounded bg-red-50 p-3 text-sm text-red-700">{error}</p>}
          {/* Overall Condition */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">Overall Condition</label>
            <div className="grid grid-cols-2 gap-2">
              {CONDITION_OPTIONS.map(opt => {
                const Icon = opt.icon
                const isSelected = data.overallCondition === opt.value
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => update({ overallCondition: opt.value })}
                    className={`flex items-center gap-2 p-3 rounded-lg border-2 text-left transition-colors ${
                      isSelected ? 'border-blue-500 bg-blue-50' : 'border-slate-200 hover:bg-slate-50'
                    }`}
                  >
                    <Icon className={`w-5 h-5 ${isSelected ? opt.color : 'text-slate-400'}`} />
                    <span className={`text-sm font-medium ${isSelected ? 'text-slate-900' : 'text-slate-600'}`}>
                      {opt.label}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>

          {/* Checklist items */}
          <div className="space-y-3">
            <label className="block text-sm font-medium text-slate-700">Checklist</label>

            <label className="flex items-center gap-3 p-3 rounded-lg border border-slate-200">
              <input
                type="checkbox"
                checked={!data.physicalDamage}
                onChange={e => update({ physicalDamage: !e.target.checked })}
                className="w-5 h-5 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
              />
              <span className="text-sm text-slate-700">No physical damage</span>
            </label>

            {data.physicalDamage && (
              <textarea
                value={data.physicalDamageNotes}
                onChange={e => update({ physicalDamageNotes: e.target.value })}
                placeholder="Describe damage..."
                rows={2}
                className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none"
              />
            )}

            <label className="flex items-center gap-3 p-3 rounded-lg border border-slate-200">
              <input
                type="checkbox"
                checked={data.cleanlinessOk}
                onChange={e => update({ cleanlinessOk: e.target.checked })}
                className="w-5 h-5 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
              />
              <span className="text-sm text-slate-700">Clean / acceptable condition</span>
            </label>

            <label className="flex items-center gap-3 p-3 rounded-lg border border-slate-200">
              <input
                type="checkbox"
                checked={data.calibrationCurrent}
                onChange={e => update({ calibrationCurrent: e.target.checked })}
                className="w-5 h-5 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
              />
              <span className="text-sm text-slate-700">Calibration / bump test current</span>
            </label>

            <label className="flex items-center gap-3 p-3 rounded-lg border border-slate-200">
              <input
                type="checkbox"
                checked={data.accessoriesReturned}
                onChange={e => update({ accessoriesReturned: e.target.checked })}
                className="w-5 h-5 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
              />
              <span className="text-sm text-slate-700">All accessories returned</span>
            </label>

            {!data.accessoriesReturned && (
              <input
                type="text"
                value={data.accessoriesNotes}
                onChange={e => update({ accessoriesNotes: e.target.value })}
                placeholder="Missing accessories..."
                className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none"
              />
            )}
          </div>

          {/* Notes */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Additional Notes</label>
            <textarea
              value={data.notes}
              onChange={e => update({ notes: e.target.value })}
              placeholder="Any other observations..."
              rows={2}
              className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none"
            />
          </div>

          {/* Damage Photos */}
          {(data.physicalDamage || data.overallCondition !== 'good') && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">Damage Photos</label>
              {data.damagePhotos.length > 0 && (
                <div className="flex gap-2 flex-wrap mb-2">
                  {data.damagePhotos.map(photo => (
                    <div key={photo.id} className="w-16 h-16 rounded-lg overflow-hidden border border-slate-200">
                      <img src={photo.dataUrl} alt="Damage" className="w-full h-full object-cover" />
                    </div>
                  ))}
                </div>
              )}
              <button
                type="button"
                onClick={() => setShowPhotos(true)}
                className="text-sm text-blue-600 font-medium"
              >
                + Add Photo
              </button>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-slate-200 shrink-0 flex gap-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="flex-1 py-3 rounded-lg border border-slate-200 text-slate-700 font-medium"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={saving}
            className="flex-1 py-3 rounded-lg bg-blue-600 text-white font-medium"
          >
            {saving ? 'Saving…' : submitLabel}
          </button>
        </div>
      </div>

      {/* Photo capture — inline below the modal when active */}
      {showPhotos && (
        <div className="fixed inset-0 z-[60] bg-white p-4">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-medium text-slate-900">Damage Photos</h3>
            <button onClick={() => setShowPhotos(false)} className="text-sm text-blue-600 font-medium">Done</button>
          </div>
          <PhotoCapture
            photos={data.damagePhotos}
            onChange={photos => update({ damagePhotos: photos })}
          />
        </div>
      )}
    </div>
  )
}
