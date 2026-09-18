/**
 * PayAtDropPanel — WI-08: taking the money at the counter.
 *
 * SURFACED AT INTAKE, not only at release. Card collection already existed on
 * the release form; the whole point of this item is that a monitor calibration
 * is paid when the customer HANDS IT OVER, while they are still standing there.
 * Catching them again at pickup is the thing that was not working.
 *
 * TWO PATHS, AND THEY ARE NOT SYMMETRICAL.
 *
 *   Stripe      ServicePRO watches the money move and gets told by Stripe
 *               itself. It can state an amount, because it has one.
 *
 *   Lightspeed  the money moves through a POS this system cannot see. All
 *               ServicePRO gets is a number a person reads off a slip. So the
 *               panel asks for that number and says plainly that the amount
 *               lives in Lightspeed — it does not print the order total and
 *               imply that is what was collected.
 *
 * The asymmetry is deliberate and is the §2 attribution rule made visible: the
 * QB receipt is the accounting fact, and ServicePRO is reporting on it with the
 * source named, never asserting it.
 *
 * ── THE AMOUNT IS TYPED, NOT DERIVED ─────────────────────────────────────
 *
 * This panel originally charged `data.total` and disabled itself when that was
 * zero. Zero is the normal case at drop-off: a shop WO has no stored total, it
 * is derived from units, and no unit is priced until a tech opens the thing --
 * so the one moment the customer is standing at the counter was the one moment
 * the panel refused to take their money.
 *
 * So the counter names the figure. It is a payment ON ACCOUNT, not a priced
 * sale: whatever is typed goes against the job, the real line items are settled
 * later, and the difference either way is due at handoff. Nothing here has to
 * guess what the job will cost, which is the only reason it can run before the
 * job is understood.
 *
 * The convenience fee rides ON TOP of that figure rather than inside it, the
 * same way DirectSalePage does it: the customer is charged amount + fee, and
 * the fee is an explicit line on the receipt rather than a silent markup. It is
 * also sent as `ccFeeAmount` so the server can credit the work portion only --
 * crediting the surcharge would refund it as free labour at handoff.
 */

import { useCallback, useEffect, useState } from 'react'
import { Elements } from '@stripe/react-stripe-js'
import type { Stripe } from '@stripe/stripe-js'
import { getStripe } from '@/lib/stripe'
import { api } from '@/lib/api'
import { PaymentForm } from '@/components/PaymentForm'
import { CreditCard, Store, CheckCircle, Loader2, AlertTriangle, Receipt, ExternalLink } from 'lucide-react'
import { DEFAULT_CC_FEE_PCT } from '@/lib/taxJurisdictions'

export interface PaidAtDropReceipt {
  url: string
  amount: number
  ccFee: number
  cardBrand: string | null
  cardLast4: string | null
  paidAt: string
}

export interface BillingRouteResponse {
  route: 'standard' | 'exempt' | 'overage'
  total: number
  collected?: number
  amountDue?: number
  paidAtDropVia: 'stripe' | 'lightspeed' | null
  lightspeedTxnNumber: string | null
  attribution: string | null
  unitsPending: number
  receipts: PaidAtDropReceipt[]
  ccFeesCollected: number
  /** Where Stripe will mail the receipt, straight off the work order. */
  receiptEmail: string | null
}

interface Props {
  workOrderId: string
  workOrderNumber: string | null
  /**
   * Whose payment this is. Without it the QB SalesReceipt falls back to the
   * walk-in customer, because the receipt is rebuilt from the line snapshot
   * this panel sends and that branch resolves the customer off the payment.
   */
  companyId?: string | null
  /** Re-read after anything that could move the total or the money. */
  refreshKey?: number
  onChanged?: () => void
}

