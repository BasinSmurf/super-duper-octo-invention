/**
 * classproTicketPush.ts — ClassPRO wave 4: "make the class".
 *
 * The ONE idempotent handoff between ClassPRO scheduling and Sundog tickets
 * (ADR-0002): a scheduled session pushes ONCE into a draft training ticket,
 * carrying its pre-registration roster along as TrainingRosterRecords. From
 * that moment Sundog owns the class — the QR sign-in link, roster edits,
 * close-out and billing all happen on the ticket; the session flips to
 * 'pushed' and keeps ticketId as display/idempotency metadata (never a FK).
 *
 * Idempotency: a session whose ticketId still resolves returns the existing
 * ticket (created:false). If someone hard-deleted the ticket, the push
 * recreates it and re-stamps ticketId.
 *
 * The ticket lands as status 'draft' — same as a wizard-created class — so
 * the trainer/dispatch flow (dispatch, sign-in QR, close-out) is unchanged.
 */

import { prisma } from '../index.js';
import { AppError } from '../middleware/errorHandler.js';
import { generateTicketNumber } from '../utils/ticketNumber.js';
import { matchEmployer } from './employerMatch.js';

export interface PushResult {
  created: boolean;
  ticketId: string;
  ticketNumber: string;
  rosterCount: number;
}

export async function pushSessionToTicket(sessionId: string, userId: string | null): Promise<PushResult> {
  const session = await prisma.cpScheduledSession.findUnique({
    where: { id: sessionId },
    include: {
      course: { select: { id: true, name: true, cardsOnSite: true } },
      trainer: { select: { userId: true, user: { select: { name: true } } } },
      location: { select: { name: true, companyId: true } },
      company: { select: { id: true, name: true } },
      registrations: { orderBy: { createdAt: 'asc' } },
    },
  });
  if (!session) throw new AppError(404, 'Session not found');
  if (session.status === 'cancelled') throw new AppError(400, 'This session is cancelled — restore it before making the class');

  // Idempotent re-push: the ticket already exists → hand it back. A voided
  // ticket counts as dead — the class gets a fresh one.
  if (session.ticketId) {
    const existing = await prisma.serviceTicket.findFirst({
      where: { id: session.ticketId, status: { not: 'void' } },
      select: { id: true, ticketNumber: true, _count: { select: { trainingRosterRecords: true } } },
    });
    if (existing) {
      return {
        created: false,
        ticketId: existing.id,
        ticketNumber: existing.ticketNumber,
        rosterCount: existing._count.trainingRosterRecords,
      };
    }
    // Ticket was deleted or voided — fall through and recreate.
  }

  // Booking customer: explicit pick → client site's customer → Basin Safety.
  // Repeating in-house classes usually carry split rosters (many employers),
  // so the class ticket defaults to ourselves — billing still splits per
  // roster employer at invoicing.
  const companyId = session.companyId ?? session.location?.companyId ?? await houseCompanyId();

  const place = session.location?.name
    ?? session.adHocAddress
    ?? (session.deliveryMode === 'in_house' ? 'Basin Safety Training Center' : null);

  // Re-run the silent matcher on still-unmatched registrations: an alias
  // confirmed after they registered should land on the ticket roster matched.
  const rosterRows: Array<{
    employeeName: string;
    employerName: string | null;
    employerCompanyId: string | null;
    contactPhone: string | null;
    contactEmail: string | null;
    notes: string | null;
    courseName: string;
    passed: boolean;
    cardIssuedOnSite: boolean;
    trainedAt: Date;
  }> = [];
  for (const reg of session.registrations) {
    let employerCompanyId = reg.employerCompanyId;
    if (!employerCompanyId && reg.employerName) {
      employerCompanyId = (await matchEmployer(reg.employerName))?.companyId ?? null;
    }
    rosterRows.push({
      employeeName: reg.studentName,
      employerName: reg.employerName,
      employerCompanyId,
      contactPhone: reg.contactPhone,
      contactEmail: reg.contactEmail,
      notes: reg.notes,
      courseName: session.course.name,
      passed: true, // trainer flips fails at close-out, same as the QR sign-in
      cardIssuedOnSite: session.course.cardsOnSite,
      trainedAt: session.date,
    });
  }

  const ticketNumber = await generateTicketNumber('training');

  const ticket = await prisma.$transaction(async (tx) => {
    const t = await tx.serviceTicket.create({
      data: {
        ticketNumber,
        ticketType: 'training',
        status: 'draft',
        sourceType: 'classpro_session',
        companyId,
        locationDisplay: place,
        serviceDate: session.date,
        // The trainer sees their own training tickets — assign them the class.
        assignedTechId: session.trainer?.userId ?? null,
        dispatchNotes: session.notes,
        workDescription: `${session.course.name} — ${place ?? 'training class'}`,
        createdById: userId,
        customData: {
          courseName: session.course.name,
          ...(session.trainer ? { trainerName: session.trainer.user.name } : {}),
          isOnSite: session.deliveryMode === 'on_site',
          ...(place ? { locationText: place } : {}),
          classproSessionId: session.id,
          autoGeneratedFrom: 'classpro_session',
        },
        ...(rosterRows.length > 0 ? { trainingRosterRecords: { create: rosterRows } } : {}),
      },
      select: { id: true, ticketNumber: true },
    });

    await tx.cpScheduledSession.update({
      where: { id: session.id },
      data: { status: 'pushed', ticketId: t.id },
    });

    return t;
  });

  console.log(
    `[classpro→ticket] Session ${session.id} (${session.course.name} ${session.date.toISOString().slice(0, 10)}) pushed to ${ticket.ticketNumber} with ${rosterRows.length} pre-registered student(s)`,
  );

  return { created: true, ticketId: ticket.id, ticketNumber: ticket.ticketNumber, rosterCount: rosterRows.length };
}

