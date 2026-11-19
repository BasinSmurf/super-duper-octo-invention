import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { cn } from '@/lib/cn'
import { verificationCurrent } from './WorkPointVerification'
import { Wind, Plus, X, Pencil } from 'lucide-react'

export interface LocationWorkPointInfo {
  id: string
  name: string
  workPointType?: string
  type?: string
  isActive: boolean
  customData: any
  verified?: boolean
  dateVerified?: string | null
  reelSerialNumber?: string | null
  standSerialNumber?: string | null
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
  const [reelSerial, setReelSerial] = useState('')
  const [standSerial, setStandSerial] = useState('')
  const [editing, setEditing] = useState<LocationWorkPointInfo | null>(null)
  const [cylinders, setCylinders] = useState<any[]>([])
  const [expiryDays, setExpiryDays] = useState<number | null>(null)
  useEffect(() => {
    api.get<{ expiryDays: number }>('/locations/work-point-verification-settings').then(data => setExpiryDays(data.expiryDays)).catch(() => {})
  }, [])

  function open(point: LocationWorkPointInfo | null) {
    setEditing(point)
    setName(point?.name || '')
    setType(point?.workPointType || point?.type || 'air_system_location')
    setSerials('')
    setNotes(point?.customData?.notes || '')
    setReelSerial(point?.reelSerialNumber || '')
    setStandSerial(point?.standSerialNumber || '')
    setCylinders((point?.customData?.cylinders || point?.customData?.bottles || []).map((c: any) => ({ ...c })))
    setAdding(true)
  }

  async function save() {
    const trimmed = name.trim()
    if (!trimmed) return
    setSaving(true)
    try {
      const addedCylinders = serials
        .split(/\r?\n|,/)
        .map(s => s.trim())
        .filter(Boolean)
        .map(serialNumber => ({ serialNumber, isActive: true }))
      const payload = {
        name: trimmed,
        workPointType: type,
        reelSerialNumber: reelSerial.trim() || null,
        standSerialNumber: standSerial.trim() || null,
        ...(!editing ? { padId: padId || undefined, wellId: wellId || undefined, isActive: true } : {}),
        customData: {
          ...(editing?.customData || {}),
          cylinders: [...cylinders, ...addedCylinders],
          ...(editing?.customData?.bottles ? { bottles: [...cylinders, ...addedCylinders] } : {}),
          notes: notes.trim(),
          source: editing?.customData?.source || 'manual',
        },
      }
      if (editing) await api.put(`/locations/work-points/${editing.id}`, payload)
      else await api.post('/locations/work-points', payload)
      setAdding(false)
      setName('')
      setType('air_system_location')
      setSerials('')
      setNotes('')
      onChanged()
    } catch (err: any) {
      alert(err?.message || 'Failed to save work point')
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
            onClick={() => open(null)}
            className="text-xs text-blue-600 hover:text-blue-800 flex items-center gap-1"
          >
            <Plus className="w-3.5 h-3.5" /> Add
          </button>
        )}
      </div>

      {adding && canManage && (
        <fieldset disabled={saving} className="px-4 py-3 border-b border-gray-100 bg-blue-50/40 space-y-3">
          <p className="text-sm font-medium">{editing ? 'Edit Work Point' : 'Add Work Point'}</p>
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
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs text-gray-600">Reel serial
              <input value={reelSerial} onChange={e => setReelSerial(e.target.value)} className="w-full border rounded-lg px-3 py-2 text-sm" />
            </label>
            <label className="text-xs text-gray-600">Stand serial
              <input value={standSerial} onChange={e => setStandSerial(e.target.value)} className="w-full border rounded-lg px-3 py-2 text-sm" />
            </label>
          </div>
          {cylinders.map((c, i) => <div key={i} className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
            <label className="text-xs text-gray-600">Cylinder serial
              <input aria-label={`Cylinder ${i + 1} serial`} value={c.serialNumber || ''} onChange={e => setCylinders(cylinders.map((item, index) => index === i ? { ...item, serialNumber: e.target.value } : item))} className="w-full border rounded-lg px-3 py-2 text-sm" />
            </label>
            <label className="text-xs text-gray-600">Hydro date
              <input aria-label={`Cylinder ${i + 1} hydro date`} type="date" value={c.hydroDate?.slice(0, 10) || ''} onChange={e => setCylinders(cylinders.map((item, index) => index === i ? { ...item, hydroDate: e.target.value || null } : item))} className="w-full border rounded-lg px-3 py-2 text-sm" />
            </label>
            <button type="button" aria-label={`Remove cylinder ${i + 1}`} onClick={() => setCylinders(cylinders.filter((_, index) => index !== i))} className="p-2 text-red-600"><X className="w-4 h-4" /></button>
          </div>)}
          <button type="button" onClick={() => setCylinders([...cylinders, { serialNumber: '', hydroDate: null, isActive: true }])} className="text-xs text-blue-600">+ Add cylinder with hydro date</button>
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
        </fieldset>
      )}

      <div className="divide-y divide-gray-100">
        {workPoints.length === 0 ? (
          <p className="px-4 py-6 text-sm text-gray-400 text-center italic">No work points on this location.</p>
        ) : (
          workPoints.map(wp => {
            const cd = wp.customData as any
            const cylinders = cd?.cylinders || cd?.bottles || []
            const label = WORK_POINT_TYPES.find(t => t.value === (wp.workPointType || wp.type))?.label || wp.workPointType || wp.type
            return (
              <div key={wp.id} className="px-4 py-3">
                <div className="flex items-start gap-2">
                  <Wind className="w-4 h-4 text-blue-500 flex-shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={cn('text-sm font-medium text-gray-800', expiryDays !== null && verificationCurrent(wp.verified, wp.dateVerified, expiryDays) && 'border-2 border-green-500 rounded px-2')}>{wp.name}</span>
                      <span className="text-xs text-gray-400">{label}</span>
                    </div>
                    {cd?.notes && <p className="text-xs text-gray-500 mt-0.5">{cd.notes}</p>}
                  </div>
                  {canManage && (
                    <button type="button" onClick={() => open(wp)} disabled={saving} className="p-1 text-gray-400 hover:text-blue-600" title="Edit work point" aria-label={`Edit ${wp.name}`}><Pencil className="w-4 h-4" /></button>
                  )}
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
