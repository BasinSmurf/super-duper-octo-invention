import { ArrowRight } from 'lucide-react'

/**
 * "Ready Rentals Not Billed" — rentals still owing billing for a month that has
 * already ended (last month or any earlier one).
 *
 * Deliberately a banner and not a dashboard widget: widgets only show for
 * people who added them to their layout, and this has to appear by itself on
 * the 1st and stay until the invoices are actually cut. It renders nothing
 * once the month is clean.
 *
 * Each side sees its own half (the server zeroes the rest): the field sees
 * what it has not sent, AR sees what was sent and is waiting on an invoice.
 * Server: GET /api/rentals/billing-release/summary.
 */

export interface RentalReleaseSummary {
  unsent: number
  closedBlocked: number
  awaitingInvoice: number
  /** Everything the field should act on today (tab badge). */
  needsSending: number
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

export function RentalUnbilledBanner({ summary, onOpenReleaseTab, onOpenBilling }: {
  summary: RentalReleaseSummary | null
  onOpenReleaseTab: () => void
  onOpenBilling: () => void
}) {
  if (!summary) return null
  const fieldCount = summary.unsent + summary.closedBlocked
  if (fieldCount === 0 && summary.awaitingInvoice === 0) return null

  return (
    <div role="alert" className="mb-4 rounded-lg border-2 border-red-300 bg-red-50 p-4">
      <p className="text-lg font-extrabold tracking-wide text-red-800">Ready Rentals Not Billed</p>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        {fieldCount > 0 && (
          <button
            type="button"
            onClick={onOpenReleaseTab}
            className="inline-flex items-center justify-between gap-3 rounded-lg bg-red-700 px-3 py-2 text-left text-sm font-semibold text-white hover:bg-red-600"
          >
            <span>
              {summary.unsent > 0 && `${plural(summary.unsent, 'rental', 'rentals')} not sent for billing`}
              {summary.unsent > 0 && summary.closedBlocked > 0 && ' · '}
              {summary.closedBlocked > 0 && `${plural(summary.closedBlocked, 'closed job', 'closed jobs')} waiting on ticket approvals`}
            </span>
            <ArrowRight className="w-4 h-4 shrink-0" />
          </button>
        )}
        {summary.awaitingInvoice > 0 && (
          <button
            type="button"
            onClick={onOpenBilling}
            className="inline-flex items-center justify-between gap-3 rounded-lg border border-red-300 bg-white px-3 py-2 text-left text-sm font-semibold text-red-800 hover:bg-red-100"
          >
            <span>{plural(summary.awaitingInvoice, 'rental', 'rentals')} sent and waiting to be invoiced</span>
            <ArrowRight className="w-4 h-4 shrink-0" />
          </button>
        )}
      </div>
    </div>
  )
}
