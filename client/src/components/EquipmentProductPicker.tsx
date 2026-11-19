import { useEffect, useState } from 'react'
import { api } from '@/lib/api'

export interface EquipmentProductOption {
  id: string; name: string; partNumber: string; isSerialized: boolean; isAssembly: boolean
}

export function EquipmentProductPicker({ value, onChange }: {
  value: EquipmentProductOption; onChange: (product: EquipmentProductOption) => void
}) {
  const [search, setSearch] = useState('')
  const [results, setResults] = useState<EquipmentProductOption[]>([])
  const [error, setError] = useState('')
  useEffect(() => {
    if (!search.trim()) { setResults([]); return }
    let active = true
    const timer = setTimeout(async () => {
      try {
        const res = await api.get<{ data: EquipmentProductOption[] }>(`/products?${new URLSearchParams({ search, active: 'true', limit: '30' })}`)
        if (active) { setResults(res.data.filter(p => p.isSerialized || p.isAssembly)); setError('') }
      } catch { if (active) setError('Could not load products') }
    }, 200)
    return () => { active = false; clearTimeout(timer) }
  }, [search])
  return <div className="space-y-2">
    <p className="text-sm text-slate-700">{value.partNumber} — {value.name}</p>
    <input aria-label="Search replacement product" value={search} onChange={e => setSearch(e.target.value)}
      placeholder="Search to change product type..." className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg" />
    {search.trim() && <div className="max-h-40 overflow-y-auto border rounded-lg">
      {results.map(p => <button key={p.id} type="button" onClick={() => { onChange(p); setSearch('') }}
        className="block w-full text-left px-3 py-2 text-sm hover:bg-blue-50">{p.partNumber} — {p.name}{p.isAssembly ? ' (Assembly)' : ''}</button>)}
      {!results.length && <p className="p-2 text-xs text-slate-500">{error || 'No matching serialized products or assemblies'}</p>}
    </div>}
  </div>
}