/**
 * After the push the ticket owns the class — but tickets can die (voided,
 * hard-deleted, discard-draft) without ClassPRO hearing about it, which used
 * to strand the session on the calendar as 'pushed' with a dead ticket link.
 * Rather than hooking ticket deletion (boundary: ticket code never knows
 * about cp_), pushed sessions lazily re-verify their ticket wherever they're
 * read and revert to 'scheduled' when it's gone. Pre-registrations were
 * copied (not moved) at push time, so the class comes back "ready to create"
 * with its roster intact.
 *
 * Returns the ids of the sessions that were reverted.
 */
export async function revertOrphanedSessions(
  sessions: Array<{ id: string; status: string; ticketId: string | null }>,
): Promise<Set<string>> {
  const pushed = sessions.filter((s) => s.status === 'pushed' && s.ticketId);
  if (pushed.length === 0) return new Set();
  const alive = await prisma.serviceTicket.findMany({
    where: { id: { in: pushed.map((s) => s.ticketId as string) }, status: { not: 'void' } },
    select: { id: true },
  });
  const aliveIds = new Set(alive.map((t) => t.id));
  const dead = pushed.filter((s) => !aliveIds.has(s.ticketId as string));
  if (dead.length === 0) return new Set();
  await prisma.cpScheduledSession.updateMany({
    where: { id: { in: dead.map((s) => s.id) } },
    data: { status: 'scheduled', ticketId: null },
  });
  for (const s of dead) {
    console.log(`[classpro→ticket] Session ${s.id}: ticket ${s.ticketId} was deleted/voided — reverted to scheduled`);
  }
  return new Set(dead.map((s) => s.id));
}

/**
 * The Basin Safety self-company (seeded as 'co-basin'; Shop Intake relies on
 * the same row for internal work). Recreated in the seed shape if a DB was
 * never seeded, so the push can't dead-end on a missing house company.
 */
async function houseCompanyId(): Promise<string> {
  const seeded = await prisma.company.findUnique({ where: { id: 'co-basin' }, select: { id: true } });
  if (seeded) return seeded.id;
  const byName = await prisma.company.findFirst({
    where: { name: { equals: 'Basin Safety', mode: 'insensitive' }, isActive: true },
    select: { id: true },
  });
  if (byName) return byName.id;
  const created = await prisma.company.create({
    data: { id: 'co-basin', name: 'Basin Safety', companyType: 'both', city: 'Williston', state: 'ND', isActive: true, qbCustomerFullName: 'Basin Safety' },
    select: { id: true },
  });
  return created.id;
}
