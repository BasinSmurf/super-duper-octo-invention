import { useState } from 'react'
import { api } from '@/lib/api'
import { cn } from '@/lib/cn'
import { Wind, Plus, X } from 'lucide-react'

export interface LocationWorkPointInfo {
  id: string
  name: string
  type: string
  isActive: boolean
  customData: any
}

interface Props {
  workPoints: LocationWorkPointInfo[]
  canManage: boolean
  padId?: string | null
  wellId?: string | null
  onChanged: () => void
}

const WORK_POINT_TYPES = [
  { value: 'air_system_location', label: 'Air System' },
  { value: 'testing_station', label: 'Testing Station' },
  { value: 'monitor_point', label: 'Monitor Point' },
  { value: 'tank', label: 'Tank' },
  { value: 'general', label: 'General' },
]

export function LocationWorkPointEditor({ workPoints, canManage, padId, wellId, onChanged }: Props) {
  const [adding, setAdding] = useState(false)
  const [saving, setSaving] = useState(false)
  const [name, setName] = useState('')
  const [type, setType] = useState('air_system_location')
  const [serials, setSerials] = useState('')
  const [notes, setNotes] = useState('')

  async function save() {
    const trimmed = name.trim()
    if (!trimmed) return
    setSaving(true)
    try {
      const cylinders = serials
        .split(/\r?\n|,/)
        .map(s => s.trim())
        .filter(Boolean)
        .map(serialNumber => ({ serialNumber, isActive: true }))
      await api.post('/locations/work-points', {
        name: trimmed,
        type,
        padId: padId || undefined,
        wellId: wellId || undefined,
        isActive: true,
        customData: {
          ...(cylinders.length ? { cylinders } : {}),
          ...(notes.trim() ? { notes: notes.trim() } : {}),
          source: 'manual',
        },
      })
      setAdding(false)
      setName('')
      setType('air_system_location')
      setSerials('')
      setNotes('')
      onChanged()
    } catch (err: any) {
      alert(err?.message || 'Failed to add work point')
    } finally {
      setSaving(false)
    }
  }

  async function deactivate(id: string) {
    if (!window.confirm('Deactivate this work point?')) return
    setSaving(true)
    try {
      await api.put(`/locations/work-points/${id}`, { isActive: false })
      onChanged()
    } catch (err: any) {
      alert(err?.message || 'Failed to deactivate work point')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
      <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
          <Wind className="w-4 h-4" /> Work Points
          <span className="text-xs text-gray-400 font-normal">({workPoints.length})</span>
        </h2>
        {canManage && !adding && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="text-xs text-blue-600 hover:text-blue-800 flex items-center gap-1"
          >
            <Plus className="w-3.5 h-3.5" /> Add
          </button>
        )}
      </div>

      {adding && (
        <div className="px-4 py-3 border-b border-gray-100 bg-blue-50/40 space-y-3">
          <div className="grid gap-2 sm:grid-cols-[1fr_11rem]">
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Work point name"
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
              autoFocus
            />
            <select
              value={type}
              onChange={e => setType(e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
            >
              {WORK_POINT_TYPES.map(t => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </div>
          <textarea
            value={serials}
            onChange={e => setSerials(e.target.value)}
            placeholder="Cylinder serials, one per line"
            rows={3}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
          />
          <input
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="Notes"
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setAdding(false)}
              className="px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-100 rounded-lg"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={!name.trim() || saving}
              className="px-3 py-1.5 text-xs font-medium bg-blue-700 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50"
            >
              Save Work Point
            </button>
          </div>
        </div>
      )}

      <div className="divide-y divide-gray-100">
        {workPoints.length === 0 ? (
          <p className="px-4 py-6 text-sm text-gray-400 text-center italic">No work points on this location.</p>
        ) : (
          workPoints.map(wp => {
            const cd = wp.customData as any
            const cylinders = cd?.cylinders || cd?.bottles || []
            const label = WORK_POINT_TYPES.find(t => t.value === wp.type)?.label || wp.type
            return (
              <div key={wp.id} className="px-4 py-3">
                <div className="flex items-start gap-2">
                  <Wind className="w-4 h-4 text-blue-500 flex-shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-gray-800">{wp.name}</span>
                      <span className="text-xs text-gray-400">{label}</span>
                    </div>
                    {cd?.notes && <p className="text-xs text-gray-500 mt-0.5">{cd.notes}</p>}
                  </div>
                  {canManage && (
                    <button
                      type="button"
                      onClick={() => deactivate(wp.id)}
                      disabled={saving}
                      className={cn('p-1 text-gray-400 hover:text-red-600', saving && 'opacity-50')}
                      title="Deactivate work point"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </div>
                {cylinders.length > 0 && (
                  <div className="ml-6 mt-1 flex flex-wrap gap-1.5">
                    {cylinders.map((c: any, i: number) => (
                      <span key={i} className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">
                        {c.serialNumber || 'No S/N'}
                        {c.hydroDate && <span className="text-gray-400 ml-1">hydro {new Date(c.hydroDate).getFullYear()}</span>}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
