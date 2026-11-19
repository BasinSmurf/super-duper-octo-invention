import { useState } from 'react'
import { Hash } from 'lucide-react'

/** One-line view/edit for a location billing code (e.g. the buyer's Cost Object). Saves null when cleared. */
export function InlineCodeField({ label, value, placeholder, canEdit, onSave }: {
  label: string
  value: string | null
  placeholder: string
  canEdit: boolean
  onSave: (value: string | null) => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)

  const save = async () => {
    setSaving(true)
    try {
      await onSave(draft.trim() || null)
      setEditing(false)
    } catch (e: any) {
      alert(e.message || `Failed to update ${label.toLowerCase()}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex items-center gap-2 pt-1">
      <Hash className="w-4 h-4 text-gray-400 flex-shrink-0" />
      {editing ? (
        <>
          <input
            type="text"
            value={draft}
            onChange={e => setDraft(e.target.value)}
            placeholder={placeholder}
            autoFocus
            className="flex-1 border border-gray-300 rounded px-2 py-1 text-sm focus:ring-1 focus:ring-blue-500"
            onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false) }}
          />
          <button onClick={save} disabled={saving} className="text-xs text-blue-600 hover:underline disabled:opacity-50">Save</button>
          <button onClick={() => setEditing(false)} className="text-xs text-gray-400 hover:text-gray-600">Cancel</button>
        </>
      ) : (
        <>
          <span className="text-gray-500">{label}:</span>
          <span className="text-gray-700">{value || <span className="text-gray-400 italic">none</span>}</span>
          {canEdit && (
            <button
              onClick={() => { setDraft(value || ''); setEditing(true) }}
              className="text-xs text-blue-600 hover:underline ml-1"
            >
              {value ? 'Edit' : 'Add'}
            </button>
          )}
        </>
      )}
    </div>
  )
}
