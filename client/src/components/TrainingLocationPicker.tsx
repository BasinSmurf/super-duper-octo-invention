import { useState, useEffect, useRef } from 'react'
import { api } from '@/lib/api'
import { cn } from '@/lib/cn'
import { Search, Plus, X, Loader2 } from 'lucide-react'

export interface TrainingLocationOption {
  id: string
  name: string
  type: 'basin' | 'client' | 'other'
}

interface TrainingLocationPickerProps {
  value: TrainingLocationOption | null
  onChange: (loc: TrainingLocationOption | null) => void
}

const TYPE_LABEL: Record<TrainingLocationOption['type'], string> = {
  basin: 'Basin Safety',
  client: 'Client site',
  other: 'Other',
}

// Picker over the existing CpLocation address book (Basin/Client/Other),
// with inline creation — mirrors the "save as reusable location" pattern
// already in TrainingCalendarPage's session scheduler, but for the field
// ticket wizard's Training work type, which previously only had a plain
// free-text location field.
export function TrainingLocationPicker({ value, onChange }: TrainingLocationPickerProps) {
  const [all, setAll] = useState<TrainingLocationOption[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState(value?.name ?? '')
  const [open, setOpen] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [newType, setNewType] = useState<TrainingLocationOption['type']>('client')
  const [newAddress, setNewAddress] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    api.get<{ locations: Array<{ id: string; name: string; type: TrainingLocationOption['type']; isActive: boolean }> }>('/classpro/locations')
      .then(r => setAll(r.locations.filter(l => l.isActive).map(l => ({ id: l.id, name: l.name, type: l.type }))))
      .catch(() => setAll([]))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { setQuery(value?.name ?? '') }, [value])

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) { setOpen(false); setShowCreate(false) }
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  const filtered = query.trim()
    ? all.filter(l => l.name.toLowerCase().includes(query.trim().toLowerCase()))
    : all

  async function createNew() {
    const name = query.trim()
    if (!name) return
    setCreating(true)
    setError(null)
    try {
      const created = await api.post<{ id: string; name: string; type: TrainingLocationOption['type'] }>(
        '/classpro/locations',
        { name, type: newType, address: newAddress.trim() || undefined },
      )
      const opt: TrainingLocationOption = { id: created.id, name: created.name, type: created.type }
      setAll(a => [...a, opt])
      onChange(opt)
      setOpen(false)
      setShowCreate(false)
      setNewAddress('')
    } catch (e: any) {
      setError(e?.message || 'Failed to create location')
    } finally {
      setCreating(false)
    }
  }

  return (
    <div ref={boxRef} className="relative">
      <label className="block text-sm font-medium text-slate-700 mb-1">Training Location</label>

      {value ? (
        <div className="flex items-center gap-2 p-2.5 border border-emerald-200 bg-emerald-50 rounded-lg">
          <span className="flex-1 min-w-0 text-sm font-medium text-emerald-900 truncate">{value.name}</span>
          <span className="text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 shrink-0">
            {TYPE_LABEL[value.type]}
          </span>
          <button type="button" onClick={() => { onChange(null); setQuery('') }} className="text-emerald-600 hover:text-emerald-800 shrink-0">
            <X className="w-4 h-4" />
          </button>
        </div>
      ) : (
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            type="text"
            value={query}
            onChange={e => { setQuery(e.target.value); setOpen(true) }}
            onFocus={() => setOpen(true)}
            placeholder="Search training locations..."
            className="w-full pl-9 pr-3 py-2.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
          />
          {loading && <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 animate-spin text-slate-400" />}
        </div>
      )}

      {open && !value && (
        <div className="absolute z-20 mt-1 w-full bg-white border border-slate-200 rounded-lg shadow-lg max-h-72 overflow-y-auto">
          {filtered.map(l => (
            <button
              key={l.id}
              type="button"
              className="w-full text-left px-3 py-2 text-sm hover:bg-blue-50 flex items-center justify-between gap-2"
              onClick={() => { onChange(l); setOpen(false) }}
            >
              <span className="truncate">{l.name}</span>
              <span className="text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 shrink-0">
                {TYPE_LABEL[l.type]}
              </span>
            </button>
          ))}
          {filtered.length === 0 && !loading && (
            <div className="px-3 py-2 text-sm text-slate-400">No matches</div>
          )}

          {!showCreate ? (
            <button
              type="button"
              onClick={() => setShowCreate(true)}
              className={cn(
                'w-full text-left px-3 py-2 text-sm flex items-center gap-1.5 text-blue-600 hover:bg-blue-50 font-medium',
                filtered.length > 0 && 'border-t border-slate-100',
              )}
            >
              <Plus className="w-3.5 h-3.5" /> Can't find it? Add new
            </button>
          ) : (
            <div className="p-3 border-t border-slate-100 space-y-2 bg-slate-50">
              <p className="text-xs font-medium text-slate-600">New training location: "{query.trim() || '...'}"</p>
              <div className="flex gap-1.5">
                {(['basin', 'client', 'other'] as const).map(t => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setNewType(t)}
                    className={cn(
                      'flex-1 px-2 py-1.5 text-xs font-medium rounded border',
                      newType === t ? 'border-blue-500 bg-blue-50 text-blue-800' : 'border-slate-200 text-slate-600',
                    )}
                  >
                    {TYPE_LABEL[t]}
                  </button>
                ))}
              </div>
              <input
                type="text"
                value={newAddress}
                onChange={e => setNewAddress(e.target.value)}
                placeholder="Address (optional)"
                className="w-full px-2.5 py-1.5 text-sm border border-slate-300 rounded outline-none focus:ring-2 focus:ring-blue-500"
              />
              {error && <p className="text-xs text-red-600">{error}</p>}
              <button
                type="button"
                disabled={creating || !query.trim()}
                onClick={createNew}
                className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded"
              >
                {creating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                Create & select
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
