/**
 * stripeWebhook.ts — WI-08: Stripe tells us the money moved, and QuickBooks
 * finds out without anybody re-keying it.
 *
 * ── WHY A WEBHOOK AT ALL, GIVEN /confirm ALREADY EXISTS ──────────────────
 *
 * The existing flow works like this: the browser confirms the card with
 * Stripe, then calls `POST /api/payments/:id/confirm`, which re-checks with
 * Stripe and queues the QB receipt. That is fine until the browser does not
 * make the second call — the tech's iPad drops off the shop wifi, the tab is
 * closed, the app is backgrounded by iOS mid-request. The card is charged and
 * ServicePRO never hears. The customer has paid and the ticket still says
 * unpaid, which is the worst of the available failures.
 *
 * The webhook closes that: Stripe delivers the outcome server-to-server and
 * keeps retrying until we acknowledge. `/confirm` stays as the fast path, so
 * the tech gets instant feedback in the normal case; the webhook is the one
 * that guarantees it happens at all.
 *
 * Both paths therefore run for a typical payment. That is why everything below
 * is idempotent — not as defensive habit, but because the duplicate is the
 * DESIGNED behaviour.
 *
 * ── THREE LAYERS OF IDEMPOTENCY, EACH FOR A DIFFERENT FAILURE ────────────
 *
 *   1. `stripe_webhook_events.id` is the Stripe event id, as PRIMARY KEY.
 *      Stops a REPLAYED DELIVERY. Holds across concurrent deliveries on two
 *      API processes, which a check-then-act in application code would not.
 *
 *   2. `payments.status` — a payment already `succeeded` is not re-processed.
 *      Stops /confirm AND the webhook both doing the work for one payment.
 *
 *   3. A partial unique index on `qb_sync_queue(entity_id) WHERE
 *      entity_type = 'sales_receipt'`. Stops a SECOND RECEIPT reaching
 *      QuickBooks even if layers 1 and 2 are somehow both bypassed — which is
 *      the thing that actually costs money to unpick.
 *
 * Layer 3 is the one that matters most, because it is the only one enforced
 * somewhere a future code path cannot forget.
 *
 * ── FAILURES ARE RECORDED, NOT RETRIED FOREVER ───────────────────────────
 *
 * A handler that throws still leaves its event row, with the error on it. The
 * replay stays suppressed. That is deliberate: a handler failing on a poison
 * event must not become Stripe retrying it hourly and re-running whatever side
 * effects DID succeed before the throw. Somebody reads the row and fixes it
 * forward.
 */

import Stripe from 'stripe';
import { prisma } from '../index.js';
import { noteReceiptOnWorkOrder } from './paymentReceiptNote.js';

/**
 * A Stripe instance used ONLY to verify webhook signatures.
 *
 * Verification is an HMAC over the raw body with the WEBHOOK secret — it needs
 * no API credentials and makes no network call. Reusing the configured client
 * would tie this endpoint to `STRIPE_SECRET_KEY` being present, which is wrong
 * twice over: an incoming webhook can be authenticated on a server that cannot
 * itself call Stripe, and requiring the API key made this path untestable
 * anywhere the live key is absent.
 *
 * Nothing after verification calls the Stripe API either — the handler reads
 * the event payload Stripe already sent us.
 */
const verifier = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_unused_for_webhook_verification', {
  apiVersion: '2026-02-25.clover',
});

/** Events we act on. Anything else is acknowledged and ignored. */
const HANDLED = new Set([
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'charge.refunded',
]);

export class WebhookSignatureError extends Error {}

/**
 * Verify Stripe's signature over the RAW request bytes.
 *
 * The signature is computed over the exact body Stripe sent, so this must be
 * given `express.raw()` output. If the global `express.json()` has already
 * parsed and re-serialised it, key order and whitespace change and every
 * signature fails — see the parser mounted ahead of it in index.ts.
 *
 * This IS the authentication for the endpoint. There is no JWT: Stripe cannot
 * hold one. An unsigned or wrongly-signed request is rejected here and never
 * reaches a database write.
 */
export function verifyEvent(rawBody: Buffer | string, signature: string | undefined): Stripe.Event {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new WebhookSignatureError('STRIPE_WEBHOOK_SECRET is not configured');
  if (!signature) throw new WebhookSignatureError('Missing stripe-signature header');
  try {
    return verifier.webhooks.constructEvent(rawBody, signature, secret);
  } catch (err) {
    throw new WebhookSignatureError(err instanceof Error ? err.message : 'Signature verification failed');
  }
}

export interface HandleResult {
  /** false when this event had already been recorded — nothing was re-run. */
  processed: boolean;
  action: 'ignored' | 'payment_settled' | 'payment_failed' | 'refund_noted' | 'duplicate' | 'unknown_payment';
  paymentId?: string;
}

/**
 * Record the event, then act on it.
 *
 * IN THAT ORDER, deliberately. Claiming the event first means a crash midway
 * through leaves it claimed and un-processed, which is visible and fixable.
 * Acting first and recording after would mean a crash between the two re-runs
 * the side effects on Stripe's next retry.
 */
