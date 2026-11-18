// #13 Training QR self-sign-in.
//
// The trainer generates a per-class link (QR) from a training ticket; students
// open it on their phone and sign in with name + signature, which lands as a
// TrainingRosterRecord on the ticket.
//
// Gate-endpoints rule: the app is internet-exposed, so the public half is NOT
// anonymous-open — it's keyed by an unguessable per-class token stored in the
// ticket's customData, only works while the class is open (draft / dispatched /
// in_progress), and write size is capped. Link generation requires a login.

import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import QRCode from 'qrcode';
import { Prisma } from '../generated/prisma/client.js';
import { prisma } from '../db.js';
import { AppError } from '../middleware/errorHandler.js';
import { authenticate } from '../middleware/auth.js';
import { matchEmployer } from '../services/employerMatch.js';

export const trainingSigninRouter = Router();

const OPEN_STATUSES = ['draft', 'dispatched', 'in_progress'];
const MAX_SELF_SIGNINS = 150;

// The wizard stores courseName='Other' + the typed name in courseOther —
// resolve to the real name so students don't see "Other" on their phone.
function courseDisplay(cd: any): string {
  if (cd?.courseName === 'Other' && cd?.courseOther) return cd.courseOther;
  return cd?.courseName || 'Training';
}

/** Public origin for building /train links — configured app URL, else the request's. */
export function resolveOrigin(req: Request): string {
  return (process.env.PUBLIC_APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}

/**
 * Mint (once) the per-class sign-in token on a training ticket and render its
 * QR. Shared by the authenticated link endpoint and the training kiosk, so both
 * produce the identical /train/:token URL + QR for a class.
 */
export async function mintSigninLink(
  ticket: { id: string; customData: unknown },
  origin: string,
): Promise<{ token: string; url: string; qrDataUrl: string }> {
  const cd = (ticket.customData as any) || {};
  let token: string = cd.signinToken;
  if (!token) {
    token = crypto.randomBytes(16).toString('hex');
    await prisma.serviceTicket.update({
      where: { id: ticket.id },
      data: { customData: { ...cd, signinToken: token } },
    });
  }
  const url = `${origin}/train/${token}`;
  const qrDataUrl = await QRCode.toDataURL(url, { width: 360, margin: 1 });
  return { token, url, qrDataUrl };
}

/**
 * Kiosk-facing: return the sign-in link for a training ticket, or null if the
 * ticket isn't an open training class (so the kiosk shows it as "not started").
 */
export async function signinLinkForTicket(
  ticketId: string,
  origin: string,
): Promise<{ token: string; url: string; qrDataUrl: string } | null> {
  const ticket = await prisma.serviceTicket.findUnique({
    where: { id: ticketId },
    select: { id: true, ticketType: true, status: true, customData: true },
  });
  if (!ticket || ticket.ticketType !== 'training' || !OPEN_STATUSES.includes(ticket.status)) return null;
  return mintSigninLink(ticket, origin);
}

async function findOpenClassByToken(token: string) {
  if (!token || !/^[a-f0-9]{32}$/.test(token)) return null;
  const ticket = await prisma.serviceTicket.findFirst({
    where: {
      ticketType: 'training',
      status: { in: OPEN_STATUSES as any },
      customData: { path: ['signinToken'], equals: token },
    },
    select: {
      id: true, ticketNumber: true, status: true, serviceDate: true,
      customData: true,
      company: { select: { name: true } },
      _count: { select: { trainingRosterRecords: true } },
    },
  });
  return ticket;
}

// ── Authenticated: generate (or fetch) the sign-in link for a class ──
// POST /api/train/link/:ticketId
trainingSigninRouter.post('/link/:ticketId', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ticket = await prisma.serviceTicket.findUnique({
      where: { id: req.params.ticketId as string },
      select: { id: true, ticketType: true, status: true, customData: true },
    });
    if (!ticket) throw new AppError(404, 'Ticket not found');
    if (ticket.ticketType !== 'training') throw new AppError(400, 'Sign-in links are for training tickets');
    if (!OPEN_STATUSES.includes(ticket.status)) {
      throw new AppError(409, `Class is ${ticket.status} — sign-in links only work while the class is open`);
    }

    const { url, qrDataUrl } = await mintSigninLink(ticket, resolveOrigin(req));
    res.json({ url, qrDataUrl });
  } catch (err) {
    next(err);
  }
});