export function PayAtDropPanel({ workOrderId, workOrderNumber, companyId, refreshKey = 0, onChanged }: Props) {
  const [data, setData] = useState<BillingRouteResponse | null>(null)
  const [stripePromise] = useState<Promise<Stripe | null> | null>(() => getStripe())
  const [mode, setMode] = useState<'idle' | 'card' | 'lightspeed'>('idle')
  const [txn, setTxn] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // What the counter is collecting, as typed. A STRING, not a number: a
  // controlled numeric input that round-trips through parseFloat eats the
  // half-typed states ("12.", "0.0") and fights whoever is entering it.
  const [amountText, setAmountText] = useState('')
  const [ccFeePct, setCcFeePct] = useState(DEFAULT_CC_FEE_PCT)
  // null = still resolving; false = Stripe.js never loaded (no publishable key
  // configured on this server). The two want opposite UI -- a spinner and an
  // explanation -- so they are distinguished rather than collapsed.
  const [cardAvailable, setCardAvailable] = useState<boolean | null>(null)

  const load = useCallback(async () => {
    try {
      setData(await api.get<BillingRouteResponse>(`/shop-orders/${workOrderId}/billing-route`))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read the balance')
    }
  }, [workOrderId])

  // Stripe.js is loaded lazily and only once. Resolved in the initialiser
  // rather than in an effect — it is a module-level promise, not state that
  // synchronises with anything, and setting it in an effect is a render the
  // component does not need.
  useEffect(() => { void load() }, [load, refreshKey])

  useEffect(() => {
    let cancelled = false
    void stripePromise?.then((sdk) => { if (!cancelled) setCardAvailable(!!sdk) })
      .catch(() => { if (!cancelled) setCardAvailable(false) })
    return () => { cancelled = true }
  }, [stripePromise])

  async function setLightspeed() {
    if (!txn.trim()) return
    setBusy(true)
    setError('')
    try {
      await api.patch(`/shop-orders/${workOrderId}/paid-at-drop`, {
        via: 'lightspeed',
        lightspeedTxnNumber: txn.trim(),
      })
      setMode('idle')
      setTxn('')
      await load()
      onChanged?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not record the reference')
    } finally {
      setBusy(false)
    }
  }

  async function clearPaidAtDrop() {
    setBusy(true)
    try {
      await api.patch(`/shop-orders/${workOrderId}/paid-at-drop`, { via: null })
      await load()
      onChanged?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not clear it')
    } finally {
      setBusy(false)
    }
  }

  if (!data) return null

  const settled = data.route === 'exempt'
  const overage = data.route === 'overage'

  // What the balance suggests, when there is one. Only ever a PREFILL: at
  // drop-off the order is usually $0 and the counter names the figure itself.
  const suggested = overage ? data.amountDue ?? 0 : data.total
  const toward = Math.max(0, Math.round((parseFloat(amountText) || 0) * 100) / 100)
  const ccFee = Math.round(toward * (ccFeePct / 100) * 100) / 100
  const charge = Math.round((toward + ccFee) * 100) / 100

  function openCard() {
    // Prefill only from a real balance. Seeding "0.00" into the box would make
    // the counter clear it before typing, every time.
    setAmountText(suggested > 0 ? suggested.toFixed(2) : '')
    setMode('card')
  }

  return (
    <div className="bg-white rounded-lg border border-slate-200 p-4 mb-4">
      <h3 className="text-sm font-semibold text-slate-700 mb-1 flex items-center gap-1.5">
        <CreditCard className="w-4 h-4 text-slate-400" />
        Pay at Drop-off
      </h3>
      <p className="text-xs text-slate-500 mb-3">
        Calibration is paid at the counter. Collecting here keeps the job out of the billing
        queue entirely — the QuickBooks receipt is the record.
      </p>

      {/* What is owed. One number, derived server-side so this and the billing
          card cannot disagree about whether the customer still owes anything. */}
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 mb-3">
        <span className="text-2xl font-bold text-slate-900">
          ${(overage ? data.amountDue ?? 0 : data.total).toFixed(2)}
        </span>
        <span className="text-xs text-slate-500">
          {overage ? 'still due' : settled ? 'order total — settled' : 'order total'}
        </span>
        {data.unitsPending > 0 && (
          <span className="text-[11px] text-amber-700">
            {data.unitsPending} unit{data.unitsPending === 1 ? '' : 's'} still inside the 48-hour
            window — the total can still move
          </span>
        )}
      </div>

      {data.attribution && (
        <p className="text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-md px-2.5 py-2 mb-3 flex items-start gap-1.5">
          <CheckCircle className="w-3.5 h-3.5 shrink-0 mt-px" />
          <span>{data.attribution}</span>
        </p>
      )}

      {/* The hosted Stripe receipts. Already stored on every payment and never
          shown until now, which meant re-sending one, or just reading back what
          was charged, meant opening the Stripe dashboard. */}
      {data.receipts.length > 0 && (
        <div className="mb-3 space-y-1">
          {data.receipts.map(r => (
            <a
              key={r.url} href={r.url} target="_blank" rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-xs text-blue-700 hover:text-blue-800 hover:underline"
            >
              <Receipt className="w-3.5 h-3.5 shrink-0" />
              <span>
                Receipt — ${r.amount.toFixed(2)}
                {r.ccFee > 0 && ` (incl. $${r.ccFee.toFixed(2)} fee)`}
                {r.cardBrand && r.cardLast4 && ` · ${r.cardBrand} ····${r.cardLast4}`}
                {' · '}{new Date(r.paidAt).toLocaleDateString('en-US')}
              </span>
              <ExternalLink className="w-3 h-3 shrink-0 opacity-60" />
            </a>
          ))}
        </div>
      )}

      {overage && (
        <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-2.5 py-2 mb-3 flex items-start gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
          <span>
            Work was added after payment. This order bills for the
            {' '}<strong>${(data.amountDue ?? 0).toFixed(2)} difference only</strong> — the invoice
            carries what was already collected as a credit line, so the reduced total explains
            itself. Take the difference at handoff, or let it bill.
          </span>
        </p>
      )}

      {settled ? (
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-500">
            Recorded as paid via {data.paidAtDropVia === 'lightspeed' ? 'Lightspeed' : 'card'}.
          </span>
          <button
            type="button" onClick={clearPaidAtDrop} disabled={busy}
            className="text-xs text-slate-500 underline hover:text-slate-700"
          >
            Not paid after all
          </button>
        </div>
      ) : mode === 'idle' ? (
        <div className="flex flex-wrap gap-2">
          {/* NOT disabled on a zero total any more. That guard was the bug: at
              drop-off nothing is priced yet, so the balance is $0 and the one
              moment the customer is at the counter was the one moment this
              refused to take their money. The amount is typed on the next
              screen instead. */}
          <button
            type="button" onClick={openCard}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold bg-blue-700 text-white hover:bg-blue-600"
          >
            <CreditCard className="w-3.5 h-3.5" /> Take card payment
          </button>
          <button
            type="button" onClick={() => setMode('lightspeed')}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold border border-slate-300 text-slate-700 hover:bg-slate-50"
          >
            <Store className="w-3.5 h-3.5" /> Rang through Lightspeed
          </button>
        </div>
      ) : mode === 'card' ? (
        <div className="rounded-lg border border-slate-200 p-3">
          {cardAvailable === false ? (
            /* Card processing is not configured on this server. Say so, and point
               at the path that still works, rather than spinning forever --
               §2's degrade-gracefully rule, never a blocked technician. */
            <div className="text-xs text-amber-800">
              <p className="font-medium mb-1">Card processing isn&rsquo;t configured on this server.</p>
              <p>Take the payment through Lightspeed and record the transaction number instead, or bill this order normally.</p>
            </div>
          ) : cardAvailable && stripePromise ? (
            <>
              {/* The figure the counter names. This is the feature. */}
              <label className="block text-[10px] font-medium text-slate-600 uppercase tracking-wide mb-1">
                Amount to apply to this job
              </label>
              <div className="relative mb-2">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm">$</span>
                <input
                  autoFocus
                  type="text"
                  inputMode="decimal"
                  value={amountText}
                  onChange={e => setAmountText(e.target.value.replace(/[^0-9.]/g, ''))}
                  placeholder="0.00"
                  className="w-full pl-7 pr-3 py-2 border border-slate-300 rounded-lg text-lg font-semibold"
                />
              </div>
              <p className="text-[11px] text-slate-500 mb-3">
                A payment against the job, not a priced sale — nothing here has to match what the
                work finally costs. The real line items settle later and the difference either way
                is due at handoff.
              </p>

              <div className="rounded-md bg-slate-50 border border-slate-200 px-3 py-2 mb-3 space-y-1">
                <div className="flex justify-between text-xs text-slate-600">
                  <span>Applied to job</span>
                  <span className="tabular-nums">${toward.toFixed(2)}</span>
                </div>
                <div className="flex justify-between items-center text-xs text-slate-600">
                  <span className="flex items-center gap-1">
                    Convenience fee
                    <input
                      type="number" min={0} max={20} step={0.5}
                      value={ccFeePct}
                      onChange={e => setCcFeePct(Math.max(0, Math.min(20, Number(e.target.value) || 0)))}
                      className="w-12 px-1 py-0.5 border border-slate-300 rounded text-[11px] text-right"
                    />
                    %
                  </span>
                  <span className="tabular-nums">${ccFee.toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-sm font-semibold text-slate-900 pt-1 border-t border-slate-200">
                  <span>Card is charged</span>
                  <span className="tabular-nums">${charge.toFixed(2)}</span>
                </div>
                {/* Said out loud because the two numbers differ and the counter
                    is about to read one of them to a customer. The fee is the
                    card's cost, so it never comes off the job. */}
                <p className="text-[11px] text-slate-500 pt-0.5">
                  The fee goes to the card network, so only the ${toward.toFixed(2)} comes off what
                  is owed at handoff.
                </p>
              </div>

              <p className="text-[11px] text-slate-500 mb-2 flex items-start gap-1.5">
                <Receipt className="w-3.5 h-3.5 shrink-0 mt-px text-slate-400" />
                <span>
                  {data.receiptEmail
                    ? <>Stripe emails the receipt to <strong>{data.receiptEmail}</strong>, and the link is filed in this order&rsquo;s contact log.</>
                    : <>No contact email on this work order — nothing will be emailed, but the receipt link is still filed in the contact log. Add a drop-off email to send it.</>}
                </span>
              </p>

              <Elements stripe={stripePromise}>
                <PaymentForm
                  amount={charge}
                  disabled={toward <= 0}
                  shopWorkOrderId={workOrderId}
                  companyId={companyId ?? undefined}
                  description={`Shop WO ${workOrderNumber || workOrderId} — paid at drop`}
                  ccFeeAmount={ccFee}
                  // The QB SalesReceipt is rebuilt from this snapshot. Without
                  // it the receipt branch falls back to the WO's items and
                  // their `estimatedCost`, which at drop-off is zero — QB would
                  // book a $0 receipt against a real card charge. Non-taxable
                  // on both lines: this is money on account, and the tax on the
                  // actual work is computed on the final invoice.
                  lineItems={[
                    {
                      description: `Payment on account — Shop WO ${workOrderNumber || workOrderId}`,
                      quantity: 1,
                      unitPrice: toward,
                      taxable: false,
                    },
                    ...(ccFee > 0 ? [{
                      description: `Convenience fee (${ccFeePct}%)`,
                      quantity: 1,
                      unitPrice: ccFee,
                      taxable: false,
                    }] : []),
                  ]}
                  onSuccess={async () => {
                    // Mark the route so the order is recognised as counter-paid
                    // even before the webhook lands.
                    await api.patch(`/shop-orders/${workOrderId}/paid-at-drop`, { via: 'stripe' })
                      .catch(() => { /* the payment is what matters; this is a label */ })
                    setMode('idle')
                    setAmountText('')
                    await load()
                    onChanged?.()
                  }}
                />
              </Elements>
            </>
          ) : (
            <Loader2 className="w-4 h-4 animate-spin text-slate-400" />
          )}
          <button
            type="button" onClick={() => setMode('idle')}
            className="mt-2 text-xs text-slate-500 underline"
          >
            Cancel
          </button>
        </div>
      ) : (
        <div className="rounded-lg border border-slate-200 p-3 space-y-2">
          <label className="block text-[10px] font-medium text-slate-600 uppercase tracking-wide">
            Lightspeed transaction number
          </label>
          <input
            autoFocus
            value={txn}
            onChange={e => setTxn(e.target.value)}
            placeholder="e.g. LS-44712"
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
          />
          <p className="text-[11px] text-slate-500">
            The amount stays in Lightspeed — ServicePRO records only the reference, so the
            manual QuickBooks entry can be matched back to this order. It does not claim to
            know what was collected.
          </p>
          <div className="flex gap-2">
            <button
              type="button" onClick={setLightspeed} disabled={!txn.trim() || busy}
              className="px-3 py-2 rounded-lg text-xs font-semibold bg-slate-700 text-white hover:bg-slate-600 disabled:opacity-40"
            >
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Record reference'}
            </button>
            <button
              type="button" onClick={() => { setMode('idle'); setTxn('') }}
              className="px-3 py-2 rounded-lg text-xs font-medium border border-slate-300 text-slate-600"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && <p className="text-xs text-red-700 mt-2">{error}</p>}
    </div>
  )
}
