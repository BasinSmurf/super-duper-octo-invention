import { HelpTip } from '@/components/HelpTip'
import { useState, useEffect } from 'react'
import { Clock } from 'lucide-react'
import { cn } from '@/lib/cn'

/** Short timezone label for the device (e.g. "CDT", "MDT") — answers
 * "what zone are we in" for crews working near the Central/Mountain line. */
function deviceZone(d: Date): string {
  try {
    const parts = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' }).formatToParts(d)
    const tz = parts.find(p => p.type === 'timeZoneName')?.value
    if (tz) return tz
  } catch { /* fall through */ }
  return Intl.DateTimeFormat().resolvedOptions().timeZone || ''
}

/**
 * #A Live device clock + timezone. Ticks every second. Device-derived only
 * (crews are all on cell — whatever zone the phone last picked up), no geo
 * lookup. Anchors H2S log timestamps to a visible zone.
 */
export function LiveClock({ className }: { className?: string }) {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])
  const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  return (
    <span className={cn('inline-flex items-center gap-1.5 tabular-nums text-slate-600', className)}>
      <Clock className="w-3.5 h-3.5 text-slate-400" />
      {time}
      <span className="font-semibold text-slate-700">{deviceZone(now)}</span>
      <HelpTip text="This clock uses your device time and time zone. Check your device settings if the displayed time is incorrect." />
    </span>
  )
}