export async function handleEvent(event: Stripe.Event): Promise<HandleResult> {
  // Layer 1. The insert IS the claim; a replay violates the primary key.
  try {
    await prisma.stripeWebhookEvent.create({
      data: { id: event.id, type: event.type },
    });
  } catch {
    return { processed: false, action: 'duplicate' };
  }

  try {
    const result = await dispatch(event);
    await prisma.stripeWebhookEvent.update({
      where: { id: event.id },
      data: { processedAt: new Date(), paymentId: result.paymentId ?? null },
    });
    return { ...result, processed: true };
  } catch (err) {
    await prisma.stripeWebhookEvent.update({
      where: { id: event.id },
      data: { error: err instanceof Error ? err.message : String(err) },
    }).catch(() => { /* the throw below is the signal that matters */ });
    throw err;
  }
}

async function dispatch(event: Stripe.Event): Promise<Omit<HandleResult, 'processed'>> {
  if (!HANDLED.has(event.type)) return { action: 'ignored' };

  if (event.type === 'charge.refunded') {
    const charge = event.data.object as Stripe.Charge;
    const payment = await prisma.payment.findFirst({
      where: { stripeChargeId: charge.id },
      select: { id: true, notes: true },
    });
    if (!payment) return { action: 'unknown_payment' };
    // The refund is NOTED, not acted on. Reversing a QuickBooks receipt is an
    // accounting decision with its own approvals, and inventing a credit memo
    // from a webhook would be ServicePRO asserting an accounting fact -- the
    // exact thing WI-08's attribution rule forbids. This makes it visible to
    // the person whose job it is.
    const note = `Stripe refund ${formatCents(charge.amount_refunded)} recorded ${new Date().toISOString()} (charge ${charge.id}) — QB receipt NOT reversed automatically`;
    await prisma.payment.update({
      where: { id: payment.id },
      data: { notes: payment.notes ? `${payment.notes}\n${note}` : note },
    });
    return { action: 'refund_noted', paymentId: payment.id };
  }

  const intent = event.data.object as Stripe.PaymentIntent;
  const payment = await prisma.payment.findUnique({
    where: { stripePaymentIntentId: intent.id },
    select: { id: true, status: true, ticketId: true },
  });
  // A PaymentIntent with no ServicePRO row is not an error: the same Stripe
  // account may be used elsewhere, and acknowledging keeps Stripe from
  // retrying something we will never recognise.
  if (!payment) return { action: 'unknown_payment' };

  if (event.type === 'payment_intent.payment_failed') {
    if (payment.status === 'succeeded') return { action: 'ignored', paymentId: payment.id };
    await prisma.payment.update({ where: { id: payment.id }, data: { status: 'failed' } });
    return { action: 'payment_failed', paymentId: payment.id };
  }

  // payment_intent.succeeded — layer 2.
  if (payment.status === 'succeeded') {
    // /confirm already did the work. Still make sure the receipt is queued:
    // the two paths can interleave, and a settled payment with no receipt is
    // the failure this whole feature exists to prevent.
    await ensureSalesReceiptQueued(payment.id);
    await noteReceiptOnWorkOrder(payment.id);
    return { action: 'ignored', paymentId: payment.id };
  }

  const card = cardDetailsOf(intent);
  await prisma.payment.update({
    where: { id: payment.id },
    data: { status: 'succeeded', ...card },
  });
  await ensureSalesReceiptQueued(payment.id);
  await noteReceiptOnWorkOrder(payment.id);

  return { action: 'payment_settled', paymentId: payment.id };
}

/**
 * Queue the QuickBooks receipt, at most once per payment — layer 3.
 *
 * The unique index does the enforcing; this catches the violation so a
 * duplicate is a no-op rather than a 500 that makes Stripe retry forever.
 */
export async function ensureSalesReceiptQueued(paymentId: string): Promise<boolean> {
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    select: { qbSalesReceiptTxnId: true },
  });
  // Already in QuickBooks. Nothing to queue, and re-queuing would duplicate it
  // there, where it is expensive to unpick.
  if (payment?.qbSalesReceiptTxnId) return false;

  try {
    await prisma.qbSyncQueue.create({
      data: { entityType: 'sales_receipt', action: 'add', entityId: paymentId, priority: 5, status: 'pending' },
    });
    return true;
  } catch {
    // Unique violation: a row already exists for this payment. That is the
    // index doing its job, and the correct response is silence.
    return false;
  }
}

/** Card brand / last4 / receipt url off the intent's charge, when expanded. */
function cardDetailsOf(intent: Stripe.PaymentIntent): Record<string, string | null> {
  const charge = intent.latest_charge;
  if (typeof charge === 'string') return { stripeChargeId: charge };
  if (!charge || typeof charge !== 'object') return {};
  const c = charge as Stripe.Charge;
  return {
    stripeChargeId: c.id,
    stripeReceiptUrl: c.receipt_url ?? null,
    cardLast4: c.payment_method_details?.card?.last4 ?? null,
    cardBrand: c.payment_method_details?.card?.brand ?? null,
  };
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
