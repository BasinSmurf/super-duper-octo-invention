import { X, Loader2 } from 'lucide-react'
import { cn } from '@/lib/cn'
import type { ReactNode } from 'react'

export interface BulkAction {
  label: string
  icon?: ReactNode
  variant: 'primary' | 'danger' | 'secondary'
  onClick: () => void
  loading?: boolean
  disabled?: boolean
}

interface Props {
  selectionCount: number
  actions: BulkAction[]
  onClear: () => void
  itemLabel?: string // e.g. "ticket" / "invoice" — pluralized automatically
}

/**
 * Sticky bottom action bar that appears when a bulk selection is active.
 * Reusable across the Approvals dashboard, invoice bulk-approval (future),
 * and pending location request approval (future).
 */
export function BulkActionBar({
  selectionCount,
  actions,
  onClear,
  itemLabel = 'item',
}: Props) {
  if (selectionCount === 0) return null

  const plural = selectionCount === 1 ? itemLabel : `${itemLabel}s`

  return (
    <div className="fixed bottom-0 left-0 right-0 lg:left-64 z-40 px-4 pb-4 pointer-events-none">
      <div className="max-w-5xl mx-auto pointer-events-auto">
        <div className="bg-slate-900 text-white rounded-xl shadow-2xl border border-slate-700 p-3 flex items-center gap-3 animate-in slide-in-from-bottom-4 duration-200">
          <div className="flex items-center gap-2 min-w-0">
            <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-blue-600 text-xs font-bold">
              {selectionCount}
            </span>
            <span className="text-sm font-medium truncate">
              {selectionCount} {plural} selected
            </span>
          </div>

          <div className="flex-1" />

          <div className="flex items-center gap-2">
            {actions.map((action, i) => (
              <button
                key={i}
                onClick={action.onClick}
                disabled={action.disabled || action.loading}
                className={cn(
                  'flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
                  action.variant === 'primary' &&
                    'bg-blue-600 hover:bg-blue-500 text-white',
                  action.variant === 'danger' &&
                    'bg-red-600 hover:bg-red-500 text-white',
                  action.variant === 'secondary' &&
                    'bg-slate-700 hover:bg-slate-600 text-white',
                )}
              >
                {action.loading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  action.icon
                )}
                <span>{action.label}</span>
              </button>
            ))}

            <button
              onClick={onClear}
              className="p-2 rounded-lg text-slate-300 hover:text-white hover:bg-slate-800 transition-colors"
              title="Clear selection"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
