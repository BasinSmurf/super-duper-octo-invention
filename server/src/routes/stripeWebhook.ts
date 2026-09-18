/**
 * stripeWebhook.ts — the one ServicePRO endpoint Stripe talks to.
 *
 * MOUNTED OUTSIDE `/api/payments` ON PURPOSE. That router sits behind
 * `authenticate`, and Stripe cannot carry a JWT. The signature check in
 * `verifyEvent` is this endpoint's authentication, and it is a stronger one —
 * it proves the body came from Stripe unmodified, which a bearer token would
 * not.
 *
 * It also needs the RAW body, so `express.raw()` is mounted for this path
 * ahead of the global `express.json()` in index.ts. If that ordering is ever
 * disturbed every signature fails at once, which is at least loud.
 */

import { Router, Request, Response } from 'express';
import { handleEvent, verifyEvent, WebhookSignatureError } from '../services/stripeWebhook.js';

export const stripeWebhookRouter = Router();

// POST /api/stripe/webhook
stripeWebhookRouter.post('/webhook', async (req: Request, res: Response) => {
  let event;
  try {
    event = verifyEvent(req.body as Buffer, req.header('stripe-signature'));
  } catch (err) {
    // 400, not 500: a bad signature is a rejected request, and Stripe should
    // NOT retry it. Retrying an unverifiable body forever helps nobody.
    const message = err instanceof WebhookSignatureError ? err.message : 'Invalid webhook';
    console.warn('[Stripe webhook] rejected:', message);
    res.status(400).json({ error: message });
    return;
  }

  try {
    const result = await handleEvent(event);
    if (result.action !== 'ignored' && result.action !== 'duplicate') {
      console.log(`[Stripe webhook] ${event.type} → ${result.action}${result.paymentId ? ` (payment ${result.paymentId})` : ''}`);
    }
    res.json({ received: true, ...result });
  } catch (err) {
    // 500 so Stripe retries. The event row is already written with the error on
    // it, so the retry is suppressed by the primary key and simply reports the
    // same failure -- which is what we want: visible, bounded, and not
    // re-running side effects.
    console.error('[Stripe webhook] handler failed:', err instanceof Error ? err.message : err);
    res.status(500).json({ error: 'Webhook handler failed' });
  }
});