// ── Public: class info for the sign-in page ──
// GET /api/train/:token
trainingSigninRouter.get('/:token', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ticket = await findOpenClassByToken(req.params.token as string);
    if (!ticket) throw new AppError(404, 'Class not found or no longer open');
    const cd = (ticket.customData as any) || {};
    res.json({
      courseName: courseDisplay(cd),
      trainerName: cd.trainerName || null,
      companyName: ticket.company?.name || null,
      serviceDate: ticket.serviceDate,
      signedInCount: ticket._count.trainingRosterRecords,
    });
  } catch (err) {
    next(err);
  }
});

// ── Public: student sign-in ──
// POST /api/train/:token  { employeeName, employerName?, contactPhone?, contactEmail?, signature }
trainingSigninRouter.post('/:token', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ticket = await findOpenClassByToken(req.params.token as string);
    if (!ticket) throw new AppError(404, 'Class not found or no longer open');

    const { employeeName, employerName, contactPhone, contactEmail, signature } = req.body || {};
    const name = String(employeeName || '').trim().slice(0, 120);
    if (!name) throw new AppError(400, 'Name is required');
    const sig = typeof signature === 'string' ? signature : '';
    if (!sig.startsWith('data:image/') || sig.length > 500_000) {
      throw new AppError(400, 'A signature is required');
    }

    // Silent employer match (alias or exact normalized name — never fuzzy):
    // billing splits invoices per employerCompanyId, so a confident match here
    // saves a reconcile later. The student sees nothing different.
    const employer = String(employerName || '').trim().slice(0, 120) || null;
    const employerCompanyId = employer ? ((await matchEmployer(employer))?.companyId ?? null) : null;

    const phone = String(contactPhone || '').trim().slice(0, 40) || null;
    const email = String(contactEmail || '').trim().slice(0, 120) || null;
    const normalize = (value: string | null) => (value || '').trim().replace(/\s+/g, ' ').toUpperCase();
    const record = await prisma.$transaction(async tx => {
      // Serialize arrivals and re-read status after the lock: simultaneous
      // retries must not create extra billable seats or race a class closeout.
      await tx.$queryRaw(Prisma.sql`SELECT id FROM service_tickets WHERE id = ${ticket.id} FOR UPDATE`);
      const current = await tx.serviceTicket.findUnique({ where: { id: ticket.id }, select: { status: true, customData: true, serviceDate: true } });
      if (!current || !OPEN_STATUSES.includes(current.status)) throw new AppError(409, 'Class is closed — see the trainer');
      const roster = await tx.trainingRosterRecord.findMany({ where: { ticketId: ticket.id } });
      const matches = roster.filter(row => normalize(row.employeeName) === normalize(name)
        && (employerCompanyId ? row.employerCompanyId === employerCompanyId : normalize(row.employerName) === normalize(employer)));
      if (matches.length > 1) throw new AppError(409, 'More than one student matches this name and employer — see the trainer');
      const existing = matches[0];
      if (existing) {
        if (existing.participantSignature === sig) return { id: existing.id };
        if (existing.participantSignature) throw new AppError(409, 'This student is already signed in — see the trainer if this is another person');
        // Preserve trainer-entered results, card status, and contact details.
        return tx.trainingRosterRecord.update({
          where: { id: existing.id },
          data: { participantSignature: sig, signedAt: new Date(), ...(phone ? { contactPhone: phone } : {}), ...(email ? { contactEmail: email } : {}) },
          select: { id: true },
        });
      }
      if (roster.length >= MAX_SELF_SIGNINS) throw new AppError(409, 'Roster is full — see the trainer');
      const cd = (current.customData as any) || {};
      return tx.trainingRosterRecord.create({ data: {
        ticketId: ticket.id,
        employeeName: name,
        employerName: employer,
        employerCompanyId,
        contactPhone: phone,
        contactEmail: email,
        courseName: courseDisplay(cd),
        passed: true, // trainer flips fails when closing out the class
        trainedAt: current.serviceDate,
        participantSignature: sig,
        signedAt: new Date(),
      }, select: { id: true } });
    });

    res.status(201).json({ ok: true, id: record.id });
  } catch (err) {
    next(err);
  }
});
