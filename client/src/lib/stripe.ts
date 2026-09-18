import { loadStripe, type Stripe } from '@stripe/stripe-js'
import { api } from './api'

let stripePromise: Promise<Stripe | null> | null = null

export function getStripe(): Promise<Stripe | null> {
  if (!stripePromise) {
    stripePromise = api
      .get<{ publishableKey: string }>('/payments/config')
      .then(({ publishableKey }) => {
        if (!publishableKey) return null
        return loadStripe(publishableKey)
      })
      .catch(() => null)
  }
  return stripePromise
}
