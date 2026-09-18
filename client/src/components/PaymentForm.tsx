import { useState } from 'react'
import { CardElement, useStripe, useElements } from '@stripe/react-stripe-js'
import { api } from '@/lib/api'

interface PaymentFormProps {
  amount: number          // in dollars
  ticketId?: string
  shopWorkOrderId?: string
  invoiceId?: string
  companyId?: string | null
  description?: string
  // Direct-sale counter receipts: pre-tax basket + chosen jurisdiction, persisted
  // so the QB SalesReceipt is rebuilt from real lines and QB recomputes tax.
  lineItems?: Array<{ productId?: string | null; description: string; quantity: number; unitPrice: number; taxable: boolean }>
  taxJurisdictionId?: string | null
  /**
   * How much of `amount` is a card surcharge rather than value the customer
   * received. Recorded on the Payment so anything that later credits this money
   * against work can credit the work portion only — the fee went to the card
   * network, and crediting it would refund the surcharge as free work.
   */
  ccFeeAmount?: number
  onSuccess: (payment: any) => void
  onError?: (error: string) => void
  disabled?: boolean
}

export function PaymentForm({
  amount,
  ticketId,
  shopWorkOrderId,
  invoiceId,
  companyId,
  description,
  lineItems,
  taxJurisdictionId,
  ccFeeAmount,
  onSuccess,
  onError,
  disabled,
}: PaymentFormProps) {
  const stripe = useStripe()
  const elements = useElements()
  const [processing, setProcessing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!stripe || !elements || processing || disabled) return

    setProcessing(true)
    setError(null)

    try {
      // 1. Create PaymentIntent on server
      const { clientSecret, paymentId } = await api.post<{
        clientSecret: string
        paymentId: string
      }>('/payments/intent', {
        amount,
        ticketId,
        shopWorkOrderId,
        invoiceId,
        companyId,
        description,
        lineItems,
        taxJurisdictionId,
        ccFeeAmount,
      })

      // 2. Confirm with Stripe
      const card = elements.getElement(CardElement)
      if (!card) throw new Error('Card element not found')

      const result = await stripe.confirmCardPayment(clientSecret, {
        payment_method: { card },
      })

      if (result.error) {
        throw new Error(result.error.message || 'Payment failed')
      }

      if (result.paymentIntent?.status !== 'succeeded') {
        throw new Error(`Unexpected status: ${result.paymentIntent?.status}`)
      }

      // 3. Confirm on server (saves card details, queues QB)
      const payment = await api.post(`/payments/${paymentId}/confirm`)
      onSuccess(payment)
    } catch (err: any) {
      const msg = err.message || 'Payment failed'
      setError(msg)
      onError?.(msg)
    } finally {
      setProcessing(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="border border-slate-300 rounded-lg p-3 bg-white">
        <CardElement
          options={{
            style: {
              base: {
                fontSize: '16px',
                color: '#334155',
                '::placeholder': { color: '#94a3b8' },
              },
              invalid: { color: '#ef4444' },
            },
          }}
        />
      </div>

      {error && (
        <p className="text-sm text-red-600">{error}</p>
      )}

      <button
        type="submit"
        disabled={!stripe || processing || disabled || amount <= 0}
        className="w-full py-3 px-4 bg-blue-600 text-white font-semibold rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {processing ? 'Processing...' : `Pay $${amount.toFixed(2)}`}
      </button>
    </form>
  )
}
