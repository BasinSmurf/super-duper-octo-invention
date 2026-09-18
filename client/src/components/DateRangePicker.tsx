import { useState } from 'react'
import { Calendar } from 'lucide-react'
import { cn } from '@/lib/cn'
import { daysAgoKey as daysAgo, todayKey as today } from '@/lib/dates'

export interface DateRange {
  from: string  // ISO date string YYYY-MM-DD
  to: string
}

interface Props {
  value: DateRange
  onChange: (range: DateRange) => void
  className?: string
}

type Preset = '30d' | '90d' | 'ytd' | 'custom'

function yearStart(): string {
  return `${new Date().getFullYear()}-01-01`
}

function detectPreset(range: DateRange): Preset {
  const t = today()
  if (range.to === t) {
    if (range.from === daysAgo(30)) return '30d'
    if (range.from === daysAgo(90)) return '90d'
    if (range.from === yearStart()) return 'ytd'
  }
  return 'custom'
}

export function DateRangePicker({ value, onChange, className }: Props) {
  const [preset, setPreset] = useState<Preset>(() => detectPreset(value))

  function selectPreset(p: Preset) {
    setPreset(p)
    const t = today()
    if (p === '30d') onChange({ from: daysAgo(30), to: t })
    else if (p === '90d') onChange({ from: daysAgo(90), to: t })
    else if (p === 'ytd') onChange({ from: yearStart(), to: t })
    // 'custom' — don't change dates, let user pick
  }

  const presets: { key: Preset; label: string }[] = [
    { key: '30d', label: '30 days' },
    { key: '90d', label: '90 days' },
    { key: 'ytd', label: 'YTD' },
    { key: 'custom', label: 'Custom' },
  ]

  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      <Calendar className="w-4 h-4 text-slate-400 shrink-0" />
      <div className="flex rounded-lg border border-slate-200 overflow-hidden">
        {presets.map(p => (
          <button
            key={p.key}
            type="button"
            onClick={() => selectPreset(p.key)}
            className={cn(
              'px-3 py-1.5 text-xs font-medium transition-colors border-r border-slate-200 last:border-r-0',
              preset === p.key
                ? 'bg-blue-600 text-white'
                : 'bg-white text-slate-600 hover:bg-slate-50'
            )}
          >
            {p.label}
          </button>
        ))}
      </div>

      {preset === 'custom' && (
        <div className="flex items-center gap-1.5">
          <input
            type="date"
            value={value.from}
            onChange={e => onChange({ ...value, from: e.target.value })}
            className="px-2 py-1.5 border border-slate-300 rounded-md text-xs focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
          />
          <span className="text-xs text-slate-400">→</span>
          <input
            type="date"
            value={value.to}
            onChange={e => onChange({ ...value, to: e.target.value })}
            className="px-2 py-1.5 border border-slate-300 rounded-md text-xs focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
          />
        </div>
      )}
    </div>
  )
}
