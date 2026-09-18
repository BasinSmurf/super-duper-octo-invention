/**
 * rentalTicketRecord.ts — how a rental-linked ticket is disposed at approval.
 *
 * A ticket attached to a rental never bills standalone. The rental agreement is
 * the billing spine (ADR-0014): the ticket's billable lines roll onto the
 * rental's invoice, and `GET /invoices/uninvoiced/tickets` deliberately excludes
 * every rental-linked ticket so it can't also bill through the standalone
 * consolidation pool (ADR-0014 mechanism #3 — the double-invoice guard).
 *
 * That leaves exactly two dispositions:
 *
 *   no billable lines → LOG-ONLY. A record of a shift, not a charge. Append it
 *                       to the rental's daily log and close it `recordOnly`.
 *                       It never enters review or the billing queue at all.
 *   billable lines    → rides the rental. Stays in the pipeline, surfaces on its
 *                       rental's card in Rentals to Bill, and flips to
 *                       `invoiced` when the rental invoice consumes it.
 *
 * This replaces an earlier `rental.isManned` test, which was the wrong axis in
 * both directions: it closed manned dailies that DID carry a billable line (a
 * 461 daily), and it left an unmanned rental's empty log ticket parked in
 * `billing_queue` — a status no queue renders for a rental-linked ticket, so it
 * read "Billing Queue" on the ticket and was absent from the billing queue,
 * permanently. Billability, not mannedness, is what decides.
 */

import { prisma, Prisma } from '../db.js';
import { emitEvent } from './eventBus.js';
import { randomUUID } from 'crypto';

/** The fields a disposition decision needs. */
export interface RentalRecordTicketShape {
  id: string;
  ticketNumber: string;
  status: string;
  workDescription: string | null;
  customData: unknown;
  serviceDate: Date;
  linkedRentalAgreementId: string | null;
  /** Attribution fallbacks for the daily-log row when there's no human actor
   *  (the background auto-approval job). RentalDailyLog.loggedById is NOT NULL. */
  assignedTechId?: string | null;
  createdById?: string | null;
}

/**
 * True when the ticket carries at least one line that actually charges. A line
 * totalling 0 is deliberately free/included (or a qty-0 note), not a charge —
 * same rule as `hasRate` in rentalComposition.ts, one level up.
 */
export async function hasBillableLines(ticketId: string): Promise<boolean> {
  const billable = await prisma.ticketLineItem.findFirst({
    where: { ticketId, total: { gt: 0 } },
    select: { id: true },
  });
  return billable !== null;
}

/**
 * True when this ticket should be closed as a log-only record instead of moving
 * toward billing: it's attached to a rental and has nothing to charge.
 */
export async function shouldRecordOnly(ticket: {
  id: string;
  linkedRentalAgreementId: string | null;
}): Promise<boolean> {
  if (!ticket.linkedRentalAgreementId) return false;
  return !(await hasBillableLines(ticket.id));
}

/**
 * Record a ticket as a non-billable "did a thing" entry on its rental's daily
 * log, then close it (`recordOnly`). Returns the closed ticket.
 *
 * The log row is keyed to the ticket's OWN serviceDate, not today — a shift
 * ticket submitted the next morning belongs on the day it was worked, and the
 * sync-side mirror (`maybeWriteRentalDailyLogFromTicket`) already keys on
 * serviceDate, so anything else puts two records of one shift on two dates.
 * Idempotent: re-running won't append a second entry for the same ticket.
 */
export async function recordTicketAsRentalLog(
  ticket: RentalRecordTicketShape,
  rentalId: string,
  /** The acting user, or null when the background job is the actor. */
  actorUserId: string | null,
  reqIp?: string,
) {
  // The log row needs an owner (loggedById is NOT NULL). With no human actor,
  // attribute the shift to whoever worked or raised it. If we can't name
  // anyone, refuse rather than invent one — the caller leaves the ticket for a
  // human instead of closing it against a fabricated author.
  const loggedById = actorUserId ?? ticket.assignedTechId ?? ticket.createdById ?? null;
  if (!loggedById) {
    throw new Error(
      `Ticket ${ticket.ticketNumber}: no user to attribute the rental daily log to — leaving it for manual review`,
    );
  }
  // Date-only, UTC-midnight — matches how RentalDailyLog.logDate reads back.
  const logDate = new Date(ticket.serviceDate);
  logDate.setUTCHours(0, 0, 0, 0);

  const actor = await prisma.user.findUnique({
    where: { id: loggedById },
    select: { name: true },
  });
  const now = new Date();
  const entry = {
    id: randomUUID(),
    time: `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`,
    type: 'note' as const,
    text: `Service ticket ${ticket.ticketNumber} — ${ticket.workDescription?.trim() || 'work logged'}${actor?.name ? ` (${actor.name})` : ''}`,
    createdAt: now.toISOString(),
  };

  const existingLog = await prisma.rentalDailyLog.findFirst({
    where: { rentalAgreementId: rentalId, logDate },
  });

  if (existingLog) {
    const prior = Array.isArray(existingLog.entries) ? (existingLog.entries as any[]) : [];
    // Don't append twice for the same ticket (a re-run, or a ticket that was
    // already logged by the sync mirror and is now being closed).
    const already = prior.some(
      e => typeof e?.text === 'string' && e.text.includes(`Service ticket ${ticket.ticketNumber}`),
    );
    if (!already) {
      await prisma.rentalDailyLog.update({
        where: { id: existingLog.id },
        data: { entries: [...prior, entry] as Prisma.InputJsonValue },
      });
    }
  } else {
    await prisma.rentalDailyLog.create({
      data: {
        rentalAgreementId: rentalId,
        logDate,
        loggedById,
        equipmentPresent: true,
        equipmentStatus: 'operational',
        entries: [entry] as Prisma.InputJsonValue,
      },
    });
  }

  const cd = (ticket.customData as Record<string, any> | null) || {};
  const closed = await prisma.serviceTicket.update({
    where: { id: ticket.id },
    data: {
      status: 'closed',
      customData: { ...cd, recordOnly: true, loggedToRentalId: rentalId },
    },
  });

  // Written directly rather than through utils/auditLog.ts, which imports
  // prisma from index.js — this service is also called from the background
  // auto-approval job, which must not pull the Express app in.
  await prisma.auditLog.create({
    data: {
      userId: actorUserId ?? undefined,
      entityType: 'service_ticket',
      entityId: ticket.id,
      action: 'status_change',
      changes: {
        from: ticket.status,
        to: 'closed',
        recordOnly: true,
        loggedToRentalId: rentalId,
      } as Prisma.InputJsonValue,
      ipAddress: reqIp,
    },
  });

  void emitEvent('ticket.transitioned', {
    ticketId: ticket.id,
    fromStatus: ticket.status,
    toStatus: 'closed',
    actorUserId,
    reason: 'record-only: no billable lines, logged to rental',
  });

  return closed;
}
