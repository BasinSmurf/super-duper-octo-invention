/**
 * Fix orphaned AirSystemInspection records by linking them to
 * a work point on the same pad as their parent ticket.
 */
import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();

async function main() {
  // Get all inspections with their ticket's pad
  const inspections = await p.airSystemInspection.findMany({
    include: {
      ticket: { select: { id: true, ticketNumber: true, padId: true, workPointId: true } },
    },
  });

  console.log('Total inspections: ' + inspections.length);

  for (const insp of inspections) {
    const ticket = insp.ticket;
    if (!ticket) {
      console.log('  ' + insp.id + ': NO TICKET — skip');
      continue;
    }

    // Check if work point exists
    if (insp.workPointId) {
      const wp = await p.workPoint.findUnique({ where: { id: insp.workPointId } });
      if (wp) {
        console.log('  ' + insp.id + ': OK (workPoint ' + wp.name + ')');
        continue;
      }
      console.log('  ' + insp.id + ': workPointId set but not found in DB');
    } else {
      console.log('  ' + insp.id + ': workPointId is null');
    }

    // Try to find a work point on the same pad
    if (ticket.padId) {
      const wpAtPad = await p.workPoint.findFirst({
        where: { padId: ticket.padId, isActive: true },
        orderBy: { createdAt: 'asc' },
      });

      if (wpAtPad) {
        console.log('    Found work point at pad: ' + wpAtPad.name + ' (id=' + wpAtPad.id + ')');
        await p.airSystemInspection.update({
          where: { id: insp.id },
          data: { workPointId: wpAtPad.id },
        });
        console.log('    LINKED inspection to work point');

        // Also update the ticket if its workPointId is null
        if (!ticket.workPointId) {
          await p.serviceTicket.update({
            where: { id: ticket.id },
            data: { workPointId: wpAtPad.id },
          });
          console.log('    LINKED ticket ' + ticket.ticketNumber + ' to work point');
        }
      } else {
        console.log('    No active work point found at pad ' + ticket.padId);
      }
    } else {
      console.log('    Ticket has no padId — cannot relink');
    }
  }

  // Verify
  const orphanCount = await p.airSystemInspection.count({ where: { workPointId: null } });
  console.log('\nRemaining orphaned inspections: ' + orphanCount);

  await p.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
