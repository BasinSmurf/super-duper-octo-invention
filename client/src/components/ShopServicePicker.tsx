import { useEffect, useState } from 'react'
import { api } from '@/lib/api'

export interface ShopServiceCharge {
  productId: string; partNumber: string; name: string; quantity: number; rate: number;
  unitOfMeasure?: string; serviceActions?: string[];
}
interface ServiceProduct { id: string; partNumber: string; name: string; productType: string; defaultSellPrice: number | null; unitOfMeasure: string | null; qbItemListId: string | null; serviceActions?: string[]; qaCategory?: string | null }

export function ShopServicePicker({ value, onChange, actions = [], category, disabled = false }: {
  value: ShopServiceCharge[]; onChange: (services: ShopServiceCharge[]) => void; actions?: string[]; category?: string; disabled?: boolean;
}) {
  const [catalog, setCatalog] = useState<ServiceProduct[]>([])
  const [search, setSearch] = useState('')
  const [error, setError] = useState('')
  useEffect(() => { let active = true; api.get<{ data: ServiceProduct[] }>('/shop-orders/parts-catalog')
    .then(r => { if (active) setCatalog(r.data.filter(p => p.productType === 'service')) })
    .catch(() => { if (active) setError('Service catalog unavailable. Reconnect to choose a service.') }); return () => { active = false } }, [])
  const q = search.toLowerCase()
  const matchesQa = (p: ServiceProduct) => p.serviceActions?.some(a => actions.includes(a) || (a === 'recharge_annual' && (actions.includes('recharge') || actions.includes('annual'))))
  const matches = catalog.filter(p => (!category || !p.qaCategory || p.qaCategory === category) && `${p.partNumber} ${p.name}`.toLowerCase().includes(q))
    .sort((a, b) => Number(!!b.serviceActions?.some(x => actions.includes(x))) - Number(!!a.serviceActions?.some(x => actions.includes(x))) || Number(!!b.qbItemListId) - Number(!!a.qbItemListId) || a.partNumber.localeCompare(b.partNumber))
  return <div className="space-y-2" aria-label="Services performed">
    <div className="text-xs font-semibold text-slate-700">Services performed / billable services</div>
    <p className="text-xs text-slate-500">Choose a priced, QuickBooks-linked service for this serial. Services matching QA actions appear first. A bundled recharge/annual service is one charge.</p>
    {actions.length > 0 && <div className="flex flex-wrap gap-2">{catalog.filter(p => (!category || p.qaCategory === category) && p.qbItemListId && p.defaultSellPrice != null && matchesQa(p) && !value.some(s => s.productId === p.id)).slice(0, 6).map(p => <button type="button" disabled={disabled} key={p.id} className="border border-blue-200 bg-blue-50 rounded p-2 text-xs text-left text-blue-800" onClick={() => onChange([...value, { productId: p.id, partNumber: p.partNumber, name: p.name, quantity: 1, rate: p.defaultSellPrice ?? 0, unitOfMeasure: p.unitOfMeasure ?? 'EA', serviceActions: p.serviceActions ?? [] }])}>Add {p.partNumber} — {p.name} ({p.defaultSellPrice == null ? 'price required' : `$${p.defaultSellPrice.toFixed(2)}`})</button>)}</div>}
    {error && <p className="text-xs text-red-700">{error}</p>}
    {!disabled && <><input aria-label="Search services" className="w-full border rounded p-2 text-xs" placeholder="Search service or QB number (061…, calibration, condemn…)" value={search} onChange={e => setSearch(e.target.value)} />
      <select aria-label="Add billable service" className="w-full border rounded p-2 text-xs" value="" onChange={e => {
        const p = catalog.find(x => x.id === e.target.value); if (!p) return;
        if (value.some(s => s.productId === p.id)) return;
        onChange([...value, { productId: p.id, partNumber: p.partNumber, name: p.name, quantity: 1, rate: p.defaultSellPrice ?? 0, unitOfMeasure: p.unitOfMeasure ?? 'EA', serviceActions: p.serviceActions ?? [] }]);
      }}><option value="">Choose a service…</option>{matches.map(p => <option key={p.id} value={p.id} disabled={value.some(s => s.productId === p.id) || !p.qbItemListId || p.defaultSellPrice == null}>{p.partNumber} — {p.name} — {p.defaultSellPrice == null ? 'PRICE REQUIRED' : `$${p.defaultSellPrice.toFixed(2)}`}{p.qbItemListId ? '' : ' (no QB mapping)'}</option>)}</select></>}
    {value.map((s, index) => <div key={`${s.productId}-${index}`} className="flex flex-wrap items-center gap-2 text-xs border rounded p-2">
      <span className="flex-1 min-w-40">{s.partNumber} — {s.name}</span>
      <input aria-label={`Quantity for ${s.partNumber}`} disabled={disabled} type="number" min="0.01" step="0.01" className="w-16 border rounded p-1" value={s.quantity} onChange={e => onChange(value.map((x, i) => i === index ? { ...x, quantity: Number(e.target.value) } : x))} />
      <span>× $</span><input aria-label={`Rate for ${s.partNumber}`} disabled={disabled} type="number" min="0" step="0.01" className="w-20 border rounded p-1" value={s.rate} onChange={e => onChange(value.map((x, i) => i === index ? { ...x, rate: Number(e.target.value) } : x))} />
      <span>${(s.quantity * s.rate).toFixed(2)}</span>{!disabled && <button type="button" className="text-red-600" onClick={() => onChange(value.filter((_, i) => i !== index))}>Remove</button>}
    </div>)}
  </div>
}
