// Billing Lineage Phase 1 — the guard for the ONE billing field ServicePRO
// owns (Rule 1). Every write to ServiceTicket.billingReadiness must go
// through here, never a raw `prisma.serviceTicket.update({ data: { billingReadiness... } })`
// elsewhere — that's what keeps the guards in the handoff's §2.1 real instead
// of decorative.

import { prisma, type Prisma } from '../db.js';
import { AppError } from '../middleware/errorHandler.js';
import type { BillingReadiness } from '../generated/prisma/client.js';

export interface SetBillingReadinessInput {
  next: BillingReadiness;
  actorUserId: string;
  /** Required when next === 'not_billable'; ignored otherwise. */
  reasonCode?: string | null;
}

/**
 * Apply a billingReadiness transition with its guards, or throw AppError(400)
 * with a message safe to surface to the caller.
 *
 * - ready: requires a service date, and a signed-ticket artifact if the
 *   customer's billing profile requires one (CustomerBillingProfile.signatureRequired).
 * - not_billable: requires a reasonCode that resolves to an active
 *   BillingReasonCode row, plus the actor — this is "the single most likely
 *   place for money to hide," per the handoff, so it's never optional.
 * - invoiced / submitted: rejected outright. Nothing produces these
 *   transitions yet (that's Phase 2/4 — the derived-invoice process and the
 *   OpenInvoice submission process); Phase 1 just closes the door on a human
 *   setting them directly, ahead of those processes existing.
 */
export async function setBillingReadiness(ticketId: string, input: SetBillingReadinessInput, db: Prisma.TransactionClient = prisma) {
  if (input.next === 'invoiced' || input.next === 'submitted') {
    throw new AppError(
      400,
      `billingReadiness "${input.next}" is set only by the derived-invoice / OpenInvoice-submission process, not directly`,
    );
  }
  if (input.next === 'unclassified') {
    throw new AppError(400, 'billingReadiness "unclassified" is the creation default — it cannot be set directly');
  }

  const ticket = await db.serviceTicket.findUnique({
    where: { id: ticketId },
    select: {
      id: true,
      serviceDate: true,
      techSignature: true,
      customerRepSignature: true,
      billingProfile: { select: { signatureRequired: true } },
    },
  });
  if (!ticket) throw new AppError(404, 'Ticket not found');

  if (input.next === 'ready') {
    if (!ticket.serviceDate) {
      throw new AppError(400, 'billingReadiness "ready" requires a service date');
    }
    const requires = ticket.billingProfile?.signatureRequired ?? 'none';
    if (
      (requires === 'ticket' || requires === 'both') &&
      !ticket.techSignature &&
      !ticket.customerRepSignature
    ) {
      throw new AppError(
        400,
        'billingReadiness "ready" requires a signed-ticket artifact — this customer\'s billing profile requires one',
      );
    }
    return db.serviceTicket.update({
      where: { id: ticketId },
      data: {
        billingReadiness: 'ready',
        billingReadinessReasonCode: null,
        billingReadinessSetById: input.actorUserId,
        billingReadinessSetAt: new Date(),
      },
    });
  }

  // not_billable
  if (!input.reasonCode) {
    throw new AppError(400, 'billingReadiness "not_billable" requires a reasonCode');
  }
  const reason = await db.billingReasonCode.findUnique({ where: { code: input.reasonCode } });
  if (!reason || !reason.isActive) {
    throw new AppError(400, `Unknown or inactive billing reason code: ${input.reasonCode}`);
  }
  return db.serviceTicket.update({
    where: { id: ticketId },
    data: {
      billingReadiness: 'not_billable',
      billingReadinessReasonCode: input.reasonCode,
      billingReadinessSetById: input.actorUserId,
      billingReadinessSetAt: new Date(),
    },
  });
}
