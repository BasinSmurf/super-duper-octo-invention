import { v4 as uuidv4 } from 'uuid'
import { cn } from '@/lib/cn'
import type { BillingRef, BillingRefType } from '@/lib/db-types'

interface BillingRefsFieldProps {
  refs: BillingRef[]
  onChange: (next: BillingRef[]) => void
  /** Customer-specific display labels; fall back to generic names. */
  labels?: { po?: string | null; afe?: string | null; costCode?: string | null }
}

/**
 * #3 PO / AFE / Cost-Code structured repeater. Each row is a typed reference
 * (dropdown) + value; "add additional" appends more. Rows seeded as `required`
 * (from the customer's billing profile) lock their type and can't be removed.
 */
export function BillingRefsField({ refs, onChange, labels }: BillingRefsFieldProps) {
  const typeLabel = (t: BillingRefType) =>
    t === 'po' ? (labels?.po || 'PO')
      : t === 'afe' ? (labels?.afe || 'AFE')
      : (labels?.costCode || 'Cost Code')

  const update = (idx: number, patch: Partial<BillingRef>) =>
    onChange(refs.map((r, i) => (i === idx ? { ...r, ...patch } : r)))
  const remove = (idx: number) => onChange(refs.filter((_, i) => i !== idx))
  const add = () =>
    onChange([...refs, { id: uuidv4(), type: 'po', value: '', required: false }])

  return (
    <div>
      <label className="block text-sm font-medium text-slate-700 mb-2">Billing References</label>
      <div className="space-y-2">
        {refs.map((ref, idx) => (
          <div key={ref.id} className="flex flex-wrap gap-2 items-center">
            <select
              value={ref.type}
              disabled={ref.required}
              onChange={e => update(idx, { type: e.target.value as BillingRefType })}
              className={cn(
                'px-2 py-2 border border-slate-300 rounded-lg text-sm bg-white focus:ring-2 focus:ring-blue-500 outline-none',
                ref.required && 'bg-slate-50 text-slate-500',
              )}
            >
              <option value="po">{typeLabel('po')}</option>
              <option value="afe">{typeLabel('afe')}</option>
              <option value="cost_code">{typeLabel('cost_code')}</option>
            </select>
            <input
              type="text"
              value={ref.value}
              placeholder={`${typeLabel(ref.type)} #`}
              onChange={e => update(idx, { value: e.target.value })}
              className={cn(
                'flex-1 min-w-[8rem] px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none',
                ref.required && !ref.value.trim() ? 'border-red-300' : 'border-slate-300',
              )}
            />
            {ref.required ? (
              <span className="text-xs text-red-600 font-medium px-1" title="Required for this customer">required</span>
            ) : (
              <button
                type="button"
                onClick={() => remove(idx)}
                className="px-2 py-2 text-slate-400 hover:text-red-600"
                aria-label="Remove billing reference"
              >✕</button>
            )}
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={add}
        className="mt-2 text-sm font-medium text-blue-600 hover:text-blue-700"
      >+ Add additional</button>
    </div>
  )
}
