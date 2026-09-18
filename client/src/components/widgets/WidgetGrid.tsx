import { WidgetFrame } from './WidgetFrame'
import { WIDGET_REGISTRY } from './registry'
import type { WidgetCatalogEntry, WidgetInstance, WidgetSize } from '@/lib/widgetTypes'
import { cn } from '@/lib/cn'

// Tailwind column-span classes keyed by widget size.
// We use a 12-column grid on desktop; on mobile everything collapses to 1 col.
const SIZE_SPAN: Record<WidgetSize, string> = {
  small: 'md:col-span-3 lg:col-span-3',
  medium: 'md:col-span-6 lg:col-span-4',
  large: 'md:col-span-6 lg:col-span-6',
  full: 'md:col-span-12 lg:col-span-12',
}

// Fixed row height multipliers, so small widgets stay compact and full takes real estate.
const SIZE_HEIGHT: Record<WidgetSize, string> = {
  small: 'min-h-[140px]',
  medium: 'min-h-[260px]',
  large: 'min-h-[320px]',
  full: 'min-h-[360px]',
}

interface Props {
  widgets: WidgetInstance[]
  catalog: WidgetCatalogEntry[]
  editing: boolean
  onRemove: (id: string) => void
  onResize: (id: string, size: WidgetSize) => void
  /**
   * Persist a widget instance's own settings (e.g. which aging bucket it shows
   * and at what threshold). Layout already stored `config` per instance; it
   * just never reached the component. Widgets that have no settings ignore it.
   */
  onConfigChange: (id: string, config: Record<string, unknown>) => void
}

export function WidgetGrid({ widgets, catalog, editing, onRemove, onResize, onConfigChange }: Props) {
  if (widgets.length === 0) {
    return (
      <div className="py-16 text-center text-slate-400">
        <p className="text-sm">
          No widgets yet. Click <span className="font-semibold">Add widget</span> to get started.
        </p>
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-12 gap-4">
      {widgets.map((w) => {
        const reg = WIDGET_REGISTRY[w.type]
        const meta = catalog.find((c) => c.type === w.type)
        if (!reg || !meta) return null
        const Component = reg.Component
        return (
          <div
            key={w.id}
            className={cn(SIZE_SPAN[w.size], SIZE_HEIGHT[w.size])}
          >
            <WidgetFrame
              widget={w}
              title={reg.title ? reg.title(w.config ?? {}) : meta.label}
              editing={editing}
              allowedSizes={meta.sizes}
              onRemove={() => onRemove(w.id)}
              onResize={(size) => onResize(w.id, size)}
              variant={reg.variant ?? 'panel'}
            >
              <Component
                config={w.config ?? {}}
                onConfigChange={(next) => onConfigChange(w.id, next)}
              />
            </WidgetFrame>
          </div>
        )
      })}
    </div>
  )
}
