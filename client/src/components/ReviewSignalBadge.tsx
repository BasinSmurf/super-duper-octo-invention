import { CheckCircle2, AlertTriangle, XCircle, HelpCircle } from 'lucide-react'
import { cn } from '@/lib/cn'

export interface ReviewSignal {
  verdict: 'green' | 'yellow' | 'red'
  reasons: string[]
  ruleResults: Record<string, 'pass' | 'warn' | 'fail'>
  ranAt: string
  engineVersion: number
}

interface Props {
  signal?: ReviewSignal | null
  size?: 'sm' | 'md'
  showLabel?: boolean
}

/**
 * Small chip showing a green/yellow/red verdict from the ticket review
 * rules engine. Hover reveals the reasons list. Used in the Approvals
 * dashboard row and can be reused in TicketDetailPage / TicketsPage.
 */
export function ReviewSignalBadge({ signal, size = 'sm', showLabel = false }: Props) {
  const base = size === 'sm'
    ? 'px-1.5 py-0.5 text-[11px] gap-1'
    : 'px-2 py-1 text-xs gap-1.5'
  const iconSize = size === 'sm' ? 'w-3 h-3' : 'w-3.5 h-3.5'

  if (!signal) {
    return (
      <span
        title="Review check pending — rules engine has not run on this ticket yet"
        className={cn(
          'inline-flex items-center rounded-full font-medium bg-slate-100 text-slate-500 border border-slate-200',
          base,
        )}
      >
        <HelpCircle className={iconSize} />
        {showLabel && <span>Pending</span>}
      </span>
    )
  }

  const reasonsText = signal.reasons.length
    ? signal.reasons.join(' • ')
    : 'All checks passed'

  if (signal.verdict === 'green') {
    return (
      <span
        title={`Routine — ${reasonsText}`}
        className={cn(
          'inline-flex items-center rounded-full font-medium bg-emerald-50 text-emerald-700 border border-emerald-200',
          base,
        )}
      >
        <CheckCircle2 className={iconSize} />
        {showLabel && <span>Routine</span>}
      </span>
    )
  }

  if (signal.verdict === 'yellow') {
    return (
      <span
        title={`Needs eyes — ${reasonsText}`}
        className={cn(
          'inline-flex items-center rounded-full font-medium bg-amber-50 text-amber-700 border border-amber-200',
          base,
        )}
      >
        <AlertTriangle className={iconSize} />
        {showLabel && <span>Review</span>}
      </span>
    )
  }

  return (
    <span
      title={`Problem — ${reasonsText}`}
      className={cn(
        'inline-flex items-center rounded-full font-medium bg-red-50 text-red-700 border border-red-200',
        base,
      )}
    >
      <XCircle className={iconSize} />
      {showLabel && <span>Problem</span>}
    </span>
  )
}
