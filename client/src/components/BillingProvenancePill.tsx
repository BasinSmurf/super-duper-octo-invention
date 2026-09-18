import { Landmark, Zap, UserRound, Clock } from 'lucide-react'
import { cn } from '@/lib/cn'

export interface BillingObservationLite {
  factKey: string
  factValue: unknown
  source: string
  sourceActor?: string | null
  asOf: string
}

interface Props {
  observation: BillingObservationLite | null | undefined
  /** Days before a mirrored fact renders as "stale" instead of its value. Default 7. */
  staleDays?: number
  size?: 'sm' | 'md'
}

const FACT_LABELS: Record<string, string> = {
  accepted: 'Accepted',
  disputed: 'Disputed',
  paid: 'Paid',
  credited: 'Credited',
  written_off: 'Written off',
  amount_paid: 'Paid',
  invoice_date: 'Invoiced',
  qb_txn_id: 'In QuickBooks',
  total_mismatch: 'Total mismatch',
  line_count_mismatch: 'Line mismatch',
  qb_record_missing: 'Missing in QuickBooks',
}

const SOURCE_LABELS: Record<string, string> = {
  quickbooks: 'QuickBooks',
  openinvoice: 'OpenInvoice',
}

// UTC, not local-timezone toLocaleDateString: a date-only asOf ("2026-08-05")
// parses to UTC midnight, and a browser west of UTC (all of North America)
// would otherwise render it as the day before — exactly the handoff's own
// example ("confirmed by Max · 8/5") is a bare date, no time, so this is the
// common case for human observations, not an edge case.
export function formatDate(iso: string) {
  const d = new Date(iso)
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${String(d.getUTCFullYear()).slice(2)}`
}

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "Aug 5" — same UTC-safety rationale as formatDate above. */
export function formatDateShort(iso: string) {
  const d = new Date(iso)
  return `${SHORT_MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`
}

/**
 * A single mirrored billing fact — value + source + as-of, or "stale" once
 * past staleDays. This is the ADR's "two different treatments, consistently
 * applied" other half: this pill must never look like BillingReadinessPill
 * (the owned field) — dashed border for human/hearsay sources, solid for
 * system-sourced ones, always with a source name, never a bare status word.
 */
export function BillingProvenancePill({ observation, staleDays = 7, size = 'sm' }: Props) {
  const base = size === 'sm' ? 'px-1.5 py-0.5 text-[11px] gap-1' : 'px-2 py-1 text-xs gap-1.5'
  const iconSize = size === 'sm' ? 'w-3 h-3' : 'w-3.5 h-3.5'

  if (!observation) return null

  const ageMs = Date.now() - new Date(observation.asOf).getTime()
  const isStale = ageMs > staleDays * 24 * 60 * 60 * 1000
  const label = FACT_LABELS[observation.factKey] ?? observation.factKey

  const isHuman = observation.source === 'human'
  const Icon = isHuman ? UserRound : observation.source === 'openinvoice' ? Zap : Landmark

  const sourceText = isHuman
    ? `confirmed by ${observation.sourceActor || 'unknown'}`
    : (SOURCE_LABELS[observation.source] ?? observation.source)

  if (isStale) {
    return (
      <span
        title={`Last known: ${label} · ${sourceText} · ${formatDate(observation.asOf)}`}
        className={cn(
          'inline-flex items-center rounded-full font-medium bg-slate-50 text-slate-400 border border-dashed border-slate-300',
          base,
        )}
      >
        <Clock className={iconSize} />
        stale · last {formatDate(observation.asOf)}
      </span>
    )
  }

  return (
    <span
      title={`${sourceText} · ${formatDate(observation.asOf)}`}
      className={cn(
        'inline-flex items-center rounded-full font-medium',
        isHuman
          ? 'bg-amber-50 text-amber-700 border border-dashed border-amber-300'
          : 'bg-blue-50 text-blue-700 border border-blue-200',
        base,
      )}
    >
      <Icon className={iconSize} />
      {label} · {sourceText} · {formatDate(observation.asOf)}
    </span>
  )
}
