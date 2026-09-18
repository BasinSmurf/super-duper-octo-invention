import { useState } from 'react'
import { Plus } from 'lucide-react'
import type { WidgetCatalogEntry, WidgetType } from '@/lib/widgetTypes'

interface Props {
  catalog: WidgetCatalogEntry[]
  /** Types already on the dashboard — still selectable, just shown as "already added" */
  existingTypes: Set<WidgetType>
  onAdd: (entry: WidgetCatalogEntry) => void
}

export function AddWidgetMenu({ catalog, existingTypes, onAdd }: Props) {
  const [open, setOpen] = useState(false)

  if (catalog.length === 0) return null

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 shadow-sm"
      >
        <Plus className="w-4 h-4" />
        Add widget
      </button>

      {open && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <div className="absolute right-0 top-full mt-2 w-80 bg-white rounded-xl shadow-xl border border-slate-200 z-50 overflow-hidden">
            <div className="p-3 border-b border-slate-100">
              <h4 className="text-sm font-semibold text-slate-700">Available widgets</h4>
              <p className="text-xs text-slate-500 mt-0.5">
                You can add the same widget more than once.
              </p>
            </div>
            <ul className="max-h-96 overflow-y-auto divide-y divide-slate-100">
              {catalog.map((entry) => {
                const already = existingTypes.has(entry.type)
                return (
                  <li key={entry.type}>
                    <button
                      onClick={() => {
                        onAdd(entry)
                        setOpen(false)
                      }}
                      className="w-full text-left px-4 py-3 hover:bg-slate-50"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium text-slate-800">
                          {entry.label}
                        </span>
                        {already && (
                          <span className="text-[10px] uppercase tracking-wide text-slate-400 font-semibold">
                            Already added
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-slate-500 mt-0.5">{entry.description}</p>
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
        </>
      )}
    </div>
  )
}
