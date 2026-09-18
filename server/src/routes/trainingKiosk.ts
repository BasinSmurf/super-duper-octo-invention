// Training Kiosk — the classroom sign-in board / always-on signage.
//
// One page serves three jobs at once: it shows TODAY's classes on a wall
// display, puts each open class's sign-in QR right on its card (walk-ins scan
// with their phone → the existing /train/:token flow), and lets a student sign
// in on the wall tablet itself. Auth is the shared device token (a manager's
// JWT also works, for previewing), so this endpoint takes authenticateUserOrKiosk.
//
// A class only has a QR once it's been "made" (pushed to a training ticket); a
// scheduled-but-unpushed class is returned with status:'scheduled' and no link,
// and the board renders it as "not started". The kiosk never writes.

import { Router, Request, Response } from 'express';
import { prisma } from '../index.js';
import { authenticateUserOrKiosk } from '../middleware/kioskAuth.js';
import { resolveOrigin, signinLinkForTicket } from './trainingSignin.js';

export const trainingKioskRouter = Router();

/** Local YYYY-MM-DD for "today" in the shop's timezone. */
function todayYmd(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
}

// GET /api/train-kiosk/today — today's classes for this kiosk.
//
// Location scope: a kiosk pinned to a classroom carries its CpLocation id in
// stationFilter; unset = all of today's classes. A manager previewing via JWT
// can pass ?locationId= to see a specific room.
trainingKioskRouter.get('/today', authenticateUserOrKiosk, async (req: Request, res: Response, next) => {
  try {
    const locationId = req.kiosk
      ? (req.kiosk.stationFilter || null)
      : ((req.query.locationId as string) || null);

    const today = todayYmd();
    const sessions = await prisma.cpScheduledSession.findMany({
      where: {
        date: new Date(today),
        status: { in: ['scheduled', 'pushed'] },
        ...(locationId ? { locationId } : {}),
      },
      include: {
        course: { select: { id: true, name: true } },
        trainer: { select: { user: { select: { name: true } } } },
        location: { select: { id: true, name: true } },
        _count: { select: { registrations: true } },
      },
      orderBy: [{ startTime: 'asc' }],
    });

    // Live roster counts for pushed classes come from the ticket (QR sign-ins
    // land there), not the pre-registration list — one grouped query.
    const pushedTicketIds = sessions
      .filter(s => s.status === 'pushed' && s.ticketId)
      .map(s => s.ticketId as string);
    const rosterCounts = pushedTicketIds.length
      ? await prisma.trainingRosterRecord.groupBy({
          by: ['ticketId'],
          where: { ticketId: { in: pushedTicketIds } },
          _count: true,
        })
      : [];
    const countByTicket = new Map(rosterCounts.map(r => [r.ticketId, r._count as unknown as number]));

    const origin = resolveOrigin(req);
    const classes = await Promise.all(
      sessions.map(async s => {
        const link =
          s.status === 'pushed' && s.ticketId ? await signinLinkForTicket(s.ticketId, origin) : null;
        const signedInCount =
          s.status === 'pushed' && s.ticketId
            ? countByTicket.get(s.ticketId) ?? 0
            : s._count.registrations;
        return {
          id: s.id,
          courseName: s.course.name,
          startTime: s.startTime,
          endTime: s.endTime,
          trainerName: s.trainer?.user.name ?? null,
          locationName: s.location?.name ?? s.adHocAddress ?? null,
          capacity: s.capacity,
          signedInCount,
          // 'open' once the QR exists; 'scheduled' = made-the-class pending.
          status: link ? 'open' : 'scheduled',
          signinToken: link?.token ?? null,
          signinUrl: link?.url ?? null,
          qrDataUrl: link?.qrDataUrl ?? null,
        };
      }),
    );

    let location: { id: string; name: string } | null = null;
    if (locationId) {
      const loc = await prisma.cpLocation.findUnique({
        where: { id: locationId },
        select: { id: true, name: true },
      });
      if (loc) location = loc;
    }

    res.json({ generatedAt: new Date().toISOString(), today, location, classes });
  } catch (err) {
    next(err);
  }
});
