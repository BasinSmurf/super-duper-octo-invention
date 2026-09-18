/**
 * paymentReceiptNote.ts — putting the Stripe receipt where somebody will find
 * it in six weeks.
 *
 * Stripe emails its own receipt to the drop-off contact the moment a counter
 * payment settles (see `receipt_email` in stripeClient). That covers the
 * customer and covers nothing else: the person who has to answer "what did we
 * charge them at the counter?" is standing in ServicePRO, not in the customer's
 * inbox, and the hosted receipt URL was being stored on the Payment row where
 * no screen ever read it.
 *
 * So the URL is also appended to the work order's contact log. Not as a new
 * kind of record -- as exactly what it is: a `customer` / `email` entry saying
 * we emailed them a receipt, which is true, and which puts it in the same
 * chronological list as every other thing anyone said to this customer.
 *
 * WHY THIS RUNS SERVER-SIDE, AND TWICE
 *
 * The receipt URL first exists when Stripe settles the charge, which reaches us
 * down two paths that race: the client's confirm call and the webhook. Writing
 * the note from the browser would lose it whenever the counter person closed
 * the tab, so it sits beside `ensureSalesReceiptQueued` and is called from both
 * settlement paths, guarded the same way -- at most one note per payment.
 */

import { prisma } from '../index.js';

/**
 * Append the receipt link to the work order's contact log, at most once.
 *
 * Returns false whenever there is nothing to write or a note already exists.
 * Never throws: a settled payment must not be rolled back, nor a Stripe webhook
 * retried forever, because a log entry could not be appended.
 */
export async function noteReceiptOnWorkOrder(paymentId: string): Promise<boolean> {
  try {
    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      select: {
        id: true,
        amount: true,
        ccFeeAmount: true,
        status: true,
        shopWorkOrderId: true,
        stripeReceiptUrl: true,
        cardBrand: true,
        cardLast4: true,
        createdById: true,
        shopWorkOrder: { select: { dropOffContactEmail: true, pickupContactEmail: true } },
      },
    });

    // Only settled shop-order payments that actually have a receipt. A payment
    // with no hosted URL has nothing to link, and inventing a note that says a
    // receipt exists would be worse than the silence it replaces.
    if (!payment || payment.status !== 'succeeded') return false;
    if (!payment.shopWorkOrderId || !payment.stripeReceiptUrl) return false;

    // Idempotency: the confirm call and the webhook both land here. Matching on
    // the payment id rather than the URL because the URL is Stripe's and could
    // in principle be reissued, while the id is ours and cannot.
    const existing = await prisma.shopContactLogEntry.findFirst({
      where: { workOrderId: payment.shopWorkOrderId, note: { contains: payment.id } },
      select: { id: true },
    });
    if (existing) return false;

    const to = payment.shopWorkOrder?.dropOffContactEmail
      || payment.shopWorkOrder?.pickupContactEmail
      || null;
    const card = payment.cardBrand && payment.cardLast4
      ? ` on ${payment.cardBrand} ····${payment.cardLast4}`
      : '';
    const fee = payment.ccFeeAmount && Number(payment.ccFeeAmount) > 0
      ? ` (includes $${Number(payment.ccFeeAmount).toFixed(2)} card fee)`
      : '';
    // "Receipt emailed to ..." only when Stripe was given an address. Where
    // there was none, the note says the receipt exists and is linked, without
    // claiming anybody received it -- the same reporting-not-asserting rule the
    // rest of this feature runs on.
    const delivery = to
      ? `Receipt emailed to ${to}`
      : 'Receipt available (no contact email on file — nothing was sent)';

    await prisma.shopContactLogEntry.create({
      data: {
        workOrderId: payment.shopWorkOrderId,
        party: 'customer',
        method: 'email',
        note: `${delivery} — card payment of $${Number(payment.amount).toFixed(2)}${card}${fee}. `
          + `Stripe receipt: ${payment.stripeReceiptUrl} (payment ${payment.id})`,
        contactedAt: new Date(),
        followUpAt: null,
        entererById: payment.createdById,
        enteredByName: 'ServicePRO (automatic)',
      },
    });
    return true;
  } catch (err) {
    console.error(`[Receipt note] Could not log receipt for payment ${paymentId}:`, err);
    return false;
  }
}
