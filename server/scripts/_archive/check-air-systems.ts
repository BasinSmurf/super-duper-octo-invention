import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // Check work points
  const workPoints = await prisma.workPoint.count();
  console.log('Work Points: ' + workPoints);

  // Check air system related tables
  const facilities = await prisma.facility.count();
  console.log('Facilities: ' + facilities);

  // Check if there are any air system inspection records on tickets
  const airTickets = await prisma.serviceTicket.findMany({
    where: {
      OR: [
        { serviceSubtype: { contains: 'air' } },
        { ticketType: { equals: 'field_service' } },
      ],
    },
    select: { id: true, ticketNumber: true, ticketType: true, serviceSubtype: true, status: true },
    take: 20,
  });
  console.log('\nAir-related tickets: ' + airTickets.length);
  for (const t of airTickets) {
    console.log('  ' + t.ticketNumber + ' | ' + t.ticketType + ' | ' + t.serviceSubtype + ' | ' + t.status);
  }

  // Check what work point types exist
  const wpTypes = await prisma.workPoint.groupBy({
    by: ['workPointType'],
    _count: true,
  });
  console.log('\nWork point types:');
  for (const wp of wpTypes) {
    console.log('  ' + wp.workPointType + ': ' + wp._count);
  }

  // Check if work points reference wells that still exist
  const wpSample = await prisma.workPoint.findMany({
    take: 10,
    include: {
      well: { select: { id: true, wellName: true } },
      pad: { select: { id: true, name: true } },
    },
  });
  console.log('\nSample work points:');
  for (const wp of wpSample) {
    console.log('  ' + wp.id + ' | type=' + wp.workPointType + ' | well=' + (wp.well?.wellName || 'null') + ' | pad=' + (wp.pad?.name || 'null'));
  }

  // Check the sync pull - what tables are synced
  // Also check if airSystemRecords exist in any Dexie-relevant server table
  const ticketLineItems = await prisma.ticketLineItem.count();
  console.log('\nTicket line items: ' + ticketLineItems);

  // Check for any air system inspection data in ticket attachments or line items
  const airLineItems = await prisma.ticketLineItem.findMany({
    where: {
      OR: [
        { lineType: { contains: 'air' } },
        { description: { contains: 'air', mode: 'insensitive' } },
        { description: { contains: 'cylinder', mode: 'insensitive' } },
        { description: { contains: 'reel', mode: 'insensitive' } },
      ],
    },
    take: 10,
  });
  console.log('Air-related line items: ' + airLineItems.length);

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
