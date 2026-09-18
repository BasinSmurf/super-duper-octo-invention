import { useState, useEffect, useRef, useCallback } from 'react'
import { api } from '@/lib/api'
import { cn } from '@/lib/cn'
import { Search, Plus, X, Loader2 } from 'lucide-react'

export interface MobileAssetOption {
  id: string
  name: string
  kind: 'rig' | 'air_trailer'
}

interface MobileAssetPickerProps {
  kind: 'rig' | 'air_trailer'
  value: MobileAssetOption | null
  onChange: (asset: MobileAssetOption | null) => void
  placeholder?: string
}

const KIND_LABEL: Record<MobileAssetPickerProps['kind'], string> = {
  rig: 'rig',
  air_trailer: 'air trailer',
}

// Flat, operator-agnostic search over the thin MobileAsset list (rigs, air
// trailers) — same name shows up regardless of which customer/operator is
// selected elsewhere in the wizard, and adding a new one is a single tap.
export function MobileAssetPicker({ kind, value, onChange, placeholder }: MobileAssetPickerProps) {
  const [query, setQuery] = useState(value?.name ?? '')
  const [results, setResults] = useState<MobileAssetOption[]>([])
  const [open, setOpen] = useState(false)
  const [searching, setSearching] = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null)

  useEffect(() => { setQuery(value?.name ?? '') }, [value])

  const doSearch = useCallback(async (term: string) => {
    setSearching(true)
    setError(null)
    try {
      const res = await api.get<{ data: MobileAssetOption[] }>(
        `/mobile-assets?kind=${kind}&search=${encodeURIComponent(term)}`,
      )
      setResults(res.data)
    } catch (e: any) {
      setError(e?.message || 'Search failed')
    } finally {
      setSearching(false)
    }
  }, [kind])

  function handleQueryChange(val: string) {
    setQuery(val)
    if (value) onChange(null)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => doSearch(val), 250)
    setOpen(true)
  }

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  async function createNew() {
    const name = query.trim()
    if (!name) return
    setCreating(true)
    setError(null)
    try {
      const created = await api.post<MobileAssetOption>('/mobile-assets', { name, kind })
      onChange(created)
      setOpen(false)
    } catch (e: any) {
      setError(e?.message || 'Failed to create')
    } finally {
      setCreating(false)
    }
  }

  const exactMatch = results.some(r => r.name.toLowerCase() === query.trim().toLowerCase())

  return (
    <div ref={boxRef} className="relative">
      {value ? (
        <div className="flex items-center gap-2 p-2.5 border border-emerald-200 bg-emerald-50 rounded-lg">
          <span className="flex-1 min-w-0 text-sm font-medium text-emerald-900 truncate">{value.name}</span>
          <button
            type="button"
            onClick={() => { onChange(null); setQuery('') }}
            className="text-emerald-600 hover:text-emerald-800 shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      ) : (
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            type="text"
            value={query}
            onChange={e => handleQueryChange(e.target.value)}
            onFocus={() => setOpen(true)}
            placeholder={placeholder || `Search ${KIND_LABEL[kind]}s...`}
            className="w-full pl-9 pr-3 py-2.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
          />
          {searching && (
            <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 animate-spin text-blue-400" />
          )}
        </div>
      )}

      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}

      {open && !value && query.trim().length > 0 && (
        <div className="absolute z-20 mt-1 w-full bg-white border border-slate-200 rounded-lg shadow-lg max-h-56 overflow-y-auto">
          {results.map(r => (
            <button
              key={r.id}
              type="button"
              className="w-full text-left px-3 py-2 text-sm hover:bg-blue-50 truncate"
              onClick={() => { onChange(r); setOpen(false) }}
            >
              {r.name}
            </button>
          ))}
          {!exactMatch && (
            <button
              type="button"
              disabled={creating}
              onClick={createNew}
              className={cn(
                'w-full text-left px-3 py-2 text-sm flex items-center gap-1.5 text-blue-600 hover:bg-blue-50 font-medium',
                results.length > 0 && 'border-t border-slate-100',
              )}
            >
              {creating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
              Add "{query.trim()}" as a new {KIND_LABEL[kind]}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
