import { cn } from '@/lib/cn'
import type { RentalComposition } from '@/lib/db-types'

export interface JobTypePill {
  label: string
  cls: string
}

interface PillSource {
  isManned?: boolean
  isRigJob?: boolean
  monitorsIncluded?: boolean
  composition?: RentalComposition | null
}

/**
 * Rig Job → Manned/Unmanned (implies a trailer) → Monitors — in that order.
 * Prefers `composition` (the source of truth) over the flat booleans, which
 * are a server-derived back-compat mirror and can be stale/absent offline.
 */
export function deriveJobTypePills(agreement: PillSource): JobTypePill[] {
  const c = agreement.composition
  const pills: JobTypePill[] = []

  const isRigJob = c ? c.drillingRig : !!agreement.isRigJob
  if (isRigJob) pills.push({ label: 'Rig Job', cls: 'bg-purple-100 text-purple-700' })

  if (c) {
    if (c.trailer) {
      pills.push(c.trailer.manned
        ? { label: 'Manned', cls: 'bg-blue-100 text-blue-700' }
        : { label: 'Unmanned', cls: 'bg-slate-100 text-slate-600' })
    }
  } else if (agreement.isManned) {
    pills.push({ label: 'Manned', cls: 'bg-blue-100 text-blue-700' })
  }

  // Older compositions can contain only a trailer or BOM package. Fall back
  // to the legacy flag when the monitor list is absent; an explicit [] wins.
  const hasMonitors = Array.isArray(c?.gasMonitors)
    ? c.gasMonitors.length > 0
    : !!agreement.monitorsIncluded
  if (hasMonitors) pills.push({ label: 'Monitors', cls: 'bg-emerald-100 text-emerald-700' })

  return pills
}

export function JobTypePillRow({ agreement, className }: { agreement: PillSource; className?: string }) {
  const pills = deriveJobTypePills(agreement)
  if (pills.length === 0) return null
  return (
    <div className={cn('flex flex-wrap gap-1.5', className)}>
      {pills.map(p => (
        <span key={p.label} className={cn('text-xs font-medium px-2 py-0.5 rounded-full', p.cls)}>
          {p.label}
        </span>
      ))}
    </div>
  )
}
