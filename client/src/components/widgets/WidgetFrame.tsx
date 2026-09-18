import { X, Maximize2, Minimize2 } from 'lucide-react'
import { cn } from '@/lib/cn'
import type { WidgetInstance, WidgetSize } from '@/lib/widgetTypes'

interface Props {
  widget: WidgetInstance
  title: string
  editing: boolean
  allowedSizes: WidgetSize[]
  onRemove: () => void
  onResize: (size: WidgetSize) => void
  children: React.ReactNode
  /** 'action' variant renders as an alert button — no chrome, just children */
  variant?: 'panel' | 'action'
}

const SIZE_ORDER: WidgetSize[] = ['small', 'medium', 'large', 'full']

export function WidgetFrame({
  widget,
  title,
  editing,
  allowedSizes,
  onRemove,
  onResize,
  children,
  variant = 'panel',
}: Props) {
  // Action variant = bare wrapper, widget handles its own chrome
  if (variant === 'action') {
    return (
      <div className="relative">
        {children}
        {editing && (
          <button
            onClick={onRemove}
            className="absolute -top-2 -right-2 w-6 h-6 rounded-full bg-red-600 text-white flex items-center justify-center shadow-lg hover:bg-red-700 z-10"
            aria-label="Remove widget"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    )
  }

  const currentIdx = SIZE_ORDER.indexOf(widget.size)
  const nextSize = allowedSizes.find(
    (s) => SIZE_ORDER.indexOf(s) > currentIdx,
  ) ?? allowedSizes[0]
  const prevSize = [...allowedSizes]
    .reverse()
    .find((s) => SIZE_ORDER.indexOf(s) < currentIdx) ?? allowedSizes[allowedSizes.length - 1]

  const canGrow = nextSize !== widget.size
  const canShrink = prevSize !== widget.size

  return (
    <div className="bg-white rounded-xl shadow-sm border border-slate-200 flex flex-col overflow-hidden h-full">
      <header className="flex items-center justify-between px-4 py-2.5 border-b border-slate-100 bg-slate-50/50">
        <h3 className="text-sm font-semibold text-slate-700">{title}</h3>
        {editing && (
          <div className="flex items-center gap-1">
            <button
              onClick={() => onResize(prevSize)}
              disabled={!canShrink}
              className={cn(
                'p-1 rounded hover:bg-slate-200 text-slate-500',
                !canShrink && 'opacity-30 cursor-not-allowed',
              )}
              title="Shrink"
            >
              <Minimize2 className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => onResize(nextSize)}
              disabled={!canGrow}
              className={cn(
                'p-1 rounded hover:bg-slate-200 text-slate-500',
                !canGrow && 'opacity-30 cursor-not-allowed',
              )}
              title="Grow"
            >
              <Maximize2 className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={onRemove}
              className="p-1 rounded hover:bg-red-100 text-red-600"
              title="Remove"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </header>
      <div className="flex-1 min-h-0 overflow-auto p-4">{children}</div>
    </div>
  )
}
