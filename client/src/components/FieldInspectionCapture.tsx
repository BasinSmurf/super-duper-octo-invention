import { useState } from 'react'
import { EquipmentInspectionEditor, type EquipmentInspectionCategory } from './EquipmentInspectionEditor'
import type { OfflineEquipmentInspection } from '@/lib/db-types'
import { cn } from '@/lib/cn'
import { ClipboardCheck, Plus, Trash2, AlertTriangle } from 'lucide-react'

// Field inspection capture for the ticket wizard (ShopWork Wave 4). Collects one
// EquipmentInspection per unit into wizard state via the shared editor in
// capture-only mode (the ticket doesn't exist yet — the wizard persists these at
// submit). PASS units bill visual-only + write a BlueLion record; FAIL units
// spawn a Shop WO (handled by the wizard at submit, not here).

const CATEGORY_OPTIONS: { value: EquipmentInspectionCategory; label: string }[] = [
  { value: 'fire_extinguisher', label: 'Fire Extinguisher' },
  { value: 'gas_detection', label: 'Gas Detection' },
  { value: 'scba', label: 'SCBA' },
  { value: 'fall_arrest', label: 'Fall Arrest' },
  { value: 'ue_cylinder', label: 'UE Cylinder' },
  { value: 'breathing_air_system', label: 'Breathing Air System' },
  { value: 'first_aid_kit', label: 'First Aid Kit' },
  { value: 'other', label: 'Other' },
]

const OUTCOME_TONE: Record<string, string> = {
  pass: 'bg-emerald-100 text-emerald-700',
  fail: 'bg-red-100 text-red-700',
  requires_parts: 'bg-amber-100 text-amber-700',
  cannot_service: 'bg-red-100 text-red-700',
  condemn: 'bg-red-200 text-red-900',
}

export function FieldInspectionCapture(props: {
  records: OfflineEquipmentInspection[]
  onChange: (records: OfflineEquipmentInspection[]) => void
  ticketId: string
}) {
  const [category, setCategory] = useState<EquipmentInspectionCategory>('fire_extinguisher')
  const [serial, setSerial] = useState('')
  const [pending, setPending] = useState<{ serial: string; category: EquipmentInspectionCategory } | null>(null)

  function startInspect() {
    if (!serial.trim()) return
    setPending({ serial: serial.trim(), category })
  }
  function handleSaved(rec: OfflineEquipmentInspection) {
    props.onChange([...props.records.filter(r => r.id !== rec.id), rec])
    setSerial('')
  }

  const failCount = props.records.filter(r => r.outcome !== 'pass').length

  return (
    <div className="bg-white rounded-lg border border-slate-200 p-4 space-y-3">
      <h3 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
        <ClipboardCheck className="w-4 h-4" /> Equipment Inspections
      </h3>
      <p className="text-xs text-slate-500">
        Inspect each unit on site. Units that <strong>pass</strong> bill as a visual-only
        inspection and write a BlueLion record. Units that <strong>fail</strong> are sent to
        the shop — a Shop Work Order is created on submit (the shop re-inspects as the
        authority); failed units are not billed in the field.
      </p>

      {props.records.length > 0 && (
        <div className="space-y-1.5">
          {props.records.map(r => (
            <div key={r.id} className="flex items-center justify-between gap-2 rounded border border-slate-200 px-2 py-1.5">
              <div className="min-w-0">
                <span className="font-mono text-sm text-slate-800">{r.serialNumber}</span>
                <span className="ml-2 text-xs text-slate-500">
                  {CATEGORY_OPTIONS.find(c => c.value === r.category)?.label ?? r.category}
                </span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className={cn('text-[10px] font-bold uppercase px-2 py-0.5 rounded-full', OUTCOME_TONE[r.outcome] ?? 'bg-slate-100 text-slate-600')}>
                  {r.outcome.replace(/_/g, ' ')}
                </span>
                <button type="button" onClick={() => props.onChange(props.records.filter(x => x.id !== r.id))} className="text-slate-400 hover:text-red-600">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {failCount > 0 && (
        <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1 flex items-start gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          {failCount} failed unit{failCount === 1 ? '' : 's'} will spawn a Shop Work Order on submit.
        </p>
      )}

      <div className="flex items-end gap-2">
        <div className="flex-1">
          <label className="block text-xs text-slate-500 mb-1">Category</label>
          <select
            value={category}
            onChange={e => setCategory(e.target.value as EquipmentInspectionCategory)}
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white"
          >
            {CATEGORY_OPTIONS.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        </div>
        <div className="flex-1">
          <label className="block text-xs text-slate-500 mb-1">Serial #</label>
          <input
            value={serial}
            onChange={e => setSerial(e.target.value)}
            placeholder="Serial number"
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
          />
        </div>
        <button
          type="button"
          onClick={startInspect}
          disabled={!serial.trim()}
          className="flex items-center gap-1.5 px-4 py-2 bg-blue-700 text-white rounded-lg text-sm font-medium hover:bg-blue-600 disabled:opacity-40"
        >
          <Plus className="w-4 h-4" /> Inspect
        </button>
      </div>

      {pending && (
        <EquipmentInspectionEditor
          ticketId={props.ticketId}
          serialNumber={pending.serial}
          category={pending.category}
          captureOnly
          onSaved={handleSaved}
          onClose={() => setPending(null)}
        />
      )}
    </div>
  )
}
