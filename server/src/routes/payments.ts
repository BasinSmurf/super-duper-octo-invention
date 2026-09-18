/**
 * Payment API routes
 *
 * Handles Stripe PaymentIntent creation, confirmation, and payment listing.
 */

import { Router, Request, Response } from 'express';
import { prisma } from '../index.js';
import { createPaymentIntent, retrievePaymentIntent, getPublishableKey } from '../services/stripeClient.js';
import { ensureSalesReceiptQueued } from '../services/stripeWebhook.js';
import { noteReceiptOnWorkOrder } from '../services/paymentReceiptNote.js';

export const paymentsRouter = Router();

// GET /api/payments/config — return Stripe publishable key (no secrets)
paymentsRouter.get('/config', (_req: Request, res: Response) => {
  const key = getPublishableKey();
  if (!key) {
    res.status(503).json({ error: 'Stripe not configured' });
    return;
  }
  res.json({ publishableKey: key });
});

// POST /api/payments/intent — create a PaymentIntent + pending Payment record
paymentsRouter.post('/intent', async (req: Request, res: Response) => {
  try {
    const { amount, ticketId, shopWorkOrderId, invoiceId, companyId, description, lineItems, taxJurisdictionId, ccFeeAmount, receiptEmail } = req.body;
    const userId = (req as any).user?.userId;

    if (!amount || amount <= 0) {
      res.status(400).json({ error: 'amount is required and must be > 0' });
      return;
    }

    if (!userId) {
      res.status(401).json({ error: 'User required' });
      return;
    }

    // The surcharge portion of `amount`. Bounded on both sides: a negative fee
    // would inflate what this payment credits against the work, and a fee at or
    // above the whole charge would mean the customer paid a processing fee and
    // bought nothing, which is a client bug rather than a transaction.
    const ccFee = Number(ccFeeAmount) || 0;
    if (ccFee < 0 || ccFee >= amount) {
      res.status(400).json({ error: 'ccFeeAmount must be between 0 and the amount charged' });
      return;
    }

    // Amount comes in dollars from client — convert to cents for Stripe
    const amountCents = Math.round(amount * 100);

    // Where Stripe mails the receipt. Resolved SERVER-SIDE from the work order
    // when the caller does not name one, so the counter path gets a receipt
    // without the panel having to know the contact fields, and so the address
    // is the one on the record rather than whatever a request body asserted.
    let receipt: string | null = typeof receiptEmail === 'string' && receiptEmail.includes('@')
      ? receiptEmail.trim()
      : null;
    if (!receipt && shopWorkOrderId) {
      const wo = await prisma.shopWorkOrder.findUnique({
        where: { id: shopWorkOrderId },
        select: { dropOffContactEmail: true, pickupContactEmail: true },
      });
      receipt = wo?.dropOffContactEmail || wo?.pickupContactEmail || null;
    }

    const metadata: Record<string, string> = {};
    if (ticketId) metadata.ticketId = ticketId;
    if (shopWorkOrderId) metadata.shopWorkOrderId = shopWorkOrderId;
    if (invoiceId) metadata.invoiceId = invoiceId;
    if (description) metadata.description = description;

    const { clientSecret, paymentIntentId } = await createPaymentIntent(amountCents, 'usd', metadata, receipt);

    // Create pending Payment record
    const payment = await prisma.payment.create({
      data: {
        amount,
        paymentMethod: 'credit_card',
        status: 'pending',
        stripePaymentIntentId: paymentIntentId,
        ticketId: ticketId || null,
        shopWorkOrderId: shopWorkOrderId || null,
        invoiceId: invoiceId || null,
        companyId: companyId || null,
        notes: description || null,
        taxJurisdictionId: taxJurisdictionId || null,
        ccFeeAmount: ccFee > 0 ? ccFee : null,
        lineItemsJson: Array.isArray(lineItems) && lineItems.length > 0 ? lineItems : undefined,
        createdById: userId,
      },
    });

    res.json({ clientSecret, paymentId: payment.id, receiptEmail: receipt });
  } catch (err: any) {
    console.error('[Payments] Error creating intent:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/payments/:id/confirm — called after Stripe confirms payment on client
paymentsRouter.post('/:id/confirm', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const payment = await prisma.payment.findUnique({ where: { id: id as string } });
    if (!payment) {
      res.status(404).json({ error: 'Payment not found' });
      return;
    }

    if (!payment.stripePaymentIntentId) {
      res.status(400).json({ error: 'No Stripe PaymentIntent linked' });
      return;
    }

    // Verify with Stripe
    const intent = await retrievePaymentIntent(payment.stripePaymentIntentId);

    if (intent.status !== 'succeeded') {
      res.status(400).json({ error: `Payment not succeeded, status: ${intent.status}` });
      return;
    }

    // Already settled — by an earlier call, or by the Stripe webhook that races
    // this one. Return the record rather than re-writing it, but still make sure
    // the receipt is queued: a settled payment with no receipt is the failure
    // this whole path exists to prevent.
    if (payment.status === 'succeeded') {
      await ensureSalesReceiptQueued(payment.id);
      await noteReceiptOnWorkOrder(payment.id);
      res.json(payment);
      return;
    }

    // Extract card details from the charge
    const charge = intent.latest_charge;
    let cardLast4: string | null = null;
    let cardBrand: string | null = null;
    let stripeChargeId: string | null = null;
    let stripeReceiptUrl: string | null = null;

    if (typeof charge === 'object' && charge !== null) {
      stripeChargeId = charge.id;
      stripeReceiptUrl = charge.receipt_url || null;
      if (charge.payment_method_details?.card) {
        cardLast4 = charge.payment_method_details.card.last4 || null;
        cardBrand = charge.payment_method_details.card.brand || null;
      }
    } else if (typeof charge === 'string') {
      stripeChargeId = charge;
    }

    // Update payment record
    const updated = await prisma.payment.update({
      where: { id: id as string },
      data: {
        status: 'succeeded',
        stripeChargeId,
        stripeReceiptUrl,
        cardLast4,
        cardBrand,
      },
    });

    // Queue the QB SalesReceipt — at most once per payment.
    //
    // This route had no guard: a double-clicked button or a retried request
    // queued a second receipt for the same money, and the discrepancy showed up
    // in QuickBooks rather than here. Now shared with the Stripe webhook, which
    // legitimately runs for the same payment, and backed by a unique index so
    // neither path has to remember.
    await ensureSalesReceiptQueued(payment.id);
    // Link the hosted Stripe receipt into the work order's contact log, so the
    // counter has a record of what was charged without going to the customer's
    // inbox for it. Same at-most-once guard, same two racing callers.
    await noteReceiptOnWorkOrder(payment.id);

    res.json(updated);
  } catch (err: any) {
    console.error('[Payments] Error confirming:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/payments/cash — record a cash/check/invoice payment (no Stripe involved)
paymentsRouter.post('/cash', async (req: Request, res: Response) => {
  try {
    const { amount, paymentMethod, ticketId, shopWorkOrderId, invoiceId, companyId, signature, description, lineItems, taxJurisdictionId } = req.body;
    const userId = (req as any).user?.userId;

    if (!amount || amount <= 0) {
      res.status(400).json({ error: 'amount is required and must be > 0' });
      return;
    }
    if (!paymentMethod || !['cash', 'check', 'invoice'].includes(paymentMethod)) {
      res.status(400).json({ error: 'paymentMethod must be cash, check, or invoice' });
      return;
    }
    if (paymentMethod === 'invoice' && !companyId) {
      res.status(400).json({ error: 'companyId is required for invoice payments' });
      return;
    }
    if (!userId) {
      res.status(401).json({ error: 'User required' });
      return;
    }

    // Map 'invoice' → 'account' for Prisma PaymentMethod enum
    const dbPaymentMethod = paymentMethod === 'invoice' ? 'account' : paymentMethod;

    const payment = await prisma.payment.create({
      data: {
        amount,
        paymentMethod: dbPaymentMethod,
        status: paymentMethod === 'invoice' ? 'pending' : 'succeeded',
        ticketId: ticketId || null,
        shopWorkOrderId: shopWorkOrderId || null,
        invoiceId: invoiceId || null,
        companyId: companyId || null,
        customerSignature: signature || null,
        notes: description || null,
        taxJurisdictionId: taxJurisdictionId || null,
        lineItemsJson: Array.isArray(lineItems) && lineItems.length > 0 ? lineItems : undefined,
        createdById: userId,
      },
    });

    // Queue QB SalesReceipt for cash/check (invoices go through billing queue instead)
    if (paymentMethod !== 'invoice') {
      // Same one-receipt-per-payment guarantee as the card path.
      await ensureSalesReceiptQueued(payment.id);
    }

    res.json(payment);
  } catch (err: any) {
    console.error('[Payments] Error recording payment:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/payments/:id — get single payment
paymentsRouter.get('/:id', async (req: Request, res: Response) => {
  try {
    const payment = await prisma.payment.findUnique({
      where: { id: req.params.id as string },
      include: { createdBy: { select: { id: true, name: true } } },
    });
    if (!payment) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.json(payment);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/payments — list payments
paymentsRouter.get('/', async (req: Request, res: Response) => {
  try {
    const { ticketId, shopWorkOrderId, invoiceId, status, limit = '50' } = req.query;

    const where: any = {};
    if (ticketId) where.ticketId = ticketId;
    if (shopWorkOrderId) where.shopWorkOrderId = shopWorkOrderId;
    if (invoiceId) where.invoiceId = invoiceId;
    if (status) where.status = status;

    const payments = await prisma.payment.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Math.min(parseInt(limit as string) || 50, 200),
      include: { createdBy: { select: { id: true, name: true } } },
    });

    res.json({ data: payments });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
