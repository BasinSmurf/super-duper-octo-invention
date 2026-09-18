/**
 * Stripe SDK wrapper
 *
 * Initializes the Stripe client and exposes helpers for PaymentIntent lifecycle.
 */

import Stripe from 'stripe';

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';

if (!STRIPE_SECRET_KEY) {
  console.warn('[Stripe] STRIPE_SECRET_KEY not set — payment processing disabled');
}

export const stripe = STRIPE_SECRET_KEY
  ? new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2026-02-25.clover' })
  : null;

export function getPublishableKey(): string {
  return process.env.STRIPE_PUBLISHABLE_KEY || '';
}

export async function createPaymentIntent(
  amount: number,
  currency: string = 'usd',
  metadata: Record<string, string> = {},
  receiptEmail?: string | null,
): Promise<{ clientSecret: string; paymentIntentId: string }> {
  if (!stripe) throw new Error('Stripe is not configured');

  const intent = await stripe.paymentIntents.create({
    amount,           // in cents
    currency,
    metadata,
    automatic_payment_methods: { enabled: true },
    // Stripe sends this receipt from its own servers on settlement. That is the
    // point of using it rather than our mailer: prod has no SMTP credentials
    // configured, so anything we tried to send ourselves would fail silently,
    // and a counter payment whose receipt never arrives is the complaint this
    // is here to prevent. Omitted entirely when there is no address -- Stripe
    // rejects an empty string.
    ...(receiptEmail ? { receipt_email: receiptEmail } : {}),
  });

  return {
    clientSecret: intent.client_secret!,
    paymentIntentId: intent.id,
  };
}

export async function retrievePaymentIntent(id: string): Promise<Stripe.PaymentIntent> {
  if (!stripe) throw new Error('Stripe is not configured');
  return stripe.paymentIntents.retrieve(id);
}
