import { Tag, AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/cn'
import type { PriceLevel } from '@/lib/priceLevels'

/**
 * The one way contract pricing is shown, so the ticket wizard and the shop
 * screens can't describe the same fact two different ways.
 *
 * Two pieces:
 *   ContractPricingBanner — "this customer is on a pricebook", shown once at
 *     the top of whatever list is being priced.
 *   ContractPriceBadge    — per-line: what the contract set, and (loudly) when
 *     someone has since typed over it.
 */

export function ContractPricingBanner({
  level,
  appliedCount,
  className,
}: {
  level: PriceLevel | null
  /** How many lines currently sit at a contract rate. Omit to hide the count. */
  appliedCount?: number
  className?: string
}) {
  if (!level) return null
  return (
    <div className={cn(
      'flex items-center gap-2 px-3 py-2 rounded-lg border border-violet-200 bg-violet-50 text-violet-900',
      className,
    )}>
      <Tag className="w-4 h-4 shrink-0 text-violet-600" />
      <p className="text-xs leading-snug">
        <span className="font-semibold">Contract pricing — {level.name}.</span>{' '}
        Rates below come from this customer's pricebook, not the list price.
        {appliedCount != null && appliedCount > 0 && (
          <span className="text-violet-700"> {appliedCount} line{appliedCount === 1 ? '' : 's'} priced.</span>
        )}
      </p>
    </div>
  )
}

/**
 * Per-line marker. `overridden` means someone edited the rate away from the
 * contract number — shown in amber rather than hidden, because a hand-typed
 * rate on a contract customer is exactly the thing the invoice will later
 * overwrite, and the person typing it should know that now.
 */
export function ContractPriceBadge({
  priceLevelName,
  listRate,
  contractRate,
  currentRate,
  className,
}: {
  priceLevelName?: string | null
  listRate?: number | null
  contractRate?: number | null
  /** The rate actually on the line right now. */
  currentRate?: number | null
  className?: string
}) {
  if (!priceLevelName || contractRate == null) return null

  const overridden = currentRate != null && Math.abs(currentRate - contractRate) > 0.005
  const showList = listRate != null && Math.abs(listRate - contractRate) > 0.005

  if (overridden) {
    return (
      <span
        title={`${priceLevelName} contract rate is $${contractRate.toFixed(2)} — the invoice will bill that, not the rate entered here.`}
        className={cn(
          'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium',
          'bg-amber-50 text-amber-800 border border-amber-200',
          className,
        )}
      >
        <AlertTriangle className="w-2.5 h-2.5" />
        Off contract · {priceLevelName} ${contractRate.toFixed(2)}
      </span>
    )
  }

  return (
    <span
      title={`Contract rate from ${priceLevelName}${showList ? ` (list $${listRate!.toFixed(2)})` : ''}`}
      className={cn(
        'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium',
        'bg-violet-50 text-violet-800 border border-violet-200',
        className,
      )}
    >
      <Tag className="w-2.5 h-2.5" />
      {priceLevelName}
      {showList && <s className="text-violet-400 font-normal">${listRate!.toFixed(2)}</s>}
    </span>
  )
}
