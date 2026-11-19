import { useState } from 'react'
import { api } from '@/lib/api'
import { ScbaAssemblyFields, type ScbaAssemblyDraft } from './ScbaAssemblyFields'

export function ScbaAssemblyEditor({ equipmentId, initial, canEdit, onSaved }: {
  equipmentId: string; initial: ScbaAssemblyDraft; canEdit: boolean; onSaved: () => void
}) {
  const [draft, setDraft] = useState(initial)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  async function save() {
    setSaving(true); setError('')
    try { await api.put(`/equipment/${equipmentId}/scba`, draft); setEditing(false); onSaved() }
    catch (err: any) { setError(err.message || 'Failed to save SCBA assembly') }
    finally { setSaving(false) }
  }
  return <section className="p-4 bg-white border border-slate-200 rounded-xl space-y-3">
    <div className="flex justify-between items-center">
      <h2 className="font-semibold text-slate-900">SCBA Assembly — {initial.durationMinutes} min</h2>
      {canEdit && !editing && <button onClick={() => { setDraft(initial); setEditing(true) }} className="text-sm text-blue-600">Edit</button>}
    </div>
    <ScbaAssemblyFields value={editing ? draft : initial} onChange={setDraft} disabled={!editing || saving} />
    {error && <p className="text-sm text-red-600">{error}</p>}
    {editing && <div className="flex justify-end gap-3">
      <button disabled={saving} onClick={() => setEditing(false)} className="text-sm text-slate-600">Cancel</button>
      <button disabled={saving || !draft.caseId.trim()} onClick={save} className="px-3 py-2 bg-blue-600 text-white rounded-lg text-sm disabled:opacity-50">{saving ? 'Saving...' : 'Save Assembly'}</button>
    </div>}
  </section>
}
